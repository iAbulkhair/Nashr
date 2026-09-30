/**
 * Reem's timed reminders: the sweep that fires every reminder whose time has come. Server only.
 *
 * Called by `POST /api/cron/secretary` (a QStash schedule every 15 minutes, `src/lib/qstash.ts` checks its signature)
 * and, as the fallback that makes a reminder late but never lost, once by every run of the 05:00 UTC daily cron.
 *
 * Rules held in code:
 * - Reads are bounded and batched: at most `SWEEP_SCOPES` scopes whose earliest reminder is due (`sec:duescopes`), and
 *   per scope at most `SWEEP_PER_SCOPE` due ids (`sec:due:{scope}`); no store call waits inside a loop.
 * - Each due id is claimed with ZREM (`zremClaim`): only the run that removed it fires it, so two overlapping sweeps
 *   (a QStash retry, the daily fallback) never fire one reminder twice. The firing itself re-reads the item under its
 *   lock and fires only an open item whose `remindAt` is set and passed (`fireReminder` in secretary.ts); a claim that
 *   could not take the lock is put back.
 * - The notification's fingerprint names the scope, the item and the reminder instant, so a retry never repeats it;
 *   the email goes only with a notification this run pushed, when email is set up and the preference is not "none".
 * - Free: no credits, no model call. The text is the item's title, which is the owner's record.
 */
import { db } from "./db";
import { pmap } from "./parallel";
import { getUser, type User } from "./auth";
import { SEC_KEYS, fireReminder, zoneFor } from "./secretary";
import { formatWhen, type SecItem } from "./secretary-agenda";
import { pushNotifs, type Push } from "./notifications";
import { sendEmail } from "./notify";
import type { Zone } from "./zones";

/** Scopes read per sweep, due ids read per scope, scopes handled at once. */
export const SWEEP_SCOPES = 200;
export const SWEEP_PER_SCOPE = 50;
export const SWEEP_CONCURRENCY = 8;
/** `sec:tick:last` lives two hours; `timedReminders()` counts the tick as running for one. */
export const TICK_TTL_S = 7200;
/** A suspended account gets no scheduled work: its scopes are looked at again this much later. */
export const SUSPENDED_HOLD_MS = 6 * 3600_000;

/** One reminder, once: this scope, this item, this reminder instant. */
export const remindFingerprint = (scope: string, id: string, remindAtMs: number) => `todo-remind:${scope}:${id}:${remindAtMs}`;

const ORIGIN = () => process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app";
/** The account a scope belongs to: the default brand's scope is the email, another brand's is `email#brandId`. */
const accountOf = (scope: string) => scope.split("#")[0];

type Fired = { scope: string; zone: Zone; item: SecItem; remindAt: string };
export type SweepReport = { scopes: number; claimed: number; fired: number; notified: number; emailed: number; failed: number };

/**
 * After a scope was processed, its entry in `sec:duescopes` follows its earliest remaining reminder, or goes. Read
 * again after the write: a reminder added meanwhile (its scope entry is written after its item entry, `dueWrites`) is
 * then either seen here or written after this removal, so a scope never drops out while it still has a reminder.
 */
async function rescore(scope: string): Promise<void> {
  const first = await db.zrangeByScore(SEC_KEYS.due(scope), Infinity, 1);
  if (first.length) await db.zadd(SEC_KEYS.dueScopes, first[0].score, scope);
  else await db.zrem(SEC_KEYS.dueScopes, scope);
  const again = await db.zrangeByScore(SEC_KEYS.due(scope), Infinity, 1);
  if (again.length && (!first.length || again[0].score < first[0].score)) await db.zadd(SEC_KEYS.dueScopes, again[0].score, scope, { lt: true });
}

/** Claim and fire what is due in one scope; the claims that met a busy item go back. */
async function sweepScope(scope: string, now: number): Promise<{ fired: Fired[]; claimed: number }> {
  const due = await db.zrangeByScore(SEC_KEYS.due(scope), now, SWEEP_PER_SCOPE);
  const won = await Promise.all(due.map((m) => db.zremClaim(SEC_KEYS.due(scope), m.member)));
  const mine = due.filter((_, i) => won[i]);
  const results = await pmap(mine, (m) => fireReminder(scope, m.member, now).catch((e) => {
    console.error("reminder fire failed", e instanceof Error ? e.name : "error");
    return "busy" as const;
  }), SWEEP_CONCURRENCY);
  const back = mine.filter((_, i) => results[i] === "busy");
  if (back.length) await Promise.all(back.map((m) => db.zadd(SEC_KEYS.due(scope), m.score, m.member)));
  await rescore(scope);
  const hits = results.flatMap((r) => (typeof r === "object" ? [r] : []));
  const zone = hits.length ? await zoneFor(scope) : ("Asia/Riyadh" as Zone);
  return { fired: hits.map((r) => ({ scope, zone, item: r.fired, remindAt: r.remindAt })), claimed: mine.length };
}

