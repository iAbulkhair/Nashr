/**
 * Reem B3, the quiet hold (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §6, ruling P2). Rule 917 (sweep
 * part): a reminder whose time falls inside a meeting of the brand's linked marketing calendar stays due until the
 * meeting chain ends, at most four hours after its time; stale events, a link that needs reconnecting and a reminder set
 * before the meeting starts fire as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { saveBrand, type Brand } from "@/lib/brand";
import { SEC_KEYS, getItem } from "@/lib/secretary";
import type { SecItem } from "@/lib/secretary-agenda";
import { sweepReminders } from "@/lib/secretary-remind";
import { putLink, sealTokens, type CalLink } from "@/lib/secretary-cal-link";
import { QUIET_CAP_MS, quietUntil, type Meeting } from "@/lib/secretary-meetings";

vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendEmail: async () => true }));

const BRAND: Brand = { name: "Rif", website: "https://brand.example", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-10-05" };
const M = 60_000;
const H = 3_600_000;
/** 2026-11-01 (a Sunday) at a Riyadh wall time, as an instant. */
const riyadh = (hh: number, mm = 0) => Date.parse(`2026-11-01T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+03:00`);
const meeting = (from: number, to: number, title = "Launch review"): Meeting => ({ start: new Date(from).toISOString(), end: new Date(to).toISOString(), title, allDay: false });
const linkOf = (over: Partial<CalLink> = {}): CalLink => ({ v: 1, provider: "gcal", login: "o@brand.example", account: "o@brand.example", proof: "domain", calendarId: "cal1", calendarName: "Marketing", tokens: sealTokens({ access: "a", refresh: "r", expiresAt: 0 }), state: "ok", connectedAt: 1, rev: 1, ...over });

