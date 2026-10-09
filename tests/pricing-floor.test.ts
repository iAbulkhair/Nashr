import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MARGIN_FLOOR, ONBOARD_EXTRA_BRAND_COST, PLAN_CREDITS, PLAN_PRICE_SAR, PRICES_INCLUDE_VAT, cheapestCreditUsd, creditRevenueUsd, maxCostPerCreditUsd,
} from "@/lib/pricing";
import { ASSUME, ESTIMATE_MODELS, ITEM_SIZE, draftCredits, estimateBatch, estimateDraft, mediaPromptUsd, onboardEstimateUsd } from "@/lib/task-costs";
import { DRAFT_TYPES, TASK_COST, TASK_COUNT, TASK_TYPES, type TaskType } from "@/lib/tasks";
import { hasRate } from "@/lib/usage";
import { ROUTINES } from "@/lib/routines";
import { countCost } from "@/lib/generate-batch";
import { MEDIA_MODELS } from "@/lib/media-catalog";
import { COST_USD } from "@/lib/media/config";
import { HANDOFF_TYPES, autoBlock, type Handoff } from "@/lib/handoffs";
import { agentForTask } from "@/lib/agents";
import { X_MAX_POSTS, X_READ_CREDITS, X_READ_USD } from "@/lib/connectors/x";

/**
 * Rule 241: the 60% margin floor is a test, not a comment. What one credit may cost us is at most 40% of the cheapest
 * self-serve credit (src/lib/pricing.ts: Business, 999 SAR / 3.75 / 1,500 = $0.1776, so $0.07104). Every task type's
 * estimated batch cost (src/lib/task-costs.ts: tokens priced by `costUsd`, so a rate change moves it) divided by its
 * TASK_COST must stay under that. A change to a price, a credit count, a task cost, a batch size or a model rate that
 * breaks the floor fails the build.
 *
 * Cache: an owner working in the app finds the workspace block cached, so on-demand types are checked on a cache hit.
 * The cron runs once a week or month per brand, so its cache is usually cold: the weekly plan and every routine's task
 * type (src/lib/routines.ts) are checked on a cold cache (founder decision, 2026-09-29). Since step 3b, Majed's auto-run
 * (src/lib/handoff-auto.ts) starts handoff items from the same 06:00 cron, once a day per brand: every type it may start
 * is checked on a cold cache too (below, "Majed's auto-run is a cron path").
 */
const ceiling = maxCostPerCreditUsd();
const CRON_TYPES: readonly TaskType[] = [...new Set<TaskType>(["weekly_plan", ...ROUTINES.map((r) => r.type)])];
const gate = (type: TaskType) => estimateBatch(type, { cache: CRON_TYPES.includes(type) ? "cold" : "hit" });
const usd = (n: number) => `$${n.toFixed(4)}`;

/**
 * The one-item chat draft exemption (founder decision, 2026-09-29: a one-item draft of social, whatsapp, ads or gbp at
 * 1 credit cost about $0.0717 on Opus 5, just over the ceiling) was removed on 2026-10-09: on Opus 5.5 the same draft
 * costs $0.0605, under the ceiling, so every draft now keeps the floor with no exemption.
 */

describe("the ceiling (rule 241)", () => {
  it("60% floor: at most 40% of the cheapest self-serve credit, which is Business's $0.1776", () => {
    expect(MARGIN_FLOOR).toBe(0.6);
    expect(PRICES_INCLUDE_VAT, "the site says prices exclude VAT; flipping this lowers the ceiling (below)").toBe(false);
    expect(creditRevenueUsd("starter")).toBeCloseTo(0.265778, 6);
    expect(creditRevenueUsd("pro")).toBeCloseTo(0.190095, 6);
    expect(creditRevenueUsd("business")).toBeCloseTo(0.1776, 6);
    expect(cheapestCreditUsd()).toBeCloseTo(0.1776, 6);
    expect(ceiling).toBeCloseTo(0.07104, 6);
    expect(maxCostPerCreditUsd(undefined, undefined, true), "VAT-inclusive prices: 999 / 1.15").toBeCloseTo(0.0618, 4);
  });
});

