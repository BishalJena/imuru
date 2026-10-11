import type { Server as HttpServer } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { Upstream } from "../src/upstream.js";
import { fakeUpstream } from "./helpers.js";

const servers: HttpServer[] = [];
afterAll(() => servers.forEach((s) => s.close()));

const make = (url: string, over: Partial<ConstructorParameters<typeof Upstream>[0]> = {}) =>
  new Upstream({
    slug: "u",
    name: "U",
    url,
    enabled: true,
    timeoutMs: 1000,
    connectTimeoutMs: 1000,
    ...over,
  });

describe("Upstream connection lifecycle (G1)", () => {
  it("a connect that finishes after the server was disabled does not bring it back", async () => {
    const f = await fakeUpstream({ name: "slowinit", initDelayMs: 300 });
    servers.push(f.server);
    const u = make(f.url);
    const checking = u.check();
    await new Promise((r) => setTimeout(r, 50));
    await u.setEnabled(false);
    await checking;
    await new Promise((r) => setTimeout(r, 100));
    expect(u.status).toBe("disabled");
    expect(u.tools).toEqual([]);
  });

  it("a connect that finishes after close() does not reconnect", async () => {
    const f = await fakeUpstream({ name: "slowinit2", initDelayMs: 300 });
    servers.push(f.server);
    const u = make(f.url);
    const checking = u.check();
    await new Promise((r) => setTimeout(r, 50));
    await u.close();
    await checking;
    expect(u.status).not.toBe("connected");
  });

  it("a connect that times out reports a timeout and stays unreachable", async () => {
    const f = await fakeUpstream({ name: "veryslow", initDelayMs: 600 });
    servers.push(f.server);
    const u = make(f.url, { connectTimeoutMs: 100 });
    await u.check();
    expect(u.status).toBe("unreachable");
    expect(u.lastError).toMatch(/^Timed out/);
    await new Promise((r) => setTimeout(r, 800));
    expect(u.status).toBe("unreachable");
  });
});

describe("Upstream call errors (G9)", () => {
  it("an error returned by the upstream is a tool error with its message, not 'unreachable'", async () => {
    const f = await fakeUpstream({ name: "alpha" });
    servers.push(f.server);
    const u = make(f.url);
    await u.check();
    expect(u.status).toBe("connected");
    // The upstream does not have this tool: it answers with a JSON-RPC error.
    const result = await u.callTool("not_a_tool", {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/not_a_tool/);
    expect(u.status).toBe("connected");
  });
});
