"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { ChatMsg, ChatItem } from "@/lib/chat";
import type { HandoffItemStatus, HandoffView } from "@/lib/handoffs";
import type { BrandProposal } from "@/lib/brand-proposals";
import { AGENTS, isAgentId, type AgentId } from "@/lib/agents";
import { limitFromError, raiseLimit } from "./LimitModal";
import { render } from "@/lib/md";
import { Icon, channelIcon } from "./Icons";
import { ActivationBar, FileCard, PlanCard, WhatsAppCard } from "./OnboardCards";
import type { Journey } from "@/lib/journey";
import JourneyCard from "./JourneyCard";

type Conv = { id: string; title: string; updatedAt: string; count: number; agent?: AgentId };
const LIMITS: Record<string, number> = { instagram: 2200, x: 280, snapchat: 250, tiktok: 2200, whatsapp: 1024, gbp: 1500, meta: 63206, linkedin: 3000 };

/**
 * A generated item inside the chat: channel header, rendered body, count vs limit, copy, approve with undo. Approving is
 * admin and owner only (`canApprove` = `can(u, "publish")` from the page); a member sees a note instead of the button.
 * An item another agent flagged in the cross-agent review (`item.xflag`) shows each reviewer's pill and, instead of
 * Approve, a link to the inbox, where the notes are: it is never approved from here unread.
 */