describe("every task type is under the ceiling (rule 241)", () => {
  it("the scheduled cron types are the weekly plan and every routine's type (the auto-run's types are checked cold below)", () => {
    expect([...CRON_TYPES].sort()).toEqual(["cart_recovery", "cash_forecast", "strategy_review", "weekly_plan", "weekly_report"]);
  });

  it("no type costs more per credit than the ceiling (cron types on a cold cache, the rest on a hit)", () => {
    const over = TASK_TYPES.map(gate).filter((e) => e.usdPerCredit > ceiling);
    expect(over.map((e) => `${e.type}: ${usd(e.usdPerCredit)} per credit at ${e.credits} credits (ceiling ${usd(ceiling)})`)).toEqual([]);
  });

  it("every type has an item size and a positive cost", () => {
    expect(Object.keys(ITEM_SIZE).sort()).toEqual([...TASK_TYPES].sort());
    for (const t of TASK_TYPES) {
      const e = estimateBatch(t);
      expect(e.totalUsd, t).toBeGreaterThan(0);
      expect([e.items, e.credits], t).toEqual([TASK_COUNT[t], TASK_COST[t]]);
    }
  });

  it("the phase-1 repricing: weekly_plan 2, weekly_report 3, followup_seq 4; the old prices fail, so the test is not vacuous", () => {
    expect([TASK_COST.weekly_plan, TASK_COST.weekly_report, TASK_COST.followup_seq]).toEqual([2, 3, 4]);
    const old = [
      estimateBatch("weekly_plan", { credits: 1, cache: "hit" }),
      estimateBatch("followup_seq", { credits: 3, cache: "hit" }),
      estimateBatch("weekly_report", { credits: 2, cache: "cold" }),
    ];
    // On Opus 5.5 (2026-10-09); they were $0.0893, $0.0888 and $0.0918 on Opus 5. Still over, so still not vacuous.
    expect(old.map((e) => e.usdPerCredit)).toEqual([expect.closeTo(0.0753, 6), expect.closeTo(0.0751, 6), expect.closeTo(0.07725, 6)]);
    for (const e of old) expect(e.usdPerCredit, `${e.type} at ${e.credits}`).toBeGreaterThan(ceiling);
  });

  it("today's figures (Opus 5.5 since 2026-10-09): weekly_plan $0.0377 on a hit and $0.0557 cold, followup_seq $0.0563, article $0.0593", () => {
    expect(estimateBatch("weekly_plan").usdPerCredit).toBeCloseTo(0.03765, 6);
    expect(estimateBatch("weekly_plan", { cache: "cold" }).usdPerCredit).toBeCloseTo(0.05565, 6);
    expect(estimateBatch("followup_seq").usdPerCredit).toBeCloseTo(0.056325, 6);
    expect(estimateBatch("article").usdPerCredit).toBeCloseTo(0.05925, 6);
    expect(estimateBatch("weekly_report", { cache: "cold" }).usdPerCredit).toBeCloseTo(0.0515, 6);
    expect(estimateBatch("cart_recovery").usdPerCredit).toBeCloseTo(0.0336833, 6);
  });

  it("the watch list: no type is above 95% of the ceiling; article is the closest", () => {
    const rows = TASK_TYPES.map(gate);
    expect(rows.filter((e) => e.usdPerCredit > 0.95 * ceiling).map((e) => e.type)).toEqual([]);
    expect(rows.reduce((a, b) => (b.usdPerCredit > a.usdPerCredit ? b : a)).type).toBe("article");
  });

  it("a price cut fails the floor: Business at 799 SAR puts article over", () => {
    const cut = maxCostPerCreditUsd({ ...PLAN_PRICE_SAR, business: 799 });
    expect(estimateBatch("article").usdPerCredit).toBeGreaterThan(cut);
  });

  it("more credits for the money fail it too: Business at 1,900 credits puts article over", () => {
    expect(estimateBatch("article").usdPerCredit).toBeGreaterThan(maxCostPerCreditUsd(undefined, { ...PLAN_CREDITS, business: 1900 }));
  });

  it("VAT-inclusive prices (ceiling $0.0618) keep the floor for every type since Opus 5.5; article is the closest", () => {
    const vat = maxCostPerCreditUsd(undefined, undefined, true);
    expect(TASK_TYPES.map(gate).filter((e) => e.usdPerCredit > vat).map((e) => e.type)).toEqual([]);
    expect(estimateBatch("article").usdPerCredit).toBeGreaterThan(0.95 * vat);
  });
});

