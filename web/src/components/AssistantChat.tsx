"use client";

import { useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; text: string; tools?: string[] };
const SUGGESTED = ["Which ads are off target this week?", "Where am I overspending?"];

export default function AssistantChat({ clientId }: { clientId: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conv = useRef<string | undefined>(undefined);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", text }, { role: "assistant", text: "", tools: [] }]);
    const patch = (fn: (a: Msg) => Msg) => setMessages((m) => [...m.slice(0, -1), fn(m[m.length - 1])]);
    try {
      const res = await fetch(`/api/clients/${clientId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, conversation_id: conv.current }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not reach the assistant.");
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).replace(/^data: /, "");
          buf = buf.slice(i + 2);
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "conversation") conv.current = ev.id;
          else if (ev.type === "text") patch((a) => ({ ...a, text: a.text ? a.text + "\n\n" + ev.text : ev.text }));
          else if (ev.type === "tool_use") patch((a) => ({ ...a, tools: [...(a.tools ?? []), ev.name] }));
          else if (ev.type === "error") setError(ev.message);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="min-h-64 space-y-3 rounded bg-white p-4 shadow">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-gray-600">Ask about this client&apos;s ad performance.</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED.map((q) => (
                <button key={q} onClick={() => send(q)} className="rounded-full border px-3 py-1 text-sm hover:bg-gray-50">{q}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div className={`inline-block max-w-[85%] whitespace-pre-wrap rounded px-3 py-2 text-sm ${m.role === "user" ? "bg-black text-white" : "bg-gray-100"}`}>
              {m.text || (busy && i === messages.length - 1 ? "Thinking..." : "")}
            </div>
            {m.tools && m.tools.length > 0 && (
              <p className="mt-1 text-xs text-gray-500">Data used: {Array.from(new Set(m.tools)).join(", ")}</p>
            )}
          </div>
        ))}
        {error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} maxLength={4000} placeholder="Ask the Ads Assistant..." className="flex-1 rounded border px-3 py-2" />
        <button disabled={busy} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">Send</button>
      </form>
    </div>
  );
}
