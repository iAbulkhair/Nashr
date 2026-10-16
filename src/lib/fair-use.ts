import { createHash } from "node:crypto";
import { db } from "./db";
import { adminEmails, getUser, type User } from "./auth";
import { SAR_PER_USD } from "./pricing";
import { monthKey } from "./credits";
import { mediaCostKey } from "./usage";
import { topupRevenueSar } from "./topups";
import { notifyItem } from "./notifications";
import { isPaying, revenueSarOf, type MarginRow } from "./margin";
import { log } from "./log";

/**
 * The fair-use stop (rules 1720-1739, docs/system/flows.md section 73). Founder decision of 2026-10-13: "no need to
 * lawyer, just stop the service". When what an account cost us this month reaches 95% of
 * what it paid us this month (founder decision of 2026-10-13: 5% stays as margin, not 100%), its paid AI usage pauses in
 * code, before any provider call, until the next month, a top-up pack, or the founder lifts it.
 *
 * For one paying account (`isPaying`, src/lib/margin.ts: not suspended, not on the trial, a plan with a price) and one
 * UTC calendar month (`monthKey()`, the month the usage counters and the margin alert use):
 *
 *   costSar  = (usage:{email}:{month}:usd_micro + usage:{email}:{month}:media_usd_micro) / 1e6 × SAR_PER_USD
 *   limitSar = (netPriceSar(priceOf(u)) + top-up packs paid this month, net of VAT) × FAIR_USE_PCT / 100
 *   paused   = costSar >= limitSar, unless the founder lifted it for this month (`User.fairUseLift`)
 *
 * The cost is the margin alert's own (rule 1530): the same two counters, the same rate; no second counter. A top-up pack
 * is money paid, so it raises the limit by what was paid for it (`topupRevenueSar`, by the payment day the founder
 * enters): buying credits ends the pause. The trial is left to its own limits (30 chat messages, its credits, one
 * video), so it is never gated twice here.
 *
 * Checked at every place that spends money on a model or a render on the account's behalf, next to the gate that
 * already stood there: `reserveChatTurn` (web chat and MCP `ask_noor`), `generateBatch` (generate, routines, the
 * weekly plan, handoffs, chat tools, spend cards, MCP `generate_content`), `renderImage` / `renderVideo`, POST
 * /api/onboard, POST /api/instructions/test and the meeting transcript. tests/fair-use.test.ts pins the list.
 */

/** The limit, in percent of what the account paid this month. 95 (founder, 2026-10-13): the account may cost up to 95% of what it paid; 5% is kept as margin. */
export const FAIR_USE_PCT = 95;
/** The refusal code every gated path answers with (HTTP 402). */
export const FAIR_USE_ERROR = "fair_use" as const;
/** The founder's "an account just paused" marker lives a little longer than a month, so one alert per account a month. */
const ALERTED_TTL_S = 40 * 86400;

export type FairUse = {
  month: string;
  /** False for an account the stop does not apply to (the trial, a suspended account, a plan without a price). */
  applies: boolean;
  costSar: number;
  limitSar: number;
  /** The founder lifted the pause for this month. */
  lifted: boolean;
  paused: boolean;
};

const micro = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const sar = (n: number) => Math.round(n * 100) / 100;

/** Pure: the account's limit for `month`, SAR net of VAT: the plan's price plus the packs paid this month, × FAIR_USE_PCT. */
export function fairUseLimitSar(u: Pick<User, "plan" | "deal" | "topups">, month: string): number {
  return sar(((revenueSarOf(u) + topupRevenueSar([u], month)) * FAIR_USE_PCT) / 100);
}

/** Pure: whether the founder lifted the pause for `month`. */
export const liftedFor = (u: Pick<User, "fairUseLift">, month: string) => u.fairUseLift?.month === month;

/** Pure: the state from the cost already read. `costUsd` is model plus media, in USD. */
export function fairUseState(u: Pick<User, "plan" | "deal" | "suspended" | "topups" | "fairUseLift">, costUsd: number, month: string): FairUse {
  const applies = isPaying(u);
  const costSar = sar((Number.isFinite(costUsd) ? Math.max(0, costUsd) : 0) * SAR_PER_USD);
  const limitSar = applies ? fairUseLimitSar(u, month) : 0;
  const lifted = liftedFor(u, month);
  return { month, applies, costSar, limitSar, lifted, paused: applies && !lifted && costSar >= limitSar };
}