describe("Majed's auto-run is a cron path: every type it may start keeps the floor on a cold cache (rules 241, 296)", () => {
  /**
   * The types the auto-run may start, asked of `autoBlock` itself: a one-item proposal of each handoff type that passes
   * every other rule (the owner's, shown, fresh, a cap on the type's agent). Nothing here repeats the code's filter.
   */
  const at = new Date().toISOString();
  const one = (type: TaskType): Handoff => ({ id: "0123456789abcdef", agent: "majed", requestedBy: { kind: "owner", email: "o@floor.example" }, origin: "web_chat", ownerMsg: "", items: [{ type, agent: agentForTask(type).id, brief: "b", cost: TASK_COST[type], status: "proposed" }], status: "proposed", createdAt: at, shownAt: at });
  const AUTO_TYPES = HANDOFF_TYPES.filter((t) => autoBlock(one(t), 0, { majedAutoHandoff: true, agentCaps: { [agentForTask(t).id]: 100 } }) === null);

  it("no type the auto-run may start costs more per credit than the ceiling on a cold cache", () => {
    const over = AUTO_TYPES.map((t) => estimateBatch(t, { cache: "cold" })).filter((e) => e.usdPerCredit > ceiling);
    expect(over.map((e) => `${e.type}: ${usd(e.usdPerCredit)} per credit cold at ${e.credits} credits (ceiling ${usd(ceiling)})`)).toEqual([]);
  });

  it("it leaves exactly article to a login's Run, the one handoff type over the ceiling cold", () => {
    const left = HANDOFF_TYPES.filter((t) => !AUTO_TYPES.includes(t));
    // followup_seq ($0.0773 cold on Opus 5) left the list on 2026-10-09: $0.0653 cold on Opus 5.5.
    expect(left).toEqual(["article"]);
    expect(left.map((t) => estimateBatch(t, { cache: "cold" }).usdPerCredit)).toEqual([expect.closeTo(0.07725, 6)]);
    // On a hit (the owner pressing Run in the app) both keep the floor, as the table above checks them.
    for (const t of left) expect(estimateBatch(t).usdPerCredit, t).toBeLessThanOrEqual(ceiling);
  });
});

describe("the estimates price the models the code calls (rule 241)", () => {
  const src = (p: string) => readFileSync(p, "utf8");

  it("noor.ts, judge.ts, onboard.ts and media/prompts.ts call the models the estimates assume", () => {
    expect(src("src/lib/noor.ts")).toContain(`model: "${ESTIMATE_MODELS.generate}"`);
    // The reviewer (`critique`) and, since step 3b, the cross-agent review call Sonnet through one constant in noor.ts.
    expect(src("src/lib/noor.ts")).toContain(`const REVIEW_MODEL = "${ESTIMATE_MODELS.review}";`);
    expect(src("src/lib/noor.ts").match(/model: REVIEW_MODEL,/g)?.length).toBe(2);
    expect(src("src/lib/judge.ts")).toContain(`model: "${ESTIMATE_MODELS.judge}"`);
    expect(src("src/lib/onboard.ts")).toContain(`model: "${ESTIMATE_MODELS.onboard}"`);
    expect(src("src/lib/media/prompts.ts")).toContain(`model: "${ESTIMATE_MODELS.mediaPrompt}"`);
  });

  it("every assumed model has its own rate: costUsd would otherwise price it as Opus without saying so", () => {
    for (const [role, model] of Object.entries(ESTIMATE_MODELS)) expect(hasRate(model), `${role}: ${model}`).toBe(true);
    expect(hasRate("claude-unknown-9")).toBe(false);
    expect(hasRate("constructor")).toBe(false);
  });
});

