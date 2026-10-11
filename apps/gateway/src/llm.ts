import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  id: string;
  name: string;
  isError: boolean;
  text: string;
  structured?: unknown;
}

/**
 * One step of the loop: given the conversation so far, the model either
 * answers (text) or asks for tool calls. The provider owns its own message
 * format; the agent only appends user turns and tool results.
 */
export interface LlmSession {
  step(): Promise<{ text: string | null; calls: ToolCallRequest[] }>;
  addToolResults(results: ToolCallResult[]): void;
}

export interface LlmProvider {
  start(input: {
    system: string;
    history: { role: "user" | "assistant"; text: string }[];
    tools: ToolSpec[];
  }): LlmSession;
}

/**
 * MCP input schemas are JSON Schema; Gemini takes a JSON Schema subset via
 * parametersJsonSchema. Drop keywords it rejects and anything that only
 * matters for validation tooling.
 */
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = {
    ...((schema.definitions as Record<string, unknown> | undefined) ?? {}),
    ...((schema.$defs as Record<string, unknown> | undefined) ?? {}),
  };
  // Keywords dropped at schema positions only; under "properties" keys are
  // parameter names and are kept whatever they are called.
  const DROP = new Set(["$schema", "$id", "$comment", "$defs", "definitions"]);
  const MAX_DEPTH = 8;

  const resolve = (ref: string): unknown => {
    const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
    return m ? defs[decodeURIComponent(m[1]!)] : undefined;
  };

  const schemaNode = (v: unknown, seen: string[]): unknown => {
    if (Array.isArray(v)) return v.map((x) => schemaNode(x, seen));
    if (!v || typeof v !== "object") return v;
    const node = v as Record<string, unknown>;
    if (typeof node.$ref === "string") {
      const target = resolve(node.$ref);
      // Unknown or recursive references become an unconstrained object.
      if (!target || seen.includes(node.$ref) || seen.length >= MAX_DEPTH)
        return { type: "object" };
      return schemaNode(target, [...seen, node.$ref]);
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(node)) {
      if (DROP.has(k)) continue;
      if ((k === "properties" || k === "patternProperties") && val && typeof val === "object") {
        out[k] = Object.fromEntries(
          Object.entries(val as Record<string, unknown>).map(([name, sub]) => [
            name,
            schemaNode(sub, seen),
          ]),
        );
      } else {
        out[k] = schemaNode(val, seen);
      }
    }
    return out;
  };

  const out = schemaNode(schema, []) as Record<string, unknown>;
  if (out.type !== "object") return { type: "object", properties: {} };
  return out;
}

export class GeminiProvider implements LlmProvider {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  start(input: Parameters<LlmProvider["start"]>[0]): LlmSession {
    const contents: Content[] = input.history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }],
    }));
    const functionDeclarations: FunctionDeclaration[] = input.tools.map((t) => ({
      name: t.name,
      description: t.description.slice(0, 1000),
      parametersJsonSchema: toGeminiSchema(t.inputSchema),
    }));
    const { ai, model } = this;
    let callSeq = 0;

    return {
      async step() {
        const res = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: input.system,
            ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
          },
        });
        const modelContent = res.candidates?.[0]?.content;
        // Append the model turn unchanged: newer models attach thought
        // signatures to function-call parts that must be sent back as-is.
        if (modelContent) contents.push({ role: "model", parts: modelContent.parts ?? [] });
        const calls = (res.functionCalls ?? []).map((fc) => ({
          id: fc.id ?? `call_${++callSeq}`,
          name: fc.name ?? "",
          args: (fc.args ?? {}) as Record<string, unknown>,
        }));
        return { text: calls.length ? null : (res.text ?? ""), calls };
      },
      addToolResults(results) {
        contents.push({
          role: "user",
          parts: results.map((r) => ({
            functionResponse: {
              id: r.id,
              name: r.name,
              response: r.isError ? { error: r.text } : { output: r.structured ?? r.text },
            },
          })),
        });
      },
    };
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * Any OpenAI-compatible chat completions API (OpenRouter, OpenAI, a
 * self-hosted model server). The key is optional for servers that need none.
 */
export class OpenAiCompatProvider implements LlmProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
    private readonly timeoutMs = 300_000,
  ) {}

  start(input: Parameters<LlmProvider["start"]>[0]): LlmSession {
    const messages: ChatMessage[] = [
      { role: "system", content: input.system },
      ...input.history.map((m) => ({ role: m.role, content: m.text }) as ChatMessage),
    ];
    const tools = input.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description.slice(0, 1000),
        parameters: toGeminiSchema(t.inputSchema),
      },
    }));
    const { baseUrl, model, apiKey, timeoutMs } = this;

    return {
      async step() {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages,
            ...(tools.length ? { tools } : {}),
            temperature: 0,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
          throw new Error(
            `LLM request failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
          );
        const body = (await res.json()) as { choices?: { message?: ChatMessage }[] };
        const msg = body.choices?.[0]?.message;
        if (!msg) throw new Error("LLM returned no message");
        messages.push({
          role: "assistant",
          content: msg.content ?? null,
          ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
        });
        const calls = (msg.tool_calls ?? []).map((tc) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            // Malformed arguments: pass none; the tool's own validation reports the problem back to the model.
          }
          return { id: tc.id, name: tc.function.name, args };
        });
        // Some models wrap reasoning in <think> tags; never show it as the answer.
        const text = (msg.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        return { text: calls.length ? null : text, calls };
      },
      addToolResults(results) {
        for (const r of results) {
          messages.push({
            role: "tool",
            tool_call_id: r.id,
            content: r.isError ? `Error: ${r.text}` : JSON.stringify(r.structured ?? r.text),
          });
        }
      },
    };
  }
}
