import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The founder's daily margin alert and the console's Integrations page (rules 1530-1549, docs/system/flows.md section 69,
 * docs/system/tests/1530-margin-integrations.md).
 */
import { db } from "@/lib/db";
import { getUser, saveUser, type Plan, type User, acct } from "@/lib/auth";
import { wipeAccount } from "@/lib/account";
import { listNotifs } from "@/lib/notifications";
import { monthKey } from "@/lib/credits";
import { SAR_PER_USD } from "@/lib/pricing";
import { mediaCostKey, meterRender, usageMonthKeys } from "@/lib/usage";
import { MARGIN_ALERT_PCT, MARGIN_DAY_TTL_S, MARGIN_LAST_KEY, accountMargins, alertText, marginAlertedKey, marginDayKey, marginPct, runMarginAlert, underFloor } from "@/lib/margin";
import { INTEGRATIONS, gatesOf, integrationNames, integrationsView, statusOf } from "@/lib/integration-status";
import { ADMIN_LABEL, ADMIN_SECTIONS } from "@/lib/admin-gate";
import { PROVIDERS, isDirectApp } from "@/lib/connectors/registry";
import { TOOLKITS } from "@/lib/connectors/composio-catalog";
import { adminSignIn, json, newUser, signOut } from "./helpers/session";
import * as integrationsRoute from "@/app/api/admin/integrations/route";
import * as overviewRoute from "@/app/api/admin/overview/route";
import * as planRoute from "@/app/api/admin/plan/route";
import * as daily from "@/app/api/cron/daily/route";

const KEY = "test-admin-key-margin-integrations";
beforeAll(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });
afterEach(() => { signOut(); vi.unstubAllEnvs(); vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); });

const src = (f: string) => readFileSync(f, "utf8");
async function account(plan: Plan, extra: Partial<User> = {}, prefix = "mg"): Promise<User> {
  const u = await newUser(prefix);
  const x = { ...(await getUser(acct(u)))!, plan, ...extra };
  await saveUser(x);
  return x;
}
/** Model and media cost for `email` in `month`, in USD, as the counters store them (micro-dollars). */
const spend = (email: string, month: string, modelUsd: number, mediaUsd = 0) =>
  Promise.all([db.set(`usage:${email}:${month}:usd_micro`, Math.round(modelUsd * 1e6)), db.set(mediaCostKey(email, month), Math.round(mediaUsd * 1e6))]);

describe("the margin formula (rule 1530)", () => {
  it("is (revenue net of VAT minus cost × SAR_PER_USD) over revenue, rounded; null without revenue", () => {
    expect(SAR_PER_USD).toBe(3.75);
    expect(marginPct(499, 0)).toBe(100);
    expect(marginPct(499, 70)).toBe(Math.round(((499 - 70 * 3.75) / 499) * 100));
    expect(marginPct(499, 70)).toBe(47);
    expect(marginPct(299, 200)).toBeLessThan(0);
    expect(marginPct(0, 10)).toBeNull();
    expect(marginPct(Number.NaN, 10)).toBeNull();
    expect(marginPct(299, -5)).toBe(100);
    expect(MARGIN_ALERT_PCT).toBe(50);
  });

  it("counts paying accounts only, with the Agency deal price and media cost, lowest first (rules 1530, 1531, 1539)", async () => {
    const month = "2031-03";
    const pro = await account("pro");
    const trial = await account("trial");
    const off = await account("starter", { suspended: true });
    const agency = await account("agency", { deal: { credits: 5000, priceSar: 3330, setAt: "2031-03-01T00:00:00.000Z", setBy: "f@test.example" } });
    await Promise.all([spend(acct(pro), month, 50, 20), spend(acct(trial), month, 500), spend(acct(off), month, 500), spend(acct(agency), month, 10)]);
    const mget = vi.spyOn(db, "mget");
    const rows = await accountMargins([pro, trial, off, agency], month);
    expect(mget).toHaveBeenCalledTimes(1);
    mget.mockRestore();
    expect(rows.map((r) => r.email)).toEqual([pro.email, agency.email]);
    expect(rows[0]).toMatchObject({ plan: "pro", revenueSar: 499, modelUsd: 50, mediaUsd: 20, costSar: 262.5, marginPct: 47 });
    expect(rows[1]).toMatchObject({ plan: "agency", revenueSar: 3330, marginPct: marginPct(3330, 10) });
    expect(underFloor(rows).map((r) => r.email)).toEqual([pro.email]);
  });

  it("the alert text names plans and margins, never an account (rule 1536)", () => {
    for (const lang of ["ar", "en"] as const) {
      const t = alertText([{ plan: "pro", marginPct: 47 }], lang);
      expect(t.title + t.body).toContain("47%");
      expect(t.title + t.body).not.toMatch(/@/);
    }
    expect(alertText([{ plan: "pro", marginPct: 47 }], "ar").title).toContain("هامش");
  });
});