/** The account's state now: one MGET of the two counters, nothing read for an account the stop does not apply to. */
export async function fairUseOf(u: User, month = monthKey()): Promise<FairUse> {
  if (!isPaying(u)) return fairUseState(u, 0, month);
  const [model, media] = await db.mget<number>([`usage:${u.email}:${month}:usd_micro`, mediaCostKey(u.email, month)]);
  return fairUseState(u, (micro(model) + micro(media)) / 1e6, month);
}

/** The day the next month starts (UTC), YYYY-MM-DD: when a pause ends by itself. */
export function resumesOn(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/** What a gated path answers with: the code, the month, and the day it ends by itself. No cost, no limit, no other account. */
export type FairUseRefusal = { error: typeof FAIR_USE_ERROR; month: string; resumes: string };

/** The marker's key part: a hash of the email, so no address is part of a key name. */
const tag = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
export const fairUseAlertedKey = (month: string, email: string) => `fairuse:alerted:${month}:${tag(email)}`;

const PLAN_NAME: Record<"ar" | "en", Record<string, string>> = {
  ar: { starter: "المبتدئة", pro: "الاحترافية", business: "الأعمال", agency: "الوكالات" },
  en: { starter: "Starter", pro: "Pro", business: "Business", agency: "Agency" },
};

/** Pure: the founder's bell item for one paused account. The plan only: no email, no name (the console shows who). */
export function fairUseAlertText(plan: string, lang: "ar" | "en") {
  const p = PLAN_NAME[lang][plan] ?? plan;
  return lang === "ar"
    ? { title: `توقف الاستخدام المدفوع لحساب على باقة ${p}`, body: "بلغت تكلفة الحساب هذا الشهر 95% مما دفعه. توقفت المحادثات والتوليد والمهام المجدولة والوسائط حتى الشهر القادم أو شراء باقة شحن. يمكنك رفع الإيقاف من لوحة المؤسس، قسم الاستخدام." }
    : { title: `Paid usage paused for an account on ${p}`, body: "The account's cost this month reached 95% of what it paid. Chat, generation, routines and media are paused until next month or a top-up pack. You can lift the pause in the founder console, Usage." };
}

/**
 * Tell every founder (`ADMIN_EMAILS`) once a month per account, on the first refusal. Never throws: the refusal stands
 * whatever happens to the bell.
 */
async function alertFounders(u: Pick<User, "email" | "plan">, month: string): Promise<void> {
  try {
    if (!(await db.setNx(fairUseAlertedKey(month, u.email), 1, ALERTED_TTL_S))) return;
    const founders = (await Promise.all(adminEmails().map((e) => getUser(e)))).filter((f): f is User => !!f);
    await Promise.all(founders.map((f) => {
      const lang = f.lang === "en" ? "en" : "ar";
      return notifyItem(f.email, lang, { kind: "credits", ...fairUseAlertText(u.plan, lang), href: `/${lang}/admin/usage#margin` }, `fairuse:${month}:${tag(u.email)}`, 35);
    }));
  } catch (e) {
    log.error("fair_use_alert_failed", e);
  }
}

/**
 * The gate: null when the account may spend, else the refusal. Called before any provider call and before anything is
 * charged or counted. A failed read of the counters lets the request through (logged): the margin alert still tells the
 * founder, and an outage of the store must not stop every paying customer.
 */
export async function fairUseGate(u: User, month = monthKey()): Promise<FairUseRefusal | null> {
  let s: FairUse;
  try {
    s = await fairUseOf(u, month);
  } catch (e) {
    log.error("fair_use_read_failed", e);
    return null;
  }
  if (!s.paused) return null;
  await alertFounders(u, month);
  return { error: FAIR_USE_ERROR, month, resumes: resumesOn(month) };
}

/** Pure: the console's marks on the margin rows (rule 1733): paused, lifted by the founder, or nothing. */
export function markFairUse(rows: readonly MarginRow[], users: readonly User[], month: string): MarginRow[] {
  const by = new Map(users.map((u) => [u.email, u]));
  return rows.map((r) => {
    const u = by.get(r.email);
    if (!u) return r;
    const s = fairUseState(u, r.modelUsd + r.mediaUsd, month);
    return { ...r, fairUse: s.paused ? "paused" : s.lifted ? "lifted" : null };
  });
}

/** The sentence an MCP client (and the model relaying it) gets for a paused account. */
export function fairUseText(): string {
  return "Paused: this account's AI usage this month reached its plan's fair-use limit. Nothing was sent and nothing was charged. It resumes on the 1st of next month (UTC), or sooner when the owner buys a top-up pack on the Subscription page in the app.";
}
