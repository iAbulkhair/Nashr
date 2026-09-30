import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MARGIN_FLOOR, ONBOARD_EXTRA_BRAND_COST, PLAN_CREDITS, PLAN_PRICE_SAR, PRICES_INCLUDE_VAT, cheapestCreditUsd, creditRevenueUsd, maxCostPerCreditUsd,
} from "@/lib/pricing";
import { ASSUME, ESTIMATE_MODELS, ITEM_SIZE, draftCredits, estimateBatch, estimateDraft, mediaPromptUsd, onboardEstimateUsd } from "@/lib/task-costs";
import { DRAFT_TYPES, TASK_COST, TASK_COUNT, TASK_TYPES, type TaskType } from "@/lib/tasks";
import { hasRate } from "@/lib/usage";
import { ROUTINES } from "@/lib/routines";
import { MEDIA_MODELS } from "@/lib/media-catalog";
import { COST_USD } from "@/lib/media/config";

/**
 * Rule 241: the 60% margin floor is a test, not a comment. What one credit may cost us is at most 40% of the cheapest
 * self-serve credit (src/lib/pricing.ts: Business, 999 SAR / 3.75 / 1,500 = $0.1776, so $0.07104). Every task type's
 * estimated batch cost (src/lib/task-costs.ts: tokens priced by `costUsd`, so a rate change moves it) divided by its
 * TASK_COST must stay under that. A change to a price, a credit count, a task cost, a batch size or a model rate that
 * breaks the floor fails the build.
 *
 * Cache: an owner working in the app finds the workspace block cached, so on-demand types are checked on a cache hit.
 * The cron runs once a week or month per brand, so its cache is usually cold: the weekly plan and every routine's task
 * type (src/lib/routines.ts) are checked on a cold cache (founder decision, 2026-09-29).
 */
const ceiling = maxCostPerCreditUsd();
const CRON_TYPES: readonly TaskType[] = [...new Set<TaskType>(["weekly_plan", ...ROUTINES.map((r) => r.type)])];
const gate = (type: TaskType) => estimateBatch(type, { cache: CRON_TYPES.includes(type) ? "cold" : "hit" });
const usd = (n: number) => `$${n.toFixed(4)}`;

/**
 * NAMED EXEMPTION (founder decision, 2026-09-29): a one-item chat draft (`draft_items`, count 1) of social, whatsapp,
 * ads or gbp costs 1 credit and about $0.0717 in model calls, under 1% over the $0.0710 ceiling: the reviewer and the
 * judge run on one short item much as on a whole batch. It stays at 1 credit because "1 credit per item" is what the
 * owner is told for a small ask, and a one-item ask is how most owners try the product; the shortfall is under a tenth
 * of a cent per draft. `maxUsdPerCredit` is today's estimate: if these drafts get dearer (a rate, a longer item, a
 * bigger prompt), this test fails and the price or the exemption must be decided again. Two- and three-item drafts
 * are not exempt.
 */
const ONE_ITEM_DRAFT_EXEMPTION = {
  types: DRAFT_TYPES,
  count: 1,
  maxUsdPerCredit: 0.07165,
  reason: "1 credit per item is the promise for small chat asks; a one-item draft runs the full reviewer and judge",
} as const;

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
  it("the cron-driven types are the weekly plan and every routine's type", () => {
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
    expect(old.map((e) => e.usdPerCredit)).toEqual([expect.closeTo(0.08925, 6), expect.closeTo(0.08875, 6), expect.closeTo(0.0917875, 6)]);
    for (const e of old) expect(e.usdPerCredit, `${e.type} at ${e.credits}`).toBeGreaterThan(ceiling);
  });

  it("today's figures: weekly_plan $0.0446 on a hit and $0.0662 cold, followup_seq $0.0666, article $0.0702", () => {
    expect(estimateBatch("weekly_plan").usdPerCredit).toBeCloseTo(0.044625, 6);
    expect(estimateBatch("weekly_plan", { cache: "cold" }).usdPerCredit).toBeCloseTo(0.0661875, 6);
    expect(estimateBatch("followup_seq").usdPerCredit).toBeCloseTo(0.0665625, 6);
    expect(estimateBatch("article").usdPerCredit).toBeCloseTo(0.070225, 6);
    expect(estimateBatch("weekly_report", { cache: "cold" }).usdPerCredit).toBeCloseTo(0.0611917, 6);
    expect(estimateBatch("cart_recovery").usdPerCredit).toBeCloseTo(0.03975, 6);
  });

  it("the watch list: only article is above 95% of the ceiling", () => {
    const near = TASK_TYPES.map(gate).filter((e) => e.usdPerCredit > 0.95 * ceiling);
    expect(near.map((e) => e.type)).toEqual(["article"]);
  });

  it("a price cut fails the floor: Business at 899 SAR puts article over", () => {
    const cut = maxCostPerCreditUsd({ ...PLAN_PRICE_SAR, business: 899 });
    expect(estimateBatch("article").usdPerCredit).toBeGreaterThan(cut);
  });

  it("more credits for the money fail it too: Business at 1,700 credits puts article over", () => {
    expect(estimateBatch("article").usdPerCredit).toBeGreaterThan(maxCostPerCreditUsd(undefined, { ...PLAN_CREDITS, business: 1700 }));
  });

  it("VAT-inclusive prices (ceiling $0.0618) would fail article, followup_seq and the cold weekly plan: they must be repriced first", () => {
    const vat = maxCostPerCreditUsd(undefined, undefined, true);
    expect(TASK_TYPES.map(gate).filter((e) => e.usdPerCredit > vat).map((e) => e.type).sort()).toEqual(["article", "followup_seq", "weekly_plan"]);
  });
});

