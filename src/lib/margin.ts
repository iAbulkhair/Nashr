import { createHash } from "node:crypto";
import { db, mgetChunked } from "./db";
import { adminEmails, getUser, type User } from "./auth";
import { SAR_PER_USD, netPriceSar, priceOf } from "./pricing";
import { monthKey } from "./credits";
import { mediaCostKey } from "./usage";
import { notifyItem } from "./notifications";
import { pmap } from "./parallel";
import { day } from "./track";
import { log } from "./log";
import { globalKey } from "./keys";

/**
 * The daily margin alert (rules 1530-1539, docs/system/flows.md section 69). The PRD asks for it before the first
 * customer: heavy chat plus media can cost more than a plan earns. Read-only for customers: nothing here changes an
 * account, a plan, a credit or a model; it tells the founder.
 *
 * For one paying account and one calendar month (UTC, `monthKey()`, the month the usage counters use):
 *
 *   revenueSar = netPriceSar(priceOf(u))                     the plan's monthly price, or an Agency deal's, net of VAT
 *   costUsd    = usage:{email}:{month}:usd_micro / 1e6       every model call metered to the account (src/lib/metered.ts)
 *              + usage:{email}:{month}:media_usd_micro / 1e6 every image and video render billed to us (media/jobs.ts)
 *   marginPct  = round((revenueSar - costUsd * SAR_PER_USD) / revenueSar * 100)
 *
 * `SAR_PER_USD` (3.75, src/lib/pricing.ts) is the rate the overview's gross margin and the Users table already use.
 * `netPriceSar` divides by 1.15 only while `PRICES_INCLUDE_VAT` is true (it is false: the list prices exclude VAT, so the
 * plan earns its list price). Top-up packs are not plan revenue and are left out, so an account that bought packs reads
 * lower than it earns: the alert errs towards telling the founder. The cost is month to date and the revenue the whole
 * month's price (a plan is paid for the month), so a margin can only fall as the month goes on.
 */

/** The floor: an account under this margin, in percent, is reported. */
export const MARGIN_ALERT_PCT = 50;
/** How long the day's record of accounts under the floor is kept (it names accounts, so it is not kept for good). */
export const MARGIN_DAY_TTL_S = 8 * 86400;
/** The per-account "already alerted today" marker: two days, so a run just after midnight UTC cannot repeat yesterday's. */
const ALERTED_TTL_S = 2 * 86400;

export type MarginRow = {
  email: string; name: string; plan: string; revenueSar: number; modelUsd: number; mediaUsd: number; costSar: number; marginPct: number;
  /** The fair-use stop's mark (src/lib/fair-use.ts `markFairUse`, rule 1733): set on the console's view only. */
  fairUse?: "paused" | "lifted" | null;
};
/** The last daily run, as `margin:last` keeps it: counts only, no account. */
export type MarginRun = { day: string; at: string; month: string; checked: number; under: number; alerted: number };
/** What the console's Margin section shows (GET /api/admin/overview `margin`). */
export type MarginView = { month: string; floorPct: number; checked: number; under: MarginRow[]; last: MarginRun | null };

/** Pure: the margin in percent, or null when there is no revenue to measure against (a trial, an unknown plan). */
export function marginPct(revenueSar: number, costUsd: number): number | null {
  if (!Number.isFinite(revenueSar) || revenueSar <= 0) return null;
  const cost = Number.isFinite(costUsd) ? Math.max(0, costUsd) : 0;
  return Math.round(((revenueSar - cost * SAR_PER_USD) / revenueSar) * 100);
}

/** The account's plan revenue for one month, SAR net of VAT. */
export const revenueSarOf = (u: Pick<User, "plan" | "deal">) => netPriceSar(priceOf(u));

/** A paying account: not suspended, not on the trial, and its plan has a price. Team members are not in `users:all`. */
export const isPaying = (u: Pick<User, "plan" | "deal" | "suspended">) => !u.suspended && u.plan !== "trial" && revenueSarOf(u) > 0;

const micro = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Every paying account's margin for `month`, lowest first. The two counters of every account come back in chunked
 * MGETs (`mgetChunked`: 100 keys a request), never one read per account in a loop. The emails come from the stored
 * records, never from a request.
 */
export async function accountMargins(users: readonly User[], month = monthKey()): Promise<MarginRow[]> {
  const paying = users.filter(isPaying);
  const keys = paying.flatMap((u) => [`usage:${u.email}:${month}:usd_micro`, mediaCostKey(u.email, month)]);
  const v = await mgetChunked<number>(keys);
  return paying
    .map((u, i) => {
      const modelUsd = micro(v[2 * i]) / 1e6;
      const mediaUsd = micro(v[2 * i + 1]) / 1e6;
      const revenueSar = revenueSarOf(u);
      const costSar = Math.round((modelUsd + mediaUsd) * SAR_PER_USD * 100) / 100;
      return { email: u.email, name: u.name, plan: u.plan, revenueSar, modelUsd: Math.round(modelUsd * 1e4) / 1e4, mediaUsd: Math.round(mediaUsd * 1e4) / 1e4, costSar, marginPct: marginPct(revenueSar, modelUsd + mediaUsd) ?? 100 };
    })
    .sort((a, b) => a.marginPct - b.marginPct || (a.email < b.email ? -1 : 1));
}