/** The bell entry for one fired reminder, in the account's language. */
function notifFor(f: Fired, user: Pick<User, "lang">, now: number): Push {
  const ar = user.lang === "ar";
  const t = `«${f.item.title.slice(0, 80)}»`;
  const due = f.item.dueAt ? formatWhen(f.item.dueAt, f.item.allDay, user.lang, now, f.zone) : "";
  return {
    n: {
      kind: "todo", agent: "reem", href: `/${user.lang}/app/todo`,
      title: ar ? `تذكير: ${t}` : `Reminder: ${t}`,
      body: ar ? `طلبت أن أذكّرك بهذه المهمة.${due ? ` موعدها: ${due}.` : ""}` : `You asked to be reminded of this.${due ? ` Due: ${due}.` : ""}`,
    },
    fingerprint: remindFingerprint(f.scope, f.item.id, Date.parse(f.remindAt)),
    ttlDays: 7,
  };
}

/** The email preference of a scope (`profile:{scope}`, else the account's), "all" when none was set. */
async function emailPrefs(scopes: string[], email: string): Promise<Map<string, string>> {
  const rows = await db.mget<{ emails?: string }>([...scopes.map((s) => `profile:${s}`), `profile:${email}`]);
  const account = rows[scopes.length]?.emails;
  return new Map(scopes.map((s, i) => [s, rows[i]?.emails ?? account ?? "all"]));
}

/** Every scope of one account: fire, then one write of the bell for all of them, then the emails. */
async function sweepAccount(email: string, scopes: string[], now: number): Promise<{ claimed: number; fired: number; notified: number; emailed: number }> {
  const user = await getUser(email);
  // An account that no longer exists keeps nothing in the index.
  if (!user) {
    await Promise.all(scopes.map((s) => db.zrem(SEC_KEYS.dueScopes, s)));
    return { claimed: 0, fired: 0, notified: 0, emailed: 0 };
  }
  // A suspended account gets no scheduled work; its reminders wait, looked at again later.
  if (user.suspended) {
    await Promise.all(scopes.map((s) => db.zadd(SEC_KEYS.dueScopes, now + SUSPENDED_HOLD_MS, s)));
    return { claimed: 0, fired: 0, notified: 0, emailed: 0 };
  }
  const per = await Promise.all(scopes.map((s) => sweepScope(s, now)));
  const fired = per.flatMap((p) => p.fired);
  const claimed = per.reduce((n, p) => n + p.claimed, 0);
  if (!fired.length) return { claimed, fired: 0, notified: 0, emailed: 0 };
  const pushed = await pushNotifs(email, fired.map((f) => notifFor(f, user, now)));
  const sendable = fired.filter((_, i) => !!pushed[i]);
  let emailed = 0;
  if (process.env.RESEND_API_KEY && sendable.length) {
    const prefs = await emailPrefs([...new Set(sendable.map((f) => f.scope))], email);
    const ar = user.lang === "ar";
    const sent = await Promise.all(sendable.filter((f) => prefs.get(f.scope) !== "none").map((f) => {
      const n = notifFor(f, user, now).n;
      return sendEmail(email, ar ? `تذكير من ريم: ${f.item.title.slice(0, 80)}` : `Reminder from Reem: ${f.item.title.slice(0, 80)}`, `${n.title}\n${n.body}\n\n${ORIGIN()}${n.href}`);
    }));
    emailed = sent.filter(Boolean).length;
  }
  return { claimed, fired: fired.length, notified: sendable.length, emailed };
}

/**
 * Fire every reminder due at `now`: up to `SWEEP_SCOPES` scopes, grouped by account (one write of each account's bell),
 * eight accounts at a time, each isolated from the others' failures. `fromQstash` records the tick that makes
 * `timedReminders()` true; the daily fallback does not.
 */
export async function sweepReminders(now = Date.now(), opts: { fromQstash?: boolean } = {}): Promise<SweepReport> {
  const scopes = (await db.zrangeByScore(SEC_KEYS.dueScopes, now, SWEEP_SCOPES)).map((m) => m.member).filter((s) => s.length > 0 && s.length <= 320);
  const byAccount = new Map<string, string[]>();
  for (const s of scopes) byAccount.set(accountOf(s), [...(byAccount.get(accountOf(s)) ?? []), s]);
  let failed = 0;
  const rows = await pmap([...byAccount], ([email, list]) => sweepAccount(email, list, now).catch((e) => {
    failed++;
    console.error("reminder sweep failed for an account", e instanceof Error ? e.name : "error");
    return { claimed: 0, fired: 0, notified: 0, emailed: 0 };
  }), SWEEP_CONCURRENCY);
  if (opts.fromQstash) await db.set(SEC_KEYS.tick, now, TICK_TTL_S);
  const sum = (k: "claimed" | "fired" | "notified" | "emailed") => rows.reduce((n, r) => n + r[k], 0);
  return { scopes: scopes.length, claimed: sum("claimed"), fired: sum("fired"), notified: sum("notified"), emailed: sum("emailed"), failed };
}
