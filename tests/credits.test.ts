import { afterEach, describe, expect, it, vi } from "vitest";
import { createUser, getUser, saveUser } from "@/lib/auth";
import { adjust, agentSpendFor, charge, monthKey, refund, renewIfDue } from "@/lib/credits";
import { applyReferral, codeFor, registerCode } from "@/lib/referral";
import { db } from "@/lib/db";
import { json } from "./helpers/session";

let n = 0;
const fresh = async () => (await createUser({ email: `credits${++n}@test.example`, name: "T", phone: "", password: "abc12345", lang: "ar" })).email;

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("credits ledger", () => {
  it("starts a trial account at 50 credits and charges exactly the cost", async () => {
    const email = await fresh();
    const r = await charge(email, 10);
    expect(r).toEqual({ ok: true, credits: 40 });
    expect((await getUser(email))!.credits).toBe(40);
  });
  it("refuses a charge the balance cannot cover and leaves the balance untouched", async () => {
    const email = await fresh();
    const r = await charge(email, 51);
    expect(r).toEqual({ ok: false, reason: "no_credits", credits: 50, need: 51 });
    expect((await getUser(email))!.credits).toBe(50);
  });
  it("refunds after a failed generation", async () => {
    const email = await fresh();
    await charge(email, 10);
    expect(await refund(email, 10)).toBe(50);
  });
  it("never goes below zero", async () => {
    const email = await fresh();
    expect(await adjust(email, -500)).toBe(0);
  });
  // The double-spend case: many requests race for the last credits. Exactly five charges of 10 may succeed on a balance of 50.
  it("serialises concurrent charges so credits cannot be spent twice", async () => {
    const email = await fresh();
    const results = await Promise.all(Array.from({ length: 12 }, () => charge(email, 10)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect((await getUser(email))!.credits).toBe(0);
  });
  // Callers read a throw as "nothing changed": the media engine answers a throwing charge with "busy, no credits were
  // used" and releases its refund marker after a throwing refund. A release that fails after the save is not that.
  it("a ledger lock that fails to release after the save still reports the change that was made", async () => {
    const email = await fresh();
    const realUnlock = db.unlock;
    vi.spyOn(console, "error").mockImplementation(() => {});
    let failing = true;
    // The first release fails, as if the DEL never reached Redis; the lock is then freed as its TTL would free it.
    vi.spyOn(db, "unlock").mockImplementation(async (key: string) => {
      if (failing && key === `lock:user:${email}`) {
        failing = false;
        throw new Error("redis_down");
      }
      return realUnlock(key);
    });
    expect(await charge(email, 12)).toEqual({ ok: true, credits: 38 });
    await realUnlock(`lock:user:${email}`);
    failing = true;
    expect(await refund(email, 12)).toBe(50);
    expect(failing, "the refund's release failed too").toBe(false);
    expect((await getUser(email))!.credits).toBe(50);
  });
});

/**
 * Rules 106-107: a charge is counted against the agent that owns the work, per brand scope and UTC month, on the User
 * record in the same save as the balance; the owner's cap for that agent is enforced inside the same lock; a refund
 * lowers the counter it raised, in its own month only; nothing else that writes the balance touches the counters.
 */
describe("per-agent monthly spend and caps (rules 106-107)", () => {
  it("a charge without meta is unchanged and writes no counters", async () => {
    const email = await fresh();
    expect(await charge(email, 3)).toEqual({ ok: true, credits: 47 });
    expect((await getUser(email))!.agentSpend).toBeUndefined();
  });

  it("counts each charge against its scope and agent, in the same save as the balance", async () => {
    const email = await fresh();
    const second = `${email}#b2`;
    const a = await charge(email, 3, { scope: email, agent: "razan" });
    expect(a).toEqual({ ok: true, credits: 47, scope: email, agent: "razan", month: monthKey(), spent: 3, warn80: false });
    expect(await charge(email, 2, { scope: second, agent: "razan" })).toMatchObject({ ok: true, credits: 45, spent: 2 });
    expect(await charge(email, 4, { scope: email, agent: "noor" })).toMatchObject({ ok: true, credits: 41, spent: 4 });
    expect(await charge(email, 1, { scope: email, agent: "razan" })).toMatchObject({ ok: true, credits: 40, spent: 4 });
    const u = (await getUser(email))!;
    expect(u.credits).toBe(40);
    expect(u.agentSpend).toEqual({ month: monthKey(), by: { [email]: { razan: 4, noor: 4 }, [second]: { razan: 2 } } });
    expect(agentSpendFor(u, email)).toEqual({ razan: 4, noor: 4 });
    expect(agentSpendFor(u, second)).toEqual({ razan: 2 });
    expect(agentSpendFor(u, `${email}#other`)).toEqual({});
  });

  it("refuses over the cap before the balance is touched; a missing or broken cap is no cap", async () => {
    const email = await fresh();
    expect(await charge(email, 6, { scope: email, agent: "sami", cap: 5 })).toEqual({ ok: false, reason: "agent_cap", credits: 50, agent: "sami", spent: 0, cap: 5 });
    expect(await charge(email, 1, { scope: email, agent: "sami", cap: 0 })).toMatchObject({ ok: false, reason: "agent_cap", spent: 0, cap: 0 });
    let u = (await getUser(email))!;
    expect(u.credits).toBe(50);
    expect(agentSpendFor(u, email)).toEqual({});
    // Exactly at the cap is allowed; one more is not.
    expect(await charge(email, 5, { scope: email, agent: "sami", cap: 5 })).toMatchObject({ ok: true, spent: 5, cap: 5 });
    expect(await charge(email, 1, { scope: email, agent: "sami", cap: 5 })).toMatchObject({ ok: false, reason: "agent_cap", spent: 5, cap: 5 });
    // The cap is per agent: Layan still spends.
    expect(await charge(email, 1, { scope: email, agent: "layan", cap: 5 })).toMatchObject({ ok: true, spent: 1 });
    for (const cap of [NaN, -1, Infinity, undefined]) expect((await charge(email, 1, { scope: email, agent: "dana", cap })).ok).toBe(true);
    u = (await getUser(email))!;
    expect(u.credits).toBe(50 - 5 - 1 - 4);
    // The cap check comes first: an agent over its cap is refused as agent_cap even with no credits left.
    await adjust(email, -1000);
    expect(await charge(email, 1, { scope: email, agent: "sami", cap: 5 })).toMatchObject({ ok: false, reason: "agent_cap" });
    expect(await charge(email, 1, { scope: email, agent: "sami", cap: 50 })).toEqual({ ok: false, reason: "no_credits", credits: 0, need: 1 });
  });

  it("N parallel charges can never take an agent past its cap", async () => {
    const email = await fresh();
    const results = await Promise.all(Array.from({ length: 12 }, () => charge(email, 3, { scope: email, agent: "faris", cap: 10 })));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "agent_cap")).toBe(true);
    const u = (await getUser(email))!;
    expect(agentSpendFor(u, email).faris).toBe(9);
    expect(u.credits).toBe(41);
  });

  it("warn80 is true only on the charge that crosses 80% of the cap", async () => {
    const email = await fresh();
    const meta = { scope: email, agent: "majed" as const, cap: 10 };
    const warns: boolean[] = [];
    for (const cost of [7, 1, 1, 1]) { const r = await charge(email, cost, meta); warns.push(r.ok && r.warn80); }
    expect(warns).toEqual([false, true, false, false]);
    // No cap, no warning, however much is spent.
    expect(await charge(email, 20, { scope: email, agent: "dana" })).toMatchObject({ ok: true, warn80: false });
  });

  it("a refund lowers the counter its charge raised, never below 0, and leaves other agents and scopes alone", async () => {
    const email = await fresh();
    const other = await charge(email, 2, { scope: email, agent: "noor" });
    const paid = await charge(email, 4, { scope: email, agent: "razan", cap: 10 });
    if (!paid.ok || !other.ok) throw new Error("charge failed");
    expect(await refund(email, 4, paid)).toBe(48);
    let u = (await getUser(email))!;
    expect(agentSpendFor(u, email)).toEqual({ noor: 2, razan: 0 });
    // A second refund of the same receipt cannot push the counter negative.
    await refund(email, 4, paid);
    u = (await getUser(email))!;
    expect(agentSpendFor(u, email).razan).toBe(0);
    // A refund for another scope finds nothing to lower there.
    await refund(email, 1, { ...other, scope: `${email}#b2` });
    expect(agentSpendFor((await getUser(email))!, email).noor).toBe(2);
  });

  it("a refund after the month rolled over does not lower the new month's counter", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
    const email = await fresh();
    const september = await charge(email, 4, { scope: email, agent: "noor" });
    if (!september.ok) throw new Error("charge failed");
    expect(september.month).toBe("2026-09");
    // 00:00 UTC on the 1st: the counters start again, whatever renewIfDue (at the 05:00 cron) has done or not.
    vi.setSystemTime(new Date("2026-10-01T00:01:00Z"));
    expect(agentSpendFor((await getUser(email))!, email)).toEqual({});
    expect(await charge(email, 3, { scope: email, agent: "noor", cap: 5 })).toMatchObject({ ok: true, month: "2026-10", spent: 3 });
    expect(await refund(email, 4, september)).toBe(47);
    const u = (await getUser(email))!;
    expect(u.agentSpend).toEqual({ month: "2026-10", by: { [email]: { noor: 3 } } });
  });

  it("referral and share bonuses, admin plan changes and top-ups, and the monthly renewal leave the counters alone", async () => {
    const email = await fresh();
    await charge(email, 5, { scope: email, agent: "layan" });
    const before = (await getUser(email))!.agentSpend;
    expect(before).toEqual({ month: monthKey(), by: { [email]: { layan: 5 } } });

    await adjust(email, 20); // the share bonus
    const referrer = await fresh();
    await registerCode(referrer);
    await applyReferral(email, codeFor(referrer));
    vi.stubEnv("WAITLIST_ADMIN_KEY", "k-credits-test");
    const admin = await import("@/app/api/admin/plan/route");
    expect((await admin.POST(json("/api/admin/plan", "POST", { email, plan: "pro" }, { "x-admin-key": "k-credits-test" }))).status).toBe(200);
    expect((await admin.POST(json("/api/admin/plan", "POST", { email, addCredits: 30 }, { "x-admin-key": "k-credits-test" }))).status).toBe(200);
    // A renewal long due (rule 2936): the last one years ago, the plan paid well past its next day.
    const set = (await getUser(email))!;
    await saveUser({ ...set, renewedAt: "2020-01", renewedOn: "2020-01-15", handPlan: { ...set.handPlan!, paidThrough: "2099-01-01" } });
    expect(await renewIfDue(email)).toBe(true);

    const u = (await getUser(email))!;
    expect(u.credits).toBe(700);
    expect(u.agentSpend).toEqual(before);
  });
});
