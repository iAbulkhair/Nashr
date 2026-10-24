import { afterEach, describe, expect, it, vi } from "vitest";
import { json, newUser, signIn, signOut, settle } from "./helpers/session";
import { acct, getUser, saveUser, sc, type Plan, type User } from "@/lib/auth";
import { getBrand, listLite, type Brand } from "@/lib/brand";
import { listBrands, scopeFor } from "@/lib/brands";
import { chargeOnboard, ONBOARD_HOLD_MS, refundOnboard } from "@/lib/credits";
import { db } from "@/lib/db";
import { saveGov } from "@/lib/governance";
import { ModelPaused } from "@/lib/model";
import { confirmOnboard, sweepOnboardHolds } from "@/lib/onboard-confirm";
import { AGENCY_BRANDS, ONBOARD_EXTRA_BRAND_COST, PLAN_BRANDS } from "@/lib/pricing";
import { BRANDS_PER_DAY, BRANDS_PER_HOUR } from "@/lib/rate";
import { getSchedule, runDaily, runWeekly, saveSchedule } from "@/lib/schedule";
import { DRAFT_TYPES, TASK_COST } from "@/lib/tasks";
import { runTool } from "@/lib/chat";
import { wipeAccount } from "@/lib/account";

/**
 * Active brands are capped per plan (founder decision 2026-10-09, rules 1390-1392, replacing rule 245's "unlimited"):
 * 1/1/2/5 for trial/starter/pro/business, Agency 10 or the founder's `User.brandCap`. Two more guardrails in code, not in
 * copy: an added brand's onboarding costs ONBOARD_EXTRA_BRAND_COST credits (shown at confirm, 402 before any stream,
 * refunded when the brand is not saved, never charged twice), and the paid Sunday plan is on by default only for the
 * default brand. Brand creation is bounded by a rate (checked first), the cap and a lock.
 * Rules 245 (rate, lock), 246 (added-brand onboarding), 247 (weekly plan per brand), 250 (draft_items types checked in
 * code) and 1390-1392 (the cap). No model key and no network: every agent call takes its mock path.
 */
const crawled: string[] = [];
vi.mock("@/lib/crawl", () => ({ crawl: async (url: string) => (crawled.push(url), { url: `https://${url}`, ok: true, title: "Roastery | Home", description: "Coffee", text: "", links: [], platform: "unknown", colors: [], fonts: [] }) }));
// The builder, with a switch that makes it throw the way the SDK or the pause backstop does mid-run, and one that makes
// the next account save after that throw fail once it was written (Redis over HTTP can apply a command and still fail
// the call: `saveUser` writes the record, then adds the email to users:all).
const ctl = vi.hoisted(() => ({ failWith: null as Error | null, flakySaveAfterFail: false, saddFails: 0 }));
vi.mock("@/lib/onboard", async (orig) => {
  const real = await orig<typeof import("@/lib/onboard")>();
  return { ...real, buildFromSite: async (...a: Parameters<typeof real.buildFromSite>) => { if (ctl.failWith) { if (ctl.flakySaveAfterFail) ctl.saddFails = 1; throw ctl.failWith; } return real.buildFromSite(...a); } };
});

import * as brandsRoute from "@/app/api/brands/route";
import * as onboardRoute from "@/app/api/onboard/route";
import * as confirmRoute from "@/app/api/onboard/confirm/route";
import * as scheduleRoute from "@/app/api/schedule/route";

afterEach(() => { ctl.failWith = null; ctl.flakySaveAfterFail = false; ctl.saddFails = 0; vi.restoreAllMocks(); signOut(); });
/** From now on, while `ctl.saddFails` > 0, an account save writes its record and then fails (the users:all add throws). */
function failSavesAfterWrite() {
  const real = db.sadd.bind(db);
  vi.spyOn(db, "sadd").mockImplementation(async (key, m) => { if (key === "users:all" && ctl.saddFails > 0) { ctl.saddFails--; await real(key, m); throw new Error("upstash: fetch failed"); } return real(key, m); });
}

