"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { adminFetch } from "@/lib/admin-fetch";
import { newPaymentId } from "./PaymentsPanel";
import { videoGrantRequest } from "./EntitlementsTable";
import { ksaDay, sarText } from "@/lib/partner-rules";
import { ADMIN_INPUT_ERRORS, parseBrandCap, parseChat, parseCreditDelta, parseDealForm, parseImpersonateMinutes, parseRefundForm, parseSeats, parseTopupForm, parseTrialDays, type Parsed } from "@/lib/admin-input";
import { USER_FILTERS, USER_PAGE_SIZES, parseUserQuery, userQueryParams, type TileCounts, type UserFilter, type UserQuery, type UserSort } from "@/lib/admin-users";
import TempPasswordDialog from "./TempPasswordDialog";
import { AGENCY_MIN, PLANS, TOPUP_PACKS, formatCount, topupPriceSar, type AgencyDeal } from "@/lib/pricing";
import type { TopupLot } from "@/lib/topups";
// The refund amount the founder is shown, computed as the server computes it (rule 460). topups.ts is client-safe (rule 451).
import { unusedRefundSar } from "@/lib/topups";
import { EndedNotice, PlanTiles, STR, useAdminEnded, type Detail, type MemberDetail, type PlanTotal, type SectionProps, type TeamChange, type U } from "./shared";
import { useAdminForm, type ActionSpec, type FieldSpec } from "./AdminForm";
import { DataTable, Pager, type Column } from "./DataTable";
import UserSheet, { chatLow } from "./UserSheet";
import Sheet from "@/components/ui/Sheet";
import Badge from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Field";
import { USERS_COPY } from "./users-copy";

