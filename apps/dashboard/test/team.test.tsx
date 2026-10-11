import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  users: vi.fn(),
  allKeys: vi.fn(),
  updateUser: vi.fn(),
  issueKey: vi.fn(),
  revokeUserKey: vi.fn(),
  invite: vi.fn(),
}));
vi.mock("../src/api.js", () => ({ api }));

import { TeamPage } from "../src/pages/Team.js";

const user = (id: string, email: string, role: "admin" | "member") => ({
  id,
  email,
  name: email,
  role,
  status: "active" as const,
  created_at: "2026-10-01T00:00:00Z",
});

beforeEach(() => {
  api.users.mockResolvedValue([
    user("me", "me@x.dev", "admin"),
    user("other", "other@x.dev", "member"),
  ]);
  api.allKeys.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Team page", () => {
  it("never offers to disable or demote the signed-in admin", async () => {
    render(<TeamPage me={{ id: "me", email: "me@x.dev", name: "me", role: "admin" }} />);
    await screen.findAllByText("other@x.dev");
    const rowOf = (email: string) =>
      Array.from(document.querySelectorAll("tbody tr")).find(
        (tr) => tr.querySelector("td")?.textContent === email,
      ) as HTMLElement;
    const mine = rowOf("me@x.dev");
    expect(mine.querySelector("select")!.hasAttribute("disabled")).toBe(true);
    expect(mine.textContent).not.toMatch(/Disable|Enable/);
    expect(rowOf("other@x.dev").textContent).toMatch(/Disable/);
  });
});
