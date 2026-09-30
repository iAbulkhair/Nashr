import { afterEach, describe, expect, it, vi } from "vitest";
import { json, newUser, signIn, signOut, settle } from "./helpers/session";
import { getUser, saveUser, type Plan, type User } from "@/lib/auth";
import { getBrand, listLite, type Brand } from "@/lib/brand";
import { listBrands, scopeFor } from "@/lib/brands";
import { chargeOnboard, ONBOARD_HOLD_MS, refundOnboard } from "@/lib/credits";
import { db } from "@/lib/db";
import { saveGov } from "@/lib/governance";
import { ModelPaused } from "@/lib/model";
import { confirmOnboard, sweepOnboardHolds } from "@/lib/onboard-confirm";
import { ONBOARD_EXTRA_BRAND_COST } from "@/lib/pricing";
import { BRANDS_PER_DAY, BRANDS_PER_HOUR } from "@/lib/rate";
import { getSchedule, runDaily, runWeekly, saveSchedule } from "@/lib/schedule";
import { DRAFT_TYPES, TASK_COST } from "@/lib/tasks";
import { runTool } from "@/lib/chat";
import { wipeAccount } from "@/lib/account";

/**
 * Brands are unlimited on every plan (founder decision 2, 2026-09-29), with two guardrails in code, not in copy:
 * an added brand's onboarding costs ONBOARD_EXTRA_BRAND_COST credits (shown at confirm, 402 before any stream,
 * refunded when the brand is not saved, never charged twice), and the paid Sunday plan is on by default only for the
 * default brand. Brand creation is bounded by a rate and a lock, never by a cap.
 * Rules 245 (unlimited brands, rate, lock), 246 (added-brand onboarding), 247 (weekly plan per brand) and 250
 * (draft_items types checked in code). No model key and no network: every agent call takes its mock path.
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

/** A signed-in owner on `plan` whose active brand is a freshly added one. */
async function withAddedBrand(plan: Plan = "trial", prefix = "gr"): Promise<{ u: User; id: string; scope: string }> {
  const u = await newUser(prefix);
  if (plan !== "trial") await saveUser({ ...(await getUser(u.email))!, plan });
  await signIn(u.email);
  const res = await add("Second");
  expect(res.status).toBe(200);
  const id = ((await res.json()) as { brand: { id: string } }).brand.id;
  return { u, id, scope: scopeFor(u.email, id) };
}