describe("the estimates price the models the code calls (rule 241)", () => {
  const src = (p: string) => readFileSync(p, "utf8");

  it("noor.ts, judge.ts, onboard.ts and media/prompts.ts call the models the estimates assume", () => {
    expect(src("src/lib/noor.ts")).toContain(`model: "${ESTIMATE_MODELS.generate}"`);
    expect(src("src/lib/noor.ts")).toContain(`model: "${ESTIMATE_MODELS.review}"`);
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
  it("9 credits at the ceiling cover one onboarding run (≈ $0.57)", () => {
    expect(ONBOARD_EXTRA_BRAND_COST).toBe(9);
    expect(onboardEstimateUsd()).toBeCloseTo(0.5675, 6);
    expect(ONBOARD_EXTRA_BRAND_COST * ceiling).toBeGreaterThanOrEqual(onboardEstimateUsd());
    expect(ASSUME.onboard).toEqual({ in: 13500, out: 20000 });
  });
});

describe("chat drafts (rules 241, 250)", () => {
  const rows = DRAFT_TYPES.flatMap((t) => ([1, 2, 3] as const).map((n) => estimateDraft(t, n)));

  it("drafts are charged by the chat's formula: the batch price pro rata, at least 1", () => {
    expect([...DRAFT_TYPES]).toEqual(["social", "whatsapp", "ads", "gbp"]);
    for (const t of DRAFT_TYPES) expect([1, 2, 3].map((n) => draftCredits(t, n)), t).toEqual([1, 2, 3]);
    // The estimate uses the same formula as the chat's draft_items charge (src/lib/chat.ts).
    expect(src().replace(/\s+/g, "")).toContain("Math.max(1,Math.ceil((TASK_COST[type]/(TASK_COUNT[type]||1))*count))");
  });

  it("only the named exemption is over the ceiling: one-item drafts, at no more than today's estimate", () => {
    const over = rows.filter((e) => e.usdPerCredit > ceiling);
    const exempt = (e: (typeof rows)[number]) => (ONE_ITEM_DRAFT_EXEMPTION.types as readonly TaskType[]).includes(e.type) && e.items === ONE_ITEM_DRAFT_EXEMPTION.count;
    expect(over.filter((e) => !exempt(e)).map((e) => `${e.type} x${e.items}: ${usd(e.usdPerCredit)} per credit`), "not exempt").toEqual([]);
    for (const e of over) {
      expect(e.usdPerCredit, `${e.type} x${e.items}: ${ONE_ITEM_DRAFT_EXEMPTION.reason}`).toBeLessThanOrEqual(ONE_ITEM_DRAFT_EXEMPTION.maxUsdPerCredit + 1e-9);
    }
    expect(over.map((e) => e.type), "the exemption is real today: remove it once it is no longer needed").toEqual([...DRAFT_TYPES]);
  });

  function src() {
    return readFileSync("src/lib/chat.ts", "utf8");
  }
});

describe("media renders are under the ceiling too (rule 241)", () => {
  it("every model's list cost plus its prompt, per credit, is at or under the ceiling; vid-cinematic is the highest", () => {
    const per = MEDIA_MODELS.map((m) => ({ id: m.id, usdPerCredit: (COST_USD[m.id] + mediaPromptUsd()) / m.credits }));
    expect(per.filter((r) => r.usdPerCredit > ceiling).map((r) => `${r.id}: ${usd(r.usdPerCredit)}`)).toEqual([]);
    const top = per.reduce((a, b) => (b.usdPerCredit > a.usdPerCredit ? b : a));
    expect(top.id).toBe("vid-cinematic");
    expect(top.usdPerCredit).toBeCloseTo(0.05875, 5);
  });
});
