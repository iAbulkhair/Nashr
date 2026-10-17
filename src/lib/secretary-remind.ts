/**
 * Reem's timed reminders: the sweep that fires every reminder whose time has come. Server only.
 *
 * Called by `POST /api/cron/secretary` (a QStash schedule every 15 minutes, `src/lib/qstash.ts` checks its signature)
 * and, as the fallback that makes a reminder late but never lost, by the first hop of the 05:00 UTC daily cron.
 *
 * Rules held in code:
 * - Reads are bounded and batched: at most `SWEEP_SCOPES` scopes whose earliest reminder is due (`sec:duescopes`), and
 *   per scope at most `SWEEP_PER_SCOPE` due ids (`sec:due:{scope}`); no store call waits inside a loop.
 * - Late, never lost. A due id is leased, not removed: `SET NX sec:firing:{scope}:{id}` for `REMIND_LEASE_S` (longer
 *   than the longest caller runs), so one run at a time works on it. The id stays in `sec:due` until the item's own
 *   write clears `remindAt` (`fireReminder` in secretary.ts, through `indexWrites`). A run that fails or is killed
 *   leaves it due: its lease is released, or expires, and the next sweep retries it.
 * - Delivery before the write, under the item's lock: the bell entry (fingerprint `todo-remind:{scope}:{id}:{ms}`),
 *   then the email only when that push was new and the scope's preference is not "none", then the item. A retry after
 *   a crash in between finds the fingerprint claimed: no second bell entry, no second email, and the item is written.
 * - One account's or one scope's failure never stops another's delivery (`Promise.allSettled`; the zone read falls back
 *   to Riyadh; the index rescore is logged, not thrown).
 * - A deadline: no account is started and no lease taken after it; what is left stays due for the next sweep.
 * - A suspended account, an unverified owner, and a brand that is not active (archived), get no scheduled work: their scopes are looked at
 *   again `SUSPENDED_HOLD_MS` later and their reminders wait in `sec:due`, delivered late once they are active again.
 * - Quiet in a meeting (Reem B3, rule 917): a reminder whose time falls inside a meeting of the brand's linked marketing
 *   calendar (fresh events only) waits until the meeting chain ends, at most `QUIET_CAP_MS` after its time.
 * - Free: no credits, no model call. The text is the item's title, which is the owner's record.
 */
import { db } from "./db";
import { isSuspended } from "./suspension";
import { pmap } from "./parallel";
import { emailVerified, getUser, type User } from "./auth";
import { listBrands, scopeFor } from "./brands";
import { SEC_KEYS, fireReminder, zoneFor } from "./secretary";
import { formatWhen, type SecItem } from "./secretary-agenda";
import { pushNotifs, type Push } from "./notifications";
import { emailAllowed, readPrefsMany, type NotifyPrefs } from "./notify-prefs";
import { log } from "./log";
import { sendEmail } from "./notify";
import { DEFAULT_ZONE, type Zone } from "./zones";
import { appOrigin } from "./origin";
import { COPY, paragraphs } from "../emails";
import { meetingsNow } from "./secretary-cal-link";
import { quietUntil } from "./secretary-meetings";

/** Scopes read per sweep, due ids read per scope, scopes handled at once. */
export const SWEEP_SCOPES = 200;
export const SWEEP_PER_SCOPE = 50;
export const SWEEP_CONCURRENCY = 8;
/** `sec:tick:last` lives two hours; `timedReminders()` counts the tick as running for one. */
export const TICK_TTL_S = 7200;
/** A suspended account or an archived brand gets no scheduled work: its scopes are looked at again this much later. */
export const SUSPENDED_HOLD_MS = 6 * 3600_000;
/** One due reminder's lease: longer than the longest caller may run (the daily cron's 300 s). */
export const REMIND_LEASE_S = 330;
/** How long a sweep may start new work: the tick (maxDuration 60 s) and the daily cron's first hop. */
export const SWEEP_BUDGET_TICK_MS = 40_000;
export const SWEEP_BUDGET_DAILY_MS = 60_000;

/** One reminder, once: this scope, this item, this reminder instant. */
export const remindFingerprint = (scope: string, id: string, remindAtMs: number) => `todo-remind:${scope}:${id}:${remindAtMs}`;

/** The account a scope belongs to: the default brand's scope is the email, another brand's is `email#brandId`. */
const accountOf = (scope: string) => scope.split("#")[0];

/** `quiet`: reminders left due because the owner is in a meeting of the linked marketing calendar (Reem B3, rule 917). */
export type SweepReport = { scopes: number; claimed: number; fired: number; notified: number; emailed: number; deferred: number; held: number; quiet: number; failed: number };
type Tally = Omit<SweepReport, "scopes">;
const zero = (): Tally => ({ claimed: 0, fired: 0, notified: 0, emailed: 0, deferred: 0, held: 0, quiet: 0, failed: 0 });
const addTo = (a: Tally, b: Tally) => { for (const k of Object.keys(a) as (keyof Tally)[]) a[k] += b[k]; return a; };
/** Two sweep reports as one (the daily route's bounded repeat). */
export const mergeReports = (a: SweepReport, b: SweepReport): SweepReport => ({ scopes: a.scopes + b.scopes, ...addTo(addTo(zero(), a), b) });