describe("unlimited brands, a creation rate and a locked add (rule 245)", () => {
  it("trial, starter, pro and business accounts add a 2nd and a 3rd brand, and GET returns no limit", async () => {
    for (const plan of ["trial", "starter", "pro", "business"] as const) {
      const u = await newUser(`p-${plan}`);
      if (plan !== "trial") await saveUser({ ...(await getUser(u.email))!, plan });
      await signIn(u.email);
      for (const name of ["Two", "Three"]) {
        const res = await add(name);
        expect(res.status, `${plan} adds ${name}`).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, brand: { name, status: "active" } });
      }
      const got = (await (await brandsRoute.GET()).json()) as Record<string, unknown> & { brands: { status: string }[] };
      expect(got.brands.filter((b) => b.status === "active"), plan).toHaveLength(3);
      // A `limit` of Infinity would reach the browser as null, and `active >= null` disables Add for everyone.
      expect(got, "no brand cap is sent at all").not.toHaveProperty("limit");
    }
  });

  it("the hourly bucket answers 429 slow_down and writes nothing; so does the daily one; each says which window refused", async () => {
    const u = await newUser("rate");
    await signIn(u.email);
    const codes: number[] = [];
    for (let i = 0; i < BRANDS_PER_HOUR; i++) codes.push((await add(`b${i}`)).status);
    expect(codes.every((c) => c === 200)).toBe(true);
    const over = await add("one too many");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("3600");
    expect(await over.json()).toEqual({ ok: false, error: "slow_down", retry: "hour" });
    expect(await listBrands(u.email)).toHaveLength(1 + BRANDS_PER_HOUR);
    expect(await db.get(`rate:brandadd:d:${u.email}`), "a refusal by the hour uses none of the day's adds").toBe(BRANDS_PER_HOUR);

    const v = await newUser("rate-day");
    await signIn(v.email);
    await db.set(`rate:brandadd:d:${v.email}`, BRANDS_PER_DAY, 86400);
    const day = await add("x");
    expect(day.status).toBe(429);
    // The day's window can last until tomorrow: the page must not say "shortly".
    expect(day.headers.get("retry-after")).toBe("86400");
    expect(await day.json()).toEqual({ ok: false, error: "slow_down", retry: "day" });
    expect(await listBrands(v.email)).toHaveLength(1);
  });

  it("adds sent side by side are all kept, and an add beside a rename keeps both", async () => {
    const u = await newUser("par");
    await signIn(u.email);
    const res = await Promise.all(["A", "B", "C", "D", "E"].map((n) => add(n)));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const rows = await listBrands(u.email);
    expect(rows.map((b) => b.name).slice(1).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(new Set(rows.map((b) => b.id)).size).toBe(6);

    const first = rows[1];
    await Promise.all([brandsRoute.POST(json("/api/brands", "POST", { action: "rename", id: first.id, name: "Renamed" })), add("F")]);
    const after = await listBrands(u.email);
    expect(after.find((b) => b.id === first.id)!.name).toBe("Renamed");
    expect(after.map((b) => b.name)).toContain("F");
  });

  it("an add that cannot take the list's lock answers 409 busy, never 402, and writes nothing", async () => {
    const u = await newUser("busy");
    await signIn(u.email);
    expect(await db.lock(`brandslock:${u.email}`, 10)).toBe(true);
    try {
      const res = await add("Blocked");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: "busy" });
      expect(await listBrands(u.email)).toHaveLength(1);
    } finally {
      await db.unlock(`brandslock:${u.email}`);
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
    expect(await credits(u.email)).toBe(50);
  });

  it("charges 9 to Noor in the new brand's scope, shown at confirm, and a second run charges nothing", async () => {
    expect(COST).toBe(9);
    const { u, scope } = await withAddedBrand("starter");
    const before = await credits(u.email);
    const c = await confirm("second.example");
    expect(c.status).toBe(200);
    expect(await c.json(), "the cost is shown before the owner presses Go").toEqual({ ok: true, cost: COST });
    expect(await credits(u.email), "confirming charges nothing").toBe(before);
    const lockTtl = vi.spyOn(db, "lockOwned");
    const done = (await drain(await onboard("second.example"))).at(-1)!;
    expect(done.type).toBe("done");
    expect(done.credits, "the balance after the charge, for the chat's credit pill").toBe(before - COST);
    // The run lock outlives the longest run the platform allows, so a reload cannot start a second run beside it.
    expect(lockTtl.mock.calls[0]?.[1]).toBeGreaterThan(onboardRoute.maxDuration);
    expect(await getBrand(scope)).not.toBeNull();
    expect(await credits(u.email)).toBe(before - COST);
    expect(await noorSpent(u.email, scope), "counted against Noor in that brand").toBe(COST);
    expect(await noorSpent(u.email, u.email), "never in the default brand").toBe(0);
    expect(await hold(u.email, scope), "the held charge goes with the finished build").toBeUndefined();
    expect((await onboard("second.example")).status).toBe(409);
    expect(await credits(u.email)).toBe(before - COST);
    await settle();
  });

  it("with fewer credits than the cost: 402 at confirm, and 402 JSON before any stream, lock or daily try", async () => {
    const { u, scope } = await withAddedBrand();
    await saveUser({ ...(await getUser(u.email))!, credits: COST - 1 });
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
    expect(await credits(u.email)).toBe(COST - 1);
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
      expect(await credits(u.email)).toBe(50);
      expect(await noorSpent(u.email, scope), "the agent's counter goes back down too").toBe(0);
      expect(await hold(u.email, scope)).toBeUndefined();
      expect(await getBrand(scope)).toBeNull();
      expect(await db.get(`onboardlock:${scope}`)).toBeNull();
    });
  }

  it("a run that was charged and then killed is not charged again on the retry, even a day later", async () => {
    const { u, scope } = await withAddedBrand();
    // Killed 25 hours ago: the confirmation (a day) is gone, the held charge is not (it has no expiry).
    await killedRun(u.email, scope, new Date(Date.now() - 25 * 3600e3).toISOString());
    await saveUser({ ...(await getUser(u.email))!, credits: 0 });
    // Already paid: neither the confirm nor the build asks for the credits again, even at a zero balance.
    expect(await (await confirm("killed.example")).json()).toEqual({ ok: true, cost: COST, paid: true });
    expect((await drain(await onboard("killed.example"))).at(-1)!.type).toBe("done");
    expect(await credits(u.email)).toBe(0);
    expect(await noorSpent(u.email, scope)).toBe(COST);
    expect(await hold(u.email, scope)).toBeUndefined();
    await settle();
  });

  it("a held charge is refunded once, however many runs fail on it", async () => {
    const { u, scope } = await withAddedBrand();
    await killedRun(u.email, scope);
    expect(await credits(u.email)).toBe(50 - COST);
    // Two refunds racing (two runs that both failed): exactly one gives the credits back.
    const both = await Promise.all([refundOnboard(u.email, scope), refundOnboard(u.email, scope)]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await credits(u.email)).toBe(50);
    expect(await noorSpent(u.email, scope)).toBe(0);
    // A run that reuses a held charge and fails refunds it; the next run pays afresh and its failure refunds only that.
    await killedRun(u.email, scope);
    await confirm("again.example");
    ctl.failWith = new Error("sdk down");
    expect((await drain(await onboard("again.example"))).at(-1)).toMatchObject({ type: "error", refunded: COST, credits: 50 });
    expect((await drain(await onboard("again.example"))).at(-1)).toMatchObject({ type: "error", refunded: COST, credits: 50 });
    expect(await credits(u.email), "charged twice, refunded twice: never more").toBe(50);
    expect(await hold(u.email, scope)).toBeUndefined();
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
    expect(await credits(u.email)).toBe(50);
    expect(await hold(u.email, scope)).toBeUndefined();
    // So the retry pays afresh: not a free build on a refunded charge.
    ctl.failWith = null;
    ctl.flakySaveAfterFail = false;
    const done = (await drain(await onboard("flaky.example"))).at(-1)!;
    expect(done).toMatchObject({ type: "done", credits: 50 - COST });
    expect(await credits(u.email)).toBe(50 - COST);
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
    expect(await credits(u.email)).toBe(50 - COST);
    expect(await hold(u.email, scope)).toBeUndefined();
    await settle();
  });

  it("the daily sweep refunds a held charge nobody used for a day, drops one whose brand exists, and leaves a recent one", async () => {
    const { u, scope } = await withAddedBrand();
    const old = new Date(Date.now() - ONBOARD_HOLD_MS - 60e3).toISOString();
    await killedRun(u.email, scope, old);
    // A second added brand, built, whose own drop failed: its hold is only dropped.
    await signIn(u.email);
    const id2 = ((await (await add("Third")).json()) as { brand: { id: string } }).brand.id;
    const built = scopeFor(u.email, id2);
    await killedRun(u.email, built, old);
    await db.set(`brand:${built}`, brand);
    expect(await credits(u.email)).toBe(50 - 2 * COST);

    vi.stubEnv("CRON_SECRET", "cron-secret-sweep");
    const { GET } = await import("@/app/api/cron/daily/route");
    const report = (await (await GET(new Request("https://nashr.test/api/cron/daily", { headers: { authorization: "Bearer cron-secret-sweep" } }))).json()) as { results: Record<string, string> };
    expect(report.results[u.email]).toMatch(/onboard_refunded:1/);
    expect(report.results[u.email]).toMatch(/onboard_settled:1/);
    expect(await credits(u.email), "the unbuilt brand's charge came back; the built one's stands").toBe(50 - COST);
    expect(await noorSpent(u.email, scope)).toBe(0);
    expect((await getUser(u.email))!.onboardPaid).toBeUndefined();

    // A recent hold is left for the owner's retry.
    await killedRun(u.email, scope);
    expect(await sweepOnboardHolds((await getUser(u.email))!)).toBeNull();
    expect(await hold(u.email, scope)).toBeDefined();
    vi.unstubAllEnvs();
  });

  it("a run that reuses a held charge restarts its clock, so the sweep never refunds a charge a run is using", async () => {
    const { u, scope } = await withAddedBrand();
    await killedRun(u.email, scope, new Date(Date.now() - ONBOARD_HOLD_MS - 60e3).toISOString());
    expect(await chargeOnboard(u.email, COST, { scope, agent: "noor" })).toMatchObject({ ok: true, reused: true, credits: 50 - COST });
    expect(await credits(u.email), "reused, not charged again").toBe(50 - COST);
    expect(await sweepOnboardHolds((await getUser(u.email))!)).toBeNull();
    expect(await hold(u.email, scope)).toBeDefined();
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
    await saveGov(u.email, { agentCaps: { noor: 0 } }); // the default brand's cap
    await saveGov(scope, { agentCaps: { noor: COST - 1 } });
    await confirm("capped.example");
    const res = await onboard("capped.example");
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ ok: false, error: "agent_cap", need: COST, agent: "noor", cap: COST - 1 });
    expect(await db.get(`onboardlock:${scope}`)).toBeNull();
    expect(await credits(u.email)).toBe(50);
    await saveGov(scope, { agentCaps: { noor: COST } });
    expect((await drain(await onboard("capped.example"))).at(-1)!.type).toBe("done");
    expect(await credits(u.email)).toBe(50 - COST);
    await settle();
  });

  it("an ended trial is refused at confirm and before the stream", async () => {
    const { u, scope } = await withAddedBrand();
    await saveUser({ ...(await getUser(u.email))!, trialEnds: new Date(Date.now() - 864e5).toISOString() });
    const c = await confirm("late.example");
    expect(c.status).toBe(402);
    expect(await c.json()).toMatchObject({ ok: false, error: "trial_over", need: COST });
    await confirmOnboard(scope, "late.example");
    const res = await onboard("late.example");
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ ok: false, error: "trial_over" });
    expect(await credits(u.email)).toBe(50);
    expect(await getBrand(scope)).toBeNull();
  });

  it("deleting the account removes every brand's onboarding records, the held charge included", async () => {
    const { u, scope } = await withAddedBrand();
    await confirmOnboard(scope, "gone.example");
    await killedRun(u.email, scope);
    await Promise.all([db.lock(`onboardlock:${scope}`, 240), db.set(`onboardok:${u.email}`, "first.example", 86400)]);
    await wipeAccount(u.email);
    for (const k of [`onboardok:${scope}`, `onboardlock:${scope}`, `onboardok:${u.email}`, `user:${u.email}`]) expect(await db.get(k), k).toBeNull();
  });

  it("a run in progress answers busy and charges nothing", async () => {
    const { u, scope } = await withAddedBrand();
    await confirm("twice.example");
    expect(await db.lock(`onboardlock:${scope}`, 240)).toBe(true);
    try {
      expect((await onboard("twice.example")).status).toBe(409);
      expect(await credits(u.email)).toBe(50);
      expect(await hold(u.email, scope)).toBeUndefined();
    } finally {
      await db.unlock(`onboardlock:${scope}`);
    }
  });
});

