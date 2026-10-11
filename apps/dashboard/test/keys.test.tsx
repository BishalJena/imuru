import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  myKeys: vi.fn(),
  config: vi.fn(),
  createKey: vi.fn(),
  revokeKey: vi.fn(),
}));
vi.mock("../src/api.js", () => ({ api }));

import { KeysPage } from "../src/pages/Keys.js";

const activeKey = {
  id: "k1",
  key_id: "abc",
  name: "laptop",
  user_email: "a@x.dev",
  created_at: "2026-10-01T00:00:00Z",
  last_used_at: null,
  revoked_at: null,
};

beforeEach(() => {
  api.config.mockResolvedValue({ mcp_url: "http://gw.test/mcp" });
  api.myKeys.mockResolvedValue([activeKey]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("Keys page", () => {
  it("clears a stale create error once the next create succeeds", async () => {
    api.createKey
      .mockRejectedValueOnce(new Error("name taken"))
      .mockResolvedValueOnce({ key: "urk_new_secret" });
    render(<KeysPage />);
    const input = await screen.findByPlaceholderText(/Key name/);

    fireEvent.change(input, { target: { value: "dup" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText("name taken")).toBeTruthy();

    fireEvent.change(input, { target: { value: "fresh" } });
    fireEvent.submit(input.closest("form")!);
    expect((await screen.findAllByText("urk_new_secret", { exact: false })).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("name taken")).toBeNull();
  });

  it("does not revoke a key unless the owner confirms", async () => {
    api.revokeKey.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<KeysPage />);
    const revoke = await screen.findByRole("button", { name: "Revoke" });

    fireEvent.click(revoke);
    expect(api.revokeKey).not.toHaveBeenCalled();

    fireEvent.click(revoke);
    await waitFor(() => expect(api.revokeKey).toHaveBeenCalledWith("k1"));
  });
});
