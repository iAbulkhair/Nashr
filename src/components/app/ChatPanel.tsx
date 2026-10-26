"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { ChatMsg, ChatItem } from "@/lib/chat";
import type { HandoffItemStatus, HandoffView } from "@/lib/handoffs";
import type { BrandProposal } from "@/lib/brand-proposals";
import type { AwayProposal } from "@/lib/secretary-away";
import type { InstructionProposalCard as InstructionProposalCardData } from "@/lib/instruction-proposals";
import type { FileProposalCard as FileProposalCardData } from "@/lib/file-proposals";
import type { SpendProposalCard as SpendProposalCardData } from "@/lib/spend-proposals";
import { MemoryProposalCard } from "./MemoryProposalCard";
import { GoalPlanCard } from "./GoalPlanCard";
import { ResearchCard } from "./ResearchCard";
import { TeamCard } from "./TeamCard";
import { endOfZoneDay, formatWhen } from "@/lib/secretary-agenda";
// Type only: chat-allowance.ts reads the store. The numbers arrive from the server in each answer's `chat`.
import type { ChatStatus } from "@/lib/chat-allowance";
import { formatCount } from "@/lib/pricing";
import { AGENTS, isAgentId, type AgentId } from "@/lib/agents";
import { limitFromError, raiseLimit } from "./LimitModal";
import { render } from "@/lib/md";
import { modelErrorCause, modelErrorText } from "@/lib/provider-errors";
import { Icon } from "./Icons";
import ApprovalCard from "./ApprovalCard";
import CopyButton from "@/components/ui/CopyButton";
import Menu from "@/components/ui/Menu";
import { useAppLink, announceCredits } from "./WorkspaceContext";
import { ActivationBar, FileCard, PlanCard, WhatsAppCard } from "./OnboardCards";
import ChatBubble from "./ChatBubble";
import type { Journey } from "@/lib/journey";
import JourneyCard from "./JourneyCard";
import AgentAvatar from "@/components/app/AgentAvatar";
import { ChatModelPicker } from "./ModelPicker";
import RunTimeline from "./RunTimeline";
import WorkPanel from "./WorkPanel";
import type { WorkStep } from "@/lib/work-view";
import { nextMadePicks, storedPick, type MadePicks } from "@/lib/model-picker";

/** A conversation as GET /api/conversations lists it. `model`: its chat pick (absent: automatic), shown by the header's picker. */
type Conv = { id: string; title: string; updatedAt: string; count: number; agent?: AgentId; model?: string };
/** The chat's approval card (src/components/app/ApprovalCard.tsx), under the name its callers and tests import. */
export const ItemCard = ApprovalCard;

/**
 * Whether Enter in the message box sends (rule 1125). Shift+Enter is a new line; so is Enter while an input method is
 * composing (Arabic or Japanese keyboards confirm a word with Enter: `isComposing`, or keyCode 229 in older Safari), and
 * on a touch screen, where Enter is the keyboard's new-line key and the Send button sends. Pure, for the tests.
 */
export function enterSends(e: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }, coarse: boolean): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !coarse;
}

/** The tallest the message box grows before it scrolls inside, in pixels (about eight lines). */
export const COMPOSER_MAX_PX = 160;

// A touch screen (no hover, a coarse pointer): read through useSyncExternalStore, so the server renders the mouse words
// and the browser switches without an effect.
const COARSE = "(pointer: coarse)";
const onPointerChange = (cb: () => void) => { const mq = window.matchMedia(COARSE); mq.addEventListener("change", cb); return () => mq.removeEventListener("change", cb); };
const isCoarse = () => window.matchMedia(COARSE).matches;
const notCoarse = () => false;

/** A string from the dictionary with its {placeholders} filled. */
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

/**
 * The line under the message box (rule 315): messages left of the account's allowance this month (or in the trial), from
 * the server's ChatStatus. `low` (10% or less left, used up, or continuing on credits) shows it in the warning colour.
 * Used up with "continue on credits" on, `credits` (the balance now) below `overflow.hold` means chat is paused: a message
 * on credits needs at least that much in the balance. An allowance of 0 (the founder turned chat off for the account)
 * promises no renewal date.
 */
export function chatLine(t: AppDict, s: ChatStatus, credits?: number): { text: string; low: boolean } {
  const C = t.chat;
  const v = { left: formatCount(s.left), allowance: formatCount(s.allowance), hold: formatCount(s.overflow.hold) };
  if (s.left > 0) return { text: fill(s.period === "trial" ? C.chatLeftTrial : C.chatLeft, v), low: s.left <= s.allowance * 0.1 };
  // Off for the account (the founder's 0): no message goes through, not even on credits (src/lib/chat-allowance.ts).
  if (s.allowance <= 0) return { text: C.chatOff, low: true };
  if (s.overflow.on && s.overflow.available) {
    const short = typeof credits === "number" && Number.isFinite(credits) && credits < s.overflow.hold;
    return { text: fill(short ? C.chatPausedCredits : C.chatOnCredits, v), low: true };
  }
  return { text: fill(s.period === "trial" ? C.chatOutTrial : C.chatOut, v), low: true };
}

/**
 * A message POST /api/chat refused before saving anything: 402 `chat_allowance` (paused) or `chat_credits` (continuing on
 * credits, the balance below `overflow.hold`, the least a message on credits needs), 402 `fair_use` (the fair-use stop,
 * rule 1727), 429 `slow_down` (the hourly or daily
 * burst limit). Null for anything else, which keeps the old path (an error bubble, or the recovery when no answer came).
 */
