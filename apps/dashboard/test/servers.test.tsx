import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  servers: vi.fn(),
  serverStats: vi.fn(),
  updateServer: vi.fn(),
  createServer: vi.fn(),
  deleteServer: vi.fn(),
}));
vi.mock("../src/api.js", () => ({ api }));

import { ServersPage } from "../src/pages/Servers.js";

const base = {
  enabled: true,
  status: "connected" as const,
  tools: [],
  url: "http://x/mcp",
  auth_type: "none" as const,
  timeout_ms: 5000,
};

beforeEach(() => {
  api.servers.mockResolvedValue([
    { ...base, id: "s1", slug: "store-north", name: "North", managed: true },
    { ...base, id: "s2", slug: "docs", name: "Docs", managed: false },
  ]);
  api.serverStats.mockResolvedValue({ hours: 24, servers: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Servers page", () => {
  it("offers Remove only for servers an admin manages, not platform-managed store servers", async () => {
    render(<ServersPage me={{ id: "u1", email: "a@x.dev", name: "A", role: "admin" }} />);
    await screen.findByText("Docs");
    const removes = screen.getAllByRole("button", { name: "Remove" });
    expect(removes).toHaveLength(1);
    expect(removes[0]!.closest("article")!.textContent).toContain("Docs");
    expect(screen.getByText(/managed by Helm/)).toBeTruthy();
  });
});
