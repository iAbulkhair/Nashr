"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Inspo } from "@/lib/inspo";
import type { Lang } from "@/lib/i18n";
import { Icon, channelIcon } from "./Icons";
import type { ChatStatus } from "@/lib/chat-allowance";
import { limitFromError, raiseLimit } from "./LimitModal";
import Scribble from "@/components/Scribble";

export default function InspoPanel({ t, lang, items }: { t: AppDict; lang: Lang; items: Inspo[] }) {
  const r = useRouter();
  const p = t.inspo;
  const [channel, setChannel] = useState("all");
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  /** A chat refusal (the hourly or daily ceiling, rule 331): the server's own text, shown here instead of an empty chat. */
  const [refusal, setRefusal] = useState("");
  const channels = ["all", ...new Set(items.map((i) => i.channel))];
  const kinds = ["all", ...new Set(items.map((i) => i.kind))];
  const needle = q.trim().toLowerCase();
  const shown = items.filter((i) => (channel === "all" || i.channel === channel) && (kind === "all" || i.kind === kind) && (!needle || [i.title, i.brand, i.why, i.sample, i.industry].join(" ").toLowerCase().includes(needle)));
  async function use(i: Inspo) {
    setBusy(i.id);
    const text = lang === "ar"
      ? `استخدمي هذا المرجع في المحتوى القادم: «${i.title}» — ${i.why} مثال: "${i.sample}". كيّفيه لعلامتنا وأخبريني ماذا تقترحين.`
      : `Use this as a reference for the next content: "${i.title}" — ${i.why} Sample: "${i.sample}". Adapt it to our brand and tell me what you suggest.`;
    setRefusal("");
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", "x-lang": lang }, body: JSON.stringify({ text }) }).catch(() => null);
    // A refused turn writes nothing to the chat (rules 330-331): an ended trial raises the subscription dialog, so do the
    // month's used-up chat messages (402 chat_allowance / chat_credits, rules 308-310), a ceiling shows the server's
    // message here, and the owner stays on this page with the reference still in front of them.
    if (res && (res.status === 402 || res.status === 429)) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; message?: { content?: string }; chat?: ChatStatus };
      setBusy("");
      if (j.error === "chat_allowance" || j.error === "chat_credits") raiseLimit(j.error === "chat_allowance" ? "chat" : "chat_credits", { period: j.chat?.period, hold: j.chat?.overflow.hold, allowance: j.chat?.allowance });
      else if (!limitFromError(j.error) && typeof j.message?.content === "string") setRefusal(j.message.content);
      return;
    }
    r.push(`/${lang}/app/chat`);
  }
  const Pill = ({ v, cur, set, label }: { v: string; cur: string; set: (s: string) => void; label: string }) => (
    <button onClick={() => set(v)} className={`rounded-full px-3 py-1 text-xs ${cur === v ? "bg-ink text-lilac" : "bg-lilac"}`}>{label}</button>
  );
  return (
    <div>
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="inspopanel-t1" />{p.title}</span></h1>
      <p className="mt-2 text-ink/70">{p.sub}</p>
      {refusal && <p role="alert" className="mt-4 rounded bg-lilac p-3 text-sm" dir="auto">{refusal}</p>}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={p.search} className="input mt-4 max-w-md" />
      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">{p.channel}:</span>
        {channels.map((c) => <Pill key={c} v={c} cur={channel} set={setChannel} label={c === "all" ? p.all : c} />)}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">{p.kind}:</span>
        {kinds.map((k) => <Pill key={k} v={k} cur={kind} set={setKind} label={k === "all" ? p.all : (p.kinds as Record<string, string>)[k] ?? k} />)}
      </div>
      {shown.length === 0 && <p className="mt-6 text-sm text-muted">{p.none}</p>}
      <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {shown.map((i) => (
          <article key={i.id} className="flex flex-col overflow-hidden card card-sm">
            <div className="-mx-4 -mt-4 mb-3 flex h-20 items-center justify-center bg-ink text-lemon" aria-hidden><Icon name={channelIcon(i.channel)} className="h-9 w-9" /></div>
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded bg-ink/10 px-2 py-0.5 text-ink">{i.channel}</span>
              <span className="rounded bg-lilac px-2 py-0.5">{(p.kinds as Record<string, string>)[i.kind]}</span>
              <span className="text-muted">{i.industry}</span>
            </div>
            <h2 className="mt-2 font-display font-medium">{i.title}</h2>
            <p className="mt-1 text-xs text-muted">{i.brand}</p>
            <p className="mt-3 text-sm text-ink/80"><span className="font-semibold">{p.why}:</span> {i.why}</p>
            <p className="mt-2 rounded bg-lilac p-2 text-sm" dir="auto"><span className="text-xs text-muted">{p.sample}: </span>{i.sample}</p>
            <button disabled={busy === i.id} onClick={() => use(i)} className="mt-auto pt-4 text-start text-sm font-semibold text-ink disabled:opacity-50">{busy === i.id ? "…" : p.use + " →"}</button>
          </article>
        ))}
      </div>
    </div>
  );
}
