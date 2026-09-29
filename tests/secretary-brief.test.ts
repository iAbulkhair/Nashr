import { beforeEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { getUser, saveUser, type User } from "@/lib/auth";
import { saveBrand, saveTask, type Brand } from "@/lib/brand";
import { saveBrands, scopeFor } from "@/lib/brands";
import { runDaily, saveSchedule } from "@/lib/schedule";
import { followUps, listNotifs } from "@/lib/notifications";
import { SEC_KEYS, newSecId, overdueFingerprint } from "@/lib/secretary";
import { AUTO_CLOSE_RESULT, riyadhDay, type SecItem } from "@/lib/secretary-agenda";

// Rules 166 and 167 in docs/system/tests.md: Reem's block in the 8 AM brief and email, and the overdue follow-up; and
// the daily cron's part of rule 160: the purge (idle scopes included) and the automatic close.

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

describe("the morning brief carries Reem's block (rule 166)", () => {
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

describe("one overdue follow-up per brand per day (rule 167)", () => {
  it("adds one in-app notification from Reem linking to My to-dos, and not again the same day", async () => {
    const u = await workspace("fu");
    await seed(u.email, { title: "Send the contract", dueAt: ago(6) });
    await seed(u.email, { title: "Book the photographer", dueAt: ago(3) });
    const first = await followUps(u, u.email);
    const todo = first.filter((n) => n.kind === "todo");
    expect(todo).toHaveLength(1);
    expect(todo[0]).toMatchObject({ agent: "reem", href: `/${u.lang}/app/todo` });
    expect(todo[0].title).toBe("مهمتان متأخرتان في قائمتك");
    expect((await followUps(u, u.email)).filter((n) => n.kind === "todo")).toEqual([]);
    expect((await listNotifs(u.email)).filter((n) => n.kind === "todo")).toHaveLength(1);
    expect(await db.get(`notifseen:${u.email}:${overdueFingerprint(u.email, riyadhDay(Date.now()))}`)).toBeTruthy();
  });

  it("nudges again the next Riyadh day, and each brand of an account gets its own", async () => {
    const u = await workspace("fudays");
    const second = scopeFor(u.email, "b2");
    await saveBrands(u.email, [{ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" }, { id: "b2", name: "Two", createdAt: new Date().toISOString(), status: "active" }]);
    await seed(u.email, { title: "Late on the first brand", dueAt: ago(6) });
    await seed(second, { title: "Late on the second brand", dueAt: ago(6) });
    expect((await followUps(u, u.email)).filter((n) => n.kind === "todo")).toHaveLength(1);
    expect((await followUps(u, second)).filter((n) => n.kind === "todo")).toHaveLength(1);
    const today = riyadhDay(Date.now());
    for (const scope of [u.email, second]) expect(await db.get(`notifseen:${u.email}:${overdueFingerprint(scope, today)}`), scope).toBeTruthy();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 864e5);
      expect(riyadhDay(Date.now())).not.toBe(today);
      expect((await followUps(u, u.email)).filter((n) => n.kind === "todo")).toHaveLength(1);
      expect((await followUps(u, u.email)).filter((n) => n.kind === "todo")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    expect((await listNotifs(u.email)).filter((n) => n.kind === "todo")).toHaveLength(3);
  });

  it("stays quiet with nothing overdue, and when follow-ups are off", async () => {
    const u = await workspace("fuquiet");
    await seed(u.email, { title: "Next week", dueAt: ahead(5) });
    expect((await followUps(u, u.email)).filter((n) => n.kind === "todo")).toEqual([]);
    const off = await workspace("fuoff");
    await seed(off.email, { title: "Late", dueAt: ago(5) });
    await saveSchedule(off.email, { followUps: false });
    expect(await followUps(off, off.email)).toEqual([]);
  });
});

describe("the daily cron purges and closes (rule 160)", () => {
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
