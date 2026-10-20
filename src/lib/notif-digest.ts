import { db } from "./db";
import { log } from "./log";
import { accountKey, globalKey } from "./keys";
import { pmap } from "./parallel";
import { sendEmail } from "./notify";
import { appOrigin } from "./origin";
import { COUNT_MAX, listNotifs, type Notif } from "./notifications";
import { appHref } from "@/lib/ws-path";

/**
 * The digest email the owner chooses (rules 2352-2357, pattern 2 of docs/reports/2026-10-19-PRD-fizzy-orca_AR.md, after
 * Fizzy's bundled notifications): one email with the bell entries that arrived unread in the last window, every 4 hours,
 * every day or every week. Off unless the owner turns it on (the founder's default of 2026-10-19), so nobody gets a new
 * email they did not ask for. The bell is per account, so the choice is too: `notifydigest:{account}`, read by Reem's
 * 15-minute tick (`sweepDigests`).
 */
export const DIGEST_EVERY = ["off", "4h", "day", "week"] as const;
export type DigestEvery = (typeof DIGEST_EVERY)[number];
/** Hours in each window. */
export const DIGEST_HOURS: Record<Exclude<DigestEvery, "off">, number> = { "4h": 4, day: 24, week: 168 };
/** Under a tick of slack, so a window that closes just after a tick goes on that tick, not 15 minutes later every time. */
const SLACK_MS = 10 * 6e4;
/** At most this many entries are written out in one email; the rest are counted. */
export const DIGEST_LINES = 20;
/** How long one account's send is claimed: a second tick in that time sends nothing. */
const LOCK_SECONDS = 600;

/** `to` and `lang`: the owner's address and language when they saved it (only the owner can, `profile.account`). */
export type StoredDigest = { v: 1; every: DigestEvery; to: string; lang: "ar" | "en"; at: string };

export const isEvery = (v: unknown): v is DigestEvery => typeof v === "string" && (DIGEST_EVERY as readonly string[]).includes(v);

/** The account's choice, "off" when it never chose or the record is not ours. */
export async function getDigest(account: string): Promise<DigestEvery> {
  const r = await db.get<StoredDigest>(accountKey.digest(account));
  return r && r.v === 1 && isEvery(r.every) ? r.every : "off";
}

/**
 * Save the choice (rule 2353). On: the record, the account in the tick's set, and a fresh window that starts now (a
 * change of length starts again, so the first email never carries a backlog older than the window). Off: all three go.
 */
export async function saveDigest(account: string, every: DigestEvery, to: string, lang: "ar" | "en"): Promise<void> {
  const at = new Date().toISOString();
  if (every === "off") {
    await Promise.all([db.del(accountKey.digest(account)), db.del(accountKey.digestLast(account)), db.srem(globalKey.digests(), account)]);
    return;
  }
  const rec: StoredDigest = { v: 1, every, to, lang, at };
  await Promise.all([db.set(accountKey.digest(account), rec), db.set(accountKey.digestLast(account), at), db.sadd(globalKey.digests(), account)]);
}

/** Has the window that started at `last` ended at `now`? */
export const windowEnded = (every: Exclude<DigestEvery, "off">, last: string, now: number) => now - Date.parse(last) >= DIGEST_HOURS[every] * 36e5 - SLACK_MS;

/** The entries of one window: unread, arrived after `since` and by `until`, newest first as the bell keeps them. */
export const digestEntries = (all: readonly Notif[], since: string, until: number): Notif[] =>
  all.filter((n) => !n.read && n.at > since && Date.parse(n.at) <= until);

const times = (n: Notif) => {
  if (!n.count || n.count < 2) return "";
  return ` (×${n.count > COUNT_MAX ? `${COUNT_MAX}+` : n.count})`;
};

/** The email: a title, one paragraph per entry (its title, how many times, its body, its link), and the bell's link. */
export function digestMail(lang: "ar" | "en", every: Exclude<DigestEvery, "off">, items: readonly Notif[]) {
  const ar = lang === "ar";
  const span = { "4h": ar ? "آخر 4 ساعات" : "the last 4 hours", day: ar ? "آخر يوم" : "the last day", week: ar ? "آخر أسبوع" : "the last week" }[every];
  const subject = ar ? `${items.length} تنبيه من فريق ذكين` : `${items.length} notification(s) from your Thakeen team`;
  const shown = items.slice(0, DIGEST_LINES);
  const lines = shown.map((n) => `${n.title}${times(n)}\n${n.body}\n${appOrigin()}${n.href}`);
  const more = items.length - shown.length;
  const head = ar ? `ما وصل إلى الجرس في ${span} ولم تقرأه بعد:` : `What reached your bell in ${span} that you have not read yet:`;
  const tail = more > 0 ? [ar ? `و${more} غيرها في صفحة التنبيهات.` : `And ${more} more on the notifications page.`] : [];
  const foot = ar ? "تغيّر وقت هذا الملخص أو توقفه من الإعدادات، التنبيهات." : "Change or stop this digest in Settings, Notifications.";
  const paragraphs = [head, ...lines, ...tail, foot];
  return { subject, paragraphs, text: paragraphs.join("\n\n"), href: `${appOrigin()}${appHref(lang, "/notifications")}` };
}

export type DigestOutcome = "off" | "start" | "wait" | "busy" | "empty" | "sent" | "failed" | "late";

/** One account's turn on the tick: start its window, wait, or close it and send what it holds (rule 2354). */
export async function digestFor(account: string, now: number): Promise<DigestOutcome> {
  const [rec, last] = await db.mget<unknown>([accountKey.digest(account), accountKey.digestLast(account)]);
  const pref = rec as StoredDigest | null;
  if (!pref || pref.v !== 1 || !isEvery(pref.every) || pref.every === "off") {
    await db.srem(globalKey.digests(), account);
    return "off";
  }
  if (typeof last !== "string" || !Number.isFinite(Date.parse(last))) {
    await db.set(accountKey.digestLast(account), new Date(now).toISOString());
    return "start";
  }
  if (!windowEnded(pref.every, last, now)) return "wait";
  if (!(await db.setNx(accountKey.digestLock(account), 1, LOCK_SECONDS))) return "busy";
  const items = digestEntries(await listNotifs(account), last, now);
  const closed = new Date(now).toISOString();
  if (!items.length) {
    await db.set(accountKey.digestLast(account), closed);
    return "empty";
  }
  const m = digestMail(pref.lang, pref.every, items);
  const sent = await sendEmail({ to: pref.to, subject: m.subject, text: `${m.text}\n\n${m.href}`, template: "notice", context: { title: m.subject, paragraphs: m.paragraphs, cta: { href: m.href } }, locale: pref.lang }).catch(() => false);
  // Not sent: the window stays open and the claim runs out, so a later tick tries again with the same entries.
  if (!sent) return "failed";
  await db.set(accountKey.digestLast(account), closed);
  return "sent";
}

/** Every account with a digest on, 8 at a time, until the tick's deadline; the ones left wait for the next tick. */
export async function sweepDigests(now: number, deadline: number): Promise<Partial<Record<DigestOutcome, number>>> {
  const ids = await db.smembers(globalKey.digests());
  const outcomes = await pmap(ids, (id) => (Date.now() > deadline ? Promise.resolve<DigestOutcome>("late") : digestFor(id, now).catch((e): DigestOutcome => {
    log.error("digest failed", e);
    return "failed";
  })), 8);
  const tally: Partial<Record<DigestOutcome, number>> = {};
  for (const o of outcomes) tally[o] = (tally[o] ?? 0) + 1;
  return tally;
}