const COST = ONBOARD_EXTRA_BRAND_COST;
const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const drain = async (res: Response) => (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { type: string; refunded?: number; credits?: number; saved?: boolean });
const add = (name: string) => brandsRoute.POST(json("/api/brands", "POST", { action: "add", name }));
const confirm = (url: string) => confirmRoute.POST(json("/api/onboard/confirm", "POST", { url }));
const onboard = (url: string) => onboardRoute.POST(json("/api/onboard", "POST", { url }));
const credits = async (email: string) => (await getUser(email))!.credits;
const noorSpent = async (email: string, scope: string) => (await getUser(email))!.agentSpend?.by[scope]?.noor ?? 0;
/** The setup charge held on the account for this brand (User.onboardPaid), or undefined. */
const hold = async (email: string, scope: string) => (await getUser(email))!.onboardPaid?.[scope];
/** What a run the platform killed after the charge leaves behind: the charge and its hold, no brand, no refund. */
async function killedRun(email: string, scope: string, at?: string) {
  const c = await chargeOnboard(email, COST, { scope, agent: "noor" });
  if (!c.ok || c.reused) throw new Error("charge failed");
  if (at) { const x = (await getUser(email))!; await saveUser({ ...x, onboardPaid: { ...x.onboardPaid, [scope]: { ...c.hold, at } } }); }
}

/** Give the account a founder brand cap (rule 1393), so a test about something else can add brands on any plan. */
const roomFor = async (email: string, brandCap = 200) => saveUser({ ...(await getUser(email))!, brandCap });

/** A signed-in owner on `plan` whose active brand is a freshly added one (the founder cap lets any plan add it). */
async function withAddedBrand(plan: Plan = "trial", prefix = "gr"): Promise<{ u: User; id: string; scope: string }> {
  const u = await newUser(prefix);
  await saveUser({ ...(await getUser(acct(u)))!, plan, brandCap: 10 });
  await signIn(u.email);
  const res = await add("Second");
  expect(res.status).toBe(200);
  const id = ((await res.json()) as { brand: { id: string } }).brand.id;
  return { u, id, scope: scopeFor(acct(u), id) };
}

