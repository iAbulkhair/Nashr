"use client";
import { useEffect, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { ChatMsg } from "@/lib/chat";

export default function ChatPanel({ t, initial, credits: c0 }: { t: AppDict; initial: ChatMsg[]; credits: number }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [credits, setCredits] = useState(c0);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  async function send(msg: string) {
    const m = msg.trim();
    if (!m || busy) return;
    setText("");
    setMsgs((p) => [...p, { role: "user", content: m, at: new Date().toISOString() }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: m }) });
      const j = await res.json();
      if (j.ok) { setMsgs((p) => [...p, j.message]); setCredits(j.credits); }
      else setMsgs((p) => [...p, { role: "assistant", content: "⚠︎ " + (j.error ?? "error"), at: new Date().toISOString() }]);
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-6rem)] max-w-3xl flex-col lg:h-[calc(100vh-3rem)]">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold text-oasis">{t.chat.title}</h1>
        <span className="font-mono text-xs text-ink/60" dir="ltr">{credits} {t.nav.credits}</span>
      </div>
      <div className="mt-4 flex-1 space-y-4 overflow-y-auto rounded-xl border border-ink/10 bg-white p-4">
        {msgs.length === 0 && (
          <div>
            <p className="text-ink/70">{t.chat.empty}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {t.chat.suggestions.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-oasis/30 px-3 py-1.5 text-sm text-oasis hover:bg-oasis hover:text-mist">{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "bg-oasis text-mist" : "bg-salt-dim text-ink"}`} dir="auto">
              {m.role === "assistant" && <span className="mb-1 block text-[11px] font-semibold text-sadu">{t.chat.title}</span>}
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.actions && m.actions.length > 0 && <p className="mt-1 font-mono text-[10px] text-ink/50" dir="ltr">{m.actions.join(" · ")}</p>}
            </div>
          </div>
        ))}
        {busy && <p className="text-sm text-ink/50">{t.chat.thinking}</p>}
        <div ref={end} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="mt-3 flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t.chat.placeholder} className="flex-1 rounded-full border border-ink/15 bg-white px-4 py-3 text-sm" />
        <button disabled={busy || !text.trim()} className="rounded-full bg-saffron px-5 py-3 text-sm font-semibold text-ink disabled:opacity-50">{t.chat.send}</button>
      </form>
    </div>
  );
}
