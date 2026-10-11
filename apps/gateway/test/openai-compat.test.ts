import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAiCompatProvider } from "../src/llm.js";

let server: Server;
let base: string;
const requests: any[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const hasToolResult = parsed.messages.some((m: { role: string }) => m.role === "tool");
      const message = hasToolResult
        ? { role: "assistant", content: "<think>reasoning</think>There is 1 order today." }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "woo__list_orders", arguments: '{"date":"2026-10-11"}' },
              },
            ],
          };
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => {
  server.close();
});

describe("OpenAiCompatProvider", () => {
  it("sends tools, parses tool calls, returns tool results, and strips reasoning from the answer", async () => {
    const session = new OpenAiCompatProvider(base, "test-model").start({
      system: "sys",
      history: [{ role: "user", text: "orders today?" }],
      tools: [
        {
          name: "woo__list_orders",
          description: "List orders",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const first = await session.step();
    expect(first.calls).toEqual([
      { id: "call_1", name: "woo__list_orders", args: { date: "2026-10-11" } },
    ]);
    expect(requests[0].tools[0]).toMatchObject({
      type: "function",
      function: { name: "woo__list_orders" },
    });
    session.addToolResults([
      {
        id: "call_1",
        name: "woo__list_orders",
        isError: false,
        text: "{}",
        structured: { total: 1 },
      },
    ]);
    const second = await session.step();
    expect(second.text).toBe("There is 1 order today.");
    const sent = requests[1].messages;
    expect(sent.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }] });
    expect(sent.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"total":1}' });
  });
});