/**
 * After a scope was processed, its entry in `sec:duescopes` follows its earliest remaining reminder, or goes. Read
 * again after the write: a reminder added meanwhile (its scope entry is written after its item entry, `dueWrites`) is
 * then either seen here or written after this removal, so a scope never drops out while it still has a reminder. An id
 * left due by a failed or deferred attempt keeps the scope at a past score, so the next sweep comes back to it.
 */
async function rescore(scope: string): Promise<void> {
  const first = await db.zrangeByScore(SEC_KEYS.due(scope), Infinity, 1);
  if (first.length) await db.zadd(SEC_KEYS.dueScopes, first[0].score, scope);
  else await db.zrem(SEC_KEYS.dueScopes, scope);
  const again = await db.zrangeByScore(SEC_KEYS.due(scope), Infinity, 1);
  if (again.length && (!first.length || again[0].score < first[0].score)) await db.zadd(SEC_KEYS.dueScopes, again[0].score, scope, { lt: true });
}

/** The bell entry for one reminder, in the account's language. */
function notifFor(scope: string, zone: Zone, item: SecItem, user: Pick<User, "lang">, now: number): Push {
  const ar = user.lang === "ar";
  const t = `«${item.title.slice(0, 80)}»`;
  const due = item.dueAt ? formatWhen(item.dueAt, item.allDay, user.lang, now, zone) : "";
  return {
    n: {
      kind: "todo", agent: "reem", href: `/${user.lang}/app/todo`,
      title: ar ? `تذكير: ${t}` : `Reminder: ${t}`,
      body: ar ? `طلبت أن أذكّرك بهذه المهمة.${due ? ` موعدها: ${due}.` : ""}` : `You asked to be reminded of this.${due ? ` Due: ${due}.` : ""}`,
    },
    fingerprint: remindFingerprint(scope, item.id, Date.parse(item.remindAt!)),
    ttlDays: 7,
  };
}


type AccountCtx = { email: string; user: User; now: number; deadline: number; prefs: () => Promise<Map<string, NotifyPrefs>>; tally: Tally };

/**
 * One reminder's delivery, run by `fireReminder` under the item's lock before the item is written: the bell entry, and
 * the email only when this push was new (an earlier attempt that pushed already sent it, or the preference said none).
 */
async function deliver(ctx: AccountCtx, scope: string, zone: Zone, cur: SecItem): Promise<void> {
  const push = notifFor(scope, zone, cur, ctx.user, ctx.now);
  // The account's preferences are read once per sweep (`ctx.prefs`), not once per reminder (rule 1190).
  const [pushed] = await pushNotifs(ctx.email, [{ ...push, scope }], await ctx.prefs());
  if (!pushed) return;
  ctx.tally.notified++;
  // The reminder email follows its own switch (Settings, Notifications; the old "none" level reads as off, rule 1147).
  const prefs = (await ctx.prefs()).get(scope);
  if (!process.env.RESEND_API_KEY || (prefs && !emailAllowed(prefs, "reminders"))) return;
  const ar = ctx.user.lang === "ar";
  // The HTML part says what the bell says, with a button to the list. The title holds the task's title, which the
  // owner or an agent wrote: `notice` escapes it as text (rule 686).
  const sent = await sendEmail({
    to: ctx.email,
    subject: ar ? `تذكير من ريم: ${cur.title.slice(0, 80)}` : `Reminder from Reem: ${cur.title.slice(0, 80)}`,
    text: `${push.n.title}\n${push.n.body}\n\n${appOrigin()}${push.n.href}`,
    template: "notice",
    context: { title: push.n.title, paragraphs: paragraphs(push.n.body), cta: { href: `${appOrigin()}${push.n.href}`, label: COPY[ctx.user.lang].notice.todo } },
    locale: ctx.user.lang,
  });
  if (sent) ctx.tally.emailed++;
}