/** Pure: the rows under the floor. */
export const underFloor = (rows: readonly MarginRow[]) => rows.filter((r) => r.marginPct < MARGIN_ALERT_PCT);

/** The marker's key part: a hash of the email, so no address is part of a key name. */
const tag = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
export const marginAlertedKey = (d: string, email: string) => `margin:alerted:${d}:${tag(email)}`;
export const marginDayKey = (d: string) => `margin:day:${d}`;
export const MARGIN_LAST_KEY = "margin:last";

/** The console's view: the live margins of `users` (already loaded by the caller) and the last daily run. */
export async function marginView(users: readonly User[], month = monthKey()): Promise<MarginView> {
  const [rows, last] = await Promise.all([accountMargins(users, month), db.get<MarginRun>(MARGIN_LAST_KEY).catch(() => null)]);
  return { month, floorPct: MARGIN_ALERT_PCT, checked: rows.length, under: underFloor(rows), last: last ?? null };
}

const PLAN_NAME: Record<"ar" | "en", Record<string, string>> = {
  ar: { starter: "المبتدئة", pro: "الاحترافية", business: "الأعمال", agency: "الوكالات" },
  en: { starter: "Starter", pro: "Pro", business: "Business", agency: "Agency" },
};

/** Pure: the founder's bell item for `rows`, in `lang`. Plans and margins only: no email, no name. */
export function alertText(rows: readonly Pick<MarginRow, "plan" | "marginPct">[], lang: "ar" | "en") {
  const n = rows.length;
  const list = rows.slice(0, 5).map((r) => `${PLAN_NAME[lang][r.plan] ?? r.plan} ${r.marginPct}%`).join(" · ");
  return lang === "ar"
    ? { title: `هامش الربح أقل من ${MARGIN_ALERT_PCT}% في ${n} ${n === 1 ? "حساب مدفوع" : "حسابات مدفوعة"} هذا الشهر`, body: `${list}. التفاصيل في لوحة المؤسس، قسم الاستخدام. لم يتغيّر شيء في الحسابات.` }
    : { title: `Margin under ${MARGIN_ALERT_PCT}% on ${n} paying account${n === 1 ? "" : "s"} this month`, body: `${list}. Details in the founder console, Usage. Nothing was changed on the accounts.` };
}

/**
 * The daily run, inside GET /api/cron/daily (its first hop; no new cron schedule). Reads every account once (`pmap`),
 * the counters in chunked MGETs, then for each account under the floor takes a per-day marker (`setNx`, all at once):
 * an account is alerted at most once a day however often the cron runs. The newly alerted accounts go to every founder
 * (`ADMIN_EMAILS`) as ONE bell item of kind `credits` (a kind no preference switches off), the channel the golden-set
 * regressions already use. The day's rows are kept under `margin:day:{day}` for `MARGIN_DAY_TTL_S`, the counts under
 * `margin:last`. Never throws into the cron: a failure is one fixed log line and the answer `{error}`.
 */
export async function runMarginAlert(now = new Date()): Promise<MarginRun | { error: string }> {
  try {
    const d = day(now), month = monthKey(now);
    const emails = await db.smembers(globalKey.usersAll());
    const users = (await pmap(emails, (e) => getUser(e), 12)).filter((u): u is User => !!u);
    const rows = await accountMargins(users, month);
    const under = underFloor(rows);
    const won = await Promise.all(under.map((r) => db.setNx(marginAlertedKey(d, r.email), 1, ALERTED_TTL_S)));
    const fresh = under.filter((_, i) => won[i]);
    const run: MarginRun = { day: d, at: now.toISOString(), month, checked: rows.length, under: under.length, alerted: fresh.length };
    const founders = fresh.length ? (await Promise.all(adminEmails().map((e) => getUser(e)))).filter((u): u is User => !!u) : [];
    const fp = `margin:${d}:${tag(fresh.map((r) => r.email).sort().join(","))}`;
    await Promise.all([
      db.set(MARGIN_LAST_KEY, run),
      under.length ? db.set(marginDayKey(d), { ...run, rows: under }, MARGIN_DAY_TTL_S) : null,
      ...founders.map((f) => {
        const lang = f.lang === "en" ? "en" : "ar";
        return notifyItem(f.email, lang, { kind: "credits", ...alertText(fresh, lang), href: `/${lang}/admin/usage#margin` }, fp, 2);
      }),
    ]);
    return run;
  } catch (e) {
    log.error("margin_alert_failed", e);
    return { error: "margin_alert_failed" };
  }
}