describe("brands capped per plan, a creation rate and a locked add (rules 245, 1390-1392)", () => {
  it("each plan adds up to its cap (default brand included), then 402 brand_limit with the cap and plan, nothing written", async () => {
    for (const plan of ["trial", "starter", "pro", "business", "agency"] as const) {
      const u = await newUser(`p-${plan}`);
      if (plan !== "trial") await saveUser({ ...(await getUser(acct(u)))!, plan });
      await signIn(u.email);
      const cap = plan === "agency" ? AGENCY_BRANDS : PLAN_BRANDS[plan];
      for (let i = 1; i < cap; i++) expect((await add(`b${i}`)).status, `${plan} adds brand ${i + 1} of ${cap}`).toBe(200);
      const over = await add("one too many");
      expect(over.status, plan).toBe(402);
      expect(await over.json()).toEqual({ ok: false, error: "brand_limit", cap, plan });
      expect(await listBrands(acct(u)), plan).toHaveLength(cap);
      const got = (await (await brandsRoute.GET()).json()) as { cap: number; count: number; canUpgrade: boolean };
      expect(got, plan).toMatchObject({ cap, count: cap, canUpgrade: true });
    }
    expect(PLAN_BRANDS).toEqual({ trial: 1, starter: 1, pro: 2, business: 5 });
  });

  it("the rate is checked before the cap: a refused rate answers 429 even at the cap", async () => {
    const u = await newUser("rate-first");
    await signIn(u.email);
    await db.set(`rate:brandadd:d:${u.email}`, BRANDS_PER_DAY, 86400);
    const res = await add("x");
    expect(res.status).toBe(429);
  });

  it("archived brands do not count; a restore over the cap is 402 and stays archived; a downgrade keeps every brand", async () => {
    const u = await newUser("arch");
    await saveUser({ ...(await getUser(acct(u)))!, plan: "pro" });
    await signIn(u.email);
    const second = ((await (await add("Two")).json()) as { brand: { id: string } }).brand.id;
    expect((await add("Three")).status).toBe(402);
    const post = (body: object) => brandsRoute.POST(json("/api/brands", "POST", body));
    expect((await post({ action: "archive", id: second })).status, "archiving is never capped").toBe(200);
    const third = ((await (await add("Three")).json()) as { brand: { id: string } }).brand.id;
    const restore = await post({ action: "archive", id: second });
    expect(restore.status).toBe(402);
    expect(await restore.json()).toMatchObject({ ok: false, error: "brand_limit", cap: 2 });
    expect((await listBrands(acct(u))).find((b) => b.id === second)!.status).toBe("archived");

    // Downgrade to starter (cap 1) with 2 active: nothing is archived or deleted, switch and rename still work, adds stop.
    await saveUser({ ...(await getUser(acct(u)))!, plan: "starter" });
    const rows = await listBrands(acct(u));
    expect(rows.filter((b) => b.status === "active").map((b) => b.id)).toEqual(["default", third]);
    expect((await post({ action: "switch", id: third })).status).toBe(200);
    expect((await post({ action: "rename", id: third, name: "Kept" })).status).toBe(200);
    expect((await add("Four")).status).toBe(402);
    expect(await listBrands(acct(u))).toHaveLength(3);
  });

  it("the founder's brandCap overrides the plan's number, either way, and an out-of-range one is ignored", async () => {
    const u = await newUser("override");
    await saveUser({ ...(await getUser(acct(u)))!, plan: "agency", brandCap: 2 });
    await signIn(u.email);
    expect((await add("Two")).status).toBe(200);
    expect(await (await add("Three")).json()).toEqual({ ok: false, error: "brand_limit", cap: 2, plan: "agency" });
    await saveUser({ ...(await getUser(acct(u)))!, plan: "agency", brandCap: 9999 });
    expect(((await (await brandsRoute.GET()).json()) as { cap: number }).cap, "out of range reads as Agency's number").toBe(AGENCY_BRANDS);
  });

  it("adds sent side by side at the cap: exactly the room left passes, the rest are 402", async () => {
    const u = await newUser("race");
    await saveUser({ ...(await getUser(acct(u)))!, plan: "business" });
    await signIn(u.email);
    const res = await Promise.all(["A", "B", "C", "D", "E", "F", "G"].map((n) => add(n)));
    const codes = res.map((r) => r.status).filter((c) => c !== 409);
    expect(codes.filter((c) => c === 200)).toHaveLength(PLAN_BRANDS.business - 1);
    expect((await listBrands(acct(u))).filter((b) => b.status === "active").length).toBeLessThanOrEqual(PLAN_BRANDS.business);
  });

  it("the hourly bucket answers 429 slow_down and writes nothing; so does the daily one; each says which window refused", async () => {
    const u = await newUser("rate");
    await roomFor(acct(u));
    await signIn(u.email);
    const codes: number[] = [];
    for (let i = 0; i < BRANDS_PER_HOUR; i++) codes.push((await add(`b${i}`)).status);
    expect(codes.every((c) => c === 200)).toBe(true);
    const over = await add("one too many");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("3600");
    expect(await over.json()).toEqual({ ok: false, error: "slow_down", retry: "hour" });
    expect(await listBrands(acct(u))).toHaveLength(1 + BRANDS_PER_HOUR);
    expect(await db.get(`rate:brandadd:d:${u.email}`), "a refusal by the hour uses none of the day's adds").toBe(BRANDS_PER_HOUR);

    const v = await newUser("rate-day");
    await roomFor(acct(v));
    await signIn(v.email);
    await db.set(`rate:brandadd:d:${v.email}`, BRANDS_PER_DAY, 86400);
    const day = await add("x");
    expect(day.status).toBe(429);
    // The day's window can last until tomorrow: the page must not say "shortly".
    expect(day.headers.get("retry-after")).toBe("86400");
    expect(await day.json()).toEqual({ ok: false, error: "slow_down", retry: "day" });
    expect(await listBrands(acct(v))).toHaveLength(1);
  });

  it("adds sent side by side are all kept, and an add beside a rename keeps both", async () => {
    const u = await newUser("par");
    await roomFor(acct(u));
    await signIn(u.email);
    const res = await Promise.all(["A", "B", "C", "D", "E"].map((n) => add(n)));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const rows = await listBrands(acct(u));
    expect(rows.map((b) => b.name).slice(1).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(new Set(rows.map((b) => b.id)).size).toBe(6);

    const first = rows[1];
    await Promise.all([brandsRoute.POST(json("/api/brands", "POST", { action: "rename", id: first.id, name: "Renamed" })), add("F")]);
    const after = await listBrands(acct(u));
    expect(after.find((b) => b.id === first.id)!.name).toBe("Renamed");
    expect(after.map((b) => b.name)).toContain("F");
  });

  it("an add that cannot take the list's lock answers 409 busy and writes nothing", async () => {
    const u = await newUser("busy");
    await signIn(u.email);
    expect(await db.lock(`brandslock:${acct(u)}`, 10)).toBe(true);
    try {
      const res = await add("Blocked");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: "busy" });
      expect(await listBrands(acct(u))).toHaveLength(1);
    } finally {
      await db.unlock(`brandslock:${acct(u)}`);
    }
  });
});