describe("the Sunday plan is on by default only for the default brand (rule 247)", () => {
  it("an added brand starts off; Run now answers off and charges nothing until the owner switches it on", async () => {
    const { u, id, scope } = await withAddedBrand();
    await Promise.all([db.set(`brand:${u.email}`, brand), db.set(`brand:${scope}`, brand)]);
    expect((await getSchedule(u.email)).weeklyPlan).toBe(true);
    expect((await getSchedule(scope)).weeklyPlan).toBe(false);
    const inBrand = { ...(await getUser(u.email))!, brandId: id, scope };
    expect(await runWeekly(inBrand)).toBe("off");
    expect(await credits(u.email)).toBe(50);
    expect(await listLite(scope)).toHaveLength(0);

    // The owner switches it on for the added brand (the session's active brand is the added one).
    const put = await scheduleRoute.PUT(json("/api/schedule", "PUT", { weeklyPlan: true }));
    expect(((await put.json()) as { schedule: { weeklyPlan: boolean } }).schedule.weeklyPlan).toBe(true);
    expect(await runWeekly({ ...(await getUser(u.email))!, brandId: id, scope })).toMatch(/^ok:/);
    expect(TASK_COST.weekly_plan).toBe(2);
    expect(await credits(u.email)).toBe(50 - TASK_COST.weekly_plan);
    expect(await noorSpent(u.email, scope)).toBe(TASK_COST.weekly_plan);
    await settle();
  });

  it("the daily run stores no default, so the added brand's Sunday plan stays off", async () => {
    const { u, id, scope } = await withAddedBrand();
    await db.set(`brand:${scope}`, brand);
    expect(await runDaily({ ...(await getUser(u.email))!, brandId: id, scope })).not.toBeNull();
    const stored = (await db.get<Record<string, unknown>>(`schedule:${scope}`))!;
    expect(stored.lastDaily).toBeTruthy();
    expect(stored, "a default is never written back").not.toHaveProperty("weeklyPlan");
    expect((await getSchedule(scope)).weeklyPlan).toBe(false);
    // saveSchedule answers the merged view and stores only what was set.
    expect(await saveSchedule(scope, { routines: { noor_cart_recovery: true } })).toMatchObject({ weeklyPlan: false, dailyBrief: true, followUps: true, routines: { noor_cart_recovery: true } });
    expect(await db.get(`schedule:${scope}`)).not.toHaveProperty("dailyBrief");
    // An explicit choice is kept, on either brand.
    await saveSchedule(u.email, { weeklyPlan: false });
    expect((await getSchedule(u.email)).weeklyPlan).toBe(false);
  });

  it("an added brand whose record froze the old default (on) before 2026-09-30 starts off and is not charged on Sunday", async () => {
    const { u, id, scope } = await withAddedBrand();
    await Promise.all([db.set(`brand:${scope}`, brand), db.set(`brand:${u.email}`, brand)]);
    // What the old saveSchedule wrote on every daily run: the merged defaults, with nothing to say who chose them.
    const legacy = { weeklyPlan: true, dailyBrief: true, followUps: true, lastDaily: "2026-09-28T05:00:00.000Z" };
    await Promise.all([db.set(`schedule:${scope}`, legacy), db.set(`schedule:${u.email}`, { ...legacy, weeklyPlan: false })]);
    expect((await getSchedule(scope)).weeklyPlan, "the unstamped old default does not count on an added brand").toBe(false);
    expect((await getSchedule(u.email)).weeklyPlan, "the default brand's stored choice still counts").toBe(false);
    expect(await runWeekly({ ...(await getUser(u.email))!, brandId: id, scope })).toBe("off");
    expect(await credits(u.email)).toBe(50);
    // A daily run keeps it that way; the owner's switch (stamped) turns it on.
    await runDaily({ ...(await getUser(u.email))!, brandId: id, scope });
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
    await db.set(`brand:${u.email}`, brand);
    const user = (await getUser(u.email))!;
    for (const type of ["weekly_plan", "article", "cart_recovery", "board_deck", "constructor"]) {
      const out = await runTool(user, "draft_items", { type, count: 3, brief: "x" }, []);
      expect(out, type).toMatch(/Not a draft type/);
      expect(out).toContain(DRAFT_TYPES.join(", "));
    }
    expect(await credits(u.email)).toBe(50);
    expect(await listLite(u.email)).toHaveLength(0);
    // A draft type still drafts, at 1 credit an item.
    expect(await runTool(user, "draft_items", { type: "social", count: 1, brief: "منشور" }, [])).toMatch(/^Drafted 1 social/);
    expect(await credits(u.email)).toBe(49);
    await settle();
  });
});