export function refusalOf(status: number, error: unknown): "chat" | "chat_credits" | "fair_use" | "slow_down" | null {
  if (status === 402 && error === "chat_allowance") return "chat";
  if (status === 402 && error === "fair_use") return "fair_use";
  if (status === 402 && error === "chat_credits") return "chat_credits";
  if (status === 429 && error === "slow_down") return "slow_down";
  return null;
}
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
    <section className="mt-3 overflow-hidden rounded-xl border border-foreground/25 bg-surface text-foreground" aria-label={fill(H.title, { name: t.agents.majed.name })} aria-busy={busy !== null || all}>
      <header className="border-b border-foreground/5 px-3 py-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground"><Icon name="users" className="h-4 w-4" />{fill(H.title, { name: t.agents.majed.name })}</p>
        {/* "Nothing runs until you press Run" is untrue while Majed's auto-run may start an item: the server says which. */}
        <p className="mt-0.5 text-xs text-foreground-muted">{view?.auto?.length ? H.subAuto : H.sub}</p>
        {/* The label follows the page's language; Majed's line is isolated, so it takes its own direction from its own text. */}
        {view?.why && <p className="mt-1 text-xs text-foreground-muted"><span className="font-semibold">{H.why}:</span> <bdi dir="auto">{view.why}</bdi></p>}
      </header>
      {!view && !gone && !err && <p className="px-3 py-2 text-xs text-foreground-muted">{H.loading}</p>}
      {gone && <p className="px-3 py-2 text-xs text-foreground-muted">{H.gone}</p>}
      {view && (
        <ol className="divide-y divide-foreground/5">
          {view.items.map((it, n) => {
            const can = RUNNABLE.has(it.status);
            return (
              <li key={n} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold">{fill(H.to, { agent: t.agents[it.agent].name, type: t.generate.types[it.type].t })}</span>
                  <span className="flex items-center gap-2">
                    {it.status === "proposed" && view.auto?.includes(n) && <span className="badge">{H.autoItem}</span>}
                    {it.ranAuto && <span className="text-foreground-muted">{H.ranAuto}</span>}
                    <span className="tnum text-foreground-muted">{fill(H.cost, { n: it.cost })}</span>
                    <span className={`badge ${badge(it.status)}`}>{busy === n ? H.status.running : H.status[it.status]}</span>
                  </span>
                </div>
                <p className="mt-1.5 text-xs font-semibold text-foreground-muted">{fill(H.brief, { name: t.agents.majed.name })}</p>
                {/* Model-written: rendered as text, never as HTML. */}
                <p className="mt-0.5 whitespace-pre-line break-words text-sm leading-relaxed text-foreground" dir="auto">{it.brief}</p>
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
        <footer className="flex flex-wrap items-center gap-2 border-t border-foreground/5 px-3 py-2 text-xs">
          <span className="tnum text-foreground-muted">{fill(H.total, { n: total })}</span>
          <span className="ms-auto flex flex-wrap gap-1.5">
            {canRun && open.length > 1 && <button type="button" onClick={runAll} disabled={busy !== null || all || lost} className="btn btn-primary btn-xs">{all ? H.running : H.runAll}</button>}
            {canDecline && open.length > 1 && <button type="button" onClick={() => decline()} disabled={busy !== null || all} className="btn btn-secondary btn-xs">{H.declineAll}</button>}
          </span>
          {!canRun && !canDecline && <p className="w-full text-foreground-muted">{H.memberNote}</p>}
        </footer>
      )}
      {err && <p role="alert" className="border-t border-foreground/5 px-3 py-2 text-xs font-semibold text-danger" dir="auto">{err}</p>}
    </section>
  );
}

/**
 * A brand change an agent proposed (src/lib/brand-proposals.ts): any field of the brand file a chat tool may change.
 * Nothing changed yet; the owner sees the old and the new value and applies it with Save, or dismisses it.
 */
export function ProposalCard({ p, t, lang, canBrand = true }: { p: BrandProposal; t: AppDict; lang: "ar" | "en"; /** `can(u, "brand.write")`: a plain member sees the change but cannot decide it */ canBrand?: boolean }) {
  const ar = lang === "ar";
  // A reloaded thread carries where the proposal stands now (history() reads it), so a decided change stays decided.
  const [state, setState] = useState<"open" | "saving" | "applied" | "dismissed" | "gone" | "stale" | "forbidden" | "busy" | "too_long" | "error">(p.state === "applied" || p.state === "dismissed" || p.state === "stale" ? p.state : p.state === "expired" ? "gone" : "open");
  async function decide(action: "apply" | "dismiss") {
    setState("saving");
    const r = await fetch(`/api/brand/proposals/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => null);
    if (!r) return setState("error");
    if (r.ok) return setState(action === "apply" ? "applied" : "dismissed");
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    setState(r.status === 403 ? "forbidden" : r.status === 404 ? "gone" : j.error === "stale" ? "stale" : j.error === "busy" ? "busy" : j.error === "too_long" ? "too_long" : "error");
  }
  const labels: Record<BrandProposal["field"], [string, string]> = {
    offers: ["العروض الحالية", "Current offers"], banned: ["الكلمات الممنوعة", "Banned words"], tone: ["نبرة الصوت", "Tone of voice"],
    products: ["المنتجات والخدمات", "Products and services"], audience: ["الجمهور", "Audience"], competitors: ["المنافسون", "Competitors"],
    preferred: ["الكلمات المفضلة", "Preferred words"], dialect: ["اللهجة", "Dialect"], city: ["المدينة / السوق", "City / market"], name: ["اسم النشاط", "Business name"],
  };
  const label = (labels[p.field] ?? [p.field, p.field])[ar ? 0 : 1];
  const why = p.field === "offers"
    ? (ar ? "العروض تحدد الخصومات والهدايا والمواعيد التي يَعِد بها الوكلاء، فلا تتغير إلا بحفظك." : "The offers decide which discounts, gifts and deadlines the agents may promise, so they change only when you press Save.")
    : p.field === "banned" && p.dropped?.length
      ? (ar ? `يُخرج من الكلمات الممنوعة: ${p.dropped.join("، ")}. بعدها تمر هذه الكلمات في العناصر المعتمدة والمنشورة.` : `Takes out of the banned words: ${p.dropped.join(", ")}. After that these words pass in approved and published items.`)
      : p.field === "banned" && p.added?.length
        ? (ar ? `يُضيف إلى الكلمات الممنوعة: ${p.added.join("، ")}. بعدها يُوقَف كل عنصر يستخدمها.` : `Adds to the banned words: ${p.added.join(", ")}. After that every item that uses them is held.`)
        : (ar ? "كل وكيل يقرأ ملف العلامة فيما يكتبه، فلا يتغير أي حقل فيه من المحادثة إلا بحفظك." : "Every agent reads the brand file in everything it writes, so no field changes from a chat until you press Save.");
  const done: Partial<Record<typeof state, string>> = {
    applied: ar ? "حُفظ في ملف العلامة." : "Saved to the brand file.",
    dismissed: ar ? "تُجوهل. لم يتغير شيء." : "Dismissed. Nothing changed.",
    gone: ar ? "حُسم هذا التغيير من قبل أو انتهت مدته (7 أيام)." : "This change was already decided or has expired (7 days).",
    stale: ar ? "تغيّر هذا الحقل بعد الاقتراح، فلم يُحفظ شيء. عدّله من صفحة ملف العلامة." : "This field changed after the proposal, so nothing was saved. Change it on the Brand page.",
    forbidden: t.team.errors.forbidden,
    busy: ar ? "يُحسم هذا التغيير الآن في نافذة أخرى. انتظر لحظة ثم حدّث الصفحة." : "This change is being decided in another window. Wait a moment, then refresh.",
    too_long: ar ? "لم يُحفظ: قائمة الكلمات الممنوعة ستتجاوز 400 حرف. اختصرها من صفحة ملف العلامة." : "Not saved: the banned list would pass 400 characters. Shorten it on the Brand page.",
    error: ar ? "لم يُحفظ. حاول مرة أخرى." : "Not saved. Try again.",
  };
  const closed = state === "applied" || state === "dismissed" || state === "gone" || state === "stale";
  return (
    <article className="mt-3 overflow-hidden rounded-xl border border-border-input bg-surface text-foreground">
      <header className="flex items-center gap-2 border-b border-foreground/5 px-3 py-2 text-xs font-semibold">
        <Icon name="shield" className="h-4 w-4 text-foreground" />{canBrand ? (ar ? "تغيير في ملف العلامة ينتظر حفظك" : "A brand change waiting for your Save") : (ar ? "تغيير في ملف العلامة ينتظر قرار المالك أو المشرف" : "A brand change waiting for the owner or an admin")}<span className="font-normal text-foreground-muted">· {label}</span>
      </header>
      <div className="grid gap-2 px-4 py-3 text-sm">
        {p.via === "mcp" && <p className="text-xs font-semibold text-danger">{ar ? "طلب هذا التغيير مساعد آخر متصل عبر MCP، لا هذه المحادثة. احفظه فقط إن كنت طلبته بنفسك." : "Another assistant connected over MCP asked for this change, not this chat. Save it only if you asked for it yourself."}</p>}
        <p className="text-foreground-muted">{why}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="min-w-0 rounded-lg bg-background-muted p-2"><p className="text-xs text-foreground-muted">{ar ? "الآن" : "Now"}</p><p className="whitespace-pre-wrap break-words" dir="auto">{p.from || "—"}</p></div>
          <div className="min-w-0 rounded-lg bg-foreground/5 p-2"><p className="text-xs text-foreground-muted">{ar ? "بعد الحفظ" : "After Save"}</p><p className="whitespace-pre-wrap break-words" dir="auto">{p.to || "—"}</p></div>
        </div>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-foreground/5 px-3 py-2 text-xs">
        {done[state] && <span role="status" className={state === "applied" || state === "dismissed" ? "text-foreground" : "text-danger"}>{done[state]}</span>}
        {!closed && !canBrand && <span className="ms-auto text-foreground-muted">{t.inbox.waitAdmin}</span>}
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

/**
 * A rewrite of a core file an agent asked for in chat (`write_file`, src/lib/file-proposals.ts, rule 2306): nothing is
 * written yet. The card shows the file, the new length and the opening of the new text as plain text (a React text node,
 * never markup); Apply writes it as the owner's click (POST /api/files/proposals/{id}, `files.core.write`, the same
 * admin level as `brand.write`, so the page's `canBrand` decides who sees the buttons), Dismiss drops it.
 */
export function FileProposalCard({ p, t, lang, canWrite = true }: { p: FileProposalCardData; t: AppDict; lang: "ar" | "en"; canWrite?: boolean }) {
  const href = useAppLink(lang);
  const ar = lang === "ar";
  const [state, setState] = useState<"open" | "saving" | "applied" | "dismissed" | "stale" | "gone" | "forbidden" | "busy" | "slow" | "error">(p.state === "applied" || p.state === "dismissed" || p.state === "stale" ? p.state : p.state === "expired" ? "gone" : "open");
  async function decide(decision: "apply" | "dismiss") {
    setState("saving");
    const r = await fetch(`/api/files/proposals/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }).catch(() => null);
    if (!r) return setState("error");
    if (r.ok) return setState(decision === "apply" ? "applied" : "dismissed");
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    setState(r.status === 403 ? "forbidden" : r.status === 404 || r.status === 410 ? "gone" : r.status === 429 ? "slow" : j.error === "stale" ? "stale" : j.error === "claim_busy" ? "busy" : "error");
  }
  const words: Partial<Record<typeof state, string>> = {
    applied: ar ? "حُفظ النص الجديد في الملف." : "The new text is saved in the file.",
    dismissed: ar ? "تجاهلته. الملف كما هو." : "Dismissed. The file is unchanged.",
    stale: ar ? "تغيّر الملف بعد هذا الاقتراح، فلم يُكتب شيء. اطلب من الوكيل إعادة الكتابة إن أردت." : "The file changed after this proposal, so nothing was written. Ask the agent again if you still want it.",
    gone: ar ? "انتهت صلاحية هذا الاقتراح أو حُسم من قبل." : "This proposal has expired or was already decided.",
    forbidden: t.team.errors.forbidden,
    busy: ar ? "يُحفظ هذا الاقتراح الآن. حاول بعد لحظة." : "This proposal is being saved right now. Try again in a moment.",
    slow: t.handoff.errors.slow_down,
    error: ar ? "تعذّر ذلك. حاول مرة أخرى." : "That did not work. Try again.",
  };
  const closed = state === "applied" || state === "dismissed" || state === "stale" || state === "gone";
  const more = p.chars > p.preview.length;
  return (
    <article className="mt-3 overflow-hidden rounded-xl border border-lemon/40 bg-surface text-foreground">
      <header className="flex items-center gap-2 border-b border-foreground/5 px-3 py-2 text-xs font-semibold">
        <Icon name="shield" className="h-4 w-4 text-foreground" />{canWrite ? (ar ? "تعديل ملف أساسي ينتظر موافقتك" : "A core file rewrite waiting for your Apply") : (ar ? "تعديل ملف أساسي ينتظر قرار المالك أو المشرف" : "A core file rewrite waiting for the owner or an admin")}<span className="font-normal text-foreground-muted" dir="ltr">· {p.name}</span>
      </header>
      <div className="grid gap-2 px-4 py-3 text-sm">
        <p className="min-w-0 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-foreground/5 p-2" dir="auto">{p.preview}{more ? "…" : ""}</p>
        <p className="text-xs text-foreground-muted">{ar ? `يحل النص الجديد (${p.chars} حرفًا) محل محتوى الملف كله، وكل الوكلاء يقرؤونه.` : `The new text (${p.chars} characters) replaces the whole file, which every agent reads.`}</p>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-foreground/5 px-3 py-2 text-xs">
        {words[state] && <span role="status" className={state === "applied" || state === "dismissed" ? "text-foreground" : "text-danger"}>{words[state]}</span>}
        {state === "applied" && <Link href={href("/files")} className="underline">{ar ? "افتح الملفات" : "Open Files"}</Link>}
        {!closed && !canWrite && <span className="ms-auto text-foreground-muted">{t.inbox.waitAdmin}</span>}
        {!closed && canWrite && (
          <span className="ms-auto flex gap-1.5">
            <button disabled={state === "saving"} onClick={() => decide("dismiss")} className="btn btn-secondary btn-xs">{ar ? "تجاهل" : "Dismiss"}</button>
            <button disabled={state === "saving"} onClick={() => decide("apply")} className="btn btn-primary btn-xs"><Icon name="check" className="h-3.5 w-3.5" />{ar ? "اكتب في الملف" : "Write to the file"}</button>
          </span>
        )}
      </footer>
    </article>
  );
}

/**
 * A standing rule an agent proposed in chat (`propose_instruction`, src/lib/instruction-proposals.ts): nothing is in the
 * agent instructions yet. The rule is the model's text, so it is shown as plain text (a React text node, never markup);
 * Apply applies it as the owner's click (POST /api/instructions/proposals/{id}, `instructions.write`), Dismiss drops it.
 */
export function InstructionProposalCard({ p, t, lang, canWrite = true }: { p: InstructionProposalCardData; t: AppDict; lang: "ar" | "en"; /** `can(u, "instructions.write")`: a plain member sees the rule but cannot decide it */ canWrite?: boolean }) {
  const href = useAppLink(lang);
  const C = t.instructionCard;
  // A reloaded thread carries where the proposal stands now (history() reads it), so a decided card stays decided.
  const [state, setState] = useState<"open" | "saving" | "applied" | "dismissed" | "gone" | "forbidden" | "busy" | "lockBusy" | "slow" | "full" | "many" | "plan" | "refused" | "error">(p.state === "applied" || p.state === "dismissed" ? p.state : p.state === "expired" ? "gone" : "open");
  async function decide(decision: "apply" | "dismiss") {
    setState("saving");
    const r = await fetch(`/api/instructions/proposals/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }).catch(() => null);
    if (!r) return setState("error");
    if (r.ok) return setState(decision === "apply" ? "applied" : "dismissed");
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    // 409 carries the reason: another answer running (claim_busy) or the workspace lock taken (busy), a full list or plan (own messages), else a text today's rules refuse.
    setState(r.status === 403 ? "forbidden" : r.status === 404 || r.status === 410 ? "gone" : r.status === 429 ? "slow" : j.error === "claim_busy" ? "busy" : j.error === "busy" ? "lockBusy" : j.error === "instructions_limit" ? "full" : j.error === "too_many" ? "many" : j.error === "per_agent_plan" ? "plan" : r.status === 409 ? "refused" : "error");
  }
  const who = p.agents === "all" ? C.forAll : C.forAgents.replace("{names}", p.agents.map((a) => t.agents[a].name).join(lang === "ar" ? "، " : ", "));
  const done: Partial<Record<typeof state, string>> = { applied: C.applied, dismissed: C.dismissed, gone: C.gone, forbidden: t.team.errors.forbidden, busy: C.busy, lockBusy: C.lockBusy, many: C.many, slow: C.slow, full: C.full, plan: C.plan, refused: C.refused, error: C.error };
  const closed = state === "applied" || state === "dismissed" || state === "gone";
  return (
    <article className="mt-3 overflow-hidden rounded-xl border border-lemon/40 bg-surface text-foreground">
      <header className="flex items-center gap-2 border-b border-foreground/5 px-3 py-2 text-xs font-semibold">
        <Icon name="shield" className="h-4 w-4 text-danger" />{canWrite ? C.title : C.titleMember}<span className="font-normal text-foreground-muted">· {who}</span>
      </header>
      <div className="grid gap-2 px-4 py-3 text-sm">
        <p className="min-w-0 whitespace-pre-wrap break-words rounded-lg bg-foreground/5 p-2" dir="auto">{p.text}</p>
        <p className="text-xs text-foreground-muted">{C.why}</p>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-foreground/5 px-3 py-2 text-xs">
        {done[state] && <span role="status" className={state === "applied" || state === "dismissed" ? "text-foreground" : "text-danger"}>{done[state]}</span>}
        {state === "applied" && <Link href={href("/instructions")} className="underline">{C.review}</Link>}
        {!closed && !canWrite && <span className="ms-auto text-foreground-muted">{t.inbox.waitAdmin}</span>}
        {!closed && canWrite && (
          <span className="ms-auto flex gap-1.5">
            <button disabled={state === "saving"} onClick={() => decide("dismiss")} className="btn btn-secondary btn-xs">{C.dismiss}</button>
            <button disabled={state === "saving"} onClick={() => decide("apply")} className="btn btn-primary btn-xs"><Icon name="check" className="h-3.5 w-3.5" />{C.apply}</button>
          </span>
        )}
      </footer>
    </article>
  );
}

/**
 * An absence Reem proposed in chat (`contact_away`, src/lib/secretary-away.ts): nothing is on the away list yet. The
 * card shows the name as typed, the contact it matches on the open items, the last away day (or that the absence ends
 * now) and how many open items that contact owes; Save puts it on the list through the list's own checks, Dismiss drops
 * it (POST /api/secretary/away/proposals/{id}, `todo.write`: every member of the account).
 */
/**
 * Why a Save or Dismiss on an away card was refused, in the reader's words, when the card stays open to try again or
 * dismiss: another Save of the card is running (`busy`), too many changes this hour, the name has left the away list,
 * or a check the away list runs now (a last day that has passed, a full list). Undefined: no words for it.
 */
export function awayCardRefusal(t: AppDict, lang: "ar" | "en", status: number, error: string | undefined): string | undefined {
  const ar = lang === "ar";
  if (status === 429) return t.handoff.errors.slow_down;
  if (error === "busy") return ar ? "يحفظ أحدٌ هذه البطاقة الآن. حاول مرة أخرى بعد لحظة." : "Someone is saving this card right now. Try again in a moment.";
  if (error === "nothing_to_change") return ar ? "لم يعد هذا الاسم في قائمة الغائبين، فلا غياب لإنهائه." : "This name is no longer on the away list, so there is no absence to end.";
  return error ? t.todo.errors[error] : undefined;
}

export function AwayProposalCard({ p, t, lang }: { p: AwayProposal; t: AppDict; lang: "ar" | "en" }) {
  const ar = lang === "ar";
  // A reloaded thread carries where the proposal stands now (history() reads it), so a decided card stays decided.
  const [state, setState] = useState<"open" | "saving" | "saved" | "dismissed" | "gone" | "decided" | "forbidden" | "refused" | "error">(p.state === "saved" || p.state === "dismissed" ? p.state : p.state === "expired" ? "gone" : "open");
  const [why, setWhy] = useState("");
  async function decide(action: "save" | "dismiss") {
    setState("saving");
    const r = await fetch(`/api/secretary/away/proposals/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => null);
    if (!r) return setState("error");
    if (r.ok) return setState(action === "save" ? "saved" : "dismissed");
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    if (r.status === 403) return setState("forbidden");
    if (r.status === 404) return setState("gone");
    if (j.error === "already_decided") return setState("decided");
    const words = awayCardRefusal(t, lang, r.status, j.error);
    if (words) { setWhy(words); return setState("refused"); }
    setState("error");
  }
  // A local day "YYYY-MM-DD" as the to-do page writes dates (Latin digits), the same day in any Gulf zone; the year is
  // shown when it is not the year the card was proposed in. Formatted in the browser too, where ICU may word it
  // differently from the server's (src/lib/dates.ts): the element holding it carries `suppressHydrationWarning`.
  const day = (d: string) => formatWhen(new Date(endOfZoneDay(d)).toISOString(), true, lang, Date.parse(p.at));
  const ending = p.until === null;
  const done: Partial<Record<typeof state, string>> = {
    saved: ending ? (ar ? "حُفظ: انتهى الغياب، وتعود المتابعة كالمعتاد." : "Saved: the absence has ended and chasing resumes as usual.") : (ar ? "حُفظ في قائمة الغائبين بصفحة مهامي." : "Saved to the away list on My to-dos."),
    dismissed: ar ? "تُجوهل. لم يتغير شيء." : "Dismissed. Nothing changed.",
    gone: ar ? "حُسمت هذه البطاقة من قبل أو انتهت مدتها (7 أيام)." : "This card was already decided or has expired (7 days).",
    decided: ar ? "حُفظت هذه البطاقة أو تُجوهلت من قبل." : "This card was already saved or dismissed.",
    forbidden: t.team.errors.forbidden,
    refused: why,
    error: ar ? "لم يُحفظ. حاول مرة أخرى." : "Not saved. Try again.",
  };
  const closed = state === "saved" || state === "dismissed" || state === "gone" || state === "decided";
  const items = ar ? `المهام المفتوحة على هذا الاسم: ${p.openItems}` : `${p.openItems} open item${p.openItems === 1 ? "" : "s"} they owe`;
  return (
    <article className="mt-3 overflow-hidden rounded-xl border border-border-input bg-surface text-foreground">
      <header className="flex items-center gap-2 border-b border-foreground/5 px-3 py-2 text-xs font-semibold">
        <Icon name="calendar" className="h-4 w-4 text-foreground" />
        {ending ? (ar ? "إنهاء غياب ينتظر حفظك" : "Ending an absence, waiting for your Save") : (ar ? "غياب جهة اتصال ينتظر حفظك" : "A contact away, waiting for your Save")}
      </header>
      <dl className="grid gap-1.5 px-4 py-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-3">
        <dt className="text-xs text-foreground-muted">{ar ? "الاسم كما كُتب" : "Name as written"}</dt>
        <dd className="min-w-0 break-words" dir="auto">{p.label}</dd>
        <dt className="text-xs text-foreground-muted">{ar ? "يطابق" : "Matches"}</dt>
        <dd className="min-w-0 break-words" dir="auto">{p.contact ? <><span>{p.contact}</span><span className="text-foreground-muted"> · {items}</span></> : <span className="text-danger">{ar ? "لا مهمة مفتوحة على هذا الاسم: تأكد من كتابته." : "No open item is owed by this name: check the spelling."}</span>}</dd>
        <dt className="text-xs text-foreground-muted">{ending ? (ar ? "الغياب" : "Absence") : (ar ? "غياب حتى" : "Away until")}</dt>
        <dd className="min-w-0" dir="auto" suppressHydrationWarning>{ending ? (ar ? "ينتهي الآن، وتعود المتابعة كالمعتاد" : "Ends now; chasing resumes as usual") : <>{day(p.until as string)} <span className="text-foreground-muted">{ar ? "(آخر يوم غياب)" : "(last day away)"}</span></>}</dd>
      </dl>
      <footer className="flex flex-wrap items-center gap-2 border-t border-foreground/5 px-3 py-2 text-xs">
        {done[state] && <span role="status" className={state === "saved" || state === "dismissed" ? "text-foreground" : "text-danger"}>{done[state]}</span>}
        {!closed && (
          <span className="ms-auto flex gap-1.5">
            <button disabled={state === "saving"} onClick={() => decide("dismiss")} className="btn btn-secondary btn-xs">{ar ? "تجاهل" : "Dismiss"}</button>
            <button disabled={state === "saving"} onClick={() => decide("save")} className="btn btn-primary btn-xs"><Icon name="check" className="h-3.5 w-3.5" />{ar ? "احفظ" : "Save"}</button>
          </span>
        )}
      </footer>
    </article>
  );
}

/**
 * Paid work the owner's message did not ask for in words (rule 1511, src/lib/spend-proposals.ts): nothing ran and nothing
 * was charged. The card shows what would run and its estimated price; Run is the owner's approval (POST
 * /api/chat/spend/{id}, rule 1512), Dismiss drops it. The brief is the model's text, so it is shown as plain text (a React
 * text node, never markup). A refusal (credits, the trial, an agent's cap) raises the app's own limit dialog and leaves the
 * card open.
 */
export function SpendProposalCard({ p, t, lang, canRun = true, onCredits }: { p: SpendProposalCardData; t: AppDict; lang: "ar" | "en"; /** `can(u, "generate")` */ canRun?: boolean; onCredits?: (n: number) => void }) {
  const href = useAppLink(lang);
  const ar = lang === "ar";
  const [state, setState] = useState<"open" | "running" | "ran" | "dismissed" | "gone" | "busy" | "slow" | "forbidden" | "paused" | "failed" | "revoked" | "error">(p.state === "ran" || p.state === "dismissed" ? p.state : p.state === "expired" ? "gone" : "open");
  const [made, setMade] = useState<number | null>(null);
  async function decide(decision: "run" | "dismiss") {
    setState("running");
    const r = await fetch(`/api/chat/spend/${p.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }).catch(() => null);
    if (!r) return setState("error");
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; credits?: number; items?: unknown[] };
    if (typeof j.credits === "number") onCredits?.(j.credits);
    if (r.ok) {
      if (decision === "dismiss") return setState("dismissed");
      if (Array.isArray(j.items)) setMade(j.items.length);
      window.dispatchEvent(new Event("nashr:pending-changed"));
      return setState("ran");
    }
    if (r.status === 403) return setState("forbidden");
    if (r.status === 404 || r.status === 410) return setState("gone");
    if (r.status === 429) return setState("slow");
    if (j.error === "claim_busy") return setState("busy");
    // The owner switched this off for the agent in Governance since the card was made (rule 2434): nothing ran.
    if (j.error === "revoked") return setState("revoked");
    if (j.error === "model_paused" || j.error === "too_late") return setState("paused");
    // Credits, the trial or an agent's cap: the app's own limit dialog, as for any batch. The card stays open.
    if (limitFromError(j.error)) return setState("open");
    setState(r.status === 502 || j.error === "generation_failed" ? "failed" : "error");
  }
  const type = t.generate.types[p.type]?.t ?? p.type;
  const what = p.kind === "image" ? (ar ? `صورة للعنصر «${p.title ?? ""}»` : `An image for "${p.title ?? ""}"`) : p.kind === "draft" ? (ar ? `${p.count ?? 1} من ${type}` : `${p.count ?? 1} × ${type}`) : type;
  const done: Partial<Record<typeof state, string>> = {
    ran: p.kind === "image" ? (ar ? "بدأ الرسم، وتظهر الصورة على العنصر في صندوق الموافقات." : "Drawing started; the image appears on the item in your approvals.") : made != null ? (ar ? `أُضيف ${made} إلى صندوق الموافقات.` : `${made} added to your approvals.`) : (ar ? "نُفّذ، والنتيجة في صندوق الموافقات." : "Done; the result is in your approvals."),
    dismissed: ar ? "تُجوهل. لم يُخصم أي كريدت." : "Dismissed. No credits were used.",
    gone: ar ? "حُسمت هذه البطاقة من قبل أو انتهت مدتها (24 ساعة)." : "This card was already decided or has expired (24 hours).",
    busy: ar ? "يُنفَّذ هذا الطلب الآن من نافذة أخرى." : "This request is already running from another window.",
    slow: ar ? "طلبات كثيرة في هذه الساعة. حاول بعد قليل." : "Too many runs this hour. Try again shortly.",
    forbidden: t.team.errors.forbidden,
    paused: ar ? "التوليد متوقف مؤقتاً. لم يُخصم أي كريدت، حاول لاحقاً." : "Generation is paused for now. No credits were used; try again later.",
    failed: ar ? "تعذّر التنفيذ، وأُعيدت الكريدتات. حاول مرة أخرى." : "It could not be done, and the credits were returned. Try again.",
    revoked: ar ? "أوقف المالك هذا لهذا الوكيل في صفحة الحوكمة، فلم يُنفَّذ شيء ولم يُخصم أي كريدت." : "The owner switched this off for this agent on the Governance page, so nothing ran and no credits were used.",
    error: ar ? "لم يُنفَّذ. حاول مرة أخرى." : "Not done. Try again.",
  };
  const closed = state === "ran" || state === "dismissed" || state === "gone";
  return (
    <article className="mt-3 overflow-hidden rounded-xl border border-border-input bg-surface text-foreground" data-spend-card>
      <header className="flex items-center gap-2 border-b border-foreground/5 px-3 py-2 text-xs font-semibold">
        <Icon name="spark" className="h-4 w-4 text-foreground" />
        {ar ? "عمل مدفوع ينتظر موافقتك" : "Paid work waiting for your Run"}
      </header>
      <dl className="grid gap-1.5 px-4 py-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-3">
        <dt className="text-xs text-foreground-muted">{ar ? "المطلوب" : "What"}</dt>
        <dd className="min-w-0 break-words" dir="auto">{what}</dd>
        {p.brief && <><dt className="text-xs text-foreground-muted">{ar ? "التفاصيل" : "Brief"}</dt><dd className="min-w-0 whitespace-pre-wrap break-words" dir="auto">{p.brief.slice(0, 400)}</dd></>}
        <dt className="text-xs text-foreground-muted">{ar ? "التكلفة التقديرية" : "Estimated cost"}</dt>
        <dd className="tnum min-w-0" dir="auto">{ar ? `${p.credits} كريدت` : `${p.credits} credit${p.credits === 1 ? "" : "s"}`}</dd>
      </dl>
      <p className="px-4 pb-2 text-xs text-foreground-muted">{p.reason === "ask"
        // Rule 2433: the owner set this to ask first for the agent in Governance, whatever the message said.
        ? (ar ? "لم يُنفَّذ شيء ولم يُخصم أي كريدت: ضبطتَ في الحوكمة أن يستأذنك هذا الوكيل قبل هذا العمل. اضغط «نفّذ» إن كنت تريده." : "Nothing ran and no credits were used: in Governance you set this agent to ask you first for this work. Press Run if you want it.")
        : (ar ? "لم يُنفَّذ شيء ولم يُخصم أي كريدت لأن رسالتك لم تطلب هذا صراحةً. اضغط «نفّذ» إن كنت تريده." : "Nothing ran and no credits were used, because your message did not ask for this in words. Press Run if you want it.")}</p>
      <footer className="flex flex-wrap items-center gap-2 border-t border-foreground/5 px-3 py-2 text-xs">
        {done[state] && (state === "ran" || state === "dismissed" ? <span role="status" className="text-foreground">{done[state]}</span> : <span role="alert" className="text-danger">{done[state]}</span>)}
        {state === "ran" && <Link href={href()} className="underline">{ar ? "افتح صندوق الموافقات" : "Open approvals"}</Link>}
        {!closed && !canRun && <span className="ms-auto text-foreground-muted">{ar ? "لا تملك صلاحية تنفيذ هذا العمل." : "You don't have permission to run this."}</span>}
        {!closed && canRun && (
          <span className="ms-auto flex gap-1.5">
            <button disabled={state === "running"} onClick={() => decide("dismiss")} className="btn btn-secondary btn-xs">{ar ? "تجاهل" : "Dismiss"}</button>
            <button disabled={state === "running"} onClick={() => decide("run")} className="btn btn-primary btn-xs"><Icon name="check" className="h-3.5 w-3.5" />{state === "running" ? (ar ? "يُنفَّذ…" : "Running…") : (ar ? "نفّذ" : "Run")}</button>
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
    else if (kind === "awayprop") out.add(lang === "ar" ? "غياب ينتظر حفظك" : "An absence waits for your Save");
    else if (kind === "instrprop") out.add(lang === "ar" ? "قاعدة مقترحة تنتظر تطبيقك" : "A proposed rule waits for your Apply");
    else if (kind === "spendprop") out.add(lang === "ar" ? "عمل مدفوع ينتظر موافقتك" : "Paid work waits for your Run");
    else if (kind === "generated" || kind === "drafted") out.add(lang === "ar" ? `أُضيف ${n ?? ""} إلى صندوق الموافقات`.replace("  ", " ") : `${n ?? ""} added to approvals`.trim());
    else if (kind === "todo") out.add(lang === "ar" ? "حُدّثت قائمة مهامك" : "Your to-do list was updated");
  }
  return [...out];
}

export default function ChatPanel({ t, initial, credits: c0, lang, initialConv, initialPrompt = "", plan, firstStep, initialAgent, pending = [], pendingCount = 0, brief, onboardUrl, starter, needPhone = false, journey, canApprove = true, canBrand = true, canInstructions = true, canRun = true, canDecline = true, handoffs, chat: chat0, canConfirmChina = false, active = null, workView = false }: { t: AppDict; initial: ChatMsg[]; credits: number; lang: "ar" | "en"; initialConv?: string; initialPrompt?: string; plan?: string; firstStep?: string; initialAgent?: string; pending?: ChatItem[]; pendingCount?: number; brief?: string | null; /** first run: build the workspace from this URL inside the thread */ onboardUrl?: string; /** goal and first task from onboarding, shown to trial accounts */ starter?: { goal: string; first?: string } | null; needPhone?: boolean; /** launch path, shown at the top of the thread until it is complete */ journey?: Journey; /** `can(u, "publish")`: approve buttons on item cards */ canApprove?: boolean; /** `can(u, "brand.write")`: Save and Dismiss on brand-change cards */ canBrand?: boolean; /** `can(u, "instructions.write")`: a plain member sees a proposed instruction but cannot decide it */ canInstructions?: boolean; /** `can(u, "generate")` and `can(u, "drafts")`: Run and Decline on Majed's handoff cards */ canRun?: boolean; canDecline?: boolean; /** the handoffs this thread names, read on the server (`handoffViews`): null for one whose record is gone */ handoffs?: Record<string, HandoffView | null>; /** the account's chat messages now (`chatStatus`, read on the server); each answer brings the next */ chat?: ChatStatus; /** the owner, not a founder impersonating (`can(u, "profile.account")`): may allow China-hosted models in the model picker */ canConfirmChina?: boolean; /** the open conversation's record as the page read it (`getConversation`): its id and chat pick, for the model picker */ active?: { id: string; model?: string } | null; /** RUN_LOG is on: the thread's work view and context meter (v2 C9 + C13), read on open */ workView?: boolean }) {
  const href = useAppLink(lang);
  const [msgs, setMsgs] = useState<ChatMsg[]>(initial);
  const [text, setText] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [credits, setCredits] = useState(c0);
  const [chatNow, setChatNow] = useState<ChatStatus | null>(chat0 ?? null);
  // A message the server refused before saving it: why, under the box (the limit dialog says the rest).
  const [notice, setNotice] = useState("");
  const [convs, setConvs] = useState<Conv[]>([]);
  const [conv, setConv] = useState(initialConv ?? "default");
  const [agent, setAgent] = useState<AgentId>((initialAgent as AgentId) ?? "noor");
  const [voted, setVoted] = useState<Record<string, 1 | -1>>({});
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [steps, setSteps] = useState<string[]>([]);
  // The turn's run-log steps as they happen (v2 C9, rule 4774): sent only while RUN_LOG is on, so empty otherwise.
  const [work, setWork] = useState<WorkStep[]>([]);
  const [left, setLeft] = useState(pendingCount);
  const list = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const ranOnboard = useRef(false);
  const [goal, setGoal] = useState(starter ?? null);
  const [onboarded, setOnboarded] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  // Stop (rule 1126): the request's controller, and whether the person stopped waiting (then no recovery runs).
  const ctl = useRef<AbortController | null>(null);
  const stopped = useRef(false);
  const [stoppedNote, setStoppedNote] = useState(false);
  const coarse = useSyncExternalStore(onPointerChange, isCoarse, notCoarse);
  // Whether the reader is at the end of the thread: new messages follow only then, so reading back up is not pulled down.
  // On a wide screen the list scrolls; on a phone the page does, with the box held at the bottom (rule 1125).
  const near = useRef(true);
  useEffect(() => {
    const onScroll = () => { const d = document.documentElement; near.current = d.scrollHeight - window.scrollY - window.innerHeight < 120; };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = list.current;
    if (!el || !near.current) return;
    if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
    else if (msgs.length > 0 || busy) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [msgs, busy, steps]);
  // The box grows with what is typed, up to COMPOSER_MAX_PX, and shrinks back when it is sent.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [text]);
  // The shell's balance (rail, phone header) follows this panel's: every answer and every handoff run brings it.
  useEffect(() => { announceCredits(credits); }, [credits]);
  useEffect(() => { void fetch("/api/conversations").then((r) => r.json()).then((j) => { if (j.ok) { setConvs(j.conversations); if (initialConv) setAgent((j.conversations as Conv[]).find((c) => c.id === initialConv)?.agent ?? "noor"); } }).catch(() => {}); }, [initialConv]);
  // After the model picker's `not_found` (the conversation is gone): the list again, without touching the agent.
  const reloadConvs = useCallback(() => { fetch("/api/conversations").then((r) => r.json()).then((j) => { if (j.ok) setConvs(j.conversations); }).catch(() => {}); }, []);
  // The picks made in this panel, by conversation (the picker's optimistic change and its rollback, `nextMadePicks`).
  // They come before the page's record of the open conversation and the listed rows (`storedPick`).
  const [made, setMade] = useState<MadePicks>({});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && !(e.target as HTMLElement)?.isContentEditable) { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // First run: Noor builds the workspace inside this thread (Enrich-style onboarding, no form).
  useEffect(() => {
    if (!onboardUrl || ranOnboard.current) return;
    ranOnboard.current = true;
    void (async () => {
      setBusy(true); setSteps([]);
      const S = t.start;
      const fill = (text: string, n: number, have: number) => text.split("{n}").join(String(n)).split("{credits}").join(String(have));
      // A provider fault (rule 1477) says why first, then what happened to the credits.
      const fail = (code?: string, ev?: { refunded?: number; credits?: number; error?: string }) => setMsgs((p) => [...p, { role: "assistant", agent: "noor", at: new Date().toISOString(), content: (modelErrorCause(lang, ev?.error) ? `${modelErrorCause(lang, ev?.error)} ` : "") + (code === "charge" ? S.notCharged : code === "refunded" ? fill(S.refunded, ev?.refunded ?? 0, ev?.credits ?? 0) : code === "saved" ? S.partial : code === "daily" ? (lang === "ar" ? "وصلت إلى حد إعداد العلامات لهذا اليوم. هذه المحاولة لم تخصم شيئاً، والإعداد المدفوع مسبقاً يبقى محسوباً لك. حاول غداً." : "You reached today's brand setup limit. This try charged nothing, and a setup already paid for stays paid. Try again tomorrow.") : code === "busy" ? (lang === "ar" ? "التجهيز جارٍ في الخلفية. حدّث الصفحة بعد دقيقة." : "Setup is still running. Refresh in a minute.") : code === "paused" ? (lang === "ar" ? "تجهيز المساحة متوقف مؤقتاً، ولم يُحفظ شيء. حدّث الصفحة لاحقاً للمحاولة مرة أخرى." : "Workspace setup is paused for now and nothing was saved. Refresh later to try again.") : (lang === "ar" ? "⚠︎ تعذّر تجهيز المساحة. حدّث الصفحة للمحاولة مرة أخرى." : "⚠︎ Could not set up the workspace. Refresh to try again.")) }]);
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
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; let got = false;
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
            else if (ev.type === "done") { got = true; if (typeof ev.credits === "number") setCredits(ev.credits); setGoal((g) => ({ goal: ev.goal ?? "", first: g?.first })); setOnboarded(true); router.replace(href("/chat")); router.refresh(); }
            // A paid setup that failed before the brand file was saved was refunded: say so, with the balance, and that a
            // retry pays again. One that failed after it was saved kept the brand: say that instead of "could not set up".
            else if (ev.type === "error") { got = true; if (typeof ev.credits === "number") setCredits(ev.credits); fail(ev.refunded ? "refunded" : ev.saved ? "saved" : undefined, ev); }
          }
        }
        // Ended without `done` or `error` (the server process died mid-run): say so instead of showing nothing.
        if (!got) throw new Error("ended");
      } catch { fail(); }
      finally { setBusy(false); setSteps([]); }
    })();
  }, [onboardUrl, lang, router, href, t.start]);

  // Rule 2977: one create at a time (a second tap would make a second empty thread, as the rail's buttons, rule 2934), and a
  // dropped connection or a non-JSON 5xx lets the button come back instead of throwing out of the click handler.
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  async function newConv(withAgent: AgentId = agent) {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    const j = await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "…", agent: withAgent }) })
      .then((res) => res.json())
      .catch(() => null)
      .finally(() => { creatingRef.current = false; setCreating(false); });
    if (!j?.ok) return;
    setConvs((p) => [j.conversation, ...p]); setConv(j.conversation.id); setAgent(withAgent); setMsgs([]);
    // The address names the new thread (rule 962): the page keys this panel by it, so a later sidebar link back to the
    // thread this one replaced is a new key and opens that thread, and a reload reopens this one.
    router.replace(href(`/chat?conv=${j.conversation.id}${withAgent === "noor" ? "" : `&agent=${withAgent}`}`));
  }
  async function pick(id: AgentId) {
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
    setText(""); setNotice(""); setStoppedNote(false);
    stopped.current = false; near.current = true;
    const ac = new AbortController();
    ctl.current = ac;
    // Kept by identity: a message the server refuses before saving it leaves the thread and goes back into the box.
    const mine: ChatMsg = { role: "user", content: m, at: new Date().toISOString() };
    setMsgs((p) => [...p, mine]);
    setBusy(true); setSteps([]); setWork([]);
    type Answer = { ok?: boolean; message?: ChatMsg; credits?: number; limit?: string | null; error?: string; chat?: ChatStatus };
    const done = (j: Answer) => {
      if (j.chat) setChatNow(j.chat);
      if (j.message) { setMsgs((p) => [...p, j.message!]); if (typeof j.credits === "number") setCredits(j.credits); if (conv !== "default") setConvs((p) => p.map((c) => (c.id === conv && c.title === "…" ? { ...c, title: m.slice(0, 60) } : c))); if (j.limit === "credits" || j.limit === "trial" || j.limit === "agent_cap" || j.limit === "fair_use") raiseLimit(j.limit); }
      else setMsgs((p) => [...p, { role: "assistant", content: `⚠︎ ${j.error === "network" ? (lang === "ar" ? "انقطع الاتصال. حاول مرة أخرى." : "Connection lost. Try again.") : j.error === "conversation_gone" ? (lang === "ar" ? "حُذفت هذه المحادثة. ابدأ محادثة جديدة." : "This conversation was deleted. Start a new one.") : modelErrorText(lang, j.error) ?? (lang === "ar" ? "تعذّر الرد. حاول مرة أخرى." : "Could not reply. Try again.")}`, at: new Date().toISOString(), agent: "noor" }]);
    };
    /** Refused before anything was saved or counted: out of the thread, back in the box, and the reason shown. */
    const unsend = (why: "chat" | "chat_credits" | "fair_use" | "slow_down", j: Answer) => {
      setMsgs((p) => p.filter((x) => x !== mine));
      setText((cur) => cur || m);
      if (j.chat) setChatNow(j.chat);
      if (typeof j.credits === "number") setCredits(j.credits);
      if (why === "slow_down") { setNotice(t.chat.slowDown); return; }
      setNotice(t.chat.notSent);
      raiseLimit(why, { period: j.chat?.period, hold: j.chat?.overflow.hold, allowance: j.chat?.allowance });
    };
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", "x-lang": lang }, body: JSON.stringify({ text: m, conv, agent, stream: true }), signal: ac.signal });
      if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) {
        const j = (await res.json()) as Answer;
        const why = refusalOf(res.status, j.error);
        if (why) unsend(why, j); else done(j);
        return;
      }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; let got = false;
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
          else if (ev.type === "step") setWork((p) => [...p, ev.step]);
          else if (ev.type === "message") { got = true; done({ ok: true, ...ev }); }
          else if (ev.type === "error") { got = true; done({ ok: false, error: ev.error }); }
        }
      }
      // A stream that ends cleanly without a message or an error (the server process died mid-turn) is a dropped stream.
      if (!got) throw new Error("ended");
    } catch {
      // Stopped (rule 1126): this page stops waiting, nothing more. The server still answers, saves and charges the reply,
      // so the words say that, the typed text is not put back, and no recovery polls for it.
      if (stopped.current) { setStoppedNote(true); return; }
      // The server keeps working and saves the reply even when the connection drops: look for it before giving up.
      setSteps((p) => [...p, lang === "ar" ? "انقطع الاتصال، أسترجع الرد…" : "Connection dropped, recovering the reply…"]);
      const sentAt = Date.now() - 5000;
      let found: ChatMsg | null = null;
      for (let n = 0; n < 40 && !found; n++) {
        await new Promise((r) => setTimeout(r, 5000));
        if (stopped.current) break;
        try {
          const j = await (await fetch(`/api/chat?conv=${encodeURIComponent(conv)}`)).json();
          if (j.chat) setChatNow(j.chat as ChatStatus);
          const last = (j.messages as ChatMsg[] | undefined)?.at(-1);
          if (last && last.role === "assistant" && new Date(last.at).getTime() >= sentAt) found = last;
        } catch { /* still offline, keep trying */ }
      }
      // Stopped while recovering: the same words as a stop during the answer.
      if (stopped.current && !found) { setStoppedNote(true); return; }
      // No saved reply: the typed text goes back into the box, unless something new was typed.
      if (found) done({ ok: true, message: found }); else { done({ ok: false, error: "network" }); setText((cur) => cur || m); }
    }
    finally { ctl.current = null; setBusy(false); setSteps([]); setWork([]); }
  }
  /** Stop waiting for the answer in flight (rule 1126). */
  function stop() {
    if (!busy || onboardUrl) return;
    stopped.current = true;
    ctl.current?.abort();
  }
  /** Retry (rule 1126): the question before message `i`, sent again as a new turn. */
  function retryAt(i: number) {
    const q = msgs.slice(0, i).findLast((x) => x.role === "user");
    if (q) void send(q.content);
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
  const line = chatNow ? chatLine(t, chatNow, credits) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <AgentAvatar id={agent} name={A[agent].name} />
          <h1 className="clip font-display text-xl font-bold text-foreground">{A[agent].name} <span className="text-sm font-normal text-foreground-muted">· {title}</span></h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ChatModelPicker t={t} lang={lang} conv={conv} stored={storedPick(conv, made, active, convs)} replying={busy} canConfirmChina={canConfirmChina} onPicked={(c, previous, model, outcome) => setMade((p) => nextMadePicks(p, c, previous, model, outcome))} onChat={setChatNow} onGone={reloadConvs} />
          <button disabled={creating} onClick={() => newConv()} className="btn btn-secondary btn-xs"><Icon name="plus" className="h-3.5 w-3.5" />{t.chat.newConv}</button>
          <Link href={href("/settings/billing")} className="tnum rounded-full bg-background-muted px-3 py-1 text-xs text-foreground-muted">{credits} {t.nav.credits}</Link>
        </div>
      </div>

      {/* Who answers (rule 1127): toggle buttons, not tabs (nothing here is a tab panel); the specialists are a menu. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={t.agents.pick}>
        <button type="button" aria-pressed={agent === "noor"} onClick={() => pick("noor")} className={`min-h-[var(--hit-min)] rounded-full border px-3 text-sm transition pointer-fine:min-h-9 ${agent === "noor" ? "border-border-strong bg-inverse text-inverse-muted" : "border-border bg-surface text-foreground-muted hover:border-border-strong"}`}><span className="font-semibold">{A.noor.name}</span> <span className="opacity-70">· {A.noor.role}</span></button>
        {agent !== "noor" && <span aria-current="true" className="inline-flex min-h-[var(--hit-min)] items-center rounded-full border border-border-strong bg-inverse px-3 text-sm text-inverse-muted pointer-fine:min-h-9"><span className="font-semibold">{A[agent].name}</span>&nbsp;<span className="opacity-70">· {A[agent].role}</span></span>}
        <Menu
          label={t.ux.chat.specialists}
          items={AGENTS.filter((a) => a.id !== "noor").map((a) => ({
            key: a.id,
            onSelect: () => { void pick(a.id); },
            label: (
              <span className="flex w-72 max-w-[calc(100vw-4rem)] items-center gap-2.5 py-1.5">
                <AgentAvatar id={a.id} name={A[a.id].name} className="h-7 w-7 text-xs" />
                <span className="min-w-0"><span className="block font-semibold text-foreground">{A[a.id].name} <span className="font-normal text-foreground-muted">· {A[a.id].role}</span></span><span className="clip block text-xs">{A[a.id].blurb}</span></span>
              </span>
            ),
          }))}
          trigger={(props) => <button {...props} className="inline-flex min-h-[var(--hit-min)] items-center rounded-full border border-dashed border-border-input px-3 text-sm text-foreground-muted hover:border-border-strong hover:text-foreground pointer-fine:min-h-9"><Icon name="plus" className="me-1 h-3.5 w-3.5" />{t.nav.askSpecialist}</button>}
        />
      </div>

      {/* A log (rule 963): a screen reader reads each new message as it arrives, without moving focus from the box. */}
      <div ref={list} role="log" aria-live="polite" aria-label={A[agent].name} onScroll={(e) => { const el = e.currentTarget; near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="mt-2 min-h-0 flex-1 space-y-4 rounded-xl border border-border bg-surface p-4 lg:overflow-y-auto">
        {journey?.next && <JourneyCard journey={journey} lang={lang} compact />}
        {(left > 0 || briefLines.length > 0) && msgs.length <= 1 && (
          <section className="rounded-xl border border-border bg-background p-3" aria-label={t.chat.todayFromTeam}>
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground"><Icon name="sun" className="h-4 w-4 text-foreground" />{t.chat.todayFromTeam}</p>
              {left > 0 && <Link href={href()} className="btn btn-primary btn-xs"><Icon name="inbox" className="h-3.5 w-3.5" />{t.chat.pending} <span className="tnum" dir="ltr">({left})</span> · {t.chat.reviewAll}</Link>}
            </div>
            {briefLines.length > 0 && <ul className="mt-2 text-sm text-foreground-muted">{briefLines.map((l, i) => <li key={i} dir="auto">{l}</li>)}</ul>}
            {pending[0] && <ItemCard item={pending[0]} t={t} lang={lang} canApprove={canApprove} onApproved={() => setLeft((n) => Math.max(0, n - 1))} />}
          </section>
        )}
        {msgs.length === 0 && !onboardUrl && (
          <div>
            <p className="text-foreground-muted">{agent === "noor" ? t.chat.empty : A[agent].blurb}</p>
            <div className="mt-4 flex flex-wrap gap-2">{A[agent].suggestions.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-foreground/30 px-3 py-1.5 text-sm text-foreground hover:bg-inverse hover:text-inverse-muted">{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => (
          <ChatBubble key={i} role={m.role} name={m.role === "assistant" ? A[m.agent ?? agent].name : undefined} wide={!!(m.items?.length || m.files?.length || m.plan?.length || m.handoff || m.proposals?.length || m.awayProposals?.length || m.instructionProposals?.length || m.spendProposals?.length || m.fileProposals?.length || m.memoryProposals?.length || m.goalPlan || m.research)}>
            {m.role === "assistant" ? <div className="prose-nashr prose-compact" dangerouslySetInnerHTML={{ __html: render(m.content) }} /> : <p className="whitespace-pre-wrap">{m.content}</p>}
            {m.items && m.items.length > 0 && <div className="mt-1">{m.items.map((it) => <ItemCard key={it.id} item={it} t={t} lang={lang} canApprove={canApprove} />)}</div>}
            {m.files && m.files.length > 0 && <div className="mt-1">{m.files.map((f, n) => <FileCard key={f.name} file={f} lang={lang} defaultOpen={n === 0 && m.files!.length === 1} />)}</div>}
            {m.plan && m.plan.length > 0 && <PlanCard plan={m.plan} lang={lang} onStart={(prompt) => send(`${lang === "ar" ? "ابدأ" : "Start"}: ${prompt}`)} />}
            {m.handoff && <HandoffCard id={m.handoff.id} t={t} lang={lang} initial={handoffs?.[m.handoff.id]} canRun={canRun} canDecline={canDecline} canApprove={canApprove} onCredits={setCredits} />}
            {m.goalPlan && <GoalPlanCard id={m.goalPlan.id} t={t} lang={lang} canRun={canRun} />}
            {m.research && <ResearchCard id={m.research.id} name={A[m.agent ?? agent].name} lang={lang} canRun={canRun} onApproved={(text) => send(text)} />}
            {m.proposals && m.proposals.length > 0 && <div className="mt-1">{m.proposals.map((p) => <ProposalCard key={p.id} p={p} t={t} lang={lang} canBrand={canBrand} />)}</div>}
            {m.awayProposals && m.awayProposals.length > 0 && <div className="mt-1">{m.awayProposals.map((p) => <AwayProposalCard key={p.id} p={p} t={t} lang={lang} />)}</div>}
            {m.instructionProposals && m.instructionProposals.length > 0 && <div className="mt-1">{m.instructionProposals.map((p) => <InstructionProposalCard key={p.id} p={p} t={t} lang={lang} canWrite={canInstructions} />)}</div>}
            {m.fileProposals && m.fileProposals.length > 0 && <div className="mt-1">{m.fileProposals.map((p) => <FileProposalCard key={p.id} p={p} t={t} lang={lang} canWrite={canBrand} />)}</div>}
            {m.memoryProposals && m.memoryProposals.length > 0 && <div className="mt-1">{m.memoryProposals.map((p) => <MemoryProposalCard key={p.id} p={p} t={t} lang={lang} canWrite={canBrand} />)}</div>}
            {m.spendProposals && m.spendProposals.length > 0 && <div className="mt-1">{m.spendProposals.map((p) => <SpendProposalCard key={p.id} p={p} t={t} lang={lang} canRun={canRun} onCredits={setCredits} />)}</div>}
            {actionLabels(m.actions, lang).length > 0 && <p className="tnum mt-1 text-xs text-foreground-muted" dir="auto">{actionLabels(m.actions, lang).join(" · ")}</p>}
            {m.role === "assistant" && m.switchTo && isAgentId(m.switchTo) && m.switchTo !== agent && (
              <button onClick={() => pick(m.switchTo!)} className="btn btn-secondary btn-xs mt-1.5">{t.chat.switchTo.replace("{name}", A[m.switchTo].name)}</button>
            )}
            {/* Team chat (v2 C4 + C12): a note-taker's reply names the owner of the request; the teammate card acts only on a press. */}
            {m.role === "assistant" && m.owner && m.agent && m.owner !== m.agent && isAgentId(m.owner) && <p className="mt-1 text-xs text-foreground-muted" data-team-note>{t.chat.teamNoteOn.replace("{name}", A[m.owner].name)}</p>}
            {m.role === "assistant" && m.teamCard && isAgentId(m.teamCard.agent) && <TeamCard card={m.teamCard} conv={conv} names={Object.fromEntries(AGENTS.map((x) => [x.id, A[x.id].name])) as Record<AgentId, string>} t={t} canAct={canRun} onAsk={(s) => { setText((cur) => s + cur); input.current?.focus(); }} />}
            {m.role === "assistant" && m.large && <p className="mt-1 text-xs text-foreground-muted" data-workspace-large>{lang === "ar" ? "ملفات مساحة العمل كبيرة، فكان لهذا الرد مساحة أقل: ربما تركتُ رسائل سابقة من المحادثة أو اختصرتُ الجواب. " : "Your workspace files are large, so this reply had less room: I may have left out earlier messages or kept the answer short. "}<Link href={href("/files")} className="underline">{lang === "ar" ? "اختصر ملفاتك الطويلة" : "Shorten your long files"}</Link>{lang === "ar" ? " أو ابدأ محادثة جديدة." : " or start a new conversation."}</p>}
            {m.role === "assistant" && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
                {/* Rule 1126: each answer can be copied; the last one (or an error) can be asked again. */}
                <CopyButton text={m.content} lang={lang} label={t.ux.chat.copy} iconOnly />
                {i === msgs.length - 1 && !busy && msgs.slice(0, i).some((x) => x.role === "user") && <button type="button" onClick={() => retryAt(i)} aria-label={t.ux.chat.retry} title={t.ux.chat.retry} className="icon-btn"><Icon name="retry" className="h-4 w-4" /></button>}
                <button type="button" onClick={() => vote(m, 1)} aria-pressed={voted[m.at] === 1} aria-label={t.chat.helpful} title={t.chat.helpful} className="icon-btn"><Icon name="thumbUp" className="h-4 w-4" /></button>
                <button type="button" onClick={() => vote(m, -1)} aria-pressed={voted[m.at] === -1} aria-label={t.chat.notHelpful} title={t.chat.notHelpful} className="icon-btn"><Icon name="thumbDown" className="h-4 w-4" /></button>
                {reasonFor === m.at && !voted[m.at] && (
                  <form onSubmit={(e) => { e.preventDefault(); void vote(m, -1); }} className="flex flex-1 items-center gap-1">
                    <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t.chat.whyBad} className="input py-1 text-xs" />
                    <button className="btn btn-secondary btn-xs">{t.chat.send_}</button>
                  </form>
                )}
              </div>
            )}
          </ChatBubble>
        ))}
        {needPhone && (onboarded || (msgs.some((m) => m.plan?.length) && !busy)) && <WhatsAppCard lang={lang} />}
        {busy && onboardUrl && (
          <OnboardProgress lang={lang} steps={steps} name={A.noor.name} />
        )}
        {busy && !onboardUrl && (
          <div className="text-sm text-foreground-muted">
            {steps.map((s, i) => <p key={i} className={`flex items-center gap-2 ${i < steps.length - 1 ? "opacity-70" : ""}`}><span className={`h-2 w-2 rounded-full ${i < steps.length - 1 ? "bg-foreground" : "animate-pulse bg-lemon"}`} />{A[agent].name}: {s}</p>)}
            {steps.length === 0 && <p>{agent === "noor" ? t.chat.thinking : `${A[agent].name}…`}</p>}
            {work.length > 0 && <div className="mt-2"><RunTimeline steps={work} t={t} /></div>}
          </div>
        )}
      </div>
      {workView && !onboardUrl && <WorkPanel key={conv} t={t} lang={lang} conv={conv === "default" ? undefined : conv} />}

      {plan === "trial" && goal?.goal && <ActivationBar lang={lang} goal={goal.goal} first={goal.first} />}
      <p role="status" className="sr-only">{busy ? (agent === "noor" ? t.chat.thinking : `${A[agent].name}…`) : ""}</p>
      {/* Rule 1125: a growing box. Enter sends and Shift+Enter is a new line with a mouse and keyboard; on a touch screen
          Enter is a new line and the button sends. On a phone the page scrolls and the box stays at the bottom, above
          the home bar. While an answer is coming the button is Stop (rule 1126). */}
      <form onSubmit={(e) => { e.preventDefault(); void send(text); }} aria-busy={busy} className="sticky bottom-0 z-10 -mx-4 mt-3 bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:-mx-8 sm:px-8 lg:static lg:mx-0 lg:p-0">
        <div className="flex items-end gap-2">
          <textarea ref={input} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (enterSends({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }, coarse)) { e.preventDefault(); void send(text); } }} enterKeyHint={coarse ? "enter" : "send"} placeholder={t.chat.placeholder} aria-label={t.chat.placeholder} aria-describedby="chat-enter-hint" className="input min-h-[var(--hit-min)] resize-none overflow-y-auto rounded-2xl py-2.5 leading-normal" />
          {busy && !onboardUrl
            ? <button type="button" onClick={stop} className="btn btn-secondary btn-lg shrink-0" aria-label={t.ux.chat.stop}><Icon name="stop" className="h-4 w-4" /><span className="hidden sm:inline">{t.ux.chat.stop}</span></button>
            : <button type="submit" disabled={busy || !text.trim()} className="btn btn-accent btn-lg shrink-0" aria-label={t.chat.send}><Icon name="send" mirror className="h-4 w-4" /><span className="hidden sm:inline">{t.chat.send}</span></button>}
        </div>
        <p id="chat-enter-hint" className="mt-1 text-xs text-foreground-muted">{coarse ? t.ux.chat.enterHintTouch : t.ux.chat.enterHint}</p>
      </form>
      {stoppedNote && <p role="status" className="mt-2 text-xs text-foreground" dir="auto">{t.ux.chat.stopped}</p>}
      {notice && <p role="alert" className="mt-2 text-xs font-semibold text-danger" dir="auto">{notice}</p>}
      {line && <p className={`tnum mt-2 text-xs ${line.low ? "font-semibold text-danger" : "text-foreground-muted"}`} dir="auto">{line.text}</p>}
      {step && plan === "trial" && !goal?.goal && <p className="mt-2 flex items-center gap-2 text-xs text-foreground-muted"><Icon name="spark" className="h-3.5 w-3.5 text-foreground" />{t.limit.firstUp}: {step}</p>}
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
    <section className="rounded-2xl border border-border bg-background p-4" aria-live="polite">
      <div className="flex items-center gap-3">
        <AgentAvatar id="noor" name={name} className="journey-next h-11 w-11 text-lg" />
        <div className="min-w-0 flex-1">
          <p className="font-display font-bold text-foreground">{ar ? `${name} تبني مساحة عملك` : `${name} is building your workspace`}</p>
          <p className="text-xs text-foreground-muted">{ar ? "تقرأ موقعك وتكتب ملف علامتك وخطة البداية. ابقَ هنا." : "Reading your site, writing your brand file and a starter plan. Stay on this page."}</p>
        </div>
      </div>
      <div className="journey-track mt-3"><div className="journey-fill" style={{ "--p": pct / 100 } as React.CSSProperties} /></div>
      <ol className="mt-3 grid gap-1.5 text-sm">
        {steps.map((st, i) => {
          const current = i === steps.length - 1;
          return (
            <li key={i} className="log-row flex items-center gap-2">
              <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${current ? "border-2 border-border-strong bg-lemon" : "pop-in bg-inverse text-lemon"}`}>{current ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lemon" /> : <Icon name="check" className="h-3 w-3" />}</span>
              <span className={current ? "font-semibold text-foreground" : "text-foreground-muted"} dir="auto">{st}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-foreground-muted"><Icon name="seed" className="h-4 w-4 text-foreground" />{ar ? "أول إنجاز في مسار الانطلاق يُفتح حين تنتهي: مستواك الأول «بذرة»." : "Your first launch-path milestone unlocks when this finishes: level one, Seed."}</p>
    </section>
  );
}