/** Lease and fire what is due in one scope, each id on its own; the index follows whatever is left. */
async function sweepScope(ctx: AccountCtx, scope: string): Promise<void> {
  const [due, zone, meetings] = await Promise.all([
    db.zrangeByScore(SEC_KEYS.due(scope), ctx.now, SWEEP_PER_SCOPE),
    zoneFor(scope).catch(() => DEFAULT_ZONE),
    // The linked calendar's fresh meetings (none when unlinked, lost or stale): a calendar read failing never blocks a reminder.
    meetingsNow(scope, ctx.now).catch(() => []),
  ]);
  await pmap(due, async (m) => {
    // Past the deadline nothing new starts: the id stays due for the next sweep.
    if (Date.now() >= ctx.deadline) { ctx.tally.deferred++; return; }
    // Its time falls in a meeting: it stays due, untouched, and fires on the first tick after the meeting (at most 4 h).
    const q = quietUntil(meetings, m.score);
    if (q !== null && ctx.now < q) { ctx.tally.quiet++; return; }
    const lease = SEC_KEYS.firing(scope, m.member);
    if (!(await db.setNx(lease, 1, REMIND_LEASE_S))) return;
    ctx.tally.claimed++;
    try {
      const r = await fireReminder(scope, m.member, ctx.now, m.score, (cur) => deliver(ctx, scope, zone, cur));
      if (typeof r === "object") ctx.tally.fired++;
    } catch (e) {
      // Nothing was written to the item (or only its index is stale): the id is still due and the next sweep retries.
      ctx.tally.failed++;
      log.error("reminder fire failed", e);
    } finally {
      await db.del(lease).catch(() => {});
    }
  }, SWEEP_CONCURRENCY);
  try {
    await rescore(scope);
  } catch (e) {
    log.error("reminder index rescore failed", e);
  }
}

/** Every scope of one account: suspended or archived ones held, the others swept, each isolated from the others. */
async function sweepAccount(email: string, scopes: string[], now: number, deadline: number): Promise<Tally> {
  const tally = zero();
  const [user, brands] = await Promise.all([getUser(email), listBrands(email)]);
  // An account that no longer exists keeps nothing in the index.
  if (!user) {
    await Promise.all(scopes.map((s) => db.zrem(SEC_KEYS.dueScopes, s)));
    return tally;
  }
  // A suspended account, an owner who has not verified the address yet (rule 755), and a brand that is not active get no
  // scheduled work: their reminders wait, looked at again later (one brand-list read per account, not one per scope).
  const active = new Set(brands.filter((b) => b.status === "active").map((b) => scopeFor(email, b.id)));
  const hold = isSuspended(user) || !emailVerified(user);
  const held = hold ? scopes : scopes.filter((s) => !active.has(s));
  const live = hold ? [] : scopes.filter((s) => active.has(s));
  if (held.length) {
    await Promise.all(held.map((s) => db.zadd(SEC_KEYS.dueScopes, now + SUSPENDED_HOLD_MS, s)));
    tally.held += held.length;
  }
  if (!live.length) return tally;
  let prefs: Promise<Map<string, NotifyPrefs>> | null = null;
  const ctx: AccountCtx = { email, user, now, deadline, tally, prefs: () => (prefs ??= readPrefsMany(live, email)) };
  const results = await Promise.allSettled(live.map((s) => sweepScope(ctx, s)));
  for (const r of results) if (r.status === "rejected") {
    tally.failed++;
    log.error("reminder sweep failed for a scope", r.reason);
  }
  return tally;
}

/**
 * Fire every reminder due at `now`: up to `SWEEP_SCOPES` scopes, grouped by account, eight accounts at a time, each
 * isolated from the others' failures. Nothing new starts after `deadline` (default: `SWEEP_BUDGET_TICK_MS` from now).
 * `tick` records the tick that makes `timedReminders()` true; the daily fallback does not. Every authenticated call of
 * the tick route passes it (rule 1432): on thakeen.com the 15-minute tick is an hPanel cron with the cron bearer, not
 * QStash, and a marker written only for QStash was never written, so owners were told "next morning" for a reminder the
 * tick fired on time.
 */
export async function sweepReminders(now = Date.now(), opts: { tick?: boolean; deadline?: number } = {}): Promise<SweepReport> {
  const deadline = opts.deadline ?? Date.now() + SWEEP_BUDGET_TICK_MS;
  const scopes = (await db.zrangeByScore(SEC_KEYS.dueScopes, now, SWEEP_SCOPES)).map((m) => m.member).filter((s) => s.length > 0 && s.length <= 320);
  const byAccount = new Map<string, string[]>();
  for (const s of scopes) byAccount.set(accountOf(s), [...(byAccount.get(accountOf(s)) ?? []), s]);
  const rows = await pmap([...byAccount], async ([email, list]) => {
    // Past the deadline no account is started: its scopes keep their past score and come first next time.
    if (Date.now() >= deadline) return { ...zero(), deferred: list.length };
    return sweepAccount(email, list, now, deadline).catch((e) => {
      log.error("reminder sweep failed for an account", e);
      return { ...zero(), failed: 1 };
    });
  }, SWEEP_CONCURRENCY);
  if (opts.tick) await db.set(SEC_KEYS.tick, now, TICK_TTL_S);
  return { scopes: scopes.length, ...rows.reduce((a, r) => addTo(a, r), zero()) };
}