async function owner(prefix: string): Promise<string> {
  const u = await newUser(prefix);
  await saveBrand(u.email, BRAND);
  return u.email;
}
/** An open item with a reminder at `remindAt`, stored and indexed the way the write path leaves it. */
async function seed(scope: string, remindAt: number): Promise<string> {
  const at = new Date(remindAt - H).toISOString();
  const it: SecItem = { id: `s${createHash("sha1").update(scope).digest("hex").slice(0, 16)}`, kind: "task", title: "Send the offer", description: "", result: null, direction: "i_owe", owedBy: "owner", owedTo: null, dueAt: null, allDay: false, snoozeUntil: null, priority: 1, critical: false, links: {}, source: "owner", notes: [], createdAt: at, updatedAt: at, completedAt: null, proposedDone: null, deletedAt: null, expiresAt: null, remindAt: new Date(remindAt).toISOString(), rev: 1 };
  await Promise.all([db.set(SEC_KEYS.item(scope, it.id), it), db.zadd(SEC_KEYS.open(scope), 32503680000000, it.id), db.sadd(SEC_KEYS.all(scope), it.id), db.zadd(SEC_KEYS.due(scope), remindAt, it.id), db.zadd(SEC_KEYS.dueScopes, remindAt, scope)]);
  return it.id;
}
/** The calendar as a sync at `syncedAt` left it. */
const calendar = (scope: string, events: Meeting[], syncedAt: number, link = linkOf()) => Promise.all([putLink(scope, link), db.set(SEC_KEYS.calEvents(scope), { syncedAt, events }, 86_400)]);
/** One tick at `now` with events synced at that moment, and whether the reminder has fired since. */
async function tick(scope: string, id: string, now: number, events: Meeting[], link = linkOf()) {
  await calendar(scope, events, now, link);
  const report = await sweepReminders(now);
  return { report, fired: (await getItem(scope, id))?.remindAt === null };
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
beforeEach(() => { vi.stubEnv("ADMIN_EMAILS", ""); });

describe("rule 917 (quiet part): quietUntil", () => {
  const ms = [meeting(riyadh(10), riyadh(11))];
  it("holds a reminder inside a meeting until it ends, and not one before it starts or at its end", () => {
    expect(quietUntil(ms, riyadh(10, 15))).toBe(riyadh(11));
    expect(quietUntil(ms, riyadh(9, 45))).toBeNull();
    expect(quietUntil(ms, riyadh(11))).toBeNull();
    expect(quietUntil([], riyadh(10, 15))).toBeNull();
  });
  it("follows back-to-back and overlapping meetings, and stops at a gap", () => {
    expect(quietUntil([meeting(riyadh(11), riyadh(12)), ...ms], riyadh(10, 15))).toBe(riyadh(12));
    expect(quietUntil([...ms, meeting(riyadh(10, 30), riyadh(11, 30))], riyadh(10, 15))).toBe(riyadh(11, 30));
    expect(quietUntil([...ms, meeting(riyadh(11, 5), riyadh(12))], riyadh(10, 15))).toBe(riyadh(11));
  });
  it("is capped four hours after the reminder's time, and ignores a malformed meeting", () => {
    expect(QUIET_CAP_MS).toBe(4 * H);
    expect(quietUntil([meeting(riyadh(10), riyadh(16))], riyadh(10, 15))).toBe(riyadh(14, 15));
    expect(quietUntil([{ start: "x", end: "y", title: "", allDay: false }, meeting(riyadh(11), riyadh(10))], riyadh(10, 15))).toBeNull();
  });
});

describe("rule 917 (sweep part): a reminder waits for the meeting the owner is in", () => {
  it("a reminder at 10:15 inside a 10:00-11:00 meeting holds at 10:15 and fires at 11:00", async () => {
    const s = await owner("quiet1");
    const id = await seed(s, riyadh(10, 15));
    const ev = [meeting(riyadh(10), riyadh(11))];
    const first = await tick(s, id, riyadh(10, 15), ev);
    expect(first.fired).toBe(false);
    expect(first.report.quiet).toBe(1);
    expect(first.report.claimed).toBe(0);
    expect((await db.zrangeWithScores(SEC_KEYS.due(s))).find((m) => m.member === id)?.score).toBe(riyadh(10, 15));
    expect((await tick(s, id, riyadh(11), ev)).fired).toBe(true);
  });

  it("back-to-back meetings 10:00-11:00 and 11:00-12:00: the 11:00 tick holds and the 12:00 tick fires", async () => {
    const s = await owner("quiet2");
    const id = await seed(s, riyadh(10, 15));
    const ev = [meeting(riyadh(10), riyadh(11)), meeting(riyadh(11), riyadh(12))];
    expect((await tick(s, id, riyadh(11), ev)).fired).toBe(false);
    expect((await tick(s, id, riyadh(12), ev)).fired).toBe(true);
  });

  it("a meeting 10:00-16:00: the 14:00 tick holds and the 14:15 tick fires (the four-hour cap)", async () => {
    const s = await owner("quiet3");
    const id = await seed(s, riyadh(10, 15));
    const ev = [meeting(riyadh(10), riyadh(16))];
    expect((await tick(s, id, riyadh(14), ev)).fired).toBe(false);
    expect((await tick(s, id, riyadh(14, 15), ev)).fired).toBe(true);
  });

  it("stale events (synced 50 minutes ago) do not hold it", async () => {
    const s = await owner("quiet4");
    const id = await seed(s, riyadh(10, 15));
    await calendar(s, [meeting(riyadh(10), riyadh(11))], riyadh(10, 15) - 50 * M);
    const report = await sweepReminders(riyadh(10, 15));
    expect(report.quiet).toBe(0);
    expect((await getItem(s, id))?.remindAt).toBeNull();
  });

  it("a link that needs reconnecting does not hold it", async () => {
    const s = await owner("quiet5");
    const id = await seed(s, riyadh(10, 15));
    expect((await tick(s, id, riyadh(10, 15), [meeting(riyadh(10), riyadh(11))], linkOf({ state: "reconnect" }))).fired).toBe(true);
  });

  it("a reminder at 09:45, before a 10:00 meeting, fires at the 10:05 tick", async () => {
    const s = await owner("quiet6");
    const id = await seed(s, riyadh(9, 45));
    expect((await tick(s, id, riyadh(10, 5), [meeting(riyadh(10), riyadh(11))])).fired).toBe(true);
  });

  it("another brand's meeting never holds this brand's reminder", async () => {
    const s = await owner("quiet7");
    const other = await owner("quiet7b");
    const id = await seed(s, riyadh(10, 15));
    await calendar(other, [meeting(riyadh(10), riyadh(11))], riyadh(10, 15));
    const report = await sweepReminders(riyadh(10, 15));
    expect(report.quiet).toBe(0);
    expect((await getItem(s, id))?.remindAt).toBeNull();
  });
});
