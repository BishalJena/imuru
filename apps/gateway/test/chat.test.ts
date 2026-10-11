import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmProvider, ToolCallResult, ToolSpec } from "../src/llm.js";
import { toGeminiSchema } from "../src/llm.js";
import { fakeUpstream, until } from "./helpers.js";
import { ADMIN, startGateway } from "./harness.js";

/** Deterministic stand-in for the model: one tool call, then an answer built from its result. */
class ScriptedProvider implements LlmProvider {
  seenTools: ToolSpec[] = [];
  results: ToolCallResult[] = [];
  start(input: Parameters<LlmProvider["start"]>[0]) {
    this.seenTools = input.tools;
    let step = 0;
    return {
      step: async () => {
        step++;
        if (step === 1)
          return {
            text: null,
            calls: [{ id: "c1", name: "alpha__echo", args: { text: "from chat" } }],
          };
        return { text: `echoed: ${this.results.at(-1)?.text}`, calls: [] };
      },
      addToolResults: (r: ToolCallResult[]) => void this.results.push(...r),
    };
  }
}

let gw: Awaited<ReturnType<typeof startGateway>>;
let upstream: HttpServer;
const provider = new ScriptedProvider();

beforeAll(async () => {
  gw = await startGateway({ provider });
  const a = await fakeUpstream({ name: "alpha" });
  upstream = a.server;
  await gw.servers.create({ slug: "alpha", name: "Alpha", url: a.url, auth_type: "none" });
  await until(() => gw.registry.get("alpha")?.status === "connected");
});
afterAll(async () => {
  await gw.stop();
  upstream.close();
});

async function chat(fetcher: Awaited<ReturnType<typeof gw.login>>, text: string) {
  const res = await fetcher("/api/chat", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", text }] }),
  });
  return { status: res.status, body: await res.text() };
}

describe("chat agent", () => {
  it("runs the tool loop through the gateway's own /mcp and streams each step", async () => {
    const asAdmin = await gw.login(ADMIN.email, ADMIN.password);
    const { status, body } = await chat(asAdmin, "echo something");
    expect(status).toBe(200);
    expect(body).toContain("event: tool_call");
    expect(body).toContain('"name":"alpha__echo"');
    expect(body).toContain("event: tool_result");
    expect(body).toContain('"text":"echoed: alpha:from chat"');
    expect(provider.seenTools.map((t) => t.name)).toContain("alpha__echo");
  });

  it("acts as the logged-in user: the call is audited under them with via=chat", async () => {
    const rows = await gw.repo.listAudit({ server: "alpha", limit: 5 });
    expect(rows[0]).toMatchObject({
      user_email: ADMIN.email,
      via: "chat",
      tool: "echo",
      outcome: "ok",
    });
  });

  it("does not offer tools of a disabled server", async () => {
    const alpha = (await gw.servers.list()).find((s) => s.slug === "alpha")!;
    await gw.servers.update(alpha.id, { enabled: false });
    const asAdmin = await gw.login(ADMIN.email, ADMIN.password);
    await chat(asAdmin, "echo again");
    expect(provider.seenTools.map((t) => t.name)).not.toContain("alpha__echo");
    await gw.servers.update(alpha.id, { enabled: true });
  });

  it("requires a dashboard session", async () => {
    const res = await fetch(`${gw.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", text: "hi" }] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("toGeminiSchema", () => {
  it("drops keywords Gemini rejects and keeps the structure", () => {
    expect(
      toGeminiSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { a: { type: "string", $comment: "x" } },
        required: ["a"],
      }),
    ).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
  });
});

describe("toGeminiSchema edge cases (G7)", () => {
  it("inlines local $refs instead of leaving them dangling", () => {
    const out = toGeminiSchema({
      type: "object",
      properties: { address: { $ref: "#/$defs/Address" } },
      $defs: { Address: { type: "object", properties: { city: { type: "string" } } } },
    });
    expect(out).toEqual({
      type: "object",
      properties: { address: { type: "object", properties: { city: { type: "string" } } } },
    });
  });

  it("keeps properties whose names look like schema keywords", () => {
    const out = toGeminiSchema({
      type: "object",
      properties: { definitions: { type: "string" }, $id: { type: "string" } },
      required: ["definitions"],
    });
    expect(Object.keys(out.properties as object)).toEqual(["definitions", "$id"]);
  });

  it("survives recursive references", () => {
    const out = toGeminiSchema({
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
    });
    expect(JSON.stringify(out)).not.toContain("$ref");
  });
});
