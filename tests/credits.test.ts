import { afterEach, describe, expect, it, vi } from "vitest";
import { createUser, getUser } from "@/lib/auth";
import { adjust, charge, refund } from "@/lib/credits";
import { db } from "@/lib/db";

let n = 0;
const fresh = async () => (await createUser({ email: `credits${++n}@test.example`, name: "T", phone: "", password: "abc12345", lang: "ar" })).email;

afterEach(() => vi.restoreAllMocks());

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
    expect(r.ok).toBe(false);
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
