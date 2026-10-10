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
  const DROP = new Set(["$schema", "$id", "$comment", "$defs", "definitions"]);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !DROP.has(k))
          .map(([k, val]) => [k, walk(val)]),
      );
    }
    return v;
  };
  const out = walk(schema) as Record<string, unknown>;
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
