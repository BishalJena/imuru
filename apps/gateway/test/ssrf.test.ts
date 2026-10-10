import { describe, expect, it } from "vitest";
import { UrlGuard } from "../src/ssrf.js";

const resolveTo = (map: Record<string, string[]>) => async (h: string) => {
  if (!map[h]) throw new Error("ENOTFOUND");
  return map[h];
};

describe("UrlGuard", () => {
  const guard = new UrlGuard(
    ["everything.demo-upstreams.svc"],
    resolveTo({
      "api.example.com": ["93.184.216.34"],
      "rebind.example.com": ["10.0.0.5"],
      "v6.example.com": ["::ffff:127.0.0.1"],
    }),
  );

  it.each([
    ["https://api.example.com/mcp", null],
    ["http://everything.demo-upstreams.svc:3001/mcp", null],
  ])("allows %s", async (url, expected) => {
    expect(await guard.check(url)).toBe(expected);
  });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://127.0.0.1:8080/mcp",
    "http://[::1]/mcp",
    "http://10.42.0.7/mcp",
    "http://rebind.example.com/mcp",
    "http://v6.example.com/mcp",
    "http://postgres.platform.svc:5432",
    "http://kubernetes.default.svc.cluster.local",
    "http://gateway/mcp",
    "file:///etc/passwd",
    "http://user:pass@api.example.com/mcp",
    "http://nxdomain.example.com/mcp",
  ])("blocks %s", async (url) => {
    expect(await guard.check(url)).not.toBeNull();
  });

  it("re-checks on every request through its fetch", async () => {
    await expect(guard.fetch()("http://169.254.169.254/")).rejects.toThrow(/SSRF guard/);
  });
});
