"use client";
import { useEffect, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { ChatMsg } from "@/lib/chat";

type Conv = { id: string; title: string; updatedAt: string; count: number };
type Hit = { conversationId: string; title: string; snippet: string; at: string };

export default function ChatPanel({ t, initial, credits: c0, lang }: { t: AppDict; initial: ChatMsg[]; credits: number; lang: "ar" | "en" }) {
  const ar = lang === "ar";
  const [msgs, setMsgs] = useState<ChatMsg[]>(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [credits, setCredits] = useState(c0);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [conv, setConv] = useState("default");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [showList, setShowList] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);
  useEffect(() => { fetch("/api/conversations").then((r) => r.json()).then((j) => j.ok && setConvs(j.conversations)); }, []);

  async function open(id: string) {
    setConv(id); setHits(null); setShowList(false);
    const j = await (await fetch(`/api/chat?conv=${id}`)).json();
    if (j.ok) setMsgs(j.messages);
  }
  async function newConv() {
    const j = await (await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "…" }) })).json();
    if (j.ok) { setConvs((p) => [j.conversation, ...p]); setConv(j.conversation.id); setMsgs([]); setShowList(false); }
  }
  async function search(v: string) {
    setQ(v);
    if (!v.trim()) return setHits(null);
    const j = await (await fetch(`/api/conversations?q=${encodeURIComponent(v)}`)).json();
    if (j.ok) setHits(j.hits);
  }
  async function del(id: string) {
    await fetch(`/api/conversations?id=${id}`, { method: "DELETE" });
    setConvs((p) => p.filter((c) => c.id !== id));
    if (conv === id) open("default");
  }
  async function send(msg: string) {
    const m = msg.trim();
    if (!m || busy) return;
    setText("");
    setMsgs((p) => [...p, { role: "user", content: m, at: new Date().toISOString() }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: m, conv }) });
      const j = await res.json();
      if (j.ok) { setMsgs((p) => [...p, j.message]); setCredits(j.credits); if (conv !== "default") setConvs((p) => p.map((c) => (c.id === conv && c.title === "…" ? { ...c, title: m.slice(0, 60) } : c))); }
      else setMsgs((p) => [...p, { role: "assistant", content: "⚠︎ " + (j.error ?? "error"), at: new Date().toISOString() }]);
    } finally { setBusy(false); }
  }
  const title = conv === "default" ? (ar ? "البداية" : "Getting started") : convs.find((c) => c.id === conv)?.title ?? "…";

  const list = (
    <aside className="flex h-full flex-col rounded-xl border border-ink/10 bg-white p-3">
      <button onClick={newConv} className="rounded-lg bg-saffron px-3 py-2 text-sm font-semibold text-ink">+ {ar ? "محادثة جديدة" : "New conversation"}</button>
      <input value={q} onChange={(e) => search(e.target.value)} placeholder={ar ? "ابحث في المحادثات…" : "Search conversations…"} className="mt-2 rounded-lg border border-ink/15 px-3 py-2 text-sm" />
      <div className="mt-2 flex-1 overflow-y-auto">
        {hits ? (
          hits.length === 0 ? <p className="p-2 text-xs text-ink/50">{ar ? "لا نتائج" : "No results"}</p> : hits.map((h, i) => <button key={i} onClick={() => open(h.conversationId)} className="block w-full rounded-lg px-2 py-2 text-start text-xs hover:bg-salt-dim"><span className="font-medium">{h.title}</span><span className="mt-0.5 block text-ink/60" dir="auto">…{h.snippet}…</span></button>)
        ) : (
          <>
            <button onClick={() => open("default")} className={`block w-full rounded-lg px-2 py-2 text-start text-sm ${conv === "default" ? "bg-oasis text-mist" : "hover:bg-salt-dim"}`}>{ar ? "البداية" : "Getting started"}</button>
            {convs.map((c) => (
              <div key={c.id} className={`group flex items-center rounded-lg ${conv === c.id ? "bg-oasis text-mist" : "hover:bg-salt-dim"}`}>
                <button onClick={() => open(c.id)} className="min-w-0 flex-1 truncate px-2 py-2 text-start text-sm" dir="auto">{c.title}</button>
                <button onClick={() => del(c.id)} className="px-2 text-xs opacity-0 group-hover:opacity-100" aria-label="delete">✕</button>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );

  return (
    <div className="mx-auto grid h-[calc(100vh-6rem)] max-w-5xl gap-4 lg:h-[calc(100vh-3rem)] lg:grid-cols-[240px_1fr]">
      <div className="hidden lg:block">{list}</div>
      {showList && <div className="fixed inset-0 z-40 bg-black/40 p-4 lg:hidden" onClick={() => setShowList(false)}><div className="h-full max-w-xs" onClick={(e) => e.stopPropagation()}>{list}</div></div>}
      <div className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button onClick={() => setShowList(true)} className="rounded-md border border-ink/15 px-2 py-1 text-xs lg:hidden">☰</button>
            <h1 className="font-display text-xl font-bold text-oasis">{t.chat.title} <span className="text-sm font-normal text-ink/50">· {title}</span></h1>
          </div>
          <span className="font-mono text-xs text-ink/60" dir="ltr">{credits} {t.nav.credits}</span>
        </div>
        <div className="mt-3 flex-1 space-y-4 overflow-y-auto rounded-xl border border-ink/10 bg-white p-4">
          {msgs.length === 0 && (
            <div>
              <p className="text-ink/70">{t.chat.empty}</p>
              <div className="mt-4 flex flex-wrap gap-2">{t.chat.suggestions.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-oasis/30 px-3 py-1.5 text-sm text-oasis hover:bg-oasis hover:text-mist">{s}</button>)}</div>
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
    </div>
  );
}