/** A new "Refund unused" request id, `rf_` and 18 hex characters (POST /api/admin/topups, rule 460). */
const newRefundId = () => `rf_${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
/** A prompt's words as a field label: the trailing colon goes. */
const lab = (s: string) => s.replace(/[:：]\s*$/, "");
const ok = <T,>(value: T): Parsed<T> => ({ ok: true, value });
/** The only places an impersonation may send the browser (rule 1188); anything else goes to the console's own language. */
export const IMPERSONATE_REDIRECT = /^\/(ar|en)\/app$/;

type TableAnswer = { users: U[]; matched: number; page: number; pages: number; per: number; facets: { all: number; plan: Record<string, number>; filter: Record<UserFilter, number> }; tiles: TileCounts; total: PlanTotal | null };

/**
 * GET /api/admin/plan?view=table (rule 1178): one page of accounts the server filtered and sorted, the counts for the
 * filter menus and the tiles. A slower answer to an older query is dropped, so typing never shows a stale page.
 */
function useUserTable(query: UserQuery) {
  const [data, setData] = useState<TableAnswer | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const key = userQueryParams(query).toString();
  const load = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    const p = new URLSearchParams(key);
    p.set("view", "table");
    const r = await adminFetch(`/api/admin/plan?${p.toString()}`);
    if (n !== seq.current) return;
    if (r.status === 401) { setLoading(false); return; }
    const j = (await r.json().catch(() => null)) as ({ ok?: boolean } & TableAnswer) | null;
    if (n !== seq.current) return;
    if (j?.ok) setData(j);
    setLoading(false);
  }, [key]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  return { data, loading, load };
}

/**
 * Founder console, Users (/{lang}/admin/users): the account table (rule 1178: filtered, sorted and paged on the server,
 * the query in the address so a link or a reload keeps it), an account's sheet (rule 1180) and every founder action on
 * it. Each change opens its form first (rule 1176): the fields, a reason of 3 to 200 characters, and for a delete or a
 * member removal the email typed again. Cancel or Escape sends nothing. `?q=` opens the list filtered.
 */
export default function Users({ lang, keySession }: SectionProps) {
  const ended = useAdminEnded();
  const S = STR[lang];
  const UC = USERS_COPY[lang];
  const [askForm, formDialog] = useAdminForm(lang);
  // The overview's recent sign-ups link to /{lang}/admin/users?q={email}: the list opens filtered to that account.
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const query = useMemo(() => parseUserQuery(new URLSearchParams(search.toString())), [search]);
  const { data, loading, load } = useUserTable(query);
  const [text, setText] = useState(query.q);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sel, setSel] = useState<Detail | null>(null);
  const [memberSel, setMemberSel] = useState<MemberDetail | null>(null);
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

  /** A new query in the address (read at the moment of the change, so a debounced search keeps the other choices). */
  function setQuery(patch: Partial<UserQuery>) {
    const now = parseUserQuery(new URLSearchParams(window.location.search));
    const p = userQueryParams({ ...now, page: 1, ...patch }).toString();
    router.replace(p ? `${pathname}?${p}` : pathname, { scroll: false });
  }
  function onText(v: string) {
    setText(v);
    if (typing.current) clearTimeout(typing.current);
    typing.current = setTimeout(() => setQuery({ q: v.trim().slice(0, 120) }), 300);
  }
  const errText = (code: string) => (ADMIN_INPUT_ERRORS[lang] as Record<string, string>)[code] ?? code;
  const failed = (email: string, code: string | number) => `${email}: ${typeof code === "string" ? errText(code) : code}`;
  const reload = async (email?: string) => {
    await load();
    if (email && sel?.user.email === email) await open(email);
  };

  /** The form each users-route action asks first (rule 1176). Every one asks a reason; deletes ask the email again. */
  function actionSpec(email: string, action: string, extra: Record<string, unknown>): ActionSpec<object> {
    const none = () => ok({});
    const base = { subject: email, fields: [] as FieldSpec[], parse: none };
    switch (action) {
      case "suspend": return { ...base, title: UC.suspendTitle, message: UC.suspendNote, destructive: true, submitLabel: S.suspend };
      case "unsuspend": return { ...base, title: UC.unsuspendTitle, submitLabel: S.unsuspend };
      case "extendTrial": return {
        ...base, title: UC.trialTitle,
        fields: [{ name: "days", label: lab(S.promptDays), initial: "7", ltr: true }],
        parse: (v) => { const days = parseTrialDays(v.days); return days === null ? { ok: false, error: "bad_days" } : ok({ days }); },
      };
      case "resetPassword": return { ...base, title: UC.resetTitle, message: UC.resetNote, destructive: true, submitLabel: S.reset };
      case "resendVerification": return { ...base, title: UC.resendTitle, submitLabel: S.resendCode };
      case "setLang": return { ...base, title: UC.langTitle, message: `${S.emailsIn} ${extra.lang === "en" ? S.english : S.arabic}` };
      case "delete": return { ...base, title: UC.deleteTitle, message: UC.deleteNote, destructive: true, submitLabel: S.del, fields: [{ name: "confirm", label: UC.typeEmail, mustMatch: email, ltr: true }] };
      case "removeMember": return { ...base, title: UC.removeMemberTitle, destructive: true, submitLabel: S.removeMember, fields: [{ name: "confirm", label: UC.typeEmail, mustMatch: email, ltr: true }] };
      case "impersonate": return {
        ...base, title: UC.impersonateTitle, message: UC.impersonateNote, destructive: true, submitLabel: UC.impersonateGo,
        fields: [{ name: "minutes", label: UC.impersonateFor, kind: "select", initial: "60", options: UC.impersonateMinutes }],
        parse: (v) => { const minutes = parseImpersonateMinutes(v.minutes); return minutes === null ? { ok: false, error: "bad_minutes" } : ok({ minutes }); },
      };
      default: return { ...base, title: action };
    }
  }

  /** A users-route action: its form first, then the request. Cancel sends nothing. */
  async function act(email: string, action: string, extra: Record<string, unknown> = {}) {
    const v = await askForm(actionSpec(email, action, extra));
    if (!v) return null;
    return send(email, action, { ...extra, ...v });
  }
  async function send(email: string, action: string, body: Record<string, unknown>) {
    setBusy(true);
    type Answer = { ok?: boolean; error?: string; tempPassword: string; redirect: string };
    let j: Answer;
    let status = 0;
    try {
      const r = await adminFetch(`/api/admin/users/${encodeURIComponent(email)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) });
      status = r.status;
      j = (await r.json().catch(() => ({}))) as Answer;
    } catch {
      setBusy(false);
      setMsg(`${email}: ${UC.network}`);
      return null;
    }
    setBusy(false);
    if (!j.ok) { setMsg(failed(email, j.error ?? status)); return j; }
    if (action === "resetPassword") { setTemp({ email, password: j.tempPassword }); setMsg(`${email}: ${UC.passwordReset}`); }
    else if (action === "impersonate") { window.location.assign(IMPERSONATE_REDIRECT.test(j.redirect) ? j.redirect : `/${lang}/app`); return j; }
    else if (action === "delete") { setMsg(`${email}: ${UC.deleted}`); setSel(null); }
    else if (action === "resendVerification") setMsg(`${email}: ${S.codeSent}`);
    else if (action === "removeMember") { setMsg(`${email}: ${UC.memberRemoved}`); setMemberSel(null); return j; }
    else setMsg(`${email}: ${UC.done}`);
    await load();
    if (sel && action !== "delete") await open(email);
    return j;
  }
  /** "Extend trial" (rules 960, 1176): a whole number of days from 1 to 90 in its form; a bad number is said in the form. */
  async function extendTrial(email: string) {
    await act(email, "extendTrial");
  }

  /** A deal as "credits @ price SAR", or that the account has no deal and counts as Business. */
  const dealText = (d?: AgencyDeal | null) => (d ? `${formatCount(d.credits)} @ ${formatCount(d.priceSar)} SAR` : S.noDeal);
  /** The team change a plan or seat change made, in one line: who was paused, who came back, how many invites went. */
  const teamLine = (t?: TeamChange) => (!t ? "" : [t.disabled.length ? `${S.teamPaused}: ${t.disabled.join(", ")}` : "", t.enabled.length ? `${S.teamResumed}: ${t.enabled.join(", ")}` : "", t.cancelled.length ? `${S.teamCancelled}: ${t.cancelled.length}` : ""].filter(Boolean).join(" · "));
  /** POST /api/admin/plan with the form's body (its reason included); `said` words the success. */
  async function postPlan<J extends { ok?: boolean; error?: string }>(email: string, body: object, said: (j: J) => string) {
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, ...body }) });
      const j = (await r.json().catch(() => ({}))) as J;
      setMsg(j.ok ? said(j) : failed(email, j.error ?? r.status));
    } catch {
      setMsg(`${email}: ${UC.network}`);
    }
    await reload(email);
    setBusy(false);
  }
  async function setPlan(u: U) {
    const v = await askForm({
      title: UC.planTitle, subject: u.email, message: UC.planNote,
      fields: [{ name: "plan", label: UC.planField, kind: "select", initial: u.plan, options: PLANS.map((p) => ({ value: p, label: p })) }],
      parse: (f) => ((PLANS as readonly string[]).includes(f.plan) ? ok({ plan: f.plan }) : { ok: false, error: "failed" }),
    });
    if (!v) return;
    await postPlan<{ ok?: boolean; error?: string; team?: TeamChange }>(u.email, v, (j) => [`${u.email} → ${v.plan}`, teamLine(j.team)].filter(Boolean).join(" · "));
  }
  /** The founder seat override (spec §5; Agency "seats sized to your team"). 0 clears it back to the plan's number. */
  async function setSeats(u: U) {
    const v = await askForm({
      title: UC.seatsTitle, subject: u.email,
      fields: [{ name: "seats", label: lab(S.promptSeats), initial: String(u.seatsOverride ?? u.seats ?? ""), ltr: true }],
      parse: (f) => parseSeats(f.seats),
    });
    if (!v) return;
    await postPlan<{ ok?: boolean; error?: string; user?: { seats: number }; team?: TeamChange }>(u.email, v, (j) => [`${u.email}: ${S.seats} ${j.user?.seats ?? ""}`, teamLine(j.team)].filter(Boolean).join(" · "));
  }
  /**
   * The founder brand cap (rule 1393): how many brands the account may have active, mostly for Agency. 0 clears it back
   * to the plan's number. POST /api/admin/brand-cap, with the reason, under the account's lock; it archives nothing.
   */
  async function setBrandCap(u: U) {
    const v = await askForm({
      title: UC.brandsTitle, subject: u.email, message: UC.brandsNote,
      fields: [{ name: "brandCap", label: UC.brandsField, initial: String(u.brandCapOverride ?? u.brandCap ?? ""), ltr: true }],
      parse: (f) => parseBrandCap(f.brandCap),
    });
    if (!v) return;
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/brand-cap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, ...v }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; user?: { brandCap: number; activeBrands: number } };
      setMsg(j.ok ? `${u.email}: ${UC.brands} ${j.user?.activeBrands ?? ""}/${j.user?.brandCap ?? ""}` : failed(u.email, j.error ?? r.status));
    } catch {
      setMsg(`${u.email}: ${UC.network}`);
    }
    await reload(u.email);
    setBusy(false);
  }
  /**
   * The founder chat override (rule 316): the account's messages per month, or for the whole trial. 0 is an override that
   * stops chat, so it is sent as 0; empty or "plan" clears the override back to the plan's number (null). Checked here
   * with the server's own test (`parseChat` on `isChatOverride`), and again by the server.
   */
  async function setChat(u: U) {
    const v = await askForm({
      title: UC.chatTitle, subject: u.email,
      fields: [{ name: "chat", label: lab(S.promptChat), initial: u.chatOverride != null ? String(u.chatOverride) : "", ltr: true }],
      parse: (f) => parseChat(f.chat),
    });
    if (!v) return;
    await postPlan<{ ok?: boolean; error?: string; user?: { chatAllowance: number; chatOverride: number | null } }>(u.email, v, (j) => `${u.email}: ${S.chat} ${j.user?.chatAllowance ?? ""}${j.user?.chatOverride == null ? "" : ` (${S.seatsOverride})`}`);
  }
  /**
   * The founder's video grant (rule 783): every video model for a trial, through the end of a UTC day, and a note. An
   * empty day clears the grant, and is refused in the form when the account has none (ruling R13, so no no-op
   * `admin:log` entry). The day itself is checked by the server (`parseVideoGrant`, which pulls the store into whatever
   * imports it, so the console cannot), which answers 400 `bad_grant`; the error is shown and the detail read again.
   */
  async function setVideoGrant(u: U) {
    const have = sel?.user.email === u.email ? sel.entitlements?.grants.video : null;
    const v = await askForm({
      title: UC.grantTitle, subject: u.email,
      fields: [
        { name: "until", label: lab(S.promptGrantUntil), kind: "date", initial: have && !have.expired ? have.until : "", ltr: true },
        { name: "note", label: lab(S.promptGrantNote), initial: have?.note ?? "", maxLength: 200 },
      ],
      parse: (f) => { const body = videoGrantRequest(f.until, f.note, !!have); return body ? ok(body) : { ok: false, error: "bad_grant" }; },
    });
    if (!v) return;
    await postPlan(u.email, v, () => `${u.email}: ${S.grantVideo} ${v.videoGrant ? v.videoGrant.until : UC.done}`);
  }
  /**
   * An Agency deal in one form: monthly credits and a SAR price at or above the Business rate, and optionally the seats.
   * Checked here with the same parser the server uses (`parseDealForm` on `parseDeal`, src/lib/pricing.ts); the server
   * checks it again and refuses a deal on any plan but agency. Empty credits clears the deal (the account then counts as
   * Business, and the server clears the deal's seats too).
   *
   * The account's first deal is sent with plan "agency", which grants the deal's allowance at once: the plan change that
   * made the account Agency gave it Business's credits, and a deal sent alone keeps the balance until the next renewal,
   * so a new 3,000-credit customer would otherwise hold Business's credits for the first month. A change to an existing
   * deal has an "apply now" box (the same) or leaves it for the next renewal (the deal alone).
   */
  async function setDeal(u: U) {
    const v = await askForm({
      title: UC.dealTitle, subject: u.email,
      fields: [
        { name: "credits", label: lab(S.promptDealCredits), initial: String(u.deal?.credits ?? AGENCY_MIN.credits), ltr: true },
        { name: "price", label: lab(S.promptDealPrice), initial: String(u.deal?.priceSar ?? AGENCY_MIN.priceSar), ltr: true },
        { name: "seats", label: lab(S.promptDealSeats), initial: String(u.seatsOverride ?? ""), ltr: true },
        ...(u.deal ? [{ name: "applyNow", label: UC.dealApplyNow, kind: "check" as const }] : []),
      ],
      parse: (f) => parseDealForm({ credits: f.credits, price: f.price, seats: f.seats, applyNow: f.applyNow === "1" }, !!u.deal),
    });
    if (!v) return;
    await postPlan<{ ok?: boolean; error?: string; user?: { deal?: AgencyDeal | null }; team?: TeamChange }>(u.email, v, (j) => [`${u.email}: ${S.deal} ${dealText(j.user?.deal)}`, teamLine(j.team)].filter(Boolean).join(" · "));
  }
  async function addCredits(email: string) {
    const v = await askForm({
      title: UC.creditsTitle, subject: email,
      fields: [{ name: "credits", label: lab(S.promptCredits), initial: "100", ltr: true }],
      parse: (f) => parseCreditDelta(f.credits),
    });
    if (!v) return;
    await postPlan(email, v, () => `${email} ${v.addCredits > 0 ? "+" : ""}${formatCount(v.addCredits)} ${UC.creditsWord}`);
  }
  /**
   * A pack paid for outside the app (rules 446-447, 454): the pack, the amount paid excluding VAT (its list price until
   * the founder types another), the payment date (today in Riyadh by default, `ksaDay`, the day every recorded payment
   * uses), the payment reference and the reason. The pack is checked here with the server's own test (`isTopupPack` in
   * `parseTopupForm`); the server checks every field again (`parseTopup`) and refuses a trial. The server records the
   * pack's payment, and the partner's commission when one is due, with the pack: the founder does not record it in
   * Payments. Through `adminFetch` (rule 436).
   */
  async function addTopup(u: U) {
    const v = await askForm({
      title: UC.topupTitle, subject: u.email,
      fields: [
        { name: "pack", label: lab(S.promptTopupPack), kind: "select", initial: String(TOPUP_PACKS[0]), options: TOPUP_PACKS.map((n) => ({ value: String(n), label: formatCount(n) })) },
        { name: "paid", label: lab(S.promptTopupPaid), ltr: true, follow: (f) => String(topupPriceSar(Number(f.pack))) },
        { name: "date", label: lab(S.promptTopupDate), kind: "date", initial: ksaDay(), ltr: true },
        { name: "ref", label: lab(S.promptTopupRef), ltr: true, maxLength: 200 },
      ],
      parse: (f) => parseTopupForm({ pack: f.pack, paid: f.paid, date: f.date, ref: f.ref }),
    });
    if (!v) return;
    const { reason, credits, paidSar, paidOn, ref } = v;
    const pack = { email: u.email, action: "add", credits, paidSar, paidOn, ref };
    const key = JSON.stringify(pack);
    if (pendingTopup.current?.key !== key) pendingTopup.current = { key, id: newPaymentId() };
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/topups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...pack, paymentId: pendingTopup.current.id, reason }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; credits?: number; payment?: { commission?: { sar: number } } | null };
      // A definite answer ends the attempt: a success, or a refusal that wrote nothing. A server error keeps the id.
      if (j.ok || (r.status >= 400 && r.status < 500)) pendingTopup.current = null;
      setMsg(j.ok ? `${u.email}: ${S.topups} +${formatCount(credits)} → ${j.credits ?? ""}${j.payment?.commission ? ` · ${S.commission} ${sarText(j.payment.commission.sar)}` : ""}` : failed(u.email, j.error ?? r.status));
    } catch {
      setMsg(`${u.email}: ${UC.network}`);
    }
    await load();
    if (sel?.user.email === u.email) { await open(u.email); setPayTick((n) => n + 1); }
    setBusy(false);
  }
  /**
   * Void a pack (a payment reversed, a pack recorded by mistake): its payment and the partner's commission on it are
   * voided, then its unspent credits leave the balance (rule 455). Logged. Through `adminFetch` (rule 436).
   */
  async function voidTopup(u: U, l: TopupLot) {
    const v = await askForm({ title: UC.voidTitle, subject: u.email, message: S.confirmVoid(l.credits, l.left), destructive: true, submitLabel: S.voidTopup, fields: [], parse: () => ok({}) });
    if (!v) return;
    const { reason } = v;
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/topups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, action: "void", id: l.id, reason }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; credits?: number; removed?: number };
      setMsg(j.ok ? `${u.email}: ${S.topups} ${S.voidTopup} −${formatCount(j.removed ?? 0)} → ${j.credits ?? ""}` : failed(u.email, j.error ?? r.status));
    } catch {
      setMsg(`${u.email}: ${UC.network}`);
    }
    await load();
    if (sel?.user.email === u.email) { await open(u.email); setPayTick((n) => n + 1); }
    setBusy(false);
  }
  /**
   * Refund a live pack's unused credits (founder decision of 2026-10-02, rule 460): the customer asked, the pack has not
   * expired. The form shows the amount (`unusedRefundSar`: credits left × the price per credit paid, excluding VAT) and
   * sends the credits left it showed, so the server refuses (`left_changed`) rather than record another amount; then the
   * transfer's date (today in Riyadh by default), its reference (required) and the reason. One request id per refund,
   * kept until a definite answer, so a retry is recognised. Through `adminFetch` (rule 436).
   */
  async function refundTopup(u: U, l: TopupLot) {
    const v = await askForm({
      title: UC.refundTitle, subject: u.email, message: S.confirmRefund(l.left, l.credits, sarText(unusedRefundSar(l))), destructive: true, submitLabel: S.refundTopup,
      fields: [
        { name: "date", label: lab(S.promptRefundDate), kind: "date", initial: ksaDay(), ltr: true },
        { name: "ref", label: lab(S.promptRefundRef), ltr: true, maxLength: 200 },
      ],
      parse: (f) => parseRefundForm({ date: f.date, ref: f.ref }),
    });
    if (!v) return;
    const { reason, on, ref } = v;
    const ask = { email: u.email, action: "refund", id: l.id, credits: l.left, on: on.trim(), ref };
    const key = JSON.stringify(ask);
    if (pendingRefund.current?.key !== key) pendingRefund.current = { key, id: newRefundId() };
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/topups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...ask, refundId: pendingRefund.current.id, reason }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; credits?: number; refunded?: { credits: number; sar: number }; payment?: { commission?: { sar: number } } | null; left?: number; sar?: number };
      // A definite answer ends the attempt: a success, or a refusal that wrote nothing. A server error keeps the id.
      if (j.ok || (r.status >= 400 && r.status < 500)) pendingRefund.current = null;
      setMsg(j.ok
        ? `${u.email}: ${S.refundTopup} −${formatCount(j.refunded?.credits ?? 0)} · ${sarText(j.refunded?.sar ?? 0)} SAR → ${j.credits ?? ""}${j.payment?.commission ? ` · ${S.commission} ${sarText(j.payment.commission.sar)}` : ""}`
        : j.error === "left_changed" ? `${u.email}: ${S.leftChanged(j.left ?? 0, sarText(j.sar ?? 0))}` : failed(u.email, j.error ?? r.status));
    } catch {
      setMsg(`${u.email}: ${UC.network}`);
    }
    await load();
    if (sel?.user.email === u.email) { await open(u.email); setPayTick((n) => n + 1); }
    setBusy(false);
  }
  /**
   * "Finish refund" (rule 465): a refund whose credits left the pack but whose payment was not marked (the request stopped
   * in between) is finished from the pack's own refund record: no credits, day or reference are sent, only the reason
   * its form asks (rule 1176). Through `adminFetch`.
   */
  async function finishRefund(u: U, l: TopupLot) {
    const v = await askForm({ title: S.finishRefund, subject: u.email, message: S.finishRefundTitle, fields: [], parse: () => ok({}) });
    if (!v) return;
    const { reason } = v;
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/topups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, action: "refund", id: l.id, finish: true, reason }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; refunded?: { credits: number; sar: number }; payment?: { commission?: { sar: number } } | null };
      setMsg(j.ok
        ? `${u.email}: ${S.finishRefund} · ${formatCount(j.refunded?.credits ?? 0)} · ${sarText(j.refunded?.sar ?? 0)} SAR${j.payment?.commission ? ` · ${S.commission} ${sarText(j.payment.commission.sar)}` : ""}`
        : failed(u.email, j.error ?? r.status));
    } catch {
      setMsg(`${u.email}: ${UC.network}`);
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

  /** The chat cell's tooltip: what to click, and what chat cost this month in all and per message. */
  const chatTitle = (u: U) => [S.setChat, `${S.chatCost} ${(u.chatUsd ?? 0).toFixed(2)}`, `${S.perMsg} ${u.usdPerMsg == null ? "—" : u.usdPerMsg.toFixed(4)}`, `${S.overflow}: ${u.plan === "trial" ? S.overflowTrial : u.chatOverflowOn ? S.overflowOn : S.overflowOff}`].join(" · ");
  const columns: Column<U, UserSort>[] = [
    {
      id: "email", header: S.email, sort: "email", className: "min-w-56",
      cell: (u) => (
        <span className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => open(u.email)} className="min-h-[var(--hit-min)] text-start text-ink underline pointer-fine:min-h-6"><bdi dir="ltr">{u.email}</bdi></button>
          {u.suspended && <Badge tone="danger">{UC.suspendedBadge}</Badge>}
          {!u.emailVerifiedAt && <span className="rounded border border-border px-1.5 text-xs text-muted" data-testid="unverified">{S.unverified}</span>}
        </span>
      ),
    },
    { id: "name", header: S.name, cell: (u) => <span dir="auto">{u.name}</span> },
    { id: "phone", header: S.phone, className: "font-mono text-xs", cell: (u) => <a href={`https://wa.me/${u.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="underline" dir="ltr">{u.phone}</a> },
    {
      id: "plan", header: S.plan, sort: "plan",
      cell: (u) => (
        <span className="flex flex-wrap items-center gap-2">
          <span>{u.plan}</span>
          <button type="button" disabled={busy} onClick={() => setPlan(u)} className="min-h-[var(--hit-min)] text-xs underline decoration-dotted pointer-fine:min-h-6">{UC.change}</button>
          {u.plan === "agency" && <button type="button" disabled={busy} onClick={() => setDeal(u)} title={S.setDeal} className="min-h-[var(--hit-min)] whitespace-nowrap text-xs underline decoration-dotted pointer-fine:min-h-6">{S.setDeal} <span className="font-mono" dir="ltr">{dealText(u.deal)}</span></button>}
        </span>
      ),
    },
    {
      id: "seats", header: S.seats, className: "whitespace-nowrap text-xs",
      cell: (u) => <><button type="button" disabled={busy} onClick={() => setSeats(u)} title={S.setSeats} className="min-h-[var(--hit-min)] font-mono underline decoration-dotted pointer-fine:min-h-6">{u.seats ?? "—"}</button>{u.seatsOverride != null && <span className="ms-1 text-muted">({S.seatsOverride})</span>}</>,
    },
    {
      id: "brands", header: UC.brands, className: "whitespace-nowrap text-xs",
      cell: (u) => <><button type="button" disabled={busy} onClick={() => setBrandCap(u)} title={UC.brandsTitle} className="min-h-[var(--hit-min)] font-mono underline decoration-dotted pointer-fine:min-h-6">{u.brandCap ?? "—"}</button>{u.brandCapOverride != null && <span className="ms-1 text-muted">({S.seatsOverride})</span>}</>,
    },
    { id: "credits", header: S.credits, sort: "credits", className: "font-mono", cell: (u) => <>{u.credits}{(u.topupCredits ?? 0) > 0 && <span className="ms-1 text-xs text-muted" title={S.topups}>({u.topupCredits} {S.ofTopup})</span>}</> },
    {
      // The raw count against the allowance (it can pass one lowered mid-period); "+N msgs on credits (M credits)" this
      // month. Red when the count reached the allowance or little is left.
      id: "chat", header: S.chat,
      cell: (u) => (
        <span className={`whitespace-nowrap text-xs ${chatLow(u.chatUsed ?? 0, u.chatAllowance, u.chatLeft) ? "font-semibold text-danger" : ""}`} data-testid="chat-cell">
          <button type="button" disabled={busy} onClick={() => setChat(u)} title={chatTitle(u)} className="min-h-[var(--hit-min)] font-mono underline decoration-dotted pointer-fine:min-h-6" dir="ltr">{u.chatUsed ?? 0} / {u.chatAllowance ?? "—"}</button>
          {u.chatOverride != null && <span className="ms-1 text-muted">({S.seatsOverride})</span>}
          {((u.chatOverflowUsed ?? 0) > 0 || (u.chatCredits ?? 0) > 0) && <span className="ms-1 font-mono">{S.onCredits(u.chatOverflowUsed ?? 0, u.chatCredits ?? 0)}</span>}
        </span>
      ),
    },
    { id: "tokens", header: S.tokensMo, className: "font-mono text-xs", cell: (u) => <span title={`${u.calls ?? 0} ${UC.modelCalls}`}>{((u.tokens ?? 0) / 1000).toFixed(1)}k</span> },
    { id: "cost", header: S.costMo, className: "font-mono text-xs", cell: (u) => (u.usd ?? 0).toFixed(2) },
    // Plan price against this month's model cost. Red once the account keeps less than half of what it pays.
    { id: "margin", header: S.marginMo, cell: (u) => <span className={`font-mono text-xs ${u.marginPct == null ? "text-muted" : u.marginPct < 50 ? "font-semibold text-danger" : ""}`} title={u.priceSar ? `${u.priceSar} SAR/mo` : ""}>{u.marginPct == null ? "—" : `${u.marginPct}%`}</span> },
    { id: "trialEnds", header: S.trialEnds, sort: "trialEnds", className: "font-mono text-xs", cell: (u) => (u.plan === "trial" ? u.trialEnds.slice(0, 10) : "—") },
    { id: "createdAt", header: S.joined, sort: "createdAt", className: "font-mono text-xs", cell: (u) => u.createdAt.slice(0, 10) },
    { id: "add", header: <span className="sr-only">{UC.actions}</span>, cell: (u) => <button type="button" disabled={busy} onClick={() => addCredits(u.email)} className="btn btn-secondary btn-xs min-h-[var(--hit-min)] whitespace-nowrap">{S.addCredits}</button> },
  ];
  const facets = data?.facets;
  const count = (n: number | undefined) => (n == null ? "" : ` (${n})`);
  return (
    <div className="grid gap-6">
      {formDialog}
      {temp && <TempPasswordDialog lang={lang} email={temp.email} password={temp.password} onClose={() => setTemp(null)} />}
      <PlanTiles lang={lang} counts={data?.tiles ?? null} total={data?.total ?? null} />
      {msg && !sel && <p role="status" className="text-sm text-ink" dir="auto">{msg}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-0 flex-1 basis-64 gap-1 text-xs text-muted">
          <span>{UC.searchLabel}</span>
          <Input type="search" value={text} onChange={(e) => onText(e.target.value)} placeholder={S.search} maxLength={120} />
        </label>
        <label className="grid gap-1 text-xs text-muted">
          <span>{UC.planFilter}</span>
          <Select value={query.plan} onChange={(e) => setQuery({ plan: e.target.value as UserQuery["plan"] })}>
            <option value="">{UC.allPlans}{count(facets?.all)}</option>
            {PLANS.map((p) => <option key={p} value={p}>{p}{count(facets?.plan[p])}</option>)}
          </Select>
        </label>
        <label className="grid gap-1 text-xs text-muted">
          <span>{UC.stateFilter}</span>
          <Select value={query.filter} onChange={(e) => setQuery({ filter: e.target.value as UserQuery["filter"] })}>
            <option value="">{UC.filters[""]}</option>
            {USER_FILTERS.map((f) => <option key={f} value={f}>{UC.filters[f]}{count(facets?.filter[f])}</option>)}
          </Select>
        </label>
        {/* Member logins are not in this list (they never enter users:all): an exact address is looked up instead. */}
        {text.includes("@") && <button type="button" disabled={busy} onClick={() => open(text.trim().toLowerCase())} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{S.lookup}</button>}
      </div>
      {data && <p className="text-xs text-muted" aria-live="polite">{UC.matched(data.matched, data.facets.all)}</p>}
      <DataTable
        lang={lang}
        caption={UC.caption}
        columns={columns}
        rows={data?.users ?? null}
        rowKey={(u) => u.email}
        sort={query.sort}
        dir={query.dir}
        // The same column flips its direction; a new one starts A to Z for text and newest or largest first otherwise.
        onSort={(k) => setQuery({ sort: k, dir: query.sort === k ? (query.dir === "desc" ? "asc" : "desc") : k === "email" || k === "plan" ? "asc" : "desc" })}
        loading={loading}
        rowClassName={(u) => (u.suspended ? "bg-agent-sami/20" : "")}
      />
      {data && <Pager lang={lang} page={data.page} pages={data.pages} per={data.per} sizes={USER_PAGE_SIZES} onPage={(p) => setQuery({ page: p })} onPer={(n) => setQuery({ per: n })} />}
      <p className="text-xs text-muted">{S.planNote}</p>
      <p className="text-xs text-muted">{S.chatNote}</p>
      {memberSel && (
        <Sheet lang={lang} label={`${S.memberLogin} ${memberSel.email}`} onClose={() => setMemberSel(null)} side="end">
          <div className="grid gap-3 p-5 pe-14 text-sm">
            <h2 className="font-display text-lg font-bold text-ink"><bdi dir="ltr">{memberSel.email}</bdi></h2>
            <p className="text-muted">{S.memberLogin} · {memberSel.role}{memberSel.disabled ? ` · ${memberSel.disabled}` : ""}</p>
            <p dir="auto">{memberSel.name} · {S.memberOf} <button type="button" onClick={() => open(memberSel.memberOf)} className="min-h-[var(--hit-min)] text-ink underline" dir="ltr">{memberSel.memberOf}</button> · {S.invitedBy} <bdi dir="ltr">{memberSel.invitedBy}</bdi> · <bdi dir="ltr">{memberSel.acceptedAt.slice(0, 10)}</bdi></p>
            {(!memberSel.ownerExists || !memberSel.onRoster) && <p className="text-danger">{[!memberSel.ownerExists ? S.ownerMissing : "", !memberSel.onRoster ? S.offRoster : ""].filter(Boolean).join(" · ")}</p>}
            {msg && <p role="status" className="text-sm text-ink" dir="auto">{msg}</p>}
            <button type="button" disabled={busy} onClick={() => act(memberSel.email, "removeMember")} className="btn btn-danger-solid btn-xs min-h-[var(--hit-min)] justify-self-start">{S.removeMember}</button>
          </div>
        </Sheet>
      )}
      {sel && (
        <UserSheet
          key={sel.user.email}
          lang={lang} sel={sel} busy={busy} msg={msg} payTick={payTick} onClose={() => setSel(null)} dealText={dealText}
          act={act} extendTrial={extendTrial} setVideoGrant={setVideoGrant} setPlan={setPlan} setSeats={setSeats} setChat={setChat} setDeal={setDeal}
          addCredits={addCredits} addTopup={addTopup} voidTopup={voidTopup} refundTopup={refundTopup} finishRefund={finishRefund}
        />
      )}
    </div>
  );
}
