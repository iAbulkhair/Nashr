import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rules 332-334: the Sunday plan's money (issues #29 and #31).
 *
 * #29: paid credits were renewed only by the daily cron at 05:00 UTC, after the Sunday plan at 03:00, so on a Sunday the
 * 1st (next: 2026-11-01) a paying owner met last month's balance, got `no_credits` and lost that week's plan.
 *
 * #31: the plan charged before generating, and only the generation was inside the refund guard: a failed task save kept
 * the charge with no plan, and a run killed after its charge (the platform runs no catch) was charged again on retry.
 */
const h = vi.hoisted(() => ({ mode: "ok" as "ok" | "hang", failSaves: 0 }));
vi.mock("@anthropic-ai/sdk", () => {
  const reply = (text: string) => ({ model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text }] });
  return {
    default: class {
      static BadRequestError = class extends Error {};
      beta = { messages: { stream: () => ({ finalMessage: () => (h.mode === "hang" ? new Promise(() => {}) : Promise.resolve(reply(JSON.stringify([{ channel: "plan", title: "خطة الأسبوع", body: "سبعة أيام من المحتوى" }])))) }) } };
      messages = { create: async () => reply(JSON.stringify([{ ok: true }])) };
    },
  };
});
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));
vi.mock("@/lib/brand", async (orig) => {
  const m = await orig<typeof import("@/lib/brand")>();
  return { ...m, saveTask: async (...a: Parameters<typeof m.saveTask>) => { if (h.failSaves > 0) { h.failSaves--; throw new Error("upstash down"); } return m.saveTask(...a); } };
});

import { getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { listTasks, type Brand } from "@/lib/brand";
import { PAID_ONCE_MS, chargeOnce, refundOnce, renewIfDue } from "@/lib/credits";
import { generateBatch } from "@/lib/generate-batch";
import { getSchedule, runWeekly, saveSchedule, weeklyClaim } from "@/lib/schedule";
import { PLAN_CREDITS } from "@/lib/pricing";
import { TASK_COST } from "@/lib/tasks";
import { newUser, settle } from "./helpers/session";
import * as weeklyRoute from "@/app/api/cron/weekly/route";

const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const COST = TASK_COST.weekly_plan;
async function owner(prefix: string, over: Partial<User> = {}): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...u, ...over });
  await db.set(`brand:${u.email}`, brand);
  return (await getUser(u.email))!;
}
const credits = async (email: string) => (await getUser(email))!.credits;
const plans = async (email: string) => (await listTasks(email)).filter((t) => t.type === "weekly_plan");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { h.mode = "ok"; h.failSaves = 0; vi.stubEnv("ANTHROPIC_API_KEY", "test"); });
afterEach(async () => { await settle(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("a paid account is renewed before the Sunday plan charges it (rule 332)", () => {
  it("Sunday 1 November 2026 at 03:00 UTC: the weekly cron renews a starter account at 0 credits, then plans", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T03:00:00Z"));
    vi.stubEnv("CRON_SECRET", "test-cron");
    const u = await owner("wk-renew", { plan: "starter", credits: 0, renewedAt: "2026-10" });
    const res = await weeklyRoute.GET(new Request("https://nashr.test/api/cron/weekly", { headers: { authorization: "Bearer test-cron" } }));
    const report = (await res.json()) as { results: Record<string, string> };
    // It used to be "no_credits", and that result wrote the week's done marker: no plan that week, no error anywhere.
    expect(report.results[u.email]).toBe("ok:1");
    const after = (await getUser(u.email))!;
    expect([after.credits, after.renewedAt]).toEqual([PLAN_CREDITS.starter - COST, "2026-11"]);
    expect(await plans(u.email)).toHaveLength(1);
    // The daily job at 05:00 finds the month renewed and leaves the balance alone: renewed once, not twice.
    vi.setSystemTime(new Date("2026-11-01T05:00:00Z"));
    expect(await renewIfDue(u.email)).toBe(false);
    expect(await credits(u.email)).toBe(PLAN_CREDITS.starter - COST);
  });

  it("a trial is never renewed by a batch, and an account renewed this month is not renewed again", async () => {
    const t = await owner("wk-trial");
    expect(await runWeekly(t)).toBe("ok:1");
    expect(await credits(t.email)).toBe(PLAN_CREDITS.trial - COST);
    const month = new Date().toISOString().slice(0, 7);
    const p = await owner("wk-paid", { plan: "starter", credits: 7, renewedAt: month });
    expect(await runWeekly(p)).toBe("ok:1");
    expect(await credits(p.email)).toBe(7 - COST);
  });
});

describe("the Sunday plan is charged once per brand and week (rule 333)", () => {
  it("a run killed after its charge: the retry reuses the charge, one credit drop and one plan", async () => {
    const u = await owner("wk-kill");
    h.mode = "hang";
    void runWeekly(u);
    // Wait for the charge: the run is now generating, and the platform kills it there (no catch, no finally).
    for (let i = 0; i < 100 && (await credits(u.email)) === PLAN_CREDITS.trial; i++) await sleep(5);
    expect(await credits(u.email)).toBe(PLAN_CREDITS.trial - COST);
    // Its lock would expire at 300 s; the retry comes after that.
    await db.del(`weeklylock:${u.email}`);
    h.mode = "ok";
    expect(await runWeekly((await getUser(u.email))!)).toBe("ok:1");
    expect(await credits(u.email), "charged once for one plan, not twice").toBe(PLAN_CREDITS.trial - COST);
    expect(await plans(u.email)).toHaveLength(1);
  });

  it("a retry after a success charges nothing, even with the week's marker gone", async () => {
    const u = await owner("wk-twice");
    expect(await runWeekly(u)).toBe("ok:1");
    expect(await runWeekly((await getUser(u.email))!)).toBe("already_this_week");
    expect(await credits(u.email)).toBe(PLAN_CREDITS.trial - COST);
    // The marker lost (an older week's record, a cleared key): the claim still holds this week's charge.
    await saveSchedule(u.email, { lastWeekly: undefined });
    expect(await runWeekly((await getUser(u.email))!)).toBe("ok:1");
    expect(await credits(u.email)).toBe(PLAN_CREDITS.trial - COST);
  });

  it("the ledger: concurrent charges of one claim debit once; a refund gives it back once; old holds are dropped", async () => {
    const u = await owner("wk-ledger");
    const meta = { scope: u.email, agent: "noor" as const };
    const rs = await Promise.all(Array.from({ length: 5 }, () => chargeOnce(u.email, COST, meta, "weekly:x:2026-10-04")));
    expect(rs.filter((r) => r.ok && !("hold" in r))).toHaveLength(1);
    expect(rs.filter((r) => r.ok && "hold" in r)).toHaveLength(4);
    expect(await credits(u.email)).toBe(PLAN_CREDITS.trial - COST);
    expect(await refundOnce(u.email, "weekly:x:2026-10-04")).toEqual({ credits: PLAN_CREDITS.trial, refunded: COST });
    expect(await refundOnce(u.email, "weekly:x:2026-10-04")).toEqual({ credits: PLAN_CREDITS.trial, refunded: 0 });
    // A hold older than PAID_ONCE_MS is gone after the next charge of the account; a live one stays.
    const old = new Date(Date.now() - PAID_ONCE_MS - 1000).toISOString();
    const rec = (await getUser(u.email))!;
    await saveUser({ ...rec, paidOnce: { stale: { scope: u.email, agent: "noor", month: "2026-09", credits: 2, at: old } } });
    await chargeOnce(u.email, COST, meta, "weekly:x:2026-10-11");
    expect(Object.keys((await getUser(u.email))!.paidOnce ?? {})).toEqual(["weekly:x:2026-10-11"]);
  });

  it("the claim is per brand and per week", () => {
    expect(weeklyClaim("a@test.example", "2026-11-01")).toBe("weekly:a@test.example:2026-11-01");
    expect(weeklyClaim("a@test.example#b1", "2026-11-01")).not.toBe(weeklyClaim("a@test.example", "2026-11-01"));
  });
});

describe("a failure after the charge refunds it once: the saves and the marker are inside the guard (rule 334)", () => {
  it("a task save that fails gives the credits back and writes no marker; the retry charges once", async () => {
    const u = await owner("wk-save");
    h.failSaves = 1;
    await expect(runWeekly(u)).rejects.toThrow("upstash down");
    const mid = (await getUser(u.email))!;
    expect([mid.credits, mid.paidOnce]).toEqual([PLAN_CREDITS.trial, undefined]);
    expect((await getSchedule(u.email)).lastWeekly).toBeUndefined();
    expect(await runWeekly(mid)).toBe("ok:1");
    expect(await credits(u.email)).toBe(PLAN_CREDITS.trial - COST);
  });

  it("a commit (the week's marker) that fails refunds, through the claim, exactly once", async () => {
    const u = await owner("wk-commit");
    const once = weeklyClaim(u.email);
    const r = await generateBatch(u, u.email, { type: "weekly_plan", source: "scheduled", via: "weekly", once, commit: async () => { throw new Error("marker failed"); } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason === "failed" && (r.error as Error).message).toBe("marker failed");
    const after = (await getUser(u.email))!;
    expect([after.credits, after.paidOnce]).toEqual([PLAN_CREDITS.trial, undefined]);
    // The tasks were saved before the marker failed; they stay (the owner can use them), and nothing is charged for them.
    expect(await plans(u.email)).toHaveLength(1);
  });

  it("every other batch keeps its plain charge, now refunded on a failed save too", async () => {
    const u = await owner("wk-app");
    h.failSaves = 1;
    const r = await generateBatch(u, u.email, { type: "article", source: "manual", via: "app" });
    expect(r.ok).toBe(false);
    expect(await credits(u.email)).toBe(PLAN_CREDITS.trial);
    expect((await getUser(u.email))!.paidOnce).toBeUndefined();
  });
});
