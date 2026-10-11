"use client";
import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { adminFetch } from "@/lib/admin-fetch";
import PaymentsPanel, { newPaymentId } from "../app/PaymentsPanel";
import EntitlementsTable, { videoGrantRequest } from "../app/EntitlementsTable";
import { ksaDay, sarText } from "@/lib/partner-rules";
import { parseChat, parseCreditDelta, parseDealForm, parseRefundForm, parseSeats, parseTopupForm, parseTrialDays, withReason, TRIAL_EXTEND_MAX_DAYS } from "@/lib/admin-input";
import TempPasswordDialog from "./TempPasswordDialog";
import { useActionDialog, type FieldSpec, type FormValues } from "./ActionDialog";
import { AGENCY_MIN, PLANS, TOPUP_PACKS, formatCount, isTopupPack, topupPriceSar, topupsSold, type AgencyDeal, type Plan } from "@/lib/pricing";
import type { TopupLot } from "@/lib/topups";
// The refund amount the founder is shown, computed as the server computes it (rule 460). topups.ts is client-safe (rule 451).
import { unusedRefundSar } from "@/lib/topups";
import { CHAT_LOW_SHARE, EndedNotice, OV, PlanTiles, STR, useAdminEnded, usePlanList, type Detail, type MemberDetail, type SectionProps, type TeamChange, type U } from "./shared";