describe("an added brand's onboarding costs ONBOARD_EXTRA_BRAND_COST credits (rule 246)", () => {
  it("the first brand is free and the confirm says so", async () => {
    const u = await newUser("first");
    await signIn(u.email);
    const c = await confirm("roastery.example");
    expect(await c.json()).toEqual({ ok: true, cost: 0 });
    expect((await drain(await onboard("roastery.example"))).at(-1)!.type).toBe("done");
    expect(await credits(acct(u))).toBe(50);
  });

  it("charges 9 to Noor in the new brand's scope, shown at confirm, and a second run charges nothing", async () => {
    expect(COST).toBe(9);
    const { u, scope } = await withAddedBrand("starter");
    const before = await credits(acct(u));
    const c = await confirm("second.example");
    expect(c.status).toBe(200);
    expect(await c.json(), "the cost is shown before the owner presses Go").toEqual({ ok: true, cost: COST });
    expect(await credits(acct(u)), "confirming charges nothing").toBe(before);
    const lockTtl = vi.spyOn(db, "lockOwned");
    const done = (await drain(await onboard("second.example"))).at(-1)!;
    expect(done.type).toBe("done");
    expect(done.credits, "the balance after the charge, for the chat's credit pill").toBe(before - COST);
    // The run lock outlives the longest run the platform allows, so a reload cannot start a second run beside it.
    expect(lockTtl.mock.calls[0]?.[1]).toBeGreaterThan(onboardRoute.maxDuration);
    expect(await getBrand(scope)).not.toBeNull();
    expect(await credits(acct(u))).toBe(before - COST);
    expect(await noorSpent(acct(u), scope), "counted against Noor in that brand").toBe(COST);
    expect(await noorSpent(acct(u), acct(u)), "never in the default brand").toBe(0);
    expect(await hold(acct(u), scope), "the held charge goes with the finished build").toBeUndefined();
    expect((await onboard("second.example")).status).toBe(409);
    expect(await credits(acct(u))).toBe(before - COST);
    await settle();
  });

  it("with fewer credits than the cost: 402 at confirm, and 402 JSON before any stream, lock or daily try", async () => {
    const { u, scope } = await withAddedBrand();
    await saveUser({ ...(await getUser(acct(u)))!, credits: COST - 1 });
    const c = await confirm("poor.example");
    expect(c.status).toBe(402);
    expect(await c.json()).toEqual({ ok: false, error: "no_credits", need: COST, credits: COST - 1 });
    // A confirmation made while the balance was enough.
    await confirmOnboard(scope, "poor.example");
    const seen = crawled.length;
    const res = await onboard("poor.example");
    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ ok: false, error: "no_credits", need: COST, credits: COST - 1 });
    expect(crawled.length, "nothing crawled").toBe(seen);
    expect(await db.get(`onboardlock:${scope}`), "no lock").toBeNull();
    expect(await db.get(`rate:onboard:${u.email}`), "none of the three daily runs used").toBeNull();
    expect(await getBrand(scope), "nothing saved").toBeNull();
    expect(await credits(acct(u))).toBe(COST - 1);
  });

  for (const [name, err] of [["an SDK error", () => new Error("sdk down")], ["the pause backstop", () => new ModelPaused()]] as const) {
    it(`a build that fails on ${name} refunds the charge and clears the marker`, async () => {
      const { u, scope } = await withAddedBrand();
      await confirm("fail.example");
      ctl.failWith = err();
      const events = await drain(await onboard("fail.example"));
      const last = events.at(-1)!;
      expect(last.type).toBe("error");
      expect(last).toMatchObject({ refunded: COST, credits: 50 });
      expect(await credits(acct(u))).toBe(50);
      expect(await noorSpent(acct(u), scope), "the agent's counter goes back down too").toBe(0);
      expect(await hold(acct(u), scope)).toBeUndefined();
      expect(await getBrand(scope)).toBeNull();
      expect(await db.get(`onboardlock:${scope}`)).toBeNull();
    });
  }

  it("a run that was charged and then killed is not charged again on the retry, even a day later", async () => {
    const { u, scope } = await withAddedBrand();
    // Killed 25 hours ago: the confirmation (a day) is gone, the held charge is not (it has no expiry).
    await killedRun(acct(u), scope, new Date(Date.now() - 25 * 3600e3).toISOString());
    await saveUser({ ...(await getUser(acct(u)))!, credits: 0 });
    // Already paid: neither the confirm nor the build asks for the credits again, even at a zero balance.
    expect(await (await confirm("killed.example")).json()).toEqual({ ok: true, cost: COST, paid: true });
    expect((await drain(await onboard("killed.example"))).at(-1)!.type).toBe("done");
    expect(await credits(acct(u))).toBe(0);
    expect(await noorSpent(acct(u), scope)).toBe(COST);
    expect(await hold(acct(u), scope)).toBeUndefined();
    await settle();
  });

  it("a held charge is refunded once, however many runs fail on it", async () => {
    const { u, scope } = await withAddedBrand();
    await killedRun(acct(u), scope);
    expect(await credits(acct(u))).toBe(50 - COST);
    // Two refunds racing (two runs that both failed): exactly one gives the credits back.
    const both = await Promise.all([refundOnboard(acct(u), scope), refundOnboard(acct(u), scope)]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await credits(acct(u))).toBe(50);
    expect(await noorSpent(acct(u), scope)).toBe(0);
    // A run that reuses a held charge and fails refunds it; the next run pays afresh and its failure refunds only that.
    await killedRun(acct(u), scope);
    await confirm("again.example");
    ctl.failWith = new Error("sdk down");
    expect((await drain(await onboard("again.example"))).at(-1)).toMatchObject({ type: "error", refunded: COST, credits: 50 });
    expect((await drain(await onboard("again.example"))).at(-1)).toMatchObject({ type: "error", refunded: COST, credits: 50 });
    expect(await credits(acct(u)), "charged twice, refunded twice: never more").toBe(50);
    expect(await hold(acct(u), scope)).toBeUndefined();
  });

  it("a refund whose save failed after it was written neither refunds twice nor makes the next build free", async () => {
    const { u, scope } = await withAddedBrand();
    await confirm("flaky.example");
    // The build fails; the next account save, the refund's, writes the record and then its second command fails.
    ctl.failWith = new Error("sdk down");
    ctl.flakySaveAfterFail = true;
    failSavesAfterWrite();
    const last = (await drain(await onboard("flaky.example"))).at(-1)!;
    expect(ctl.saddFails, "the refund's save was the one that failed").toBe(0);
    expect(last.type).toBe("error");
    expect(last, "the route could not confirm the refund").not.toHaveProperty("refunded");
    // It was written, and the hold went in the same write: the balance is whole and nothing is held any more.
    expect(await credits(acct(u))).toBe(50);
    expect(await hold(acct(u), scope)).toBeUndefined();
    // So the retry pays afresh: not a free build on a refunded charge.
    ctl.failWith = null;
    ctl.flakySaveAfterFail = false;
    const done = (await drain(await onboard("flaky.example"))).at(-1)!;
    expect(done).toMatchObject({ type: "done", credits: 50 - COST });
    expect(await credits(acct(u))).toBe(50 - COST);
    await settle();
  });

  it("a failure after the brand file was saved keeps the charge, drops the hold and says the brand was saved", async () => {
    const { u, scope } = await withAddedBrand();
    await confirm("half.example");
    const real = db.set.bind(db);
    vi.spyOn(db, "set").mockImplementation(async (key, value, ttl) => { if (key === `onboardplan:${scope}`) throw new Error("upstash: fetch failed"); return real(key, value, ttl); });
    const last = (await drain(await onboard("half.example"))).at(-1)!;
    expect(last).toMatchObject({ type: "error", saved: true });
    expect(last).not.toHaveProperty("refunded");
    expect(await getBrand(scope), "the brand was delivered").not.toBeNull();
    expect(await credits(acct(u))).toBe(50 - COST);
    expect(await hold(acct(u), scope)).toBeUndefined();
    await settle();
  });

  it("the daily sweep refunds a held charge nobody used for a day, drops one whose brand exists, and leaves a recent one", async () => {
    const { u, scope } = await withAddedBrand();
    const old = new Date(Date.now() - ONBOARD_HOLD_MS - 60e3).toISOString();
    await killedRun(acct(u), scope, old);
    // A second added brand, built, whose own drop failed: its hold is only dropped.
    await signIn(u.email);
    const id2 = ((await (await add("Third")).json()) as { brand: { id: string } }).brand.id;
    const built = scopeFor(acct(u), id2);
    await killedRun(acct(u), built, old);
    await db.set(`brand:${built}`, brand);
    expect(await credits(acct(u))).toBe(50 - 2 * COST);

    vi.stubEnv("CRON_SECRET", "cron-secret-sweep");
    const { GET } = await import("@/app/api/cron/daily/route");
    const report = (await (await GET(new Request("https://nashr.test/api/cron/daily", { headers: { authorization: "Bearer cron-secret-sweep" } }))).json()) as { results: Record<string, string> };
    expect(report.results[acct(u)]).toMatch(/onboard_refunded:1/);
    expect(report.results[acct(u)]).toMatch(/onboard_settled:1/);
    expect(await credits(acct(u)), "the unbuilt brand's charge came back; the built one's stands").toBe(50 - COST);
    expect(await noorSpent(acct(u), scope)).toBe(0);
    expect((await getUser(acct(u)))!.onboardPaid).toBeUndefined();

    // A recent hold is left for the owner's retry.
    await killedRun(acct(u), scope);
    expect(await sweepOnboardHolds((await getUser(acct(u)))!)).toBeNull();
    expect(await hold(acct(u), scope)).toBeDefined();
    vi.unstubAllEnvs();
  });

  it("a run that reuses a held charge restarts its clock, so the sweep never refunds a charge a run is using", async () => {
    const { u, scope } = await withAddedBrand();
    await killedRun(acct(u), scope, new Date(Date.now() - ONBOARD_HOLD_MS - 60e3).toISOString());
    expect(await chargeOnboard(acct(u), COST, { scope, agent: "noor" })).toMatchObject({ ok: true, reused: true, credits: 50 - COST });
    expect(await credits(acct(u)), "reused, not charged again").toBe(50 - COST);
    expect(await sweepOnboardHolds((await getUser(acct(u)))!)).toBeNull();
    expect(await hold(acct(u), scope)).toBeDefined();
  });

  it("a run lock is released only by its owner: a run whose lock expired cannot free the next run's", async () => {
    const key = `onboardlock:owner-test-${Math.random()}`;
    const first = await db.lockOwned(key, 330);
    expect(first).toBeTruthy();
    expect(await db.lockOwned(key, 330), "held").toBeNull();
    await db.del(key); // the first run's lock expired
    const second = await db.lockOwned(key, 330);
    expect(second).toBeTruthy();
    await db.unlockOwned(key, first!); // the first run finishes late
    expect(await db.lockOwned(key, 330), "the second run still holds it").toBeNull();
    await db.unlockOwned(key, second!);
    expect(await db.lockOwned(key, 330)).toBeTruthy();
  });

  it("Noor's cap in the new brand refuses before the stream; the default brand's cap does not apply", async () => {
    const { u, scope } = await withAddedBrand();
    await saveGov(acct(u), { agentCaps: { noor: 0 } }); // the default brand's cap
    await saveGov(scope, { agentCaps: { noor: COST - 1 } });
    await confirm("capped.example");
    const res = await onboard("capped.example");
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ ok: false, error: "agent_cap", need: COST, agent: "noor", cap: COST - 1 });
    expect(await db.get(`onboardlock:${scope}`)).toBeNull();
    expect(await credits(acct(u))).toBe(50);
    await saveGov(scope, { agentCaps: { noor: COST } });
    expect((await drain(await onboard("capped.example"))).at(-1)!.type).toBe("done");
    expect(await credits(acct(u))).toBe(50 - COST);
    await settle();
  });

  it("an ended trial is refused at confirm and before the stream", async () => {
    const { u, scope } = await withAddedBrand();
    await saveUser({ ...(await getUser(acct(u)))!, trialEnds: new Date(Date.now() - 864e5).toISOString() });
    const c = await confirm("late.example");
    expect(c.status).toBe(402);
    expect(await c.json()).toMatchObject({ ok: false, error: "trial_over", need: COST });
    await confirmOnboard(scope, "late.example");
    const res = await onboard("late.example");
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ ok: false, error: "trial_over" });
    expect(await credits(acct(u))).toBe(50);
    expect(await getBrand(scope)).toBeNull();
  });

  it("deleting the account removes every brand's onboarding records, the held charge included", async () => {
    const { u, scope } = await withAddedBrand();
    await confirmOnboard(scope, "gone.example");
    await killedRun(acct(u), scope);
    // Rule 528: the game's answers (`onboardgame:`, src/lib/onboard-confirm.ts) carry the brand name the owner typed.
    await Promise.all([db.lock(`onboardlock:${scope}`, 240), db.set(`onboardok:${acct(u)}`, "first.example", 86400), db.set(`onboardgame:${scope}`, { brand: "Gone" }, 86400), db.set(`onboardgame:${acct(u)}`, { brand: "Gone" }, 86400)]);
    await wipeAccount(acct(u));
    for (const k of [`onboardok:${scope}`, `onboardlock:${scope}`, `onboardok:${acct(u)}`, `onboardgame:${scope}`, `onboardgame:${acct(u)}`, `user:${acct(u)}`]) expect(await db.get(k), k).toBeNull();
  });

  it("a run in progress answers busy and charges nothing", async () => {
    const { u, scope } = await withAddedBrand();
    await confirm("twice.example");
    expect(await db.lock(`onboardlock:${scope}`, 240)).toBe(true);
    try {
      expect((await onboard("twice.example")).status).toBe(409);
      expect(await credits(acct(u))).toBe(50);
      expect(await hold(acct(u), scope)).toBeUndefined();
    } finally {
      await db.unlock(`onboardlock:${scope}`);
    }
  });
});