describe("per-account media cost (rule 1531)", () => {
  it("meterRender adds micro-dollars to the account's month, ignores junk, and wipeAccount removes it", async () => {
    const u = await newUser("mg-media");
    await meterRender(acct(u), 0.08);
    await meterRender(acct(u), 0.02);
    await meterRender(acct(u), undefined);
    await meterRender(acct(u), -1);
    await meterRender(acct(u), Number.NaN);
    expect(await db.get<number>(mediaCostKey(acct(u)))).toBe(100000);
    expect(mediaCostKey(acct(u))).toBe(`usage:${acct(u)}:${monthKey()}:media_usd_micro`);
    expect(usageMonthKeys(acct(u), monthKey())).toContain(mediaCostKey(acct(u)));
    await wipeAccount(acct(u));
    expect(await db.get(mediaCostKey(acct(u)))).toBeNull();
  });

  it("a render's cost is counted to the account only while it is the same account (spec A32)", () => {
    const s = src("src/lib/media/jobs.ts");
    expect(s).toMatch(/own\.then\(\(ok\) => \(ok \? meterRender\(cur\.email, costUsd\) : undefined\)\)/);
    expect(s).toMatch(/own\.then\(\(ok\) => \(ok \? meterRender\(cur\.email, failed\.costUsd\) : undefined\)\)/);
  });
});

