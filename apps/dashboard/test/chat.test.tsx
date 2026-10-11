import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "../src/pages/Chat.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const me = { id: "u1", email: "a@x.dev", name: "A", role: "member" as const };

describe("Chat page", () => {
  it("does not send an unanswered user message with the next question", async () => {
    const bodies: { messages: { role: string; text: string }[] }[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response('event: message\ndata: {"text":"hi"}\n\nevent: done\ndata: {}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<ChatPage me={me} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "first" } });
    fireEvent.submit(box.closest("form")!);
    expect(await screen.findByText("quota exceeded")).toBeTruthy();

    fireEvent.change(box, { target: { value: "second" } });
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]!.messages).toEqual([{ role: "user", text: "second" }]);
  });
});