describe("the Sunday plan is on by default only for the default brand (rule 247)", () => {
  it("an added brand starts off; Run now answers off and charges nothing until the owner switches it on", async () => {
    const { u, id, scope } = await withAddedBrand();
    await Promise.all([db.set(`brand:${acct(u)}`, brand), db.set(`brand:${scope}`, brand)]);
    expect((await getSchedule(acct(u))).weeklyPlan).toBe(true);
    expect((await getSchedule(scope)).weeklyPlan).toBe(false);
    const inBrand = { ...(await getUser(acct(u)))!, brandId: id, scope };
    expect(await runWeekly(inBrand)).toBe("off");
    expect(await credits(acct(u))).toBe(50);
    expect(await listLite(scope)).toHaveLength(0);

    // The owner switches it on for the added brand (the session's active brand is the added one).
    const put = await scheduleRoute.PUT(json("/api/schedule", "PUT", { weeklyPlan: true }));
    expect(((await put.json()) as { schedule: { weeklyPlan: boolean } }).schedule.weeklyPlan).toBe(true);
    expect(await runWeekly({ ...(await getUser(acct(u)))!, brandId: id, scope })).toMatch(/^ok:/);
    expect(TASK_COST.weekly_plan).toBe(2);
    expect(await credits(acct(u))).toBe(50 - TASK_COST.weekly_plan);
    expect(await noorSpent(acct(u), scope)).toBe(TASK_COST.weekly_plan);
    await settle();
  });

  it("the daily run stores no default, so the added brand's Sunday plan stays off", async () => {
    const { u, id, scope } = await withAddedBrand();
    await db.set(`brand:${scope}`, brand);
    expect(await runDaily({ ...(await getUser(acct(u)))!, brandId: id, scope })).not.toBeNull();
    const stored = (await db.get<Record<string, unknown>>(`schedule:${scope}`))!;
    expect(stored.lastDaily).toBeTruthy();
    expect(stored, "a default is never written back").not.toHaveProperty("weeklyPlan");
    expect((await getSchedule(scope)).weeklyPlan).toBe(false);
    // saveSchedule answers the merged view and stores only what was set.
    expect(await saveSchedule(scope, { routines: { noor_cart_recovery: true } })).toMatchObject({ weeklyPlan: false, dailyBrief: true, followUps: true, routines: { noor_cart_recovery: true } });
    expect(await db.get(`schedule:${scope}`)).not.toHaveProperty("dailyBrief");
    // An explicit choice is kept, on either brand.
    await saveSchedule(acct(u), { weeklyPlan: false });
    expect((await getSchedule(acct(u))).weeklyPlan).toBe(false);
  });

  it("an added brand whose record froze the old default (on) before 2026-09-30 starts off and is not charged on Sunday", async () => {
    const { u, id, scope } = await withAddedBrand();
    await Promise.all([db.set(`brand:${scope}`, brand), db.set(`brand:${acct(u)}`, brand)]);
    // What the old saveSchedule wrote on every daily run: the merged defaults, with nothing to say who chose them.
    const legacy = { weeklyPlan: true, dailyBrief: true, followUps: true, lastDaily: "2026-09-28T05:00:00.000Z" };
    await Promise.all([db.set(`schedule:${scope}`, legacy), db.set(`schedule:${acct(u)}`, { ...legacy, weeklyPlan: false })]);
    expect((await getSchedule(scope)).weeklyPlan, "the unstamped old default does not count on an added brand").toBe(false);
    expect((await getSchedule(acct(u))).weeklyPlan, "the default brand's stored choice still counts").toBe(false);
    expect(await runWeekly({ ...(await getUser(acct(u)))!, brandId: id, scope })).toBe("off");
    expect(await credits(acct(u))).toBe(50);
    // A daily run keeps it that way; the owner's switch (stamped) turns it on.
    await runDaily({ ...(await getUser(acct(u)))!, brandId: id, scope });
    expect((await getSchedule(scope)).weeklyPlan).toBe(false);
    const put = await scheduleRoute.PUT(json("/api/schedule", "PUT", { weeklyPlan: true }));
    expect(((await put.json()) as { schedule: Record<string, unknown> }).schedule).toMatchObject({ weeklyPlan: true });
    expect(await db.get(`schedule:${scope}`)).toHaveProperty("weeklyPlanSetAt");
    expect((await getSchedule(scope)).weeklyPlan).toBe(true);
    expect(await getSchedule(scope), "the stamp stays internal").not.toHaveProperty("weeklyPlanSetAt");
  });
});

describe("draft_items takes only the draft types, checked in code (rule 250)", () => {
  it("a batch type is refused before any charge, whatever the model sends", async () => {
    const u = await newUser("draft");
    await db.set(`brand:${acct(u)}`, brand);
    const user = { ...(await getUser(acct(u)))!, scope: sc(u) };
    for (const type of ["weekly_plan", "article", "cart_recovery", "board_deck", "constructor"]) {
      const out = await runTool(user, "draft_items", { type, count: 3, brief: "x" }, []);
      expect(out, type).toMatch(/Not a draft type/);
      expect(out).toContain(DRAFT_TYPES.join(", "));
    }
    expect(await credits(acct(u))).toBe(50);
    expect(await listLite(acct(u))).toHaveLength(0);
    // A draft type still drafts: a one-item social draft costs social's draft minimum, 2 credits (rule 4031).
    expect(await runTool(user, "draft_items", { type: "social", count: 1, brief: "منشور" }, [])).toMatch(/^Drafted 1 social/);
    expect(await credits(acct(u))).toBe(48);
    await settle();
  });
});