describe("the daily run (rules 1534-1539)", () => {
  it("alerts every founder once per account per day, records the day, and changes no customer (rules 1535-1538)", async () => {
    const founder = await account("trial", {}, "mg-founder");
    vi.stubEnv("ADMIN_EMAILS", founder.email);
    const day1 = new Date("2031-05-10T06:00:00Z");
    const month = monthKey(day1);
    const low = await account("pro", {}, "mg-low");
    const fine = await account("business", {}, "mg-fine");
    await Promise.all([spend(acct(low), month, 50, 20), spend(acct(fine), month, 5)]);
    const before = await Promise.all([getUser(acct(low)), getUser(acct(fine))]);

    const r1 = await runMarginAlert(day1);
    expect(r1).toMatchObject({ day: "2031-05-10", month: "2031-05" });
    if ("error" in r1) throw new Error(r1.error);
    expect(r1.alerted).toBeGreaterThanOrEqual(1);
    expect(await db.get(marginAlertedKey("2031-05-10", low.email))).not.toBeNull();
    expect(await db.get(marginAlertedKey("2031-05-10", fine.email))).toBeNull();
    expect(marginAlertedKey("2031-05-10", low.email)).not.toContain(low.email);
    const rec = await db.get<{ rows: { email: string }[] }>(marginDayKey("2031-05-10"));
    expect(rec?.rows.map((r) => r.email)).toContain(low.email);
    expect(rec?.rows.map((r) => r.email)).not.toContain(fine.email);
    const last = await db.get<Record<string, unknown>>(MARGIN_LAST_KEY);
    expect(last).toMatchObject({ day: "2031-05-10", under: r1.under, alerted: r1.alerted });
    expect(JSON.stringify(last)).not.toContain("@");
    // The day's rows (with emails) live 8 days, the per-account marker 2 days, the counts until the next run (rules 1535, 1538).
    expect(MARGIN_DAY_TTL_S).toBe(8 * 86400);
    const [dayTtl, markerTtl, lastTtl] = await Promise.all([db.ttl(marginDayKey("2031-05-10")), db.ttl(marginAlertedKey("2031-05-10", low.email)), db.ttl(MARGIN_LAST_KEY)]);
    expect(dayTtl).toBeGreaterThan(8 * 86400 - 60);
    expect(dayTtl).toBeLessThanOrEqual(8 * 86400);
    expect(markerTtl).toBeGreaterThan(2 * 86400 - 60);
    expect(markerTtl).toBeLessThanOrEqual(2 * 86400);
    expect(lastTtl).toBe(-1);

    const bell1 = (await listNotifs(acct(founder))).filter((n) => n.href.endsWith("/admin/usage#margin"));
    expect(bell1).toHaveLength(1);
    expect(bell1[0]).toMatchObject({ kind: "credits", href: "/ar/admin/usage#margin" });
    expect(bell1[0].title + bell1[0].body).not.toContain(low.email);
    expect(bell1[0].title + bell1[0].body).not.toContain("@");

    // Same day again: nobody new, no second bell item.
    const r2 = await runMarginAlert(new Date("2031-05-10T18:00:00Z"));
    expect(r2).toMatchObject({ alerted: 0 });
    expect((await listNotifs(acct(founder))).filter((n) => n.href.endsWith("/admin/usage#margin"))).toHaveLength(1);

    // The next day the account still under the floor is alerted again, once.
    const r3 = await runMarginAlert(new Date("2031-05-11T06:00:00Z"));
    expect((r3 as { alerted: number }).alerted).toBeGreaterThanOrEqual(1);
    expect((await listNotifs(acct(founder))).filter((n) => n.href.endsWith("/admin/usage#margin"))).toHaveLength(2);

    // Read-only for customers: the accounts are exactly as they were, and they got no bell item.
    expect(await Promise.all([getUser(acct(low)), getUser(acct(fine))])).toEqual(before);
    expect((await listNotifs(acct(low))).filter((n) => n.href.includes("margin"))).toEqual([]);
  });

  it("without founders it still records the run and never throws (rule 1536)", async () => {
    vi.stubEnv("ADMIN_EMAILS", "");
    const r = await runMarginAlert(new Date("2031-06-02T06:00:00Z"));
    expect(r).toMatchObject({ day: "2031-06-02" });
  });

  it("runs inside the daily cron's first hop behind the bearer secret, with no schedule of its own (rule 1534)", async () => {
    const s = src("src/app/api/cron/daily/route.ts");
    const hop = s.slice(s.indexOf('searchParams.get("chain")'), s.indexOf("const roster = await dailyRoster()"));
    expect(hop).toMatch(/margin = await runMarginAlert\(\)/);
    expect(s.indexOf("sameSecret(bearer, process.env.CRON_SECRET)")).toBeLessThan(s.indexOf("runMarginAlert()"));
    expect(s).toMatch(/emailConfigured: mailReady\(\), reminders, margin, checkouts \}/);
    vi.stubEnv("CRON_SECRET", "cron-secret-margin");
    const before = await db.get(MARGIN_LAST_KEY);
    const res = await daily.GET(new Request("https://nashr.test/api/cron/daily", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
    expect(await db.get(MARGIN_LAST_KEY)).toEqual(before);
    for (const f of ["vercel.json"]) {
      try { expect(src(f)).not.toMatch(/margin/); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
  });

  it("no db await inside a loop in margin.ts (rule 1539)", () => {
    const s = src("src/lib/margin.ts");
    expect(s).not.toMatch(/for \([^)]*\)\s*\{?[^}]*await db\./);
    expect(s).toMatch(/mgetChunked/);
    expect(s).toMatch(/pmap\(emails/);
  });
});

describe("the console shows margins (rules 1532, 1533)", () => {
  it("the overview carries the live accounts under the floor; the Usage page has the Margin section", async () => {
    const low = await account("starter", {}, "mg-ov");
    await spend(acct(low), monthKey(), 60);
    await adminSignIn();
    const ov = (await (await overviewRoute.GET(json("/api/admin/overview", "GET"))).json()) as { margin: { floorPct: number; under: { email: string; marginPct: number }[] } };
    expect(ov.margin.floorPct).toBe(50);
    expect(ov.margin.under.find((r) => r.email === low.email)?.marginPct).toBe(marginPct(299, 60));
    const u = src("src/components/admin/Usage.tsx");
    expect(u).toMatch(/<section id="margin"/);
    expect(u).toMatch(/title: "الهامش"/);
    expect(u).toMatch(/title: "Margin"/);
  });

  it("the Users table's margin includes media cost (rule 1532)", async () => {
    const u = await account("pro", {}, "mg-row");
    await spend(acct(u), monthKey(), 50, 20);
    await adminSignIn();
    const rows = ((await (await planRoute.GET(json("/api/admin/plan", "GET"))).json()) as { users: { email: string; marginPct: number | null; mediaUsd: number }[] }).users;
    expect(rows.find((r) => r.email === u.email)).toMatchObject({ marginPct: 47, mediaUsd: 20 });
  });
});

describe("Integrations: presence only (rules 1540-1544)", () => {
  it("the section is in the console nav in both languages (rule 1540)", () => {
    expect(ADMIN_SECTIONS).toContain("integrations");
    expect(ADMIN_LABEL.en.integrations).toBe("Integrations");
    expect(ADMIN_LABEL.ar.integrations).toBe("التكاملات");
    expect(src("src/components/admin/AdminNav.tsx")).toMatch(/integrations: "plug"/);
  });

  it("statusOf: all, partial, off, and any-of alternatives (rule 1542)", () => {
    const has = (set: string[]) => (n: string) => set.includes(n);
    expect(statusOf({ all: ["A", "B"] }, has(["A", "B"]))).toBe("on");
    expect(statusOf({ all: ["A", "B"] }, has(["A"]))).toBe("partial");
    expect(statusOf({ all: ["A", "B"] }, has([]))).toBe("off");
    expect(statusOf({ any: [["A", "B"], ["C", "D"]] }, has(["C", "D"]))).toBe("on");
    expect(statusOf({ any: [["A", "B"], ["C", "D"]] }, has(["A", "D"]))).toBe("partial");
    expect(statusOf({ any: [["A", "B"], ["C", "D"]] }, has([]))).toBe("off");
  });

  it("the same answer for any value: an empty value is unset, and no value, length or prefix is in the answer (rule 1542)", () => {
    const names = integrationNames();
    const a = Object.fromEntries(names.map((n) => [n, `SENTINEL-${n}-KEYPREFIX_0123456789abcdef`]));
    const b = Object.fromEntries(names.map((n) => [n, "x"]));
    const va = integrationsView(a, false), vb = integrationsView(b, false);
    expect(JSON.stringify(va)).toEqual(JSON.stringify(vb));
    expect(JSON.stringify(va)).not.toMatch(/SENTINEL|KEYPREFIX|0123456789/);
    expect(va.every((i) => i.status === "on")).toBe(true);
    const empty = integrationsView(Object.fromEntries(names.map((n) => [n, ""])), false);
    expect(empty.every((i) => i.status === "off")).toBe(true);
    // The source reads env values in exactly one place, the presence check.
    expect(src("src/lib/integration-status.ts").match(/env\[name\]/g)).toHaveLength(2);
  });

  it("gates come from the code constant and name presence only (rule 1543)", () => {
    const has = (set: string[]) => (n: string) => set.includes(n);
    expect(gatesOf("anthropic", has([]), true)[0]).toMatchObject({ id: "claude_paused", off: true });
    expect(gatesOf("anthropic", has([]), false)[0].off).toBe(false);
    expect(gatesOf("paymob", has([]))[0]).toMatchObject({ id: "paymob_live", off: true });
    expect(gatesOf("paymob", has(["PAYMOB_LIVE"]))[0].off).toBe(false);
    expect(gatesOf("kie", has([]))[0]).toMatchObject({ id: "media_models_on", off: true });
    expect(gatesOf("straitly", has(["LLM_PROVIDER"]))[0].off).toBe(false);
    expect(gatesOf("linkedin", has(["COMPOSIO_API_KEY"]))[0].off).toBe(true);
    expect(gatesOf("linkedin", has(["COMPOSIO_API_KEY", "COMPOSIO_PROVIDERS"]))[0].off).toBe(false);
    expect(gatesOf("fal", has([]))).toEqual([]);
  });

  it("every name is documented, and every connector and Composio toolkit name is covered (rule 1544)", () => {
    const doc = src("docs/system/variables.md");
    const names = integrationNames();
    for (const n of [...names, "MEDIA_MODELS_ON", "PAYMOB_LIVE", "LLM_PROVIDER", "COMPOSIO_PROVIDERS"]) expect(doc, n).toContain(n);
    // Rule 2175: a platform app's names only for the providers an app of ours connects; Composio-only ones are covered by their toolkit's auth name below.
    for (const p of PROVIDERS.filter(isDirectApp)) for (const n of [p.oauth!.clientIdEnv, p.oauth!.clientSecretEnv]) expect(names, `${p.id} ${n}`).toContain(n);
    for (const t of Object.values(TOOLKITS)) expect(names, t.authEnv).toContain(t.authEnv);
    expect(new Set(INTEGRATIONS.map((i) => i.id)).size).toBe(INTEGRATIONS.length);
    for (const i of INTEGRATIONS) for (const l of ["ar", "en"] as const) expect(i.name[l] && i.what[l], `${i.id} ${l}`).toBeTruthy();
  });

  it("GET /api/admin/integrations: 401 without a founder, 200 with one, no value in the answer, no write (rule 1541)", async () => {
    expect((await integrationsRoute.GET(json("/api/admin/integrations", "GET"))).status).toBe(401);
    vi.stubEnv("ANTHROPIC_API_KEY", "SENTINEL-anthropic-value");
    vi.stubEnv("PAYMOB_SECRET_KEY", "SENTINEL-paymob-value");
    await adminSignIn();
    const set = vi.spyOn(db, "set");
    const res = await integrationsRoute.GET(json("/api/admin/integrations", "GET"));
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("SENTINEL");
    const body = JSON.parse(text) as { items: { id: string; status: string }[] };
    expect(body.items.find((i) => i.id === "anthropic")?.status).toBe("on");
    expect(body.items.find((i) => i.id === "paymob")?.status).toBe("partial");
    const r = src("src/app/api/admin/integrations/route.ts");
    expect(r.indexOf("adminActor(req)")).toBeLessThan(r.indexOf("integrationsView()"));
    expect(r).not.toMatch(/console\.|adminAudit\(|db\./);
  });
});