export function ItemCard({ item, t, lang, onApproved, canApprove = true }: { item: ChatItem; t: AppDict; lang: "ar" | "en"; onApproved?: (id: string) => void; canApprove?: boolean }) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState(item.status);
  const [err, setErr] = useState("");
  const [undoAt, setUndoAt] = useState(0);
  const [held, setHeld] = useState<string[]>([]);
  const limit = LIMITS[item.channel];
  const ar = lang === "ar";
  const chName = (t.channelNames as Record<string, string>)[item.channel] ?? item.channel;
  async function setState(next: "approved" | "pending") {
    setErr("");
    const r = await fetch(`/api/tasks/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: next }) });
    if (!r.ok) {
      // The brand rules hold this item on the server: say which word, and send the owner to the inbox to fix it.
      const j = (await r.json().catch(() => ({}))) as { error?: string; violations?: { term: string }[] };
      if (r.status === 409 && j.error === "brand_violation") { setHeld((j.violations ?? []).map((v) => v.term)); return; }
      setErr(r.status === 403 ? t.team.errors.forbidden : t.chat.approveFail);
      return;
    }
    setStatus(next);
    // The sidebar badge listens for this; only the inbox used to send it, so approving from a chat card left the badge
    // one too high until the owner navigated. That matters more now the badge is exhaustive and therefore trusted.
    window.dispatchEvent(new Event("nashr:pending-changed"));
    if (next === "approved") { setUndoAt(Date.now()); onApproved?.(item.id); setTimeout(() => setUndoAt((v) => (Date.now() - v >= 4000 ? 0 : v)), 4200); }
    else setUndoAt(0);
  }
  const over = !!limit && item.body.length > limit;
  const flags = (item.xflag ?? []).filter((f) => isAgentId(f.by));
  const flagged = flags.length > 0 && status !== "approved";
  return (
    <article className="mt-3 overflow-hidden rounded-xl border border-ink/10 bg-white text-ink">
      <header className="flex items-center justify-between gap-2 border-b border-ink/5 px-3 py-2 text-xs">
        <span className="flex min-w-0 items-center gap-2 font-semibold"><Icon name={channelIcon(item.channel)} className="h-4 w-4 text-oasis" />{chName}<span className="clip font-normal text-ink/60" dir="auto">· {item.title}</span></span>
        <span className="flex flex-wrap items-center justify-end gap-1.5">
          {flags.map((f) => <span key={f.by} className="whitespace-nowrap rounded-full bg-saffron/20 px-2 py-0.5 font-semibold text-sadu-deep">{f.n === 1 ? fill(t.inbox.xNote, { name: t.agents[f.by].name }) : fill(t.inbox.xNotes, { name: t.agents[f.by].name, n: f.n })}</span>)}
          <span className={`badge whitespace-nowrap ${status === "approved" ? "badge-primary" : "badge-accent"}`}>{status === "approved" ? t.inbox.approved : t.inbox.pending}</span>
        </span>
      </header>
      {open && <div className="prose-nashr prose-compact px-4 py-3 text-sm" dir="auto" dangerouslySetInnerHTML={{ __html: render(item.body) }} />}
      <footer className="flex flex-wrap items-center gap-2 border-t border-ink/5 px-3 py-2 text-xs">
        <span className={`tnum ${over ? "font-semibold text-sadu-deep" : "text-ink/60"}`} dir="ltr">{item.body.length}{limit ? ` / ${limit}` : ""}</span>
        {err && <span className="text-sadu-deep">{err}</span>}
        {held.length > 0 && <span role="alert" className="flex items-center gap-1 font-semibold text-sadu-deep"><Icon name="shield" className="h-3.5 w-3.5" /><span dir="auto">{ar ? `محجوز بحارس العلامة: ${held.join("، ")}` : `Held by brand guard: ${held.join(", ")}`}</span> · <Link href={`/${lang}/app`} className="underline">{ar ? "عدّله في صندوق الموافقة" : "Fix it in the inbox"}</Link></span>}
        {undoAt > 0 && status === "approved" && <span className="flex items-center gap-2 text-oasis"><Icon name="check" className="h-4 w-4" />{t.chat.approved} · <button onClick={() => setState("pending")} className="underline">{t.chat.undo}</button></span>}
        {flagged && <span className="font-semibold text-sadu-deep">{t.chat.xflagHint}</span>}
        <span className="ms-auto flex gap-1.5">
          <button onClick={() => setOpen(!open)} className="btn btn-secondary btn-xs">{open ? (ar ? "طيّ" : "Collapse") : (ar ? "عرض" : "Expand")}</button>
          <button onClick={async () => { await navigator.clipboard.writeText(item.body); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="btn btn-secondary btn-xs"><Icon name="copy" className="h-3.5 w-3.5" />{copied ? t.inbox.copied : status === "approved" ? `${t.chat.copyTo} ${chName}` : t.inbox.copy}</button>
          {status !== "approved" && !canApprove && <span className="text-ink/60">{t.inbox.waitAdmin}</span>}
          {flagged && canApprove && <Link href={`/${lang}/app`} className="btn btn-primary btn-xs">{t.chat.readNotes}</Link>}
          {status !== "approved" && canApprove && !flagged && <button onClick={() => setState("approved")} disabled={over || held.length > 0} title={over ? (ar ? "النص أطول من حد القناة" : "Text exceeds the channel limit") : undefined} className="btn btn-primary btn-xs"><Icon name="check" className="h-3.5 w-3.5" />{t.inbox.approve}</button>}
        </span>
      </footer>
    </article>
  );
}

/** A string from the dictionary with its {placeholders} filled. */
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
const RUNNABLE: ReadonlySet<HandoffItemStatus> = new Set(["proposed", "failed"]);
/** While an item runs, the card reads the stored state again this often, at most HANDOFF_POLLS times in a row. */
export const HANDOFF_POLL_MS = 10_000;
const HANDOFF_POLLS = 60;

/**
 * What the card makes of a Run request's answer. "lost": no answer from the route (the connection dropped, or a gateway
 * answered in its place without the route's JSON): the run may still be going on the server and may already be
 * charged, so the card reads the stored state and never says "try again". "refresh": another request holds the handoff
 * and the answer carries no state: the card reads it, so it shows the item that runs. "ran" or "refused" otherwise.
 */
export function runAnswer(res: { ok: boolean } | null, j: { ok?: boolean; handoff?: unknown; error?: string }): "ran" | "lost" | "refresh" | "refused" {
  if (!res || (!res.ok && !j.error)) return "lost";
  if (res.ok && j.ok) return "ran";
  if (j.error === "busy" && !j.handoff) return "refresh";
  return "refused";
}
/** Whether the card keeps reading the stored state: while an item runs or a Run's answer was lost, and nothing is in flight. */
export const keepReading = (s: { gone: boolean; inFlight: boolean; running: boolean; lost: boolean }) => !s.gone && !s.inFlight && (s.running || s.lost);

/**
 * One of Majed's handoffs under his reply: each item with the agent who will write it, its type, his brief (as text),
 * its cost and status, with Run and Decline, and the inbox items a run made as item cards. It takes the server's state
 * with the page (`initial`, or null when the record is gone) or reads it once on show, and takes the server's new state
 * after every action, so what it shows is what is stored. While an item runs (a run from another tab or login, Majed's
 * auto-run, or this card's own request whose answer was lost) it reads the stored state again every HANDOFF_POLL_MS
 * until nothing runs. "Run all" is one request per item, in order, stopping at the first refusal. The buttons follow the
 * login's role (`canRun` = `can(u, "generate")`, `canDecline` = `can(u, "drafts")`); the routes check the same actions.
 */
export function HandoffCard({ id, t, lang, initial, canRun = true, canDecline = true, canApprove = true, onCredits }: { id: string; t: AppDict; lang: "ar" | "en"; /** read on the server with the thread (chat page): the view, or null when the record is gone; without it the card reads it on show */ initial?: HandoffView | null; canRun?: boolean; canDecline?: boolean; canApprove?: boolean; onCredits?: (n: number) => void }) {
  const H = t.handoff;
  const [view, setView] = useState<HandoffView | null>(initial ?? null);
  const [gone, setGone] = useState(initial === null);
  // The item whose request is in flight, or "decline"; `all` while "Run all" works through the items one by one.
  const [busy, setBusy] = useState<number | "decline" | null>(null);
  const [all, setAll] = useState(false);
  const [err, setErr] = useState("");
  // A Run whose answer never arrived: the server may still be running it, and may have charged it. The card reads the
  // stored state until it knows, instead of offering Run again on what may be a stale "Proposed".
  const [lost, setLost] = useState(false);
  const errText = (code: unknown, status: number) => (status === 403 ? H.errors.forbidden : typeof code === "string" && Object.hasOwn(H.errors, code) ? H.errors[code as keyof typeof H.errors] : H.errors.failed);
  /** The stored state, read again. */
  const refresh = useCallback(async () => {
    const r = await fetch(`/api/handoffs/${id}`).catch(() => null);
    if (!r) return;
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; handoff?: HandoffView };
    if (r.ok && j.ok && j.handoff) {
      setView(j.handoff);
      if (!j.handoff.items.some((it) => it.status === "running")) setLost(false);
    } else if (r.status === 404) {
      setGone(true);
      setLost(false);
    }
  }, [id]);
  const running = !!view?.items.some((it) => it.status === "running");
  useEffect(() => {
    if (!keepReading({ gone, inFlight: busy !== null || all, running, lost })) return;
    let n = 0;
    const timer = setInterval(() => { if (++n > HANDOFF_POLLS) clearInterval(timer); else void refresh(); }, HANDOFF_POLL_MS);
    return () => clearInterval(timer);
  }, [gone, busy, all, running, lost, refresh]);
  useEffect(() => {
    // A card the server rendered already shows what is stored, or that it is gone; one proposed in this session reads it once.
    if (initial !== undefined) return;
    let live = true;
    fetch(`/api/handoffs/${id}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; handoff?: HandoffView; error?: string };
        if (!live) return;
        if (r.ok && j.ok && j.handoff) setView(j.handoff);
        else if (r.status === 404) setGone(true);
        else setErr(errText(j.error, r.status));
      })
      .catch(() => { if (live) setErr(H.errors.failed); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, initial]);

  /** One request for one item; true when it ran. The card takes the server's state, whatever the answer. */
  async function runOne(n: number): Promise<boolean> {
    setErr("");
    const r = await fetch(`/api/handoffs/${id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item: n }) }).catch(() => null);
    const j = r ? ((await r.json().catch(() => ({}))) as { ok?: boolean; handoff?: HandoffView; credits?: number; error?: string }) : {};
    const a = runAnswer(r, j);
    // The run may still be going on the server: never "try again" here; the card reads what is stored until it knows.
    if (a === "lost") { setErr(H.errors.network); setLost(true); void refresh(); return false; }
    if (j.handoff) setView(j.handoff);
    if (typeof j.credits === "number") onCredits?.(j.credits);
    if (a === "ran") { window.dispatchEvent(new Event("nashr:pending-changed")); return true; }
    if (a === "refresh") void refresh();
    // Credits, the trial or an agent's cap: the app's own limit dialog, as for any batch.
    if (!limitFromError(j.error)) setErr(errText(j.error, r?.status ?? 0));
    return false;
  }
  async function run(n: number) {
    if (busy !== null || all || lost) return;
    setBusy(n);
    try { await runOne(n); } finally { setBusy(null); }
  }
  async function runAll() {
    if (busy !== null || all || lost || !view) return;
    setAll(true);
    try {
      for (const [n, it] of view.items.entries()) {
        if (!RUNNABLE.has(it.status)) continue;
        setBusy(n);
        if (!(await runOne(n))) break;
      }
    } finally { setBusy(null); setAll(false); }
  }
  async function decline(n?: number) {
    if (busy !== null || all) return;
    setBusy("decline"); setErr("");
    try {
      const r = await fetch(`/api/handoffs/${id}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(n === undefined ? {} : { item: n }) }).catch(() => null);
      if (!r) { setErr(H.errors.failed); return; }
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; handoff?: HandoffView; error?: string };
      if (j.handoff) setView(j.handoff);
      if (!(r.ok && j.ok)) setErr(errText(j.error, r.status));
    } finally { setBusy(null); }
  }

  const open = view ? view.items.filter((it) => RUNNABLE.has(it.status)) : [];
  const total = open.reduce((sum, it) => sum + it.cost, 0);
  const badge = (s: HandoffItemStatus) => (s === "done" ? "badge-primary" : s === "declined" ? "badge-danger" : "badge-accent");
  return (
    <section className="mt-3 overflow-hidden rounded-xl border border-oasis/25 bg-white text-ink" aria-label={fill(H.title, { name: t.agents.majed.name })} aria-busy={busy !== null || all}>
      <header className="border-b border-ink/5 px-3 py-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-oasis"><Icon name="users" className="h-4 w-4" />{fill(H.title, { name: t.agents.majed.name })}</p>
        {/* "Nothing runs until you press Run" is untrue while Majed's auto-run may start an item: the server says which. */}
        <p className="mt-0.5 text-xs text-ink/60">{view?.auto?.length ? H.subAuto : H.sub}</p>
        {/* The label follows the page's language; Majed's line is isolated, so it takes its own direction from its own text. */}
        {view?.why && <p className="mt-1 text-xs text-ink/80"><span className="font-semibold">{H.why}:</span> <bdi dir="auto">{view.why}</bdi></p>}
      </header>
      {!view && !gone && !err && <p className="px-3 py-2 text-xs text-ink/60">{H.loading}</p>}
      {gone && <p className="px-3 py-2 text-xs text-ink/60">{H.gone}</p>}
      {view && (
        <ol className="divide-y divide-ink/5">
          {view.items.map((it, n) => {
            const can = RUNNABLE.has(it.status);
            return (
              <li key={n} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold">{fill(H.to, { agent: t.agents[it.agent].name, type: t.generate.types[it.type].t })}</span>
                  <span className="flex items-center gap-2">
                    {it.status === "proposed" && view.auto?.includes(n) && <span className="badge">{H.autoItem}</span>}
                    {it.ranAuto && <span className="text-ink/60">{H.ranAuto}</span>}
                    <span className="tnum text-ink/70">{fill(H.cost, { n: it.cost })}</span>
                    <span className={`badge ${badge(it.status)}`}>{busy === n ? H.status.running : H.status[it.status]}</span>
                  </span>
                </div>
                <p className="mt-1.5 text-xs font-semibold text-sadu-deep">{fill(H.brief, { name: t.agents.majed.name })}</p>
                {/* Model-written: rendered as text, never as HTML. */}
                <p className="mt-0.5 whitespace-pre-line break-words text-sm leading-relaxed text-ink/85" dir="auto">{it.brief}</p>
                {can && (canRun || canDecline) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {/* While a Run's answer is lost, the item may be running already: no second Run until the card knows. */}
                    {canRun && <button type="button" onClick={() => run(n)} disabled={busy !== null || all || lost} className="btn btn-primary btn-xs"><Icon name="spark" className="h-3.5 w-3.5" />{busy === n ? H.running : it.status === "failed" ? H.retry : H.run}</button>}
                    {canDecline && <button type="button" onClick={() => decline(n)} disabled={busy !== null || all} className="btn btn-secondary btn-xs">{H.decline}</button>}
                  </div>
                )}
                {it.made.length > 0 && <div className="mt-1">{it.made.map((m) => <ItemCard key={m.id} item={m} t={t} lang={lang} canApprove={canApprove} />)}</div>}
              </li>
            );
          })}
        </ol>
      )}
      {view && open.length > 0 && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-ink/5 px-3 py-2 text-xs">
          <span className="tnum text-ink/70">{fill(H.total, { n: total })}</span>
          <span className="ms-auto flex flex-wrap gap-1.5">
            {canRun && open.length > 1 && <button type="button" onClick={runAll} disabled={busy !== null || all || lost} className="btn btn-primary btn-xs">{all ? H.running : H.runAll}</button>}
            {canDecline && open.length > 1 && <button type="button" onClick={() => decline()} disabled={busy !== null || all} className="btn btn-secondary btn-xs">{H.declineAll}</button>}
          </span>
          {!canRun && !canDecline && <p className="w-full text-ink/60">{H.memberNote}</p>}
        </footer>
      )}
      {err && <p role="alert" className="border-t border-ink/5 px-3 py-2 text-xs font-semibold text-sadu-deep" dir="auto">{err}</p>}
    </section>
  );
}