describe("added-brand onboarding covers its cost (rules 241, 246)", () => {
  it("9 credits at the ceiling cover one onboarding run (≈ $0.45 on Opus 5.5; $0.57 on Opus 5)", () => {
    expect(ONBOARD_EXTRA_BRAND_COST).toBe(9);
    expect(onboardEstimateUsd()).toBeCloseTo(0.454, 6);
    expect(ONBOARD_EXTRA_BRAND_COST * ceiling).toBeGreaterThanOrEqual(onboardEstimateUsd());
    expect(ASSUME.onboard).toEqual({ in: 13500, out: 20000 });
  });
});

describe("chat drafts (rules 241, 250)", () => {
  const rows = DRAFT_TYPES.flatMap((t) => ([1, 2, 3] as const).map((n) => estimateDraft(t, n)));

  it("drafts are charged by the chat's formula: the batch price pro rata, at least 1", () => {
    expect([...DRAFT_TYPES]).toEqual(["social", "whatsapp", "ads", "gbp"]);
    for (const t of DRAFT_TYPES) expect([1, 2, 3].map((n) => draftCredits(t, n)), t).toEqual([1, 2, 3]);
    // The estimate uses the same formula as the chat's draft_items charge: the tool passes `count` to generateBatch
    // (src/lib/chat.ts), which charges `countCost` (src/lib/generate-batch.ts).
    for (const t of TASK_TYPES) expect([1, 2, 3].map((n) => countCost(t, n)), t).toEqual([1, 2, 3].map((n) => draftCredits(t, n)));
    expect(src("src/lib/generate-batch.ts").replace(/\s+/g, "")).toContain("Math.max(1,Math.ceil((TASK_COST[type]/(TASK_COUNT[type]||1))*count))");
    expect(src("src/lib/generate-batch.ts").replace(/\s+/g, "")).toContain("constcost=opts.count?countCost(type,opts.count):TASK_COST[type];");
    expect(src("src/lib/chat.ts").replace(/\s+/g, "")).toContain('generateBatch(user,email,{type,notes:String(input.brief??""),count,');
  });

  it("every draft keeps the floor, one-item drafts included (no exemption since 2026-10-09)", () => {
    expect(rows.filter((e) => e.usdPerCredit > ceiling).map((e) => `${e.type} x${e.items}: ${usd(e.usdPerCredit)} per credit`)).toEqual([]);
    for (const t of DRAFT_TYPES) expect(estimateDraft(t, 1).usdPerCredit, t).toBeCloseTo(0.06045, 6);
  });

  function src(path: string) {
    return readFileSync(path, "utf8");
  }
});

describe("media renders are under the ceiling too (rule 241)", () => {
  it("every model's list cost plus its prompt, per credit, is at or under the ceiling; vid-cinematic is the highest", () => {
    const per = MEDIA_MODELS.map((m) => ({ id: m.id, usdPerCredit: (COST_USD[m.id] + mediaPromptUsd()) / m.credits }));
    expect(per.filter((r) => r.usdPerCredit > ceiling).map((r) => `${r.id}: ${usd(r.usdPerCredit)}`)).toEqual([]);
    const top = per.reduce((a, b) => (b.usdPerCredit > a.usdPerCredit ? b : a));
    expect(top.id).toBe("vid-cinematic");
    expect(top.usdPerCredit).toBeCloseTo(0.0583542, 6);
  });
});

describe("X reads are under the ceiling too (rule 745)", () => {
  it("an X refresh costs less than one credit, with and without VAT (745)", () => {
    // One user read and at most X_MAX_POSTS posts, at X's list prices on 2026-10-08 (docs/system/costs.md 3.2).
    const usd = (X_READ_USD.user + X_MAX_POSTS * X_READ_USD.post) / X_READ_CREDITS;
    expect(usd).toBeCloseTo(0.06, 6);
    expect(usd).toBeLessThanOrEqual(maxCostPerCreditUsd());
    expect(usd).toBeLessThanOrEqual(maxCostPerCreditUsd(undefined, undefined, true));
    expect(X_READ_CREDITS).toBe(1);
    expect(X_MAX_POSTS).toBeGreaterThanOrEqual(5);
    expect(X_MAX_POSTS).toBeLessThanOrEqual(10);
  });
});
