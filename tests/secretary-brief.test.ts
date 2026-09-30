import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { getUser, saveUser, type User } from "@/lib/auth";
import { saveBrand, saveTask, type Brand } from "@/lib/brand";
import { saveBrands, scopeFor } from "@/lib/brands";
import { runDaily, saveSchedule } from "@/lib/schedule";
import { followUps, listNotifs, pushNotif, type Notif } from "@/lib/notifications";
import { SEC_ALERTS_PER_DAY, SEC_KEYS, newSecId, overdueAlertFingerprint } from "@/lib/secretary";
import { AUTO_CLOSE_RESULT, alertStep, type SecItem } from "@/lib/secretary-agenda";

// Rules 199, 200 and 208 in docs/system/tests.md: Reem's block in the 8 AM brief and email, the overdue alerts, and the
// atomic notification marker; and the daily cron's part of rule 193: the purge (idle scopes included) and the automatic
// close.

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendEmail: async (to: string, subject: string, text: string) => { sent.push({ to, subject, text }); return true; } }));
import * as cronDaily from "@/app/api/cron/daily/route";

const BRAND: Brand = { name: "Rif", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-09-29" };

/** One stored open item, written the way createItem writes it (item, open set, id index). */
async function seed(scope: string, p: Partial<SecItem> & { title: string }): Promise<SecItem> {
  const at = new Date().toISOString();
  const it: SecItem = { id: newSecId(), kind: "task", description: "", result: null, direction: "i_owe", owedBy: "owner", owedTo: null, dueAt: null, allDay: false, snoozeUntil: null, priority: 1, critical: false, links: {}, source: "owner", notes: [], createdAt: at, updatedAt: at, completedAt: null, proposedDone: null, deletedAt: null, expiresAt: null, rev: 1, ...p };
  await Promise.all([db.set(SEC_KEYS.item(scope, it.id), it), db.zadd(SEC_KEYS.open(scope), it.dueAt ? Date.parse(it.dueAt) : 32503680000000, it.id), db.sadd(SEC_KEYS.all(scope), it.id)]);
  return it;
}
/** One item deleted more than 30 days ago, stored the way a delete leaves it (item, deleted set, id index). */
async function seedExpired(scope: string, title: string): Promise<SecItem> {
  const past = Date.now() - 1000;
  const it = await seed(scope, { title, deletedAt: new Date(past - 30 * 864e5).toISOString(), expiresAt: new Date(past).toISOString() });
  await Promise.all([db.zrem(SEC_KEYS.open(scope), it.id), db.zadd(SEC_KEYS.deleted(scope), past, it.id)]);
  return it;
}
const gone = async (scope: string, id: string) => ({
  item: await db.get(SEC_KEYS.item(scope, id)), all: (await db.smembers(SEC_KEYS.all(scope))).includes(id), deleted: (await db.zrangeWithScores(SEC_KEYS.deleted(scope))).some((m) => m.member === id),
});
const cron = (secret: string) => cronDaily.GET(new Request("https://nashr.test/api/cron/daily", { headers: { authorization: `Bearer ${secret}` } }));
const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
const ahead = (d: number) => new Date(Date.now() + d * 864e5).toISOString();

async function workspace(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await saveBrand(u.email, BRAND);
  return u;
}

beforeEach(() => { sent.length = 0; });

describe("the morning brief carries Reem's block (rule 199)", () => {
  it("counts overdue, today and waiting items and names the first three overdue or due-today titles, without a model", async () => {
    const u = await workspace("brief");
    await seed(u.email, { title: "Pay the printer", dueAt: ago(30) });
    await seed(u.email, { title: "Call the bank", dueAt: ago(2), critical: true });
    await seed(u.email, { title: "Invoice from Ahmad", direction: "they_owe", owedBy: "أحمد", owedTo: "owner", dueAt: ahead(3) });
    await seed(u.email, { title: "Hidden for now", dueAt: ago(5), snoozeUntil: ahead(1) });
    const brief = (await runDaily(u))!;
    expect(brief.agenda).toMatchObject({ overdue: 2, waiting: 1 });
    // Critical first, then the earliest due.
    expect(brief.agenda!.top.slice(0, 2)).toEqual(["Call the bank", "Pay the printer"]);
    expect(brief.text).toContain("مهامك (ريم): 2 متأخرة");
    expect(brief.text).toContain("«Call the bank»");
    expect(brief.text).not.toContain("Hidden for now");
    expect(await db.get(`brief:${u.email}`)).toMatchObject({ agenda: { overdue: 2 } });
  });

  it("adds nothing when the list is empty", async () => {
    const u = await workspace("briefempty");
    const brief = (await runDaily(u))!;
    expect(brief.agenda).toMatchObject({ overdue: 0, today: 0, waiting: 0, top: [] });
    expect(brief.text).not.toContain("ريم");
  });

  it("the daily email includes the block, and the 'important' preference sends for an overdue to-do", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-brief");
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const late = await workspace("briefmail");
    const quiet = await workspace("briefquiet");
    for (const u of [late, quiet]) {
      await db.set(`profile:${u.email}`, { emails: "important" });
      // Follow-ups off, so only the brief itself can make the email "important".
      await saveSchedule(u.email, { followUps: false });
    }
    await seed(late.email, { title: "Renew the licence", dueAt: ago(4) });
    const res = await cronDaily.GET(new Request("https://nashr.test/api/cron/daily", { headers: { authorization: "Bearer cron-secret-brief" } }));
    expect(res.status).toBe(200);
    const mail = sent.find((m) => m.to === late.email);
    expect(mail?.text).toContain("مهامك (ريم): 1 متأخرة");
    expect(mail?.text).toContain("«Renew the licence»");
    expect(sent.find((m) => m.to === quiet.email)).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

describe("one alert per overdue item, spaced, then only the brief (rule 200)", () => {
  // A fixed clock: Monday 5 October 2026, 12:00 in Riyadh (09:00 UTC). Only Date is faked; timers run.
  const T0 = Date.parse("2026-10-05T09:00:00Z");
  const at = (days: number, hours = 0) => new Date(T0 + days * 864e5 + hours * 3600e3).toISOString();
  const todos = (ns: Notif[]) => ns.filter((n) => n.kind === "todo");
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it("alerts on the day an item falls behind and 1, 3 and 7 days later, each step once, then stops", async () => {
    const u = await workspace("fusteps");
    const late = await seed(u.email, { title: "Send the contract", dueAt: at(0, -3) }); // 09:00 Riyadh today
    const sent: Record<number, number> = {};
    // Past the markers' five days, too: nothing comes back after the seventh day.
    for (let day = 0; day <= 14; day++) {
      vi.setSystemTime(T0 + day * 864e5);
      const first = todos(await followUps(u, u.email));
      const again = todos(await followUps(u, u.email));
      expect(again, `day ${day}, second run`).toEqual([]);
      sent[day] = first.length;
      if (first.length) {
        expect(first[0]).toMatchObject({ agent: "reem", href: `/${u.lang}/app/todo`, title: "متأخرة: «Send the contract»" });
        expect(first[0].body.includes("آخر تنبيه"), `day ${day}`).toBe(day === 7);
      }
    }
    expect(sent).toEqual({ 0: 1, 1: 1, 2: 0, 3: 1, 4: 0, 5: 0, 6: 0, 7: 1, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0, 13: 0, 14: 0 });
    expect([...Array(10).keys()].map(alertStep)).toEqual([0, 1, 1, 3, 3, 3, 3, 7, null, null]);
    vi.setSystemTime(T0 + 9 * 864e5);
    // Silent from the eighth day, still in the morning brief.
    expect((await runDaily(u))!.agenda).toMatchObject({ overdue: 1, top: ["Send the contract"] });
    // Each marker lives five days: on day 9 only the seventh day's is left.
    const marker = async (step: number) => db.get(`notifseen:${u.email}:${overdueAlertFingerprint(u.email, late.id, late.dueAt!, step)}`);
    expect(await Promise.all([0, 1, 3, 7].map(marker))).toEqual([null, null, null, 1]);
  });

  it("a new due date is a new signature: a rescheduled item that falls behind again alerts afresh", async () => {
    const u = await workspace("furesched");
    const it = await seed(u.email, { title: "Pay the printer", dueAt: at(0, -3) });
    expect(todos(await followUps(u, u.email))).toHaveLength(1);
    expect(todos(await followUps(u, u.email))).toEqual([]);
    // Rescheduled to an hour ago, still today: the same step, a different signature.
    await db.set(SEC_KEYS.item(u.email, it.id), { ...it, dueAt: at(0, -1), rev: 2 });
    expect(todos(await followUps(u, u.email))).toHaveLength(1);
  });

  it("sends at most five a brand a day, critical and earliest first, and each brand of an account counts its own", async () => {
    const u = await workspace("fucap");
    const titles = Array.from({ length: 7 }, (_, i) => `Late ${i}`);
    const items = await Promise.all(titles.map((title, i) => seed(u.email, { title, dueAt: at(0, -1 - i), critical: i === 6 })));
    const first = todos(await followUps(u, u.email));
    expect(first).toHaveLength(SEC_ALERTS_PER_DAY);
    // Critical first, then the earliest due: "Late 6" (critical), then 5, 4, 3, 2; "Late 1" and "Late 0" wait.
    expect(first.map((n) => n.title)).toEqual(["Late 6", "Late 5", "Late 4", "Late 3", "Late 2"].map((t) => `متأخرة: «${t}»`));
    expect(todos(await followUps(u, u.email))).toEqual([]);
    expect(await db.get(SEC_KEYS.alerts(u.email, "2026-10-05"))).toBe(SEC_ALERTS_PER_DAY);
    // The two held back were handed back, not burnt: their markers are free for another day of their window.
    const marker = (it: SecItem) => db.get(`notifseen:${u.email}:${overdueAlertFingerprint(u.email, it.id, it.dueAt!, 0)}`);
    expect(await Promise.all(items.map(marker))).toEqual([null, null, 1, 1, 1, 1, 1]);
    // A second brand of the same account has its own allowance the same day.
    const second = scopeFor(u.email, "b2");
    await saveBrands(u.email, [{ id: "default", name: "", createdAt: at(0), status: "active" }, { id: "b2", name: "Two", createdAt: at(0), status: "active" }]);
    await seed(second, { title: "Late on the second brand", dueAt: at(0, -2) });
    expect(todos(await followUps(u, second))).toHaveLength(1);
  });

  it("stays quiet with nothing overdue, and when follow-ups are off", async () => {
    const u = await workspace("fuquiet");
    await seed(u.email, { title: "Next week", dueAt: at(5) });
    expect(todos(await followUps(u, u.email))).toEqual([]);
    const off = await workspace("fuoff");
    await seed(off.email, { title: "Late", dueAt: at(0, -5) });
    await saveSchedule(off.email, { followUps: false });
    expect(await followUps(off, off.email)).toEqual([]);
  });
});

describe("a notification's marker is claimed atomically (rule 208)", () => {
  it("two overlapping pushes with one fingerprint notify once", async () => {
    const u = await workspace("fuatomic");
    const n = { kind: "info" as const, title: "Once", body: "b", href: "/ar/app" };
    const both = await Promise.all([pushNotif(u.email, n, "same-fp"), pushNotif(u.email, n, "same-fp")]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect((await listNotifs(u.email)).filter((x) => x.title === "Once")).toHaveLength(1);
    // Without a fingerprint nothing is deduplicated, as before; and a marker that expired can be claimed again.
    await pushNotif(u.email, { ...n, title: "Twice" });
    await pushNotif(u.email, { ...n, title: "Twice" });
    expect((await listNotifs(u.email)).filter((x) => x.title === "Twice")).toHaveLength(2);
    expect(await pushNotif(u.email, n, "short-fp", 1)).not.toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 864e5 + 1000);
      expect(await pushNotif(u.email, n, "short-fp", 1)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("two overlapping follow-up runs alert each overdue item once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2026-10-05T09:00:00Z"));
      const u = await workspace("fuoverlap");
      await seed(u.email, { title: "One", dueAt: "2026-10-05T06:00:00.000Z" });
      await seed(u.email, { title: "Two", dueAt: "2026-10-05T07:00:00.000Z" });
      const [a, b] = await Promise.all([followUps(u, u.email), followUps(u, u.email)]);
      expect([...a, ...b].filter((x) => x.kind === "todo").map((x) => x.title).sort()).toEqual(["متأخرة: «One»", "متأخرة: «Two»"]);
      expect((await listNotifs(u.email)).filter((x) => x.kind === "todo")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the daily cron purges and closes (rule 193)", () => {
  it("purges expired deleted items in every scope, archived brands and suspended accounts included, and closes approved links", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-purge");
    const branded = await workspace("purgebrand");
    const bare = await newUser("purgebare"); // no brand file: the daily job still runs Reem's part
    const archived = await workspace("purgearch");
    const archivedScope = scopeFor(archived.email, "old");
    await saveBrands(archived.email, [{ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" }, { id: "old", name: "Old", createdAt: new Date().toISOString(), status: "archived" }]);
    const suspended = await workspace("purgesusp");
    await saveUser({ ...(await getUser(suspended.email))!, suspended: true });
    const expired = await Promise.all([branded.email, bare.email, archivedScope, suspended.email].map(async (scope) => ({ scope, it: await seedExpired(scope, `Expired in ${scope}`) })));
    const kept = await seed(branded.email, { title: "Still restorable", deletedAt: ago(24), expiresAt: new Date(Date.now() + 29 * 864e5).toISOString() });
    await db.zadd(SEC_KEYS.deleted(branded.email), Date.now() + 29 * 864e5, kept.id);
    await saveTask(bare.email, { id: "abababababab0001", type: "social", channel: "instagram", title: "Post", body: "b", status: "approved", createdAt: new Date().toISOString(), lang: "ar" }, true);
    const linked = await seed(bare.email, { title: "Waits for the post", links: { taskId: "abababababab0001" } });
    const res = await cron("cron-secret-purge");
    expect(res.status).toBe(200);
    const report = await res.json();
    for (const { scope, it } of expired) expect(await gone(scope, it.id), scope).toEqual({ item: null, all: false, deleted: false });
    expect(report.results[`idle:${archivedScope}`]).toBe("todo:1p");
    expect(report.results[`idle:${suspended.email}`]).toBe("todo:1p");
    expect(await gone(branded.email, kept.id)).toMatchObject({ all: true, deleted: true });
    const closed = (await db.get<SecItem>(SEC_KEYS.item(bare.email, linked.id)))!;
    expect(closed).toMatchObject({ result: AUTO_CLOSE_RESULT });
    expect(closed.completedAt).toBeTruthy();
    const log = (await db.lrange(SEC_KEYS.audit(bare.email), 0, -1)).map((x) => JSON.parse(x));
    expect(log.find((l) => l.action === "auto_close")).toMatchObject({ actor: "cron", via: "cron", id: linked.id });
    expect(log.find((l) => l.action === "purge")).toMatchObject({ actor: "cron", via: "cron" });
    // Suspended accounts still get no scheduled work: only the purge ran for them.
    expect(sent.find((m) => m.to === suspended.email)).toBeUndefined();
    vi.unstubAllEnvs();
  });
});
