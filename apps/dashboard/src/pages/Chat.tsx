import { useRef, useState } from "react";
import type { Me } from "../api.js";

interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  result?: string;
  isError?: boolean;
  durationMs?: number;
}

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; call: ToolCall }
  | { kind: "error"; text: string };

/** Reads `event:`/`data:` frames from a fetch response body. */
async function* sse(res: Response): AsyncGenerator<{ event: string; data: string }> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      yield { event, data };
    }
  }
}

export function ChatPage({ me }: { me: Me }) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const history = useRef<{ role: "user" | "assistant"; text: string }[]>([]);

  const send = async (text: string) => {
    setBusy(true);
    history.current.push({ role: "user", text });
    setItems((xs) => [...xs, { kind: "user", text }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ messages: history.current }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      for await (const { event, data } of sse(res)) {
        const d = JSON.parse(data || "{}");
        if (event === "tool_call") {
          setItems((xs) => [
            ...xs,
            { kind: "tool", call: { id: d.id, name: d.name, args: d.args } },
          ]);
        } else if (event === "tool_result") {
          setItems((xs) =>
            xs.map((x) =>
              x.kind === "tool" && x.call.id === d.id
                ? {
                    kind: "tool",
                    call: {
                      ...x.call,
                      result: d.text,
                      isError: d.isError,
                      durationMs: d.durationMs,
                    },
                  }
                : x,
            ),
          );
        } else if (event === "message") {
          history.current.push({ role: "assistant", text: d.text });
          setItems((xs) => [...xs, { kind: "assistant", text: d.text }]);
        } else if (event === "error") {
          setItems((xs) => [...xs, { kind: "error", text: d.message }]);
        }
      }
    } catch (err) {
      setItems((xs) => [...xs, { kind: "error", text: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chat">
      <header className="page-head">
        <h2>Chat</h2>
        <span className="muted small">Calls tools through the gateway as {me.email}</span>
      </header>
      <div className="messages">
        {items.length === 0 && (
          <p className="muted">
            Try: "Create a product called Demo Hoodie priced at 999" or "What orders came in today?"
          </p>
        )}
        {items.map((it, i) =>
          it.kind === "tool" ? (
            <details key={i} className={`toolcall ${it.call.isError ? "err" : ""}`}>
              <summary>
                <span className="mono">{it.call.name}</span>
                <span className="muted small">
                  {it.call.result === undefined
                    ? " running…"
                    : ` ${it.call.isError ? "error" : "ok"} · ${it.call.durationMs} ms`}
                </span>
              </summary>
              <div className="muted small">Arguments</div>
              <pre className="mono">{JSON.stringify(it.call.args, null, 2)}</pre>
              {it.call.result !== undefined && (
                <>
                  <div className="muted small">Result</div>
                  <pre className="mono">{it.call.result}</pre>
                </>
              )}
            </details>
          ) : (
            <div key={i} className={`bubble ${it.kind}`}>
              {it.text}
            </div>
          ),
        )}
        {busy && <div className="muted small">Thinking…</div>}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || busy) return;
          const text = input.trim();
          setInput("");
          void send(text);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about products and orders…"
          disabled={busy}
        />
        <button disabled={busy}>Send</button>
      </form>
    </section>
  );
}
