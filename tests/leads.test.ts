import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { json, newUser, signIn, signOut } from "./helpers/session";
import { createUser } from "@/lib/auth";
import { db } from "@/lib/db";
import * as support from "@/app/api/support/route";
import * as affiliates from "@/app/api/affiliates/route";
import * as leads from "@/app/api/admin/leads/route";
import type { Lead } from "@/lib/leads";

/**
 * Rules 353-355 (#134). Enterprise and early-customer requests and affiliate applications were stored, but the founder
 * console had no view of them and email cannot reach the founder yet, so a sales lead could sit unread while the visitor
 * was told the team would reply soon. The console's Leads tab reads GET /api/admin/leads.
 */

const FOUNDER = "leads-founder@test.example";
let ip = 0;
const from = () => ({ "x-real-ip": `10.9.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` });
const contact = (name: string, company: string, message: string) => [`Name: ${name}`, `Company: ${company}`, "", message].join("\n");
type Body = { ok: boolean; leads: Lead[]; total: number; unread: number; seenAt: string | null; mail: { ready: boolean; forwardTo: boolean } };
const list = async (query = "") => {
  const r = await leads.GET(json(`/api/admin/leads${query}`, "GET"));
  return { status: r.status, body: (await r.json()) as Body };
};

beforeAll(async () => {
  vi.stubEnv("ADMIN_EMAILS", FOUNDER);
  await createUser({ email: FOUNDER, name: "Founder", phone: "", password: "abc12345", lang: "ar" });
});
afterEach(() => signOut());

describe("rule 353: only the founder reads leads", () => {
  it("anonymous and customer callers get 401 on GET, the CSV and POST", async () => {
    expect((await list()).status).toBe(401);
    expect((await leads.GET(json("/api/admin/leads?format=csv", "GET"))).status).toBe(401);
    expect((await leads.POST(json("/api/admin/leads", "POST", { action: "seen" }))).status).toBe(401);
    const customer = await newUser("leads-customer");
    await signIn(customer.email);
    expect((await list()).status).toBe(401);
    expect((await leads.POST(json("/api/admin/leads", "POST", { action: "seen" }))).status).toBe(401);
  });
});

describe("rule 354: the Leads tab lists sales leads newest first, with an unread count", () => {
  it("an anonymous enterprise request, an early-customer request and an affiliate application all appear, newest first", async () => {
    const tag = `t${Date.now()}`;
    expect((await support.POST(json("/api/support", "POST", { email: `ent-${tag}@co.example`, message: contact("Sara", "Roastery Co", "We have 12 branches"), type: "enterprise", page: "/enterprise", lang: "en" }, from()))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect((await support.POST(json("/api/support", "POST", { email: `q-${tag}@co.example`, message: "How do I reset?", type: "question" }, from()))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect((await affiliates.POST(json("/api/affiliates", "POST", { name: "Fahad", email: `aff-${tag}@co.example`, phone: "+966 50 000 0000", channel: "YouTube", audience: "10k" }, from()))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect((await support.POST(json("/api/support", "POST", { email: `early-${tag}@co.example`, message: contact("Noura", "Bakery", "Interested"), type: "early-adopter", page: "/customers" }, from()))).status).toBe(200);

    await signIn(FOUNDER);
    const { status, body } = await list();
    expect(status).toBe(200);
    const mine = body.leads.filter((l) => l.email.includes(tag));
    expect(mine.map((l) => l.kind), "sales leads only, newest first").toEqual(["early-adopter", "affiliate", "enterprise"]);
    const ent = mine.find((l) => l.kind === "enterprise")!;
    expect([ent.name, ent.company, ent.message, ent.page, ent.lang]).toEqual(["Sara", "Roastery Co", "We have 12 branches", "/enterprise", "en"]);
    expect(mine.find((l) => l.kind === "affiliate")!.phone).toBe("+966 50 000 0000");
    expect(body.unread).toBeGreaterThanOrEqual(3);

    const everything = await list("?all=1");
    expect(everything.body.leads.filter((l) => l.email.includes(tag)).map((l) => l.kind)).toEqual(["early-adopter", "affiliate", "support", "enterprise"]);
  });

  it("opening the tab marks everything read; a new lead counts again", async () => {
    await signIn(FOUNDER);
    expect((await leads.POST(json("/api/admin/leads", "POST", { action: "seen" }))).status).toBe(200);
    expect((await list()).body.unread).toBe(0);
    expect((await leads.POST(json("/api/admin/leads", "POST", { action: "other" }))).status).toBe(400);
    await new Promise((r) => setTimeout(r, 5));
    signOut();
    await support.POST(json("/api/support", "POST", { email: "later@co.example", message: contact("A", "B", "C"), type: "enterprise" }, from()));
    await support.POST(json("/api/support", "POST", { email: "later-q@co.example", message: "a question", type: "question" }, from()));
    await signIn(FOUNDER);
    expect((await list()).body.unread, "a plain support question is not a sales lead").toBe(1);
  });

  it("pages are capped at 100 rows and follow offset", async () => {
    await signIn(FOUNDER);
    const all = (await list("?all=1&limit=1000")).body;
    expect(all.leads.length).toBeLessThanOrEqual(100);
    const second = (await list("?all=1&limit=2&offset=1")).body;
    expect(second.leads.map((l) => l.at)).toEqual(all.leads.slice(1, 3).map((l) => l.at));
    expect((await list("?limit=0")).body.leads).toEqual([]);
  });

  it("warns while email cannot reach the founder", async () => {
    await signIn(FOUNDER);
    vi.stubEnv("RESEND_API_KEY", "re_key");
    vi.stubEnv("MAIL_FROM", "");
    expect((await list()).body.mail.ready).toBe(false);
    vi.stubEnv("MAIL_FROM", "Noor <noor@mail.example>");
    expect((await list()).body.mail.ready).toBe(true);
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAIL_FROM", "");
  });
});

describe("rule 355: lead contents stay out of logs and are inert in the CSV", () => {
  it("the CSV escapes formula cells, and no lead field is logged", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const logBefore = await db.lrange("admin:log", 0, 1999);
    await support.POST(json("/api/support", "POST", { email: "csv@co.example", message: contact("=HYPERLINK(\"http://x.example\")", "+cmd", "@SUM(1)"), type: "enterprise" }, from()));
    await signIn(FOUNDER);
    const r = await leads.GET(json("/api/admin/leads?format=csv", "GET"));
    expect(r.headers.get("content-type")).toMatch(/text\/csv/);
    const csv = await r.text();
    const row = csv.split("\r\n").find((l) => l.includes("csv@co.example"))!;
    expect(row).toContain(`"'=HYPERLINK(""http://x.example"")"`);
    expect(row).toContain(`"'+cmd"`);
    expect(row).toContain(`"'@SUM(1)"`);
    await list();
    await leads.POST(json("/api/admin/leads", "POST", { action: "seen" }));
    const printed = spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))).join(" ");
    spies.forEach((s) => s.mockRestore());
    expect(printed).not.toContain("csv@co.example");
    const logAfter = await db.lrange("admin:log", 0, 1999);
    expect(logAfter.slice(0, logAfter.length - logBefore.length).join(" ")).not.toContain("csv@co.example");
  });
});
