"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { ChatMsg, ChatItem } from "@/lib/chat";
import { AGENTS, type AgentId } from "@/lib/agents";
import { HireBlock, raiseLimit } from "./LimitModal";
import { render } from "@/lib/md";

type Conv = { id: string; title: string; updatedAt: string; count: number; agent?: AgentId };
type Hit = { conversationId: string; title: string; snippet: string; at: string };

const LIMITS: Record<string, number> = { instagram: 2200, x: 280, snapchat: 250, tiktok: 2200, whatsapp: 1024, gbp: 1500, meta: 63206, linkedin: 3000 };
const ICONS: Record<string, string> = { instagram: "📸", x: "𝕏", snapchat: "👻", tiktok: "🎵", whatsapp: "💬", gbp: "📍", meta: "📘", linkedin: "💼", email: "✉️", call: "📞", blog: "📝" };

/** A generated item rendered inside the chat, Enrich-style: channel header, body, character count, copy, approve. */
function ItemCard({ item, t, lang }: { item: ChatItem; t: AppDict; lang: "ar" | "en" }) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState(item.status);
  const limit = LIMITS[item.channel];
  const ar = lang === "ar";
  async function approve() {
    const r = await fetch(`/api/tasks/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved" }) });
    if (r.ok) setStatus("approved");
  }
  return (
    <article className="mt-3 overflow-hidden rounded-xl border border-ink/10 bg-white text-ink">
      <header className="flex items-center justify-between border-b border-ink/5 px-3 py-2 text-xs">
        <span className="flex items-center gap-2 font-semibold"><span aria-hidden>{ICONS[item.channel] ?? "•"}</span>{item.channel}<span className="font-normal text-ink/50" dir="auto">· {item.title}</span></span>
        <span className={`badge ${status === "approved" ? "badge-primary" : "badge-accent"}`}>{status === "approved" ? t.inbox.approved : t.inbox.pending}</span>
      </header>
      {open && <div className="prose-nashr prose-compact px-4 py-3 text-sm" dir="auto" dangerouslySetInnerHTML={{ __html: render(item.body) }} />}
      <footer className="flex flex-wrap items-center gap-2 border-t border-ink/5 px-3 py-2 text-xs">
        <span className={`font-mono ${limit && item.body.length > limit ? "text-sadu" : "text-ink/50"}`} dir="ltr">{item.body.length}{limit ? ` / ${limit}` : ""}</span>
        <span className="ms-auto flex gap-1.5">
          <button onClick={() => setOpen(!open)} className="btn btn-secondary btn-xs">{open ? (ar ? "طيّ" : "Collapse") : (ar ? "عرض" : "Expand")}</button>
          <button onClick={async () => { await navigator.clipboard.writeText(item.body); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="btn btn-secondary btn-xs">{copied ? t.inbox.copied : t.inbox.copy}</button>
          {status !== "approved" && <button onClick={approve} className="btn btn-primary btn-xs">{t.inbox.approve}</button>}
        </span>
      </footer>
    </article>
  );
}

export default function ChatPanel({ t, initial, credits: c0, lang, initialConv, initialPrompt = "", plan, firstStep, wide, initialAgent }: { t: AppDict; initial: ChatMsg[]; credits: number; lang: "ar" | "en"; initialConv?: string; initialPrompt?: string; plan?: string; firstStep?: string; wide?: boolean; initialAgent?: string }) {
  const ar = lang === "ar";
  const [msgs, setMsgs] = useState<ChatMsg[]>(initial);
  const [text, setText] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [credits, setCredits] = useState(c0);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [conv, setConv] = useState(initialConv ?? "default");
  const [agent, setAgent] = useState<AgentId>((initialAgent as AgentId) ?? "noor");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [showList, setShowList] = useState(false);
  const [voted, setVoted] = useState<Record<string, 1 | -1>>({});
  const [steps, setSteps] = useState<string[]>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);
  useEffect(() => { fetch("/api/conversations").then((r) => r.json()).then((j) => { if (j.ok) { setConvs(j.conversations); if (initialConv) setAgent((j.conversations as Conv[]).find((c) => c.id === initialConv)?.agent ?? "noor"); } }); }, [initialConv]);

  async function open(id: string) {
    setConv(id); setHits(null); setShowList(false);
    setAgent(id === "default" ? "noor" : convs.find((c) => c.id === id)?.agent ?? "noor");
    const j = await (await fetch(`/api/chat?conv=${id}`)).json();
    if (j.ok) setMsgs(j.messages);
  }
  async function newConv(withAgent: AgentId = agent) {
    const j = await (await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "…", agent: withAgent }) })).json();
    if (j.ok) { setConvs((p) => [j.conversation, ...p]); setConv(j.conversation.id); setAgent(withAgent); setMsgs([]); setShowList(false); }
  }
  /** Switching agent: the default thread belongs to Noor; another agent gets its own conversation. */
  async function pick(id: AgentId) {
    if (id === agent) return;
    if (conv === "default") { if (id !== "noor") await newConv(id); return; }
    const cur = convs.find((c) => c.id === conv);
    if (cur && cur.count > 0) { await newConv(id); return; }
    setAgent(id);
    setConvs((p) => p.map((c) => (c.id === conv ? { ...c, agent: id } : c)));
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
    setBusy(true); setSteps([]);
    const done = (j: { ok?: boolean; message?: ChatMsg; credits?: number; limit?: string | null; error?: string }) => {
      if (j.message) { setMsgs((p) => [...p, j.message!]); if (typeof j.credits === "number") setCredits(j.credits); if (conv !== "default") setConvs((p) => p.map((c) => (c.id === conv && c.title === "…" ? { ...c, title: m.slice(0, 60) } : c))); if (j.limit === "credits" || j.limit === "trial") raiseLimit(j.limit); }
      else setMsgs((p) => [...p, { role: "assistant", content: "⚠︎ " + (j.error ?? "error"), at: new Date().toISOString() }]);
    };
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", "x-lang": lang }, body: JSON.stringify({ text: m, conv, agent, stream: true }) });
      if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) { done(await res.json()); return; }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
          if (!line.startsWith("data:")) continue;
          const ev = JSON.parse(line.slice(5));
          if (ev.type === "status") setSteps((p) => [...p, ev.text]);
          else if (ev.type === "message") done({ ok: true, ...ev });
          else if (ev.type === "error") done({ ok: false, error: ev.error });
        }
      }
    } catch { done({ ok: false, error: "network" }); }
    finally { setBusy(false); setSteps([]); }
  }
  async function vote(m: ChatMsg, value: 1 | -1) {
    if (voted[m.at]) return;
    setVoted((p) => ({ ...p, [m.at]: value }));
    let reason: string | undefined;
    if (value === -1) reason = window.prompt(t.chat.whyBad) ?? undefined;
    await fetch("/api/chat/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: m.agent ?? agent, value, reason, at: m.at }) });
  }
  const title = conv === "default" ? (ar ? "البداية" : "Getting started") : convs.find((c) => c.id === conv)?.title ?? "…";

  const list = (
    <aside className="flex h-full flex-col rounded-xl border border-ink/10 bg-white p-3">
      <button onClick={() => newConv()} className="rounded-lg bg-saffron px-3 py-2 text-sm font-semibold text-ink">+ {ar ? "محادثة جديدة" : "New conversation"}</button>
      <input value={q} onChange={(e) => search(e.target.value)} placeholder={ar ? "ابحث في المحادثات…" : "Search conversations…"} className="mt-2 rounded-lg border border-ink/15 px-3 py-2 text-sm" />
      <div className="mt-2 flex-1 overflow-y-auto">
        {hits ? (
          hits.length === 0 ? <p className="p-2 text-xs text-ink/50">{ar ? "لا نتائج" : "No results"}</p> : hits.map((h, i) => <button key={i} onClick={() => open(h.conversationId)} className="block w-full rounded-lg px-2 py-2 text-start text-xs hover:bg-salt-dim"><span className="font-medium">{h.title}</span><span className="mt-0.5 block text-ink/60" dir="auto">…{h.snippet}…</span></button>)
        ) : (
          <>
            <button onClick={() => open("default")} className={`block w-full rounded-lg px-2 py-2 text-start text-sm ${conv === "default" ? "bg-oasis text-mist" : "hover:bg-salt-dim"}`}>{ar ? "البداية" : "Getting started"}</button>
            {convs.map((c) => (
              <div key={c.id} className={`group flex items-center rounded-lg ${conv === c.id ? "bg-oasis text-mist" : "hover:bg-salt-dim"}`}>
                <button onClick={() => open(c.id)} className="min-w-0 flex-1 truncate px-2 py-2 text-start text-sm" dir="auto"><span className="me-1 text-[10px] opacity-70">{t.agents[c.agent ?? "noor"].name}</span>{c.title}</button>
                <button onClick={() => del(c.id)} className="px-2 text-xs opacity-0 group-hover:opacity-100" aria-label="delete">✕</button>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );

  return (
    <div className={`mx-auto grid h-[calc(100vh-6rem)] gap-4 lg:h-[calc(100vh-3rem)] lg:grid-cols-[240px_1fr] ${wide ? "" : "max-w-5xl"}`}>
      <div className="hidden lg:block">{list}</div>
      {showList && <div className="fixed inset-0 z-40 bg-black/40 p-4 lg:hidden" onClick={() => setShowList(false)}><div className="h-full max-w-xs" onClick={(e) => e.stopPropagation()}>{list}</div></div>}
      <div className="flex min-h-0 flex-col">
        <div className="mb-2 flex gap-1 border-b border-ink/10 text-sm">
          <span className="border-b-2 border-oasis px-4 py-2 font-semibold text-oasis">{t.inbox.tabChat}</span>
          <Link href={`/${lang}/app`} className="px-4 py-2 text-ink/60 hover:text-oasis">{t.inbox.tabFeed} <span className="badge badge-accent ms-1">NEW</span></Link>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button onClick={() => setShowList(true)} className="rounded-md border border-ink/15 px-2 py-1 text-xs lg:hidden">☰</button>
            <h1 className="font-display text-xl font-bold text-oasis">{t.agents[agent].name} <span className="text-sm font-normal text-ink/50">· {title}</span></h1>
          </div>
          <span className="font-mono text-xs text-ink/60" dir="ltr">{credits} {t.nav.credits}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5" role="tablist" aria-label={t.agents.pick}>
          {AGENTS.map((a) => (
            <button key={a.id} role="tab" aria-selected={agent === a.id} onClick={() => pick(a.id)} title={t.agents[a.id].blurb} className={`rounded-full border px-3 py-1 text-xs transition ${agent === a.id ? "border-oasis bg-oasis text-mist" : "border-ink/15 bg-white text-ink/70 hover:border-oasis"}`}>
              <span className="font-semibold">{t.agents[a.id].name}</span> <span className="opacity-70">· {t.agents[a.id].role}</span>
            </button>
          ))}
        </div>
        <div className="mt-2 flex-1 space-y-4 overflow-y-auto card card-sm">
          {msgs.length === 0 && (
            <div>
              <p className="text-ink/70">{agent === "noor" ? t.chat.empty : t.agents[agent].blurb}</p>
              <div className="mt-4 flex flex-wrap gap-2">{t.agents[agent].suggestions.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-oasis/30 px-3 py-1.5 text-sm text-oasis hover:bg-oasis hover:text-mist">{s}</button>)}</div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`${m.items?.length ? "w-full max-w-[95%]" : "max-w-[85%]"} rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "bg-oasis text-mist" : "bg-salt-dim text-ink"}`} dir="auto">
                {m.role === "assistant" && <span className="mb-1 block text-[11px] font-semibold text-sadu">{t.agents[m.agent ?? agent].name}</span>}
                {m.role === "assistant" ? <div className="prose-nashr prose-compact" dangerouslySetInnerHTML={{ __html: render(m.content) }} /> : <p className="whitespace-pre-wrap">{m.content}</p>}
                {m.items && m.items.length > 0 && <div className="mt-1">{m.items.map((it) => <ItemCard key={it.id} item={it} t={t} lang={lang} />)}</div>}
                {m.actions && m.actions.length > 0 && <p className="mt-1 font-mono text-[10px] text-ink/50" dir="ltr">{m.actions.join(" · ")}</p>}
                {m.role === "assistant" && (
                  <span className="mt-1 flex gap-1 text-[11px]">
                    <button onClick={() => vote(m, 1)} aria-label={t.chat.helpful} title={t.chat.helpful} className={`rounded px-1 ${voted[m.at] === 1 ? "bg-oasis text-mist" : "text-ink/40 hover:text-oasis"}`}>👍</button>
                    <button onClick={() => vote(m, -1)} aria-label={t.chat.notHelpful} title={t.chat.notHelpful} className={`rounded px-1 ${voted[m.at] === -1 ? "bg-sadu text-white" : "text-ink/40 hover:text-sadu"}`}>👎</button>
                  </span>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="text-sm text-ink/50">
              {steps.map((s, i) => <p key={i} className={`flex items-center gap-2 ${i < steps.length - 1 ? "opacity-60" : ""}`}><span className={`h-1.5 w-1.5 rounded-full ${i < steps.length - 1 ? "bg-oasis" : "animate-pulse bg-saffron"}`} />{s}</p>)}
              {steps.length === 0 && <p>{agent === "noor" ? t.chat.thinking : `${t.agents[agent].name}…`}</p>}
            </div>
          )}
          <div ref={end} />
        </div>
        <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="mt-3 flex gap-2">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t.chat.placeholder} className="flex-1 input rounded-full" />
          <button disabled={busy || !text.trim()} className="rounded-full bg-saffron px-5 py-3 text-sm font-semibold text-ink disabled:opacity-50">{t.chat.send}</button>
        </form>
        {plan === "trial" && <HireBlock t={t} lang={lang} firstStep={firstStep} />}
      </div>
    </div>
  );
}
