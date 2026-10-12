import { db } from "./db";

/**
 * Lightweight product analytics, self-hosted in Redis counters.
 * Events per day, active-user sets per day/week/month, per-user event totals.
 * Nothing leaves the workspace; no third-party analytics needed for the founder console.
 */
export const EVENTS = ["signup", "login", "onboard", "generate", "chat", "approve", "reject", "publish", "connect", "image", "error"] as const;
export type Event = (typeof EVENTS)[number];

export const day = (d = new Date()) => d.toISOString().slice(0, 10);
export function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - y0.getTime()) / 864e5 + 1) / 7)).padStart(2, "0")}`;
}

export async function track(email: string | undefined, event: Event) {
  const now = new Date();
  const d = day(now);
  try {
    await Promise.all([
      db.incrby(`ev:${d}:${event}`, 1),
      ...(email && event !== "error" ? [
        db.sadd(`active:d:${d}`, email),
        db.sadd(`active:w:${isoWeek(now)}`, email),
        db.sadd(`active:m:${d.slice(0, 7)}`, email),
        db.incrby(`uev:${email}:${event}`, 1),
        db.set(`ulast:${email}`, now.toISOString()),
        ...(event === "signup" ? [] : [db.set(`ufirst:${email}:${event}`, now.toISOString())].filter(() => true)),
      ] : []),
    ]);
    if (email && event !== "error" && event !== "signup") {
      // keep the first occurrence only
      const k = `ufirst:${email}:${event}`;
      const existing = await db.get<string>(`ufirst0:${email}:${event}`);
      if (!existing) await db.set(`ufirst0:${email}:${event}`, now.toISOString());
      await db.del(k);
    }
  } catch (e) {
    console.error("track failed", e);
  }
}

export async function userEvents(email: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  // One MGET for the eleven counters (rule 1433), not eleven GETs in a row: the console reads this for every user it lists.
  const counts = await db.mget<number>(EVENTS.map((e) => `uev:${email}:${e}`));
  EVENTS.forEach((e, i) => { if (counts[i]) out[e] = Number(counts[i]); });
  return out;
}
export const lastActive = (email: string) => db.get<string>(`ulast:${email}`);
export const firstEvent = (email: string, e: Event) => db.get<string>(`ufirst0:${email}:${e}`);
export const dayCount = async (d: string, e: Event) => Number((await db.get<number>(`ev:${d}:${e}`)) ?? 0);
export const activeCount = async (key: string) => (await db.smembers(key)).length;
