import { db } from "./db";

/**
 * The idle and absolute limits a short console session keeps (the console key session, rules 420-424, and the staff
 * session, rule 1634). One copy of the logic, so the two can never drift apart.
 *
 * A record carries `at` (when it was opened, epoch ms) and `seen` (its last renewal). It is live while both limits hold,
 * checked in code whatever TTL it was stored with. A live record is renewed at most once per `renew` seconds with one
 * `SET XX EX`, which rewrites `seen` and the TTL only while the record still exists, so a renewal racing a logout never
 * brings the session back. The TTL is the idle window, cut short by the absolute cap.
 */
export type IdleRec = { at: number; seen?: number };
export type IdleLimits = { idle: number; max: number; renew: number };

/** Seconds the record may live from `now`: the idle window, cut short by the absolute cap. 0 when it is over. */
export const idleTtl = (rec: IdleRec, now: number, l: IdleLimits) =>
  Math.max(0, Math.min(l.idle, Math.floor((rec.at + l.max * 1000 - now) / 1000)));

/** Both limits checked in code, whatever TTL the record was stored with. */
export const idleInTime = (rec: IdleRec, now: number, l: IdleLimits) =>
  typeof rec.at === "number" &&
  now - rec.at < l.max * 1000 &&
  now - (typeof rec.seen === "number" ? rec.seen : rec.at) < l.idle * 1000;

/**
 * Renew a live record: at most once per `l.renew` seconds (a request inside that window writes nothing), with one
 * `setXx` that rewrites `seen` and the TTL only while the record still exists. A failed renewal only shortens the
 * session; it never fails the request it rode on. `rec` is written as given (plus `seen`), so pass only stored fields.
 */
export async function renewIdle<T extends IdleRec>(key: string, rec: T, now: number, l: IdleLimits): Promise<void> {
  const last = typeof rec.seen === "number" ? rec.seen : rec.at;
  const ttl = idleTtl(rec, now, l);
  if (now - last >= l.renew * 1000 && ttl > 0) {
    await db.setXx(key, { ...rec, seen: now }, ttl).catch(() => false);
  }
}
