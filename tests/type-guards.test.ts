import { describe, expect, it } from "vitest";
import { TASK_COST, TASK_TYPES, isTaskType } from "@/lib/tasks";
import { PLAN_CREDITS, PLANS, isPlan, seatLimit, type Plan } from "@/lib/auth";
import { allowanceOf, priceOf } from "@/lib/pricing";
import { charge, adjust } from "@/lib/credits";
import { newUser } from "./helpers/session";
import { getUser } from "@/lib/auth";

/**
 * Values that arrive from a request body or from model output are checked for MEMBERSHIP, never with `in`. `in` walks
 * the prototype chain, so every one of these keys passed the old guard and produced a function where a number was
 * expected — which opened the credit gate (every comparison against NaN is false) and wrote NaN into the balance.
 */
const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"];

describe("task type membership", () => {
  it("the `in` operator would have accepted every prototype key", () => {
    // Documents the defect this guard replaces; if this ever stops being true the guard can be simplified.
    expect(PROTOTYPE_KEYS.filter((k) => k in TASK_COST)).toEqual(PROTOTYPE_KEYS);
  });

  it("isTaskType rejects all of them", () => {
    expect(PROTOTYPE_KEYS.filter(isTaskType)).toEqual([]);
  });

  it("isTaskType accepts every real type and nothing else", () => {
    expect(TASK_TYPES.length).toBe(26);
    expect(TASK_TYPES.every(isTaskType)).toBe(true);
    for (const v of ["", "social ", "SOCIAL", "not_a_type", null, undefined, 0, {}, []]) expect(isTaskType(v)).toBe(false);
  });

  it("every real type has a numeric cost", () => {
    for (const t of TASK_TYPES) expect(Number.isFinite(TASK_COST[t]), t).toBe(true);
  });
});

describe("plan membership", () => {
  it("the same hole existed for plans", () => {
    expect(PROTOTYPE_KEYS.filter((k) => k in PLAN_CREDITS)).toEqual(PROTOTYPE_KEYS);
    expect(PROTOTYPE_KEYS.filter(isPlan)).toEqual([]);
    expect(PLANS.every(isPlan)).toBe(true);
  });

  it("business is a plan and the retired enterprise is not (rule 242)", () => {
    expect(PLANS).toContain("business");
    expect(isPlan("business")).toBe(true);
    expect(isPlan("enterprise"), "enterprise is read as agency, never offered or accepted").toBe(false);
    expect(PLANS).not.toContain("enterprise");
  });

  it("every plan has a finite allowance, price and seat count, and prototype keys get nothing", () => {
    for (const plan of PLANS) {
      expect(Number.isFinite(allowanceOf({ plan })), plan).toBe(true);
      expect(Number.isFinite(priceOf({ plan })), plan).toBe(true);
      expect(Number.isInteger(seatLimit({ plan })), plan).toBe(true);
    }
    for (const k of PROTOTYPE_KEYS) {
      const junk = { plan: k as Plan };
      expect([allowanceOf(junk), priceOf(junk), seatLimit(junk)], k).toEqual([0, 0, 1]);
    }
  });
});

describe("the ledger refuses a cost that is not a number", () => {
  it("charge throws rather than writing NaN into the balance", async () => {
    const u = await newUser("ledger");
    for (const bad of [NaN, Infinity, -1, undefined as unknown as number, "5" as unknown as number, (() => 1) as unknown as number]) {
      await expect(charge(u.email, bad)).rejects.toThrow(/invalid_cost/);
    }
    expect((await getUser(u.email))!.credits, "no failed charge may move the balance").toBe(50);
  });

  it("adjust throws on a non-finite delta", async () => {
    const u = await newUser("ledger");
    await expect(adjust(u.email, NaN)).rejects.toThrow(/invalid_delta/);
    expect((await getUser(u.email))!.credits).toBe(50);
  });

  it("a balance already damaged by the old defect is repaired on the next charge", async () => {
    const u = await newUser("ledger");
    const { saveUser } = await import("@/lib/auth");
    await saveUser({ ...u, credits: NaN });
    const r = await charge(u.email, 5);
    expect(r.ok, "a NaN balance must read as zero, not as infinite credit").toBe(false);
    expect((await getUser(u.email))!.credits).toBe(0);
  });
});