/**
 * A brand change an agent proposed (src/lib/brand-proposals.ts): the offers, or banned words taken out. Nothing changed
 * yet; the owner sees the old and the new value and applies it with Save, or dismisses it.
 */
export function ProposalCard({ p, t, lang, canBrand = true }: { p: BrandProposal; t: AppDict; lang: "ar" | "en"; /** `can(u, "brand.write")`: a plain member sees the change but cannot decide it */ canBrand?: boolean }) {
  const ar = lang === "ar";
  // A reloaded thread carries where the proposal stands now (history() reads it), so a decided change stays decided.
  const [state, setState] = useState<"open" | "saving" | "applied" | "dismissed" | "gone" | "stale" | "forbidden" | "busy" | "error">(p.state === "applied" || p.state === "dismissed" || p.state === "stale" ? p.state : p.state === "expired" ? "gone" : "open");
  async function decide(action: "apply" | "dismiss") {
    setState("saving");
    const r = await fetch(`/api/brand/proposals/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => null);
    if (!r) return setState("error");
    if (r.ok) return setState(action === "apply" ? "applied" : "dismissed");
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    setState(r.status === 403 ? "forbidden" : r.status === 404 ? "gone" : j.error === "stale" ? "stale" : j.error === "busy" ? "busy" : "error");
  }
  const label = p.field === "offers" ? (ar ? "العروض الحالية" : "Current offers") : (ar ? "الكلمات الممنوعة" : "Banned words");
  const why = p.field === "offers"
    ? (ar ? "العروض تحدد الخصومات والهدايا والمواعيد التي يَعِد بها الوكلاء، فلا تتغير إلا بحفظك." : "The offers decide which discounts, gifts and deadlines the agents may promise, so they change only when you press Save.")
    : (ar ? `يُخرج من الكلمات الممنوعة: ${(p.dropped ?? []).join("، ")}. بعدها تمر هذه الكلمات في العناصر المعتمدة والمنشورة.` : `Takes out of the banned words: ${(p.dropped ?? []).join(", ")}. After that these words pass in approved and published items.`);
  const done: Partial<Record<typeof state, string>> = {
    applied: ar ? "حُفظ في ملف العلامة." : "Saved to the brand file.",
    dismissed: ar ? "تُجوهل. لم يتغير شيء." : "Dismissed. Nothing changed.",
    gone: ar ? "حُسم هذا التغيير من قبل أو انتهت مدته (7 أيام)." : "This change was already decided or has expired (7 days).",
    stale: ar ? "تغيّر هذا الحقل بعد الاقتراح، فلم يُحفظ شيء. عدّله من صفحة ملف العلامة." : "This field changed after the proposal, so nothing was saved. Change it on the Brand page.",
    forbidden: t.team.errors.forbidden,
    busy: ar ? "يُحسم هذا التغيير الآن في نافذة أخرى. انتظر لحظة ثم حدّث الصفحة." : "This change is being decided in another window. Wait a moment, then refresh.",
    error: ar ? "لم يُحفظ. حاول مرة أخرى." : "Not saved. Try again.",
  };
  const closed = state === "applied" || state === "dismissed" || state === "gone" || state === "stale";
  return (
    <article className="mt-3 overflow-hidden rounded-xl border border-saffron/40 bg-white text-ink">
      <header className="flex items-center gap-2 border-b border-ink/5 px-3 py-2 text-xs font-semibold">
        <Icon name="shield" className="h-4 w-4 text-sadu-deep" />{canBrand ? (ar ? "تغيير في ملف العلامة ينتظر حفظك" : "A brand change waiting for your Save") : (ar ? "تغيير في ملف العلامة ينتظر قرار المالك أو المشرف" : "A brand change waiting for the owner or an admin")}<span className="font-normal text-ink/60">· {label}</span>
      </header>
      <div className="grid gap-2 px-4 py-3 text-sm">
        {p.via === "mcp" && <p className="text-xs font-semibold text-sadu-deep">{ar ? "طلب هذا التغيير مساعد آخر متصل عبر MCP، لا هذه المحادثة. احفظه فقط إن كنت طلبته بنفسك." : "Another assistant connected over MCP asked for this change, not this chat. Save it only if you asked for it yourself."}</p>}
        <p className="text-ink/70">{why}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="min-w-0 rounded-lg bg-salt-dim p-2"><p className="text-xs text-ink/60">{ar ? "الآن" : "Now"}</p><p className="whitespace-pre-wrap break-words" dir="auto">{p.from || "—"}</p></div>
          <div className="min-w-0 rounded-lg bg-oasis/5 p-2"><p className="text-xs text-ink/60">{ar ? "بعد الحفظ" : "After Save"}</p><p className="whitespace-pre-wrap break-words" dir="auto">{p.to || "—"}</p></div>
        </div>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-ink/5 px-3 py-2 text-xs">
        {done[state] && <span role="status" className={state === "applied" || state === "dismissed" ? "text-oasis" : "text-sadu-deep"}>{done[state]}</span>}
        {!closed && !canBrand && <span className="ms-auto text-ink/60">{t.inbox.waitAdmin}</span>}
        {!closed && canBrand && (
          <span className="ms-auto flex gap-1.5">
            <button disabled={state === "saving"} onClick={() => decide("dismiss")} className="btn btn-secondary btn-xs">{ar ? "تجاهل" : "Dismiss"}</button>
            <button disabled={state === "saving"} onClick={() => decide("apply")} className="btn btn-primary btn-xs"><Icon name="check" className="h-3.5 w-3.5" />{ar ? "احفظ في ملف العلامة" : "Save to brand file"}</button>
          </span>
        )}
      </footer>
    </article>
  );
}

/** Owner-readable labels for tool actions; internal tags that mean nothing to the owner are dropped. */
function actionLabels(actions: string[] | undefined, lang: "ar" | "en"): string[] {
  const out = new Set<string>();
  for (const a of actions ?? []) {
    const [kind, , n] = a.split(":");
    if (kind === "brand") out.add(lang === "ar" ? "حُدّث ملف العلامة" : "Brand file updated");
    else if (kind === "brandprop") out.add(lang === "ar" ? "تغيير في ملف العلامة ينتظر حفظك" : "A brand change waits for your Save");
    else if (kind === "generated" || kind === "drafted") out.add(lang === "ar" ? `أُضيف ${n ?? ""} إلى صندوق الموافقات`.replace("  ", " ") : `${n ?? ""} added to approvals`.trim());
    else if (kind === "todo") out.add(lang === "ar" ? "حُدّثت قائمة مهامك" : "Your to-do list was updated");
  }
  return [...out];
}

export default function ChatPanel({ t, initial, credits: c0, lang, initialConv, initialPrompt = "", plan, firstStep, initialAgent, pending = [], pendingCount = 0, brief, onboardUrl, starter, needPhone = false, journey, canApprove = true, canBrand = true, canRun = true, canDecline = true, handoffs }: { t: AppDict; initial: ChatMsg[]; credits: number; lang: "ar" | "en"; initialConv?: string; initialPrompt?: string; plan?: string; firstStep?: string; initialAgent?: string; pending?: ChatItem[]; pendingCount?: number; brief?: string | null; /** first run: build the workspace from this URL inside the thread */ onboardUrl?: string; /** goal and first task from onboarding, shown to trial accounts */ starter?: { goal: string; first?: string } | null; needPhone?: boolean; /** launch path, shown at the top of the thread until it is complete */ journey?: Journey; /** `can(u, "publish")`: approve buttons on item cards */ canApprove?: boolean; /** `can(u, "brand.write")`: Save and Dismiss on brand-change cards */ canBrand?: boolean; /** `can(u, "generate")` and `can(u, "drafts")`: Run and Decline on Majed's handoff cards */ canRun?: boolean; canDecline?: boolean; /** the handoffs this thread names, read on the server (`handoffViews`): null for one whose record is gone */ handoffs?: Record<string, HandoffView | null> }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>(initial);
  const [text, setText] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [credits, setCredits] = useState(c0);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [conv, setConv] = useState(initialConv ?? "default");
  const [agent, setAgent] = useState<AgentId>((initialAgent as AgentId) ?? "noor");
  const [pickOpen, setPickOpen] = useState(false);
  const [voted, setVoted] = useState<Record<string, 1 | -1>>({});
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [steps, setSteps] = useState<string[]>([]);
  const [left, setLeft] = useState(pendingCount);
  const list = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const ranOnboard = useRef(false);
  const [goal, setGoal] = useState(starter ?? null);
  const [onboarded, setOnboarded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, busy, steps]);
  useEffect(() => { fetch("/api/conversations").then((r) => r.json()).then((j) => { if (j.ok) { setConvs(j.conversations); if (initialConv) setAgent((j.conversations as Conv[]).find((c) => c.id === initialConv)?.agent ?? "noor"); } }); }, [initialConv]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); input.current?.focus(); }
      if (e.key === "Escape") setPickOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // First run: Noor builds the workspace inside this thread (Enrich-style onboarding, no form).
  useEffect(() => {
    if (!onboardUrl || ranOnboard.current) return;
    ranOnboard.current = true;
    (async () => {
      setBusy(true); setSteps([]);
      const S = t.start;
      const fill = (text: string, n: number, have: number) => text.split("{n}").join(String(n)).split("{credits}").join(String(have));
      const fail = (code?: string, ev?: { refunded?: number; credits?: number }) => setMsgs((p) => [...p, { role: "assistant", agent: "noor", at: new Date().toISOString(), content: code === "charge" ? S.notCharged : code === "refunded" ? fill(S.refunded, ev?.refunded ?? 0, ev?.credits ?? 0) : code === "saved" ? S.partial : code === "daily" ? (lang === "ar" ? "وصلت إلى حد إعداد العلامات لهذا اليوم. هذه المحاولة لم تخصم شيئاً، والإعداد المدفوع مسبقاً يبقى محسوباً لك. حاول غداً." : "You reached today's brand setup limit. This try charged nothing, and a setup already paid for stays paid. Try again tomorrow.") : code === "busy" ? (lang === "ar" ? "التجهيز جارٍ في الخلفية. حدّث الصفحة بعد دقيقة." : "Setup is still running. Refresh in a minute.") : code === "paused" ? (lang === "ar" ? "تجهيز المساحة متوقف مؤقتاً، ولم يُحفظ شيء. حدّث الصفحة لاحقاً للمحاولة مرة أخرى." : "Workspace setup is paused for now and nothing was saved. Refresh later to try again.") : (lang === "ar" ? "⚠︎ تعذّر تجهيز المساحة. حدّث الصفحة للمحاولة مرة أخرى." : "⚠︎ Could not set up the workspace. Refresh to try again.") }]);
      try {
        const res = await fetch("/api/onboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: onboardUrl }) });
        if (res.status === 409) return fail("busy");
        if (res.status === 503) return fail("paused");
        // 402, before any stream: an added brand's setup the balance, the agent cap or the trial cannot cover (rule 246).
        // Nothing was charged; the paywall says why and the thread says nothing was used.
        if (res.status === 402) { const j = (await res.json().catch(() => ({}))) as { error?: string }; limitFromError(j.error); return fail("charge"); }
        // 429: the account's daily setup allowance, checked before any charge.
        if (res.status === 429) return fail("daily");
        if (!res.ok || !res.body) return fail();
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
            else if (ev.type === "message") { setMsgs((p) => [...p, ev.message]); if (ev.message.plan?.length) setGoal((g) => ({ goal: g?.goal ?? "", first: ev.message.plan[0].title })); }
            // The balance after an added brand's setup charge: the page keeps this component (and its state) across the
            // refresh below, so the header's pill would otherwise show the balance from before the charge.
            else if (ev.type === "done") { if (typeof ev.credits === "number") setCredits(ev.credits); setGoal((g) => ({ goal: ev.goal ?? "", first: g?.first })); setOnboarded(true); router.replace(`/${lang}/app/chat`); router.refresh(); }
            // A paid setup that failed before the brand file was saved was refunded: say so, with the balance, and that a
            // retry pays again. One that failed after it was saved kept the brand: say that instead of "could not set up".
            else if (ev.type === "error") { if (typeof ev.credits === "number") setCredits(ev.credits); fail(ev.refunded ? "refunded" : ev.saved ? "saved" : undefined, ev); }
          }
        }
      } catch { fail(); }
      finally { setBusy(false); setSteps([]); }
    })();
  }, [onboardUrl, lang, router, t.start]);

  async function newConv(withAgent: AgentId = agent) {
    const j = await (await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "…", agent: withAgent }) })).json();
    if (j.ok) { setConvs((p) => [j.conversation, ...p]); setConv(j.conversation.id); setAgent(withAgent); setMsgs([]); }
  }
  async function pick(id: AgentId) {
    setPickOpen(false);
    if (id === agent || busy) return;
    if (conv === "default") { if (id !== "noor") await newConv(id); return; }
    const cur = convs.find((c) => c.id === conv);
    if (cur && cur.count > 0) { await newConv(id); return; }
    setAgent(id);
    setConvs((p) => p.map((c) => (c.id === conv ? { ...c, agent: id } : c)));
  }
  async function send(msg: string) {
    const m = msg.trim();
    if (!m || busy) return;
    setText("");
    setMsgs((p) => [...p, { role: "user", content: m, at: new Date().toISOString() }]);
    setBusy(true); setSteps([]);
    const done = (j: { ok?: boolean; message?: ChatMsg; credits?: number; limit?: string | null; error?: string }) => {
      if (j.message) { setMsgs((p) => [...p, j.message!]); if (typeof j.credits === "number") setCredits(j.credits); if (conv !== "default") setConvs((p) => p.map((c) => (c.id === conv && c.title === "…" ? { ...c, title: m.slice(0, 60) } : c))); if (j.limit === "credits" || j.limit === "trial" || j.limit === "agent_cap") raiseLimit(j.limit); }
      else setMsgs((p) => [...p, { role: "assistant", content: `⚠︎ ${j.error === "network" ? (lang === "ar" ? "انقطع الاتصال. حاول مرة أخرى." : "Connection lost. Try again.") : (lang === "ar" ? "تعذّر الرد. حاول مرة أخرى." : "Could not reply. Try again.")}`, at: new Date().toISOString(), agent: "noor" }]);
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
    } catch {
      // The server keeps working and saves the reply even when the connection drops: look for it before giving up.
      setSteps((p) => [...p, lang === "ar" ? "انقطع الاتصال، أسترجع الرد…" : "Connection dropped, recovering the reply…"]);
      const sentAt = Date.now() - 5000;
      let found: ChatMsg | null = null;
      for (let n = 0; n < 40 && !found; n++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const j = await (await fetch(`/api/chat?conv=${encodeURIComponent(conv)}`)).json();
          const last = (j.messages as ChatMsg[] | undefined)?.at(-1);
          if (last && last.role === "assistant" && new Date(last.at).getTime() >= sentAt) found = last;
        } catch { /* still offline, keep trying */ }
      }
      if (found) done({ ok: true, message: found }); else done({ ok: false, error: "network" });
    }
    finally { setBusy(false); setSteps([]); }
  }
  async function vote(m: ChatMsg, value: 1 | -1) {
    if (voted[m.at]) return;
    if (value === -1 && reasonFor !== m.at) { setReasonFor(m.at); return; }
    setVoted((p) => ({ ...p, [m.at]: value }));
    await fetch("/api/chat/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: m.agent ?? agent, value, reason: value === -1 ? reason : undefined, at: m.at }) });
    setReasonFor(null); setReason("");
  }

  const A = t.agents;
  const title = conv === "default" ? t.nav.gettingStarted : convs.find((c) => c.id === conv)?.title ?? "…";
  const step = firstStep ? (t.limit.firstSteps as Record<string, string>)[firstStep] : undefined;
  const briefLines = (brief ?? "").split("\n").filter(Boolean).slice(1, 4);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-oasis font-display text-sm font-bold text-saffron" aria-hidden>{A[agent].name.charAt(0)}</span>
          <h1 className="clip font-display text-xl font-bold text-oasis">{A[agent].name} <span className="text-sm font-normal text-ink/60">· {title}</span></h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => newConv()} className="btn btn-secondary btn-xs"><Icon name="plus" className="h-3.5 w-3.5" />{t.chat.newConv}</button>
          <Link href={`/${lang}/app/billing`} className="tnum rounded-full bg-salt-dim px-3 py-1 text-xs text-ink/80">{credits} {t.nav.credits}</Link>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5" role="tablist" aria-label={t.agents.pick}>
        <button role="tab" aria-selected={agent === "noor"} aria-label={A.noor.name} onClick={() => pick("noor")} className={`rounded-full border px-3 py-1.5 text-sm transition ${agent === "noor" ? "border-oasis bg-oasis text-mist" : "border-ink/15 bg-white text-ink/70 hover:border-oasis"}`}><span className="font-semibold">{A.noor.name}</span> <span className="opacity-70">· {A.noor.role}</span></button>
        {agent !== "noor" && <button role="tab" aria-selected aria-label={A[agent].name} className="rounded-full border border-oasis bg-oasis px-3 py-1.5 text-sm text-mist"><span className="font-semibold">{A[agent].name}</span> <span className="opacity-70">· {A[agent].role}</span></button>}
        <span className="relative">
          <button onClick={() => setPickOpen(!pickOpen)} aria-expanded={pickOpen} aria-haspopup="listbox" className="rounded-full border border-dashed border-ink/25 px-3 py-1.5 text-sm text-ink/70 hover:border-oasis hover:text-oasis"><Icon name="plus" className="me-1 inline h-3.5 w-3.5" />{t.nav.askSpecialist}</button>
          {pickOpen && (
            <ul role="listbox" className="absolute start-0 top-full z-20 mt-1 w-72 rounded-xl border border-ink/10 bg-white p-1.5 shadow-lg">
              {AGENTS.filter((a) => a.id !== "noor").map((a) => (
                <li key={a.id} role="option" aria-selected={agent === a.id}>
                  <button onClick={() => pick(a.id)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-start text-sm hover:bg-salt-dim">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-oasis text-xs font-bold text-saffron">{A[a.id].name.charAt(0)}</span>
                    <span className="min-w-0"><span className="block font-semibold">{A[a.id].name} <span className="font-normal text-ink/60">· {A[a.id].role}</span></span><span className="clip block text-xs text-ink/60">{A[a.id].blurb}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </span>
      </div>

      <div ref={list} className="mt-2 min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-ink/10 bg-white p-4">
        {journey?.next && <JourneyCard journey={journey} lang={lang} compact />}
        {(left > 0 || briefLines.length > 0) && msgs.length <= 1 && (
          <section className="rounded-xl border border-oasis/20 bg-salt p-3" aria-label={t.chat.todayFromTeam}>
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-sm font-semibold text-oasis"><Icon name="sun" className="h-4 w-4 text-saffron" />{t.chat.todayFromTeam}</p>
              {left > 0 && <Link href={`/${lang}/app`} className="btn btn-primary btn-xs"><Icon name="inbox" className="h-3.5 w-3.5" />{t.chat.pending} <span className="tnum" dir="ltr">({left})</span> · {t.chat.reviewAll}</Link>}
            </div>
            {briefLines.length > 0 && <ul className="mt-2 text-sm text-ink/80">{briefLines.map((l, i) => <li key={i} dir="auto">{l}</li>)}</ul>}
            {pending[0] && <ItemCard item={pending[0]} t={t} lang={lang} canApprove={canApprove} onApproved={() => setLeft((n) => Math.max(0, n - 1))} />}
          </section>
        )}
        {msgs.length === 0 && !onboardUrl && (
          <div>
            <p className="text-ink/70">{agent === "noor" ? t.chat.empty : A[agent].blurb}</p>
            <div className="mt-4 flex flex-wrap gap-2">{A[agent].suggestions.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-oasis/30 px-3 py-1.5 text-sm text-oasis hover:bg-oasis hover:text-mist">{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`${m.items?.length || m.files?.length || m.plan?.length || m.handoff || m.proposals?.length ? "w-full max-w-[95%]" : "max-w-[85%]"} rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.role === "user" ? "bg-oasis text-mist" : "bg-salt-dim text-ink"}`} dir="auto">
              {m.role === "assistant" && <span className="mb-1 block text-xs font-semibold text-sadu-deep">{A[m.agent ?? agent].name}</span>}
              {m.role === "assistant" ? <div className="prose-nashr prose-compact" dangerouslySetInnerHTML={{ __html: render(m.content) }} /> : <p className="whitespace-pre-wrap">{m.content}</p>}
              {m.items && m.items.length > 0 && <div className="mt-1">{m.items.map((it) => <ItemCard key={it.id} item={it} t={t} lang={lang} canApprove={canApprove} />)}</div>}
              {m.files && m.files.length > 0 && <div className="mt-1">{m.files.map((f, n) => <FileCard key={f.name} file={f} lang={lang} defaultOpen={n === 0 && m.files!.length === 1} />)}</div>}
              {m.plan && m.plan.length > 0 && <PlanCard plan={m.plan} lang={lang} onStart={(prompt) => send(prompt)} />}
              {m.handoff && <HandoffCard id={m.handoff.id} t={t} lang={lang} initial={handoffs?.[m.handoff.id]} canRun={canRun} canDecline={canDecline} canApprove={canApprove} onCredits={setCredits} />}
              {m.proposals && m.proposals.length > 0 && <div className="mt-1">{m.proposals.map((p) => <ProposalCard key={p.id} p={p} t={t} lang={lang} canBrand={canBrand} />)}</div>}
              {actionLabels(m.actions, lang).length > 0 && <p className="tnum mt-1 text-xs text-ink/60" dir="auto">{actionLabels(m.actions, lang).join(" · ")}</p>}
              {m.role === "assistant" && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                  <button onClick={() => vote(m, 1)} aria-label={t.chat.helpful} title={t.chat.helpful} className={`rounded p-1 ${voted[m.at] === 1 ? "bg-oasis text-mist" : "text-ink/50 hover:text-oasis"}`}><Icon name="thumbUp" className="h-4 w-4" /></button>
                  <button onClick={() => vote(m, -1)} aria-label={t.chat.notHelpful} title={t.chat.notHelpful} className={`rounded p-1 ${voted[m.at] === -1 ? "bg-sadu-deep text-white" : "text-ink/50 hover:text-sadu-deep"}`}><Icon name="thumbDown" className="h-4 w-4" /></button>
                  {reasonFor === m.at && !voted[m.at] && (
                    <form onSubmit={(e) => { e.preventDefault(); vote(m, -1); }} className="flex flex-1 items-center gap-1">
                      <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t.chat.whyBad} className="input py-1 text-xs" />
                      <button className="btn btn-secondary btn-xs">{t.chat.send_}</button>
                    </form>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {needPhone && (onboarded || (msgs.some((m) => m.plan?.length) && !busy)) && <WhatsAppCard lang={lang} />}
        {busy && onboardUrl && (
          <OnboardProgress lang={lang} steps={steps} name={A.noor.name} />
        )}
        {busy && !onboardUrl && (
          <div className="text-sm text-ink/70">
            {steps.map((s, i) => <p key={i} className={`flex items-center gap-2 ${i < steps.length - 1 ? "opacity-70" : ""}`}><span className={`h-2 w-2 rounded-full ${i < steps.length - 1 ? "bg-oasis" : "animate-pulse bg-saffron"}`} />{A[agent].name}: {s}</p>)}
            {steps.length === 0 && <p>{agent === "noor" ? t.chat.thinking : `${A[agent].name}…`}</p>}
          </div>
        )}
      </div>

      {plan === "trial" && goal?.goal && <ActivationBar lang={lang} goal={goal.goal} first={goal.first} />}
      <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="mt-3 flex gap-2">
        <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder={t.chat.placeholder} aria-label={t.chat.placeholder} className="input rounded-full" />
        <button disabled={busy || !text.trim()} className="btn btn-accent btn-lg shrink-0" aria-label={t.chat.send}><Icon name="send" className="h-4 w-4" /><span className="hidden sm:inline">{t.chat.send}</span></button>
      </form>
      {step && plan === "trial" && !goal?.goal && <p className="mt-2 flex items-center gap-2 text-xs text-ink/70"><Icon name="spark" className="h-3.5 w-3.5 text-saffron" />{t.limit.firstUp}: {step}</p>}
    </div>
  );
}

/**
 * First run, while Noor builds the workspace: the stages the server reports, as a path that fills. The bar moves only
 * when a stage really lands (src/app/api/onboard/route.ts sends one status per stage) and never claims 100% before
 * the server says done.
 */
function OnboardProgress({ lang, steps, name }: { lang: "ar" | "en"; steps: string[]; name: string }) {
  const ar = lang === "ar";
  const EXPECTED = 5;
  const pct = Math.min(92, Math.round(((steps.length + 0.4) / EXPECTED) * 100));
  return (
    <section className="rounded-2xl border border-oasis/20 bg-salt p-4" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="journey-next grid h-11 w-11 shrink-0 place-items-center rounded-full bg-oasis font-display text-lg font-bold text-saffron" aria-hidden>{name.charAt(0)}</span>
        <div className="min-w-0 flex-1">
          <p className="font-display font-bold text-oasis">{ar ? `${name} تبني مساحة عملك` : `${name} is building your workspace`}</p>
          <p className="text-xs text-ink/60">{ar ? "تقرأ موقعك وتكتب ملف علامتك وخطة البداية. ابقَ هنا." : "Reading your site, writing your brand file and a starter plan. Stay on this page."}</p>
        </div>
      </div>
      <div className="journey-track mt-3"><div className="journey-fill" style={{ width: `${pct}%` }} /></div>
      <ol className="mt-3 grid gap-1.5 text-sm">
        {steps.map((st, i) => {
          const current = i === steps.length - 1;
          return (
            <li key={i} className="log-row flex items-center gap-2">
              <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${current ? "border-2 border-saffron bg-white" : "pop-in bg-oasis text-saffron"}`}>{current ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-saffron" /> : <Icon name="check" className="h-3 w-3" />}</span>
              <span className={current ? "font-semibold text-ink" : "text-ink/60"} dir="auto">{st}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-xs text-ink/70"><Icon name="seed" className="h-4 w-4 text-oasis" />{ar ? "أول إنجاز في مسار الانطلاق يُفتح حين تنتهي: مستواك الأول «بذرة»." : "Your first launch-path milestone unlocks when this finishes: level one, Seed."}</p>
    </section>
  );
}