/** A new "Refund unused" request id, `rf_` and 18 hex characters (POST /api/admin/topups, rule 460). */
const newRefundId = () => `rf_${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
/**
 * Red once the raw count reached the allowance (it can pass one lowered mid-period; an allowance of 0, chat stopped,
 * counts too) or CHAT_LOW_SHARE of it or less is left.
 */
const chatLow = (counted: number, allowance: number | undefined, left: number | undefined) =>
  allowance != null && (counted >= allowance || (left ?? Math.max(0, allowance - counted)) <= allowance * CHAT_LOW_SHARE);

/** Founder console, Users (/{lang}/admin/users): the account table and an account's card, with every founder action on it. `?q=` opens the list filtered. */
export default function Users({ lang, keySession }: SectionProps) {
  const ended = useAdminEnded();
  const S = STR[lang];
  const O = OV[lang];
  const { users, total, load } = usePlanList();
  const [sel, setSel] = useState<Detail | null>(null);
  const [memberSel, setMemberSel] = useState<MemberDetail | null>(null);
  // The overview's recent sign-ups link to /{lang}/admin/users?q={email}: the list opens filtered to that account.
  const search = useSearchParams();
  const [q, setQ] = useState(search.get("q") ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  /** Bumped after a top-up is added or voided: remounts the Payments panel, which shows the pack's payment (rule 454). */
  const [payTick, setPayTick] = useState(0);
  /**
   * The payment id of an "Add top-up" not yet confirmed, with the values it was sent with (rule 454): the same pack
   * entered again after a timeout or a server error reuses it, so the retry adds one pack and records one payment.
   */
  const pendingTopup = useRef<{ key: string; id: string } | null>(null);
  /** The request id of a "Refund unused" not yet confirmed, with what it was sent with: a retry is recognised (rule 460). */
  const pendingRefund = useRef<{ key: string; id: string } | null>(null);
  /** The temporary password from "Reset password", shown once in its own dialog and dropped from state when it closes. */
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  /**
   * Every founder change asks in the console's own form (rules 1100-1102), never in the browser's prompt or confirm:
   * one form per change with all its fields and the reason, checked by the shared parsers (`@/lib/admin-input`) before it
   * closes. Cancel and Escape answer null and the change sends nothing (rule 960: before, a cancelled reason prompt
   * still sent the plan, seats, chat, deal, credits, top-up, void, refund or member removal). An empty reason still goes.
   */
  const [ask, actionDialog] = useActionDialog(lang);
  /** The reason field every change but "Extend trial", the video grant and the account delete carries (logged, 200 characters). */
  const REASON: FieldSpec = { name: "reason", label: O.reason, kind: "textarea", maxLength: 200 };
  const reasonOnly = (v: FormValues) => withReason({ ok: true, value: {} }, v.reason);
  /** "Extend trial" (rule 960): a whole number of days from 1 to 90; Cancel sends nothing, a bad number says so in the form. */
  async function extendTrial(email: string) {
    const v = await ask({
      title: S.extend, subject: email, submitLabel: S.extend,
      fields: [{ name: "days", label: S.promptDays, initial: "7", ltr: true }],
      parse: (f) => { const days = parseTrialDays(f.days); return days === null ? { ok: false, error: `bad_days (1-${TRIAL_EXTEND_MAX_DAYS})` } : { ok: true, value: { days } }; },
    });
    if (!v) return;
    await act(email, "extendTrial", v);
  }
  async function act(email: string, action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    const r = await adminFetch(`/api/admin/users/${encodeURIComponent(email)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
    const j = await r.json();
    setBusy(false);
    if (!j.ok) { setMsg(`${action} failed: ${j.error ?? r.status}`); return j; }
    if (action === "resetPassword") { setTemp({ email, password: j.tempPassword }); setMsg(`${email}: password reset`); }
    else if (action === "impersonate") { window.location.assign(j.redirect); return j; }
    else if (action === "delete") { setMsg(`${email} deleted`); setSel(null); }
    else if (action === "resendVerification") setMsg(`${email}: ${S.codeSent}`);
    else if (action === "removeMember") { setMsg(`${email}: member login removed`); setMemberSel(null); return j; }
    else setMsg(`${email}: ${action} ✓`);
    await load();
    if (sel && action !== "delete") await open(email);
    return j;
  }
  /** Delete an account: the form's button stays off until the account's own email is typed (rule 1102). */
  async function deleteAccount(email: string) {
    const v = await ask({ title: S.del, subject: email, submitLabel: S.del, destructive: true, fields: [{ name: "email", label: S.promptDelete, ltr: true, mustMatch: email }], parse: () => ({ ok: true, value: {} }) });
    if (!v) return;
    await act(email, "delete");
  }
  /** Remove a member login (it frees the address): the member's email typed, and the reason (rule 1102). */
  async function removeMember(email: string) {
    const v = await ask({ title: S.removeMember, subject: email, submitLabel: S.removeMember, destructive: true, fields: [{ name: "email", label: S.promptRemoveMember, ltr: true, mustMatch: email }, REASON], parse: reasonOnly });
    if (!v) return;
    await act(email, "removeMember", v);
  }
  /** A deal as "credits @ price SAR", or that the account has no deal and counts as Business. */
  const dealText = (d?: AgencyDeal | null) => (d ? `${formatCount(d.credits)} @ ${formatCount(d.priceSar)} SAR` : S.noDeal);
  /** The team change a plan or seat change made, in one line: who was paused, who came back, how many invites went. */
  const teamLine = (t?: TeamChange) => (!t ? "" : [t.disabled.length ? `${S.teamPaused}: ${t.disabled.join(", ")}` : "", t.enabled.length ? `${S.teamResumed}: ${t.enabled.join(", ")}` : "", t.cancelled.length ? `${S.teamCancelled}: ${t.cancelled.length}` : ""].filter(Boolean).join(" · "));
  async function setPlan(email: string, from: string, plan: string) {
    const v = await ask({ title: `${S.plan}: ${from} → ${plan}`, subject: email, fields: [REASON], parse: reasonOnly });
    if (!v) return;
    setBusy(true);
    const r = await adminFetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, plan, ...v }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; team?: TeamChange; error?: string };
    setMsg(j.ok ? [`${email} → ${plan}`, teamLine(j.team)].filter(Boolean).join(" · ") : `${email}: ${j.error ?? r.status}`);
    await load();
    setBusy(false);
  }
  /** The founder seat override (spec §5; Agency "seats sized to your team"). 0 clears it back to the plan's number. */
  async function setSeats(u: U) {
    const v = await ask({
      title: S.setSeats, subject: u.email,
      fields: [{ name: "seats", label: S.promptSeats, initial: String(u.seatsOverride ?? u.seats ?? ""), ltr: true }, REASON],
      parse: (f) => withReason(parseSeats(f.seats), f.reason),
    });
    if (!v) return;
    setBusy(true);
    const r = await adminFetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, ...v }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; user?: { seats: number }; team?: TeamChange; error?: string };
    setMsg(j.ok ? [`${u.email}: ${S.seats} ${j.user?.seats ?? ""}`, teamLine(j.team)].filter(Boolean).join(" · ") : `${u.email}: ${j.error ?? r.status}`);
    await load();
    setBusy(false);
  }
  /**
   * The founder chat override (rule 316): the account's messages per month, or for the whole trial. 0 is an override that
   * stops chat, so it is sent as 0; empty or "plan" clears the override back to the plan's number (null). Checked here
   * with the server's own test (`isChatOverride`, through `parseChat`), and again by the server.
   */
  async function setChat(u: U) {
    const v = await ask({
      title: S.setChat, subject: u.email,
      fields: [{ name: "chat", label: S.promptChat, initial: u.chatOverride != null ? String(u.chatOverride) : "plan", ltr: true }, REASON],
      parse: (f) => withReason(parseChat(f.chat), f.reason),
    });
    if (!v) return;
    setBusy(true);
    const r = await adminFetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, ...v }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; user?: { chatAllowance: number; chatOverride: number | null }; error?: string };
    setMsg(j.ok ? `${u.email}: ${S.chat} ${j.user?.chatAllowance ?? ""}${j.user?.chatOverride == null ? "" : ` (${S.seatsOverride})`}` : `${u.email}: ${j.error ?? r.status}`);
    await load();
    if (sel?.user.email === u.email) await open(u.email);
    setBusy(false);
  }
  /**
   * The founder's video grant (rule 783): every video model for a trial, through the end of a UTC day. One form asks for
   * the day and a note and sends `videoGrant: {until, note?}` (`videoGrantRequest`); an empty day clears the grant, and
   * sends nothing when the account has none (ruling R13, so no no-op `admin:log` entry). The day is not checked here: the
   * server is the one check (`parseVideoGrant`, which pulls the store into whatever imports it, so the console cannot) and
   * answers 400 `bad_grant` for a day that is today, past, over 366 days ahead or not a day, or a note over 200
   * characters. The error is shown as the other actions show theirs, and the detail is read again.
   */
  async function setVideoGrant(u: U) {
    const have = sel?.user.email === u.email ? sel.entitlements?.grants.video : null;
    const v = await ask({
      title: S.grantVideo, subject: u.email,
      fields: [{ name: "until", label: S.promptGrantUntil, kind: "date", initial: have && !have.expired ? have.until : "", ltr: true }, { name: "note", label: S.promptGrantNote, initial: have?.note ?? "", maxLength: 200 }],
      parse: (f) => ({ ok: true, value: { body: videoGrantRequest(f.until, f.until.trim() === "" ? "" : f.note, !!have) } }),
    });
    if (!v?.body) return;
    const body = v.body;
    setBusy(true);
    const r = await adminFetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, ...body }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setMsg(j.ok ? `${u.email}: ${S.grantVideo} ${body.videoGrant ? body.videoGrant.until : "✓"}` : `${u.email}: ${j.error ?? r.status}`);
    await load();
    if (sel?.user.email === u.email) await open(u.email);
    setBusy(false);
  }
  /** The chat cell's tooltip: what to click, and what chat cost this month in all and per message. */
  const chatTitle = (u: U) => [S.setChat, `${S.chatCost} ${(u.chatUsd ?? 0).toFixed(2)}`, `${S.perMsg} ${u.usdPerMsg == null ? "—" : u.usdPerMsg.toFixed(4)}`, `${S.overflow}: ${u.plan === "trial" ? S.overflowTrial : u.chatOverflowOn ? S.overflowOn : S.overflowOff}`].join(" · ");
  /**
   * An Agency deal in one form: monthly credits and a SAR price at or above the Business rate, and optionally the seats.
   * Checked here with the parser the server uses (`parseDeal`, through `parseDealForm`) so a typo is caught before the
   * request; the server checks it again and refuses a deal on any plan but agency. Empty credits clears the deal (the
   * account then counts as Business, and the server clears the deal's seats too).
   *
   * The account's first deal is sent with plan "agency", which grants the deal's allowance at once: the plan change that
   * made the account Agency gave it Business's credits, and a deal sent alone keeps the balance until the next renewal,
   * so a new 3,000-credit customer would otherwise hold Business's credits for the first month. A change to an existing
   * deal offers "apply now" (the same), unticked by default (the deal alone, from the next renewal).
   */
  async function setDeal(u: U) {
    const fields: FieldSpec[] = [
      { name: "credits", label: S.promptDealCredits, initial: String(u.deal?.credits ?? AGENCY_MIN.credits), ltr: true },
      { name: "price", label: S.promptDealPrice, initial: String(u.deal?.priceSar ?? AGENCY_MIN.priceSar), ltr: true },
      ...(u.deal ? [{ name: "applyNow", label: S.dealApplyNow, kind: "check" } as FieldSpec] : []),
      { name: "seats", label: S.promptDealSeats, initial: String(u.seatsOverride ?? ""), ltr: true },
      REASON,
    ];
    const v = await ask({
      title: S.setDeal, subject: u.email, fields,
      parse: (f) => withReason(parseDealForm({ credits: f.credits, price: f.price, seats: f.seats, applyNow: f.applyNow === "1" }, !!u.deal), f.reason),
    });
    if (!v) return;
    setBusy(true);
    const r = await adminFetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, ...v }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; user?: { deal?: AgencyDeal | null }; team?: TeamChange; error?: string };
    setMsg(j.ok ? [`${u.email}: ${S.deal} ${dealText(j.user?.deal)}`, teamLine(j.team)].filter(Boolean).join(" · ") : `${u.email}: ${j.error ?? r.status}`);
    await load();
    setBusy(false);
  }
  async function addCredits(email: string) {
    const v = await ask({
      title: S.addCredits, subject: email,
      fields: [{ name: "credits", label: S.promptCredits, initial: "100", ltr: true }, REASON],
      parse: (f) => withReason(parseCreditDelta(f.credits), f.reason),
    });
    if (!v) return;
    setBusy(true);
    const r = await adminFetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, ...v }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setMsg(j.ok ? `${email} +${v.addCredits} credits` : `${email}: ${j.error ?? r.status}`);
    await load();
    setBusy(false);
  }
  /**
   * A pack paid for outside the app (rules 446-447, 454), in one form: the pack, the amount paid excluding VAT (its list
   * price, following the pack until the founder types one), the payment date (today in Riyadh by default, `ksaDay`, the
   * day every recorded payment uses), the payment reference and the reason. The pack is checked here with the server's own
   * test (`isTopupPack`, through `parseTopupForm`); the server checks every field again (`parseTopup`) and refuses a
   * trial. The server records the pack's payment, and the partner's commission when one is due, with the pack: the
   * founder does not record it in Payments. Through `adminFetch` (rule 436).
   */
  async function addTopup(u: U) {
    const v = await ask({
      title: S.addTopup, subject: u.email,
      fields: [
        { name: "pack", label: S.promptTopupPack, kind: "select", initial: String(TOPUP_PACKS[0]), options: TOPUP_PACKS.map((p) => ({ value: String(p), label: formatCount(p) })), ltr: true },
        { name: "paid", label: S.promptTopupPaid, ltr: true, follow: (f) => (isTopupPack(Number(f.pack)) ? String(topupPriceSar(Number(f.pack))) : f.paid ?? "") },
        { name: "date", label: S.promptTopupDate, kind: "date", initial: ksaDay(), ltr: true },
        { name: "ref", label: S.promptTopupRef, ltr: true },
        REASON,
      ],
      parse: (f) => withReason(parseTopupForm({ pack: f.pack, paid: f.paid, date: f.date, ref: f.ref }), f.reason),
    });
    if (!v) return;
    const { reason, ...rest } = v;
    const pack = { email: u.email, action: "add", ...rest };
    const credits = rest.credits;
    const key = JSON.stringify(pack);
    if (pendingTopup.current?.key !== key) pendingTopup.current = { key, id: newPaymentId() };
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/topups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...pack, paymentId: pendingTopup.current.id, reason }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; credits?: number; payment?: { commission?: { sar: number } } | null };
      // A definite answer ends the attempt: a success, or a refusal that wrote nothing. A server error keeps the id.
      if (j.ok || (r.status >= 400 && r.status < 500)) pendingTopup.current = null;
      setMsg(j.ok ? `${u.email}: ${S.topups} +${formatCount(credits)} → ${j.credits ?? ""}${j.payment?.commission ? ` · ${S.commission} ${sarText(j.payment.commission.sar)}` : ""}` : `${u.email}: ${j.error ?? r.status}`);
    } catch {
      setMsg(`${u.email}: network`);
    }
    await load();
    if (sel?.user.email === u.email) { await open(u.email); setPayTick((n) => n + 1); }
    setBusy(false);
  }
  /**
   * Void a pack (a payment reversed, a pack recorded by mistake): its payment and the partner's commission on it are
   * voided, then its unspent credits leave the balance (rule 455). One form says what goes and asks the reason. Logged.
   * Through `adminFetch` (rule 436).
   */
  async function voidTopup(u: U, l: TopupLot) {
    const v = await ask({ title: S.voidTopup, subject: u.email, message: S.confirmVoid(l.credits, l.left), submitLabel: S.voidTopup, destructive: true, fields: [REASON], parse: reasonOnly });
    if (!v) return;
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/topups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, action: "void", id: l.id, ...v }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; credits?: number; removed?: number };
      setMsg(j.ok ? `${u.email}: ${S.topups} ${S.voidTopup} −${formatCount(j.removed ?? 0)} → ${j.credits ?? ""}` : `${u.email}: ${j.error ?? r.status}`);
    } catch {
      setMsg(`${u.email}: network`);
    }
    await load();
    if (sel?.user.email === u.email) { await open(u.email); setPayTick((n) => n + 1); }
    setBusy(false);
  }
  /**
   * Refund a live pack's unused credits (founder decision of 2026-10-02, rule 460): the customer asked, the pack has not
   * expired. One form shows the amount (`unusedRefundSar`: credits left × the price per credit paid, excluding VAT) and
   * asks the transfer's date (today in Riyadh by default), its reference (required) and the reason; it sends the credits
   * left it showed, so the server refuses (`left_changed`) rather than record another amount. One request id per refund,
   * kept until a definite answer, so a retry is recognised. Through `adminFetch` (rule 436).
   */
  async function refundTopup(u: U, l: TopupLot) {
    const v = await ask({
      title: S.refundTopup, subject: u.email, message: S.confirmRefund(l.left, l.credits, sarText(unusedRefundSar(l))), submitLabel: S.refundTopup, destructive: true,
      fields: [{ name: "date", label: S.promptRefundDate, kind: "date", initial: ksaDay(), ltr: true }, { name: "ref", label: S.promptRefundRef, ltr: true }, REASON],
      parse: (f) => withReason(parseRefundForm({ date: f.date, ref: f.ref }), f.reason),
    });
    if (!v) return;
    const { reason, on, ref } = v;
    const req = { email: u.email, action: "refund", id: l.id, credits: l.left, on, ref };
    const key = JSON.stringify(req);
    if (pendingRefund.current?.key !== key) pendingRefund.current = { key, id: newRefundId() };
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/topups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...req, refundId: pendingRefund.current.id, reason }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; credits?: number; refunded?: { credits: number; sar: number }; payment?: { commission?: { sar: number } } | null; left?: number; sar?: number };
      // A definite answer ends the attempt: a success, or a refusal that wrote nothing. A server error keeps the id.
      if (j.ok || (r.status >= 400 && r.status < 500)) pendingRefund.current = null;
      setMsg(j.ok
        ? `${u.email}: ${S.refundTopup} −${formatCount(j.refunded?.credits ?? 0)} · ${sarText(j.refunded?.sar ?? 0)} SAR → ${j.credits ?? ""}${j.payment?.commission ? ` · ${S.commission} ${sarText(j.payment.commission.sar)}` : ""}`
        : j.error === "left_changed" ? `${u.email}: ${S.leftChanged(j.left ?? 0, sarText(j.sar ?? 0))}` : `${u.email}: ${j.error ?? r.status}`);
    } catch {
      setMsg(`${u.email}: network`);
    }
    await load();
    if (sel?.user.email === u.email) { await open(u.email); setPayTick((n) => n + 1); }
    setBusy(false);
  }
  /**
   * "Finish refund" (rule 465): a refund whose credits left the pack but whose payment was not marked (the request stopped
   * in between) is finished from the pack's own refund record: no credits, day or reference are sent. Through `adminFetch`.
   */
  async function finishRefund(u: U, l: TopupLot) {
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/topups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, action: "refund", id: l.id, finish: true }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; refunded?: { credits: number; sar: number }; payment?: { commission?: { sar: number } } | null };
      setMsg(j.ok
        ? `${u.email}: ${S.finishRefund} · ${formatCount(j.refunded?.credits ?? 0)} · ${sarText(j.refunded?.sar ?? 0)} SAR${j.payment?.commission ? ` · ${S.commission} ${sarText(j.payment.commission.sar)}` : ""}`
        : `${u.email}: ${j.error ?? r.status}`);
    } catch {
      setMsg(`${u.email}: network`);
    }
    await load();
    if (sel?.user.email === u.email) { await open(u.email); setPayTick((n) => n + 1); }
    setBusy(false);
  }
  async function open(email: string) {
    const r = await adminFetch(`/api/admin/users/${encodeURIComponent(email)}`);
    const j = await r.json().catch(() => ({}));
    if (j.ok && j.kind === "member") { setSel(null); setMemberSel(j.member); return; }
    if (j.ok) { setMemberSel(null); setSel(j); return; }
    if (r.status === 404) setMsg(`${email}: ${S.notFound}`);
  }
  if (ended) return <EndedNotice lang={lang} keySession={keySession} />;
  const list = users ?? [];
  const shown = list.filter((u) => !q || [u.email, u.name, u.phone, u.plan].some((x) => (x ?? "").toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="grid gap-6">
      {actionDialog}
      {temp && <TempPasswordDialog lang={lang} email={temp.email} password={temp.password} onClose={() => setTemp(null)} />}
      <PlanTiles lang={lang} users={users} total={total} />
      {msg && <p className="text-sm text-ink">{msg}</p>}
      {users === null && <p className="text-sm text-muted">{S.loading}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={S.search} className="w-full max-w-md rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm" />
        {/* Member logins are not in this list (they never enter users:all): an exact address is looked up instead. */}
        {q.includes("@") && <button type="button" disabled={busy} onClick={() => open(q.trim().toLowerCase())} className="btn btn-secondary btn-xs">{S.lookup}</button>}
      </div>
      {memberSel && (
        <div className="rounded-xl border border-ink/30 bg-white p-5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-bold text-ink" dir="ltr">{memberSel.email} <span className="text-sm font-normal text-muted">· {S.memberLogin} · {memberSel.role}{memberSel.disabled ? ` · ${memberSel.disabled}` : ""}</span></h2>
            <button onClick={() => setMemberSel(null)} className="text-sm text-muted">{S.close}</button>
          </div>
          <p className="mt-2" dir="auto">{memberSel.name} · {S.memberOf} <button onClick={() => open(memberSel.memberOf)} className="text-ink underline" dir="ltr">{memberSel.memberOf}</button> · {S.invitedBy} <span dir="ltr">{memberSel.invitedBy}</span> · {memberSel.acceptedAt.slice(0, 10)}</p>
          {(!memberSel.ownerExists || !memberSel.onRoster) && <p className="mt-1 text-danger">{[!memberSel.ownerExists ? S.ownerMissing : "", !memberSel.onRoster ? S.offRoster : ""].filter(Boolean).join(" · ")}</p>}
          <button disabled={busy} onClick={() => removeMember(memberSel.email)} className="btn btn-danger-solid btn-xs mt-3">{S.removeMember}</button>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-lilac text-left text-xs uppercase tracking-wide text-muted">
            <tr><th className="p-3">{S.email}</th><th>{S.name}</th><th>{S.phone}</th><th>{S.plan}</th><th>{S.seats}</th><th>{S.credits}</th><th>{S.chat}</th><th>{S.tokensMo}</th><th>{S.costMo}</th><th>{S.marginMo}</th><th>{S.trialEnds}</th><th>{S.joined}</th><th></th></tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.email} className={`border-t border-ink/5 ${u.suspended ? "bg-agent-sami/20" : ""}`}>
                <td className="p-3"><button onClick={() => open(u.email)} className="text-ink underline">{u.email}</button>{u.suspended && <span className="ms-2 rounded bg-danger px-1.5 text-xs font-semibold text-white">SUSPENDED</span>}{!u.emailVerifiedAt && <span className="ms-2 rounded border border-ink/30 px-1.5 text-xs text-muted" data-testid="unverified">{S.unverified}</span>}</td>
                <td>{u.name}</td>
                <td className="font-mono text-xs"><a href={`https://wa.me/${u.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="underline">{u.phone}</a></td>
                <td>
                  <select value={u.plan} disabled={busy} onChange={(e) => setPlan(u.email, u.plan, e.target.value)} className="rounded border border-ink/15 bg-white px-2 py-1">
                    {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  {u.plan === "agency" && <button disabled={busy} onClick={() => setDeal(u)} title={S.setDeal} className="ms-2 whitespace-nowrap text-xs underline decoration-dotted">{S.setDeal} <span className="font-mono">{dealText(u.deal)}</span></button>}
                </td>
                <td className="whitespace-nowrap text-xs">
                  <button disabled={busy} onClick={() => setSeats(u)} title={S.setSeats} className="font-mono underline decoration-dotted">{u.seats ?? "—"}</button>
                  {u.seatsOverride != null && <span className="ms-1 text-muted">({S.seatsOverride})</span>}
                </td>
                <td className="font-mono">{u.credits}{(u.topupCredits ?? 0) > 0 && <span className="ms-1 text-xs text-muted" title={S.topups}>({u.topupCredits} {S.ofTopup})</span>}</td>
                {/* The raw count against the allowance (it can pass one lowered mid-period); "+N msgs on credits (M credits)" this
                    month. Red when the count reached the allowance or little is left. */}
                <td className={`whitespace-nowrap text-xs ${chatLow(u.chatUsed ?? 0, u.chatAllowance, u.chatLeft) ? "font-semibold text-danger" : ""}`} data-testid="chat-cell">
                  <button disabled={busy} onClick={() => setChat(u)} title={chatTitle(u)} className="font-mono underline decoration-dotted">{u.chatUsed ?? 0} / {u.chatAllowance ?? "—"}</button>
                  {u.chatOverride != null && <span className="ms-1 text-muted">({S.seatsOverride})</span>}
                  {((u.chatOverflowUsed ?? 0) > 0 || (u.chatCredits ?? 0) > 0) && <span className="ms-1 font-mono">{S.onCredits(u.chatOverflowUsed ?? 0, u.chatCredits ?? 0)}</span>}
                </td>
                <td className="font-mono text-xs" title={`${u.calls ?? 0} model calls`}>{((u.tokens ?? 0) / 1000).toFixed(1)}k</td>
                <td className="font-mono text-xs">{(u.usd ?? 0).toFixed(2)}</td>
                {/* Plan price against this month's model cost. Red once the account keeps less than half of what it pays. */}
                <td className={`font-mono text-xs ${u.marginPct == null ? "text-muted" : u.marginPct < 50 ? "font-semibold text-danger" : ""}`} title={u.priceSar ? `${u.priceSar} SAR/mo` : ""}>{u.marginPct == null ? "—" : `${u.marginPct}%`}</td>
                <td className="font-mono text-xs">{u.plan === "trial" ? u.trialEnds.slice(0, 10) : "—"}</td>
                <td className="font-mono text-xs">{u.createdAt.slice(0, 10)}</td>
                <td className="p-3"><button disabled={busy} onClick={() => addCredits(u.email)} className="btn btn-secondary btn-xs">{S.addCredits}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">{S.planNote}</p>
      <p className="text-xs text-muted">{S.chatNote}</p>
      {sel && (
        <div className="rounded-xl border border-ink/30 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-bold text-ink">{sel.user.email} <span className="text-sm font-normal text-muted">· {sel.user.name} · {sel.user.phone} · {sel.user.plan}{sel.user.plan === "agency" ? ` (${dealText(sel.user.deal)})` : ""} · {sel.user.credits} credits{sel.user.suspended ? " · SUSPENDED" : ""} · {sel.user.emailVerifiedAt ? `${S.verifiedOn} ${sel.user.emailVerifiedAt.slice(0, 10)}` : S.unverified}</span></h2>
            <button onClick={() => setSel(null)} className="text-sm text-muted">{S.close}</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <button disabled={busy} onClick={() => act(sel.user.email, "impersonate")} className="rounded-full bg-ink px-3 py-1 font-semibold text-lilac">{S.impersonate}</button>
            <button disabled={busy} onClick={() => extendTrial(sel.user.email)} className="btn btn-secondary btn-xs">{S.extend}</button>
            <button disabled={busy} onClick={() => setVideoGrant(sel.user)} className="btn btn-secondary btn-xs" data-testid="video-grant-button">{S.grantVideo}</button>
            <button disabled={busy} onClick={() => act(sel.user.email, "resetPassword")} className="btn btn-secondary btn-xs">{S.reset}</button>
            {/* Rule 777: only while the address is unproved; the route refuses a verified owner and rate-limits per address. */}
            {!sel.user.emailVerifiedAt && <button disabled={busy} onClick={() => act(sel.user.email, "resendVerification")} className="btn btn-secondary btn-xs">{S.resendCode}</button>}
            <button disabled={busy} onClick={() => act(sel.user.email, "setLang", { lang: sel.user.lang === "ar" ? "en" : "ar" })} className="btn btn-secondary btn-xs">{S.emailsIn} {sel.user.lang === "ar" ? S.english : S.arabic}</button>
            <button disabled={busy} onClick={() => act(sel.user.email, sel.user.suspended ? "unsuspend" : "suspend")} className={`rounded-full px-3 py-1 font-semibold ${sel.user.suspended ? "bg-ink text-lilac" : "border border-danger text-danger"}`}>{sel.user.suspended ? S.unsuspend : S.suspend}</button>
            <button disabled={busy} onClick={() => deleteAccount(sel.user.email)} className="btn btn-danger-solid btn-xs">{S.del}</button>
          </div>
          {/* Partner programme: record payments (the source of truth for commissions) and void them (src/lib/partners.ts). */}
          <PaymentsPanel key={`${sel.user.email}:${payTick}`} email={sel.user.email} lang={lang} />
          <div className="mt-4 grid gap-2 text-xs sm:grid-cols-4">
            <div className="rounded border border-ink/10 p-2"><p className="text-muted">{S.usage}</p><p className="font-mono">{Math.round((sel.usage.in + sel.usage.out) / 1000)}k tokens · ${sel.usage.usd.toFixed(2)} · {sel.usage.calls} calls</p><p className="font-mono text-xs text-muted">{Object.entries(sel.usage.kinds).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</p></div>
            {sel.chat && (
              <div className="rounded border border-ink/10 p-2" data-testid="chat-detail">
                <p className="text-muted">{S.chatMessages} ({sel.chat.period === "trial" ? S.chatTrial : S.chatMonth})</p>
                {/* The raw count, as the list shows it, and this month's messages on credits with what they were billed. */}
                <p className={`font-mono ${chatLow(sel.chat.counted, sel.chat.allowance, sel.chat.left) ? "font-semibold text-danger" : ""}`}>{sel.chat.counted} / {sel.chat.allowance}{sel.chat.overflow.used > 0 || sel.chat.overflow.credits > 0 ? ` · ${S.onCredits(sel.chat.overflow.used, sel.chat.overflow.credits)}` : ""}</p>
                <p className="font-mono text-xs text-muted">{S.overflow}: {!sel.chat.overflow.available ? S.overflowTrial : sel.chat.overflow.on ? S.overflowOn : S.overflowOff}{sel.usage.byKind?.chat ? ` · ${S.chatCost} ${sel.usage.byKind.chat.usd.toFixed(2)}` : ""}{sel.chatUsdPerMsg != null ? ` · ${S.perMsg} ${sel.chatUsdPerMsg.toFixed(4)}` : ""}</p>
              </div>
            )}
            {sel.entitlements && <div className="col-span-full min-w-0"><EntitlementsTable view={sel.entitlements} lang={lang} deal={sel.user.deal} /></div>}
            {sel.usage.byKind && Object.keys(sel.usage.byKind).length > 0 && (
              <div className="col-span-full rounded border border-ink/10 p-2">
                <p className="text-muted">{S.perKind}</p>
                <table className="mt-1 w-full font-mono text-xs">
                  <tbody>
                    {Object.entries(sel.usage.byKind).sort((a, b) => b[1].usd - a[1].usd).map(([k, v]) => (
                      <tr key={k} className="border-t border-ink/5">
                        <td className="py-0.5">{k}</td>
                        <td className="text-end">{v.calls}×</td>
                        <td className="text-end">${(v.usd / Math.max(1, v.calls)).toFixed(4)}</td>
                        <td className="text-end">${v.usd.toFixed(2)}</td>
                        <td className="text-end text-muted">{Math.round((v.in + v.out) / 1000)}k tok</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {sel.usage.byAgent && Object.keys(sel.usage.byAgent).length > 0 && (
              <div className="col-span-full rounded border border-ink/10 p-2">
                <p className="text-muted">{S.perAgent}</p>
                <table className="mt-1 w-full font-mono text-xs">
                  <tbody>
                    {Object.entries(sel.usage.byAgent).sort((a, b) => b[1].usd - a[1].usd).map(([k, v]) => (
                      <tr key={k} className="border-t border-ink/5">
                        <td className="py-0.5">{k}</td>
                        <td className="text-end">{v.calls}×</td>
                        <td className="text-end">${(v.usd / Math.max(1, v.calls)).toFixed(4)}</td>
                        <td className="text-end">${v.usd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="rounded border border-ink/10 p-2"><p className="text-muted">{S.trialRenewed}</p><p className="font-mono">{sel.user.trialEnds.slice(0, 10)} · {sel.user.renewedAt ?? "—"}</p><p className="font-mono text-xs text-muted">joined {sel.user.createdAt.slice(0, 10)}</p></div>
            <div className="rounded border border-ink/10 p-2"><p className="text-muted">{S.integrations}</p><p className="font-mono">{sel.connections.length ? sel.connections.map((c) => c.provider).join(", ") : "none"}</p></div>
            <div className="rounded border border-ink/10 p-2"><p className="text-muted">{S.brandsEtc}</p><p className="font-mono">{sel.brands.length} · {sel.conversations} · {sel.referrals} · {sel.avgScore ?? "—"}</p></div>
          </div>
          {/* Top-up packs (rules 446-447): what is left of each, when it expires, what was paid and when, the reference and who
              activated it. Text only: the reference is what the founder typed. */}
          <div className="mt-4 rounded border border-ink/10 p-3 text-xs" data-testid="topups-detail">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted">{S.topups}{sel.user.topups?.length ? ` · ${formatCount(sel.user.topups.reduce((n, l) => n + l.left, 0))}` : ""}</p>
              <button disabled={busy || !topupsSold(sel.user.plan as Plan)} title={topupsSold(sel.user.plan as Plan) ? S.addTopup : S.topupTrial} onClick={() => addTopup(sel.user)} className="btn btn-secondary btn-xs">{S.addTopup}</button>
            </div>
            {!topupsSold(sel.user.plan as Plan) && <p className="mt-1 text-muted">{S.topupTrial}</p>}
            {/* One entry point for a top-up's payment (rule 454): this block records it, the Payments panel never does. */}
            <p className="mt-1 text-muted" data-topup-pay-note>{S.topupPayNote}</p>
            <p className="mt-1 text-muted" data-topup-refund-note>{S.topupRefundNote}</p>
            {!sel.user.topups?.length ? <p className="mt-1 text-muted">{S.noTopups}</p> : (
              <table className="mt-1 w-full font-mono">
                <tbody>
                  {sel.user.topups.map((l) => (
                    <tr key={l.id} className="border-t border-ink/5" data-lot={l.id}>
                      <td className="py-0.5 pe-2" dir="ltr">{formatCount(l.left)} / {formatCount(l.credits)} {S.topupLeft}</td>
                      <td className="pe-2">{S.topupExpires} <span dir="ltr">{l.expiresAt.slice(0, 10)}</span></td>
                      <td className="pe-2">{S.topupPaid} <span dir="ltr">{l.paidSar} SAR</span> {S.topupOn} <span dir="ltr">{l.paidOn}</span></td>
                      <td className="pe-2" dir="auto">{l.ref ? `${S.topupRef} ${l.ref}` : ""}</td>
                      <td className="pe-2" dir="ltr">{S.topupBy} {l.by}</td>
                      {/* Rule 460: a refunded pack shows its refund (the transfer's reference is the founder's own text);
                          a paid pack with credits left can be refunded once. */}
                      <td className="pe-2" dir="auto" data-refund={l.refund ? "done" : undefined}>{l.refund
                        ? <>{S.topupRefunded(l.refund.credits, sarText(l.refund.sar), l.refund.on)}{l.refund.ref ? ` · ${S.topupRef} ${l.refund.ref}` : ""}
                          {/* Rule 465: the refund is on the pack but not on its payment yet (a request that stopped). */}
                          {sel.unfinishedRefunds?.includes(l.id) && <> · <button type="button" disabled={busy} title={S.finishRefundTitle} onClick={() => finishRefund(sel.user, l)} className="text-danger underline" data-finish-refund>{S.finishRefund}</button></>}</>
                        : l.paidSar > 0 && l.left > 0 && <button type="button" disabled={busy} onClick={() => refundTopup(sel.user, l)} className="text-ink underline">{S.refundTopup}</button>}</td>
                      <td className="text-end"><button type="button" disabled={busy} onClick={() => voidTopup(sel.user, l)} className="text-danger underline">{S.voidTopup}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <h3 className="mt-4 text-xs uppercase tracking-wide text-muted">{S.brandFile}</h3>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-lilac p-3 text-xs" dir="auto">{sel.brand ? JSON.stringify(sel.brand, null, 2) : "— not completed —"}</pre>
          <h3 className="mt-4 text-xs uppercase tracking-wide text-muted">{S.generated} ({sel.tasks.length}) · {S.approved} {sel.tasks.filter((t) => t.status === "approved").length} · {S.rejected} {sel.tasks.filter((t) => t.status === "rejected").length}</h3>
          <ul className="mt-2 grid max-h-96 gap-2 overflow-auto">
            {sel.tasks.map((t) => (
              <li key={t.id} className="rounded border border-ink/10 p-3 text-xs">
                <div className="flex justify-between text-muted"><span>{t.type} · {t.channel} · {t.status}{t.quality ? ` · judge ${t.quality.score}` : ""}</span><span>{t.createdAt.slice(0, 16).replace("T", " ")}</span></div>
                <p className="mt-1 whitespace-pre-wrap" dir="auto">{(t.editedBody ?? t.body).slice(0, 600)}</p>
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-xs uppercase tracking-wide text-muted">{S.activity}</h3>
          {(sel.activity ?? []).map((b) => (
            <div key={b.brand} className="mt-2 max-h-72 overflow-auto rounded border border-ink/10 p-2">
              <p className="text-xs text-muted" dir="auto">{b.name} · {b.rows.length}</p>
              {b.rows.length === 0 ? <p className="text-xs text-muted">{S.activityNone}</p> : (
                <table className="mt-1 w-full font-mono text-xs">
                  <tbody>
                    {/* Text only: the note is a title or file name a model or an outside app wrote. */}
                    {b.rows.map((a, i) => (
                      <tr key={`${a.at}-${i}`} className="border-t border-ink/5 align-top">
                        <td className="py-0.5 pe-2 whitespace-nowrap">{a.at.slice(0, 16).replace("T", " ")}</td>
                        <td className="pe-2">{a.agent ?? "—"}</td>
                        <td className="pe-2">{a.kind}{a.outcome ? ` · ${a.outcome}` : ""}{a.score !== undefined ? ` · ${a.score}` : ""}</td>
                        <td className="pe-2">{a.via}</td>
                        <td className="pe-2" dir="ltr">{a.by.kind}{a.by.email && a.by.kind === "member" ? ` · ${a.by.email}` : ""}</td>
                        <td className="pe-2 text-end">{a.credits ?? ""}</td>
                        <td dir="auto">{a.note ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
