import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHAT_ALLOWANCE, CHAT_TURN_MAX_USD, MARGIN_FLOOR, ONBOARD_EXTRA_BRAND_COST, PLAN_CREDITS, PLAN_PRICE_SAR, PRICES_INCLUDE_VAT, SELF_SERVE_PLANS as SELF_SERVE,
  cheapestCreditUsd, creditRevenueUsd, maxCostPerCreditUsd,
} from "@/lib/pricing";
import { ASSUME, ESTIMATE_MODELS, ITEM_SIZE, draftCredits, estimateBatch, estimateDraft, estimateFor, mediaPromptUsd, onboardEstimateUsd } from "@/lib/task-costs";
import { DRAFT_TYPES, TASK_COST, TASK_COUNT, TASK_TYPES, isTaskType, type TaskType } from "@/lib/tasks";
import { costUsd, hasRate } from "@/lib/usage";
import { ROUTINES } from "@/lib/routines";
import { countCost } from "@/lib/generate-batch";
import { MEDIA_MODELS } from "@/lib/media-catalog";
import { COST_USD } from "@/lib/media/config";
import { HANDOFF_TYPES, autoBlock, autoUnderFloor, type Handoff } from "@/lib/handoffs";
import { AGENTS, agentForTask } from "@/lib/agents";
import { MODELS, modelAllowsTask, modelById } from "@/lib/models/catalog";
import { route } from "@/lib/models/route";
import { PRICED_AT } from "@/lib/models/tiers";
import { chatHoldFor, chatTurnMaxUsd, chatUnitsFor, creditsFor, tierMultiplier } from "@/lib/models/credits";
import { CHAT_FIRST_MIN_OUT, CHAT_HISTORY_MAX_CHARS, CHAT_HISTORY_MAX_MSGS, CHAT_MIN_OUT, fitFirstCall } from "@/lib/chat-budget";
import { system, toolsFor } from "@/lib/chat";
import { CORE_FILES, memoryBlock, writeFile } from "@/lib/files";
import { db } from "@/lib/db";
import type { Brand } from "@/lib/brand";
import { newUser } from "./helpers/session";
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

  it("each call site sends route(purpose).model for its own purpose", () => {
    // That the estimates price exactly the routing's defaults (`ESTIMATE_MODELS`) is pinned once, in tests/model-route.test.ts.
    // The calls: no literal (tests/model-route-calls.test.ts scans all of src), each site asks for its own purpose; that
    // test also runs every site and checks the model each request really carries, so the source pins below stay few.
    const noor = src("src/lib/noor.ts");
    expect(noor).toContain('model: opts.model ?? route("generate").model,');
    // The reviewer (`critique`) asks for "review"; the cross-agent review asks once for "xreview" and both reviewers use it.
    expect(noor.match(/model: route\("review"\)\.model,/g)?.length).toBe(1);
    expect(noor.match(/const model = route\("xreview"\)\.model;/g)?.length).toBe(1);
    expect(src("src/lib/judge.ts")).toContain('model: route("judge", { generatedBy: ctx.generatedBy }).model,');
    // Onboarding asks once; its three parts and a retry run on the same model.
    expect(src("src/lib/onboard.ts")).toContain('const model = route("onboard").model;');
    expect(src("src/lib/media/prompts.ts")).toContain('model: route("imagePrompt").model,');
    expect(src("src/app/api/tools/[tool]/route.ts")).toContain('model: route("tool").model,');
  });

  it("the cross-agent review runs on a model no dearer than the estimate's reviewer on every bucket", () => {
    // `estimateBatch` does not add the cross-review; its cost is worked out by hand at the reviewer's rates (docs/system/costs.md,
    // the `xreview` table, every row under the ceiling). A dearer `DEFAULTS.xreview` would make that table wrong without a test failing.
    const est = modelById(ESTIMATE_MODELS.review)!.rate;
    const xreview = modelById(route("xreview").model)!;
    for (const b of ["in", "out", "cacheRead", "cacheWrite"] as const) expect(xreview.rate[b], `${xreview.id} ${b}`).toBeLessThanOrEqual(est[b]);
  });

  it("whichever model generated the batch, the judge the routing picks costs no more than the estimate's judge on every bucket", () => {
    const est = modelById(ESTIMATE_MODELS.judge)!.rate;
    const buckets = ["in", "out", "cacheRead", "cacheWrite"] as const;
    for (const generatedBy of [undefined, ...MODELS.map((m) => m.id)]) {
      const picked = modelById(route("judge", { generatedBy }).model)!;
      for (const b of buckets) expect(picked.rate[b], `${String(generatedBy)}: ${picked.id} ${b}`).toBeLessThanOrEqual(est[b]);
    }
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
    // The base is the batch's or the draft's share; the charge is that base at the batch model's tier (rule 241 by tier, below).
    expect(src("src/lib/generate-batch.ts").replace(/\s+/g, "")).toContain("constbase=opts.count?countCost(type,opts.count):TASK_COST[type];");
    expect(src("src/lib/generate-batch.ts").replace(/\s+/g, "")).toContain('constcost=creditsFor(base,model,"generate");');
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

/**
 * Rule 241 over the model catalog (spec 2026-10-08-straitly-model-routing, section 6; plan Task 4). A task run on another
 * model is charged its base credits times that model's tier multiplier, relative to the generation default
 * (`PRICED_AT.generate`, Opus 5.5 since 2026-10-09: x1; a standard model x0.5; an economy one x0.3; src/lib/models/credits.ts). The cost per
 * CHARGED credit (after rounding up, at least 1) must keep the floor for every catalog model that routing or a customer may
 * use (`auto` or `pick`), on every task type the model allows (`tasks`; unset means all). Every model is checked on a COLD
 * cache, the dearest case (`estimateFor`), with no exemption but the one below.
 *
 * When a model misses the floor on a type, the fix is its `tasks` allow-list in src/lib/models/catalog.ts, never a lower
 * floor (the Sonnets below).
 */
const pickable = MODELS.filter((m) => m.auto || m.pick);
const perCredit = (type: TaskType, model: string) => estimateFor(type, model) / creditsFor(TASK_COST[type], model, "generate");

/**
 * NAMED EXEMPTION (founder decision 2026-09-29, rules 241 and 296): on the generation default (Opus 5.5 since 2026-10-09),
 * article is over the ceiling on a cold cache. That is today's price, not a new one: an owner pressing Run finds the
 * cache warm (it keeps the floor on a hit, checked above and here), and Majed's auto-run, the only cron path that could
 * start it, leaves it to a login (`autoBlock`, rule 296). `maxColdUsdPerCredit` is today's cold figure: if it gets dearer
 * this test fails and the price must be decided again. No other model and no other type is exempt. followup_seq left the
 * exemption on 2026-10-09: $0.0773 cold on Opus 5, $0.0653 on Opus 5.5.
 */
const DEFAULT_MODEL_COLD_EXEMPTION = {
  model: PRICED_AT.generate,
  maxColdUsdPerCredit: { article: 0.0773 } as Partial<Record<TaskType, number>>,
  reason: "on-demand on a warm cache (hit) and kept off the auto-run, founder decision 2026-09-29",
} as const;
const exempt = (model: string, type: TaskType) => model === DEFAULT_MODEL_COLD_EXEMPTION.model && DEFAULT_MODEL_COLD_EXEMPTION.maxColdUsdPerCredit[type] !== undefined;

describe("every catalog model keeps the floor on every task type it allows, per charged credit, cold (rule 241 by tier)", () => {
  it("the catalog models routing or a customer may use are the three current Claude models (rule 809; the spike adds the rest)", () => {
    expect(pickable.map((m) => m.id).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  });

  it("no model costs more per charged credit than the ceiling on any type it allows, on a cold cache", () => {
    const over: string[] = [];
    for (const m of pickable) {
      for (const t of TASK_TYPES.filter((t) => modelAllowsTask(m, t))) {
        const pc = perCredit(t, m.id);
        if (pc > ceiling && !exempt(m.id, t)) over.push(`${m.id} on ${t}: ${usd(pc)} per credit cold at ${creditsFor(TASK_COST[t], m.id, "generate")} credits (ceiling ${usd(ceiling)})`);
      }
    }
    expect(over).toEqual([]);
  });

  it("every catalog id customers may pick is in the set checked here (the auto-run's floor check relies on it)", () => {
    const picks = MODELS.filter((m) => m.pick).map((m) => m.id);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.filter((id) => !pickable.some((m) => m.id === id))).toEqual([]);
  });

  /**
   * Majed's auto-run checks the floor on the generation default (`autoUnderFloor`, src/lib/handoffs.ts), while the batch
   * it starts runs on the brand's pick when route() accepts it, and on the default otherwise (a pick not allowed for the
   * type falls back, `task_not_allowed`). That is safe only while the default's check is never looser than a pick's:
   * every type it lets through keeps the floor cold on every pickable model that allows the type.
   */
  it("the auto-run's check on the default model is never looser than a brand pick: what it lets through keeps the floor cold on every pick", () => {
    const passed = TASK_TYPES.filter(autoUnderFloor);
    expect(passed.length).toBeGreaterThan(0);
    const over: string[] = [];
    for (const t of passed) {
      for (const m of MODELS.filter((x) => x.pick && modelAllowsTask(x, t))) {
        if (perCredit(t, m.id) > ceiling) over.push(`${m.id} on ${t}: ${usd(perCredit(t, m.id))} per credit cold`);
      }
    }
    expect(over).toEqual([]);
  });

  it("the default model's exemption: exactly article, at no more than today's cold figure, under on a hit", () => {
    const m = PRICED_AT.generate;
    const overCold = TASK_TYPES.filter((t) => perCredit(t, m) > ceiling);
    expect(overCold, "remove a type from the exemption once it keeps the floor cold").toEqual(Object.keys(DEFAULT_MODEL_COLD_EXEMPTION.maxColdUsdPerCredit));
    expect(overCold.map((t) => perCredit(t, m))).toEqual([expect.closeTo(0.07725, 6)]);
    for (const t of overCold) {
      expect(perCredit(t, m), `${t}: ${DEFAULT_MODEL_COLD_EXEMPTION.reason}`).toBeLessThanOrEqual(DEFAULT_MODEL_COLD_EXEMPTION.maxColdUsdPerCredit[t]!);
      expect(estimateBatch(t, { cache: "hit", model: m }).usdPerCredit, `${t} on a hit`).toBeLessThanOrEqual(ceiling);
    }
    // At x1 the charge is today's TASK_COST, so the default model's figures are today's (the tables above).
    for (const t of TASK_TYPES) expect(creditsFor(TASK_COST[t], m, "generate"), t).toBe(TASK_COST[t]);
  });

  it("the Sonnets run every type but article and followup_seq, which miss the floor at x0.5 even on a warm cache", () => {
    const rest = TASK_TYPES.filter((t) => t !== "article" && t !== "followup_seq");
    for (const id of ["claude-sonnet-5", "claude-sonnet-5-5"]) {
      const m = MODELS.find((x) => x.id === id)!;
      expect([...(m.tasks ?? [])].sort(), id).toEqual([...rest].sort());
      expect(TASK_TYPES.filter((t) => !modelAllowsTask(m, t)), id).toEqual(["article", "followup_seq"]);
      // Not vacuous: the two left out are over the ceiling cold and on a hit. Article is 1 credit at x0.5 and the reviewer
      // and the judge cost the same on any generation model.
      expect(["article", "followup_seq"].map((t) => perCredit(t as TaskType, id)), id).toEqual([expect.closeTo(0.09635, 6), expect.closeTo(0.082575, 6)]);
      const hit = (t: TaskType) => estimateBatch(t, { cache: "hit", model: id, credits: creditsFor(TASK_COST[t], id, "generate") }).usdPerCredit;
      expect([hit("article"), hit("followup_seq")], id).toEqual([expect.closeTo(0.0791, 6), expect.closeTo(0.07395, 6)]);
      for (const t of ["article", "followup_seq"] as const) expect(hit(t), `${id} ${t} on a hit`).toBeGreaterThan(ceiling);
    }
  });

  it("an allow-list names only real task types, and is empty only on a model no customer can pick (Haiku 5.5 writes no task)", () => {
    for (const m of MODELS) {
      if (!m.tasks) continue;
      if (m.pick) expect(m.tasks.length, m.id).toBeGreaterThan(0);
      expect(m.tasks.filter((t) => !isTaskType(t)), m.id).toEqual([]);
      expect(new Set(m.tasks).size, m.id).toBe(m.tasks.length);
    }
  });

  it("the floor divides by the CHARGED credits: a 2-credit type at x0.5 is charged 1, and its figure is per that 1", () => {
    for (const t of ["weekly_plan", "lead_qualifier", "dashboard_spec"] as const) {
      expect(TASK_COST[t], t).toBe(2);
      expect(creditsFor(TASK_COST[t], "claude-sonnet-5-5", "generate"), t).toBe(1);
      expect(perCredit(t, "claude-sonnet-5-5"), t).toBe(estimateFor(t, "claude-sonnet-5-5"));
    }
  });

  it("the watch list on the other models: only the three 2-credit medium types are above 95% of the ceiling cold (97%)", () => {
    const near = pickable.filter((m) => m.id !== PRICED_AT.generate).flatMap((m) => TASK_TYPES.filter((t) => modelAllowsTask(m, t) && perCredit(t, m.id) > 0.95 * ceiling).map((t) => `${m.id}:${t}`));
    expect(near.sort()).toEqual(["claude-sonnet-5-5:dashboard_spec", "claude-sonnet-5-5:lead_qualifier", "claude-sonnet-5-5:weekly_plan"]);
    expect(perCredit("weekly_plan", "claude-sonnet-5-5")).toBeCloseTo(0.06915, 6);
  });

  it("chat drafts on another model keep the floor cold at every size, with no exemption", () => {
    const over: string[] = [];
    for (const m of pickable.filter((x) => x.id !== PRICED_AT.generate)) {
      for (const t of DRAFT_TYPES.filter((t) => modelAllowsTask(m, t))) {
        for (const n of [1, 2, 3]) {
          const charged = creditsFor(draftCredits(t, n), m.id, "generate");
          const e = estimateBatch(t, { items: n, credits: charged, cache: "cold", model: m.id });
          if (e.usdPerCredit > ceiling) over.push(`${m.id} ${t} x${n}: ${usd(e.usdPerCredit)} per credit at ${charged}`);
        }
      }
    }
    expect(over).toEqual([]);
  });
});

/**
 * Rule 313 by tier: a message past the allowance needs `chatHoldFor(model)` credits in the balance and is billed its
 * metered cost at the floor rate, at most that hold. The hold must cover the model's own per-message ceiling
 * (`chatTurnMaxUsd`, CHAT_TURN_MAX_USD times the chat multiplier) at the floor rate, and be the smallest that does. What
 * that ceiling leaves for the answer on each model is the next describe block.
 */
describe("chat keeps the floor per tier: the hold covers each model's own ceiling (rule 313 by tier)", () => {
  // What chat can run on: a model a customer may pick that runs tools (the default, Sonnet 5.5, is one). Haiku 5.5 is
  // automatic for the short jobs only and never answers a chat message.
  const chatModels = MODELS.filter((m) => m.pick && m.caps.tools);

  it("each model's ceiling is CHAT_TURN_MAX_USD times its chat multiplier; the hold is the smallest that covers it", () => {
    for (const m of chatModels) {
      const max = chatTurnMaxUsd(m.id);
      expect(max / CHAT_TURN_MAX_USD, m.id).toBeCloseTo(tierMultiplier(m.id, "chat"), 12);
      const hold = chatHoldFor(m.id);
      expect(Number.isInteger(hold) && hold >= 1, m.id).toBe(true);
      expect(hold * ceiling, `${m.id}: the hold covers the ceiling at the floor rate`).toBeGreaterThanOrEqual(max);
      expect((hold - 1) * ceiling, `${m.id}: and is the smallest that does`).toBeLessThan(max);
    }
  });

  it("today's figures: Sonnet 5.5 $0.14 and 2 credits, Opus 5.5 $0.28 and 4", () => {
    expect(chatModels.map((m) => [m.id, chatTurnMaxUsd(m.id), chatHoldFor(m.id)])).toEqual([
      ["claude-sonnet-5-5", 0.14, 2],
      ["claude-opus-5-5", expect.closeTo(0.28, 12), 4],
    ]);
  });

  /**
   * The allowance by tier (coordinator ruling 2026-10-08, option a): a message counts `chatUnitsFor(model)` =
   * ceil(chat multiplier) messages, so each unit of the allowance carries at most CHAT_TURN_MAX_USD, the ceiling the plans'
   * allowances were priced at (costs.md section 4.1), whatever model the owner picks.
   */
  it("each allowance unit carries at most CHAT_TURN_MAX_USD on every chat model, with the fewest units that do", () => {
    for (const m of chatModels) {
      const units = chatUnitsFor(m.id);
      expect(Number.isSafeInteger(units) && units >= 1, m.id).toBe(true);
      expect(chatTurnMaxUsd(m.id) / units, `${m.id}: per unit`).toBeLessThanOrEqual(CHAT_TURN_MAX_USD + 1e-12);
      if (units > 1) expect(chatTurnMaxUsd(m.id) / (units - 1), `${m.id}: one unit fewer would not`).toBeGreaterThan(CHAT_TURN_MAX_USD);
    }
  });

  it("today's figures: per unit $0.14 on every model, a full allowance at 44% / 68% / 68% of net revenue (88% / 137% / 137% at one per Opus message)", () => {
    expect(chatModels.map((m) => [m.id, chatUnitsFor(m.id), chatTurnMaxUsd(m.id) / chatUnitsFor(m.id)])).toEqual([
      ["claude-sonnet-5-5", 1, 0.14],
      ["claude-opus-5-5", 2, expect.closeTo(0.14, 12)],
    ]);
    const worstPerUnit = Math.max(...chatModels.map((m) => chatTurnMaxUsd(m.id) / chatUnitsFor(m.id)));
    const opusPerMessage = chatTurnMaxUsd("claude-opus-5-5");
    const pct = (usdPerUnit: number) => Object.fromEntries(SELF_SERVE.map((p) => [p, Math.round(((CHAT_ALLOWANCE[p] * usdPerUnit) / (creditRevenueUsd(p) * PLAN_CREDITS[p])) * 100)]));
    expect(pct(worstPerUnit)).toEqual({ starter: 44, pro: 68, business: 68 });
    expect(pct(opusPerMessage), "the hole counting one unit per Opus message would have left").toEqual({ starter: 88, pro: 137, business: 137 });
  });
});

/**
 * Rule 313 by tier, what the ceiling leaves for the answer (final branch review, Important 1). Opus 5.5's ceiling is twice
 * Sonnet 5.5's ($0.28, founder-approved with x2 credits, 2 units and a hold of 4), and every Opus 5.5 rate but the cache
 * read is exactly twice Sonnet 5.5's (src/lib/models/catalog.ts; the cache read is the same $0.20), so an Opus 5.5
 * message has the same room as Automatic: 100%. Until 2026-10-09 the pick was Opus 5, every rate 2.5 times Sonnet 5.5's,
 * which left $0.112 of Sonnet-priced room (80%) and a LARGE_REPLY cliff at about 108,000 characters of prefix on six of
 * the eight agents with a full memory. The first call pays the cached prefix as a cache write (`fitFirstCall`,
 * src/lib/chat-budget.ts), so a large workspace takes the room first from the thread and then from the answer, and past
 * a size (the cliff below) the turn ends with LARGE_REPLY: no model call, given back and not counted (`settleChatTurn`
 * with usd 0, src/lib/chat-allowance.ts; rule 309).
 *
 * The sizes are the code's own, never estimates: the prefix and the volatile block are what chat() passes at
 * src/lib/chat.ts (`JSON.stringify(tools).length + sys[0] + sys[1]`, and `sys[2]`), built here by the real `system()` and
 * `toolsFor()` for every agent; "at the cap" is the 7 CORE_FILES each over MEMORY_BUDGET (6,000 characters, src/lib/files.ts)
 * plus the onboarding goal at `goalLine`'s 140; the thread is the history guard's cap, CHAT_HISTORY_MAX_MSGS messages
 * together CHAT_HISTORY_MAX_CHARS (src/lib/chat-budget.ts). docs/system/costs.md section 2 measures the batch prompt
 * (`systemPrompt`), not chat's, which carries the tool definitions and the chat rules on top: hence the larger figures.
 * On 2026-10-09 the live prefix was 63,029 to 71,575 characters on an empty workspace and 105,948 to 114,494 with
 * the memory at the cap. The pinned figures use round sizes just above the live maxima (P_EMPTY, P_CAP, V), so
 * preferences, a longer brand, feedback or handoff notes, which the live prompt here leaves out, are what moves a real
 * account toward the cliff; a larger volatile block or a longer newest message moves the cliff itself lower.
 */
describe("what each chat model's ceiling leaves for the answer, from the real chat prompt (rule 313 by tier)", () => {
  const chatModels = MODELS.filter((m) => m.pick && m.caps.tools);
  const OPUS = "claude-opus-5-5", AUTO = route("chat").model;
  const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
  // The history guard's cap: CHAT_HISTORY_MAX_MSGS messages of CHAT_HISTORY_MAX_CHARS / CHAT_HISTORY_MAX_MSGS = 1,500
  // characters each, the newest the owner's (chat() pushes it before the call).
  const per = CHAT_HISTORY_MAX_CHARS / CHAT_HISTORY_MAX_MSGS;
  const thread = Array.from({ length: CHAT_HISTORY_MAX_MSGS }, (_, i) => ({ role: (i % 2 ? "user" : "assistant") as "user" | "assistant", content: `${i}`.padEnd(per, "x") }));
  const newest = thread.slice(-1);
  const P_EMPTY = 72_000, P_CAP = 115_000, V = 1_000;
  const fit = (model: string, prefix: number, volatile = V, msgs = thread) => fitFirstCall(model, msgs, prefix, volatile);
  /** The largest prefix whose first call still gets CHAT_MIN_OUT with only the newest message: past it, LARGE_REPLY. */
  const cliff = (model: string) => {
    let lo = 0, hi = 1_000_000;
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (fit(model, mid, V, newest).maxTokens) lo = mid; else hi = mid; }
    return lo;
  };

  /** The live prefix and volatile sizes for every agent, as chat() computes them, on an empty and on a full workspace. */
  async function live() {
    const empty = await newUser("room-empty"), full = await newUser("room-cap");
    await Promise.all([...CORE_FILES.map((n) => writeFile(full.email, n, n.padEnd(6_001, "م"), "user")), db.set(`onboardplan:${full.email}`, { goal: "g".repeat(140), plan: [], at: "2026-10-09T00:00:00.000Z" })]);
    const [memEmpty, memFull] = await Promise.all([memoryBlock(empty.email), memoryBlock(full.email)]);
    expect(memEmpty).toBe("");
    expect(memFull.split("(showing the ").length - 1, "every core file is cut at the budget").toBe(CORE_FILES.length);
    const size = (u: typeof empty, memory: string, files: string[], id: (typeof AGENTS)[number]["id"]) => {
      const sys = system(brand, u, [], memory, files, [], id);
      return { prefix: JSON.stringify(toolsFor(id)).length + sys[0].text.length + sys[1].text.length, volatile: sys[2].text.length };
    };
    return AGENTS.map((a) => ({ id: a.id, empty: size(empty, memEmpty, [], a.id), cap: size(full, memFull, [...CORE_FILES], a.id) }));
  }

  it("Automatic is Sonnet 5.5; Opus 5.5's ceiling buys all of its room at x2 credits (Opus 5.5 is Sonnet 5.5 x 2 but for the cache read)", () => {
    expect(AUTO).toBe(PRICED_AT.chat);
    expect(AUTO).toBe("claude-sonnet-5-5");
    const same = { cache_creation_input_tokens: 1000, input_tokens: 1000, output_tokens: 1000 };
    expect(costUsd(OPUS, same) / costUsd(AUTO, same)).toBeCloseTo(2, 12);
    expect(chatTurnMaxUsd(OPUS) / 2 / chatTurnMaxUsd(AUTO)).toBeCloseTo(1, 12);
    expect(chatUnitsFor(OPUS)).toBe(2);
  });

  it("the live prompt: every agent's prefix and volatile block fit under the pinned sizes", async () => {
    const rows = await live();
    expect(rows.map((r) => r.id).sort()).toEqual(AGENTS.map((a) => a.id).sort());
    expect(Math.max(...rows.map((r) => r.empty.prefix)), "empty workspace").toBeLessThanOrEqual(P_EMPTY);
    expect(Math.max(...rows.map((r) => r.cap.prefix)), "memory at the cap").toBeLessThanOrEqual(P_CAP);
    expect(Math.max(...rows.flatMap((r) => [r.empty.volatile, r.cap.volatile])), "volatile block").toBeLessThanOrEqual(V);
  });

  it("empty workspace, full thread, live: every chat model's first call gets at least CHAT_FIRST_MIN_OUT on every agent", async () => {
    const short: string[] = [];
    for (const r of await live()) {
      for (const m of chatModels) {
        const f = fit(m.id, r.empty.prefix, r.empty.volatile);
        if (f.maxTokens < CHAT_FIRST_MIN_OUT) short.push(`${m.id} ${r.id}: ${f.maxTokens}`);
      }
    }
    expect(short).toEqual([]);
  });

  it("memory at the cap, full thread, live: every chat model, Opus 5.5 included, still gets CHAT_FIRST_MIN_OUT on every agent", async () => {
    const rows = await live();
    const short: string[] = [];
    for (const r of rows) for (const m of chatModels) if (fit(m.id, r.cap.prefix, r.cap.volatile).maxTokens < CHAT_FIRST_MIN_OUT) short.push(`${m.id} ${r.id}`);
    // Opus 5 ended six agents' turns with LARGE_REPLY here (dana, faris, layan, noor, razan, sami); Opus 5.5 ends none.
    // If this list stops being empty, update docs/system/costs.md section 4.1 and the rule's coverage file.
    expect(short).toEqual([]);
  });

  it("pinned at P_EMPTY: Automatic and Opus 5.5 keep the whole thread with room to spare", () => {
    const row = (model: string) => { const f = fit(model, P_EMPTY); return [model, f.maxTokens, f.messages.length]; };
    // [model, max_tokens of the first call, messages of the thread kept]
    expect(chatModels.map((m) => row(m.id))).toEqual([
      ["claude-sonnet-5-5", 6299, 16],
      ["claude-opus-5-5", 6299, 16],
    ]);
  });

  it("pinned at P_CAP: Automatic and Opus 5.5 drop the oldest messages and still answer", () => {
    const row = (model: string) => { const f = fit(model, P_CAP); return [model, f.maxTokens, f.messages.length]; };
    expect(chatModels.map((m) => row(m.id))).toEqual([
      ["claude-sonnet-5-5", 4043, 3],
      ["claude-opus-5-5", 4043, 3],
    ]);
  });

  it("the cliff: the largest prefix still answered with only the newest message (volatile V), exact, per chat model", () => {
    expect(Object.fromEntries(chatModels.map((m) => [m.id, cliff(m.id)]))).toEqual({ "claude-sonnet-5-5": 141_396, "claude-opus-5-5": 141_396 });
    const c = cliff(OPUS);
    expect(fit(OPUS, c, V, newest).maxTokens).toBe(CHAT_MIN_OUT);
    expect(fit(OPUS, c + 1, V, newest).maxTokens).toBe(0);
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
