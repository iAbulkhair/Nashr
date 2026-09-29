import { beforeEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import type { User } from "@/lib/auth";
import { saveBrand, type Brand } from "@/lib/brand";
import { runDaily, saveSchedule } from "@/lib/schedule";
import { followUps, listNotifs } from "@/lib/notifications";
import { SEC_KEYS, newSecId } from "@/lib/secretary";
import type { SecItem } from "@/lib/secretary-agenda";

// Rules 166 and 167 in docs/system/tests.md: Reem's block in the 8 AM brief and email, and the overdue follow-up.

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
    expect(todo[0].title).toContain("2");
    expect((await followUps(u, u.email)).filter((n) => n.kind === "todo")).toEqual([]);
    expect((await listNotifs(u.email)).filter((n) => n.kind === "todo")).toHaveLength(1);
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
