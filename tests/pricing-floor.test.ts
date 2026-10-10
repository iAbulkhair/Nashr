import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHAT_ALLOWANCE, CHAT_TURN_MAX_USD, MARGIN_FLOOR, ONBOARD_EXTRA_BRAND_COST, PLAN_CREDITS, PLAN_PRICE_SAR, PRICES_INCLUDE_VAT, SELF_SERVE_PLANS as SELF_SERVE,
  cheapestCreditUsd, creditRevenueUsd, maxCostPerCreditUsd,
} from "@/lib/pricing";
import { TASK_MODELS } from "@/lib/task-models";
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
 * costs $0.0605, under the ceiling, so every draft now keeps the floor with no exemption. Since rule 901 (the same day)
 * whatsapp and gbp are written by Sonnet 5.5: their one-item draft is $0.0426; social and ads stay on Opus 5.5.
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

  it("the phase-1 repricing stands: weekly_plan 2, weekly_report 3, followup_seq 4 (the old prices would keep the floor since rule 901)", () => {
    expect([TASK_COST.weekly_plan, TASK_COST.weekly_report, TASK_COST.followup_seq]).toEqual([2, 3, 4]);
    const old = [
      estimateBatch("weekly_plan", { credits: 1, cache: "hit" }),
      estimateBatch("followup_seq", { credits: 3, cache: "hit" }),
      estimateBatch("weekly_report", { credits: 2, cache: "cold" }),
    ];
    // They were $0.0893, $0.0888 and $0.0918 on Opus 5 and $0.0753, $0.0751 and $0.0773 on Opus 5.5, all over the ceiling.
    // Since rule 901 Sonnet 5.5 writes all three, and the old prices would keep the floor: lowering them is a pricing
    // decision, not a margin one, so the prices stay and this pins where they would land.
    expect(old.map((e) => e.usdPerCredit)).toEqual([expect.closeTo(0.0519, 6), expect.closeTo(0.0493, 6), expect.closeTo(0.048175, 6)]);
    for (const e of old) expect(e.usdPerCredit, `${e.type} at ${e.credits}`).toBeLessThanOrEqual(ceiling);
  });

  it("today's figures (each type's own writer, rule 901): weekly_plan $0.0260 on a hit and $0.0346 cold, article $0.0396, unit_economics $0.0395", () => {
    // Sonnet 5.5 writes these.
    expect(estimateBatch("weekly_plan").usdPerCredit).toBeCloseTo(0.02595, 6);
    expect(estimateBatch("weekly_plan", { cache: "cold" }).usdPerCredit).toBeCloseTo(0.034575, 6);
    expect(estimateBatch("followup_seq").usdPerCredit).toBeCloseTo(0.036975, 6);
    expect(estimateBatch("article").usdPerCredit).toBeCloseTo(0.03955, 6);
    expect(estimateBatch("weekly_report", { cache: "cold" }).usdPerCredit).toBeCloseTo(0.0321167, 6);
    expect(estimateBatch("cart_recovery").usdPerCredit).toBeCloseTo(0.02305, 6);
    // Opus 5.5 writes these.
    expect(estimateBatch("unit_economics").usdPerCredit).toBeCloseTo(0.0395, 6);
    expect(estimateBatch("decision_memo", { cache: "cold" }).usdPerCredit).toBeCloseTo(0.0515, 6);
  });

  it("the watch list: no type is above 95% of the ceiling; article is the closest", () => {
    const rows = TASK_TYPES.map(gate);
    expect(rows.filter((e) => e.usdPerCredit > 0.95 * ceiling).map((e) => e.type)).toEqual([]);
    expect(rows.reduce((a, b) => (b.usdPerCredit > a.usdPerCredit ? b : a)).type).toBe("article");
  });

  it("a price cut fails the floor: Business at 549 SAR puts article over (599 does not)", () => {
    expect(estimateBatch("article").usdPerCredit).toBeLessThan(maxCostPerCreditUsd({ ...PLAN_PRICE_SAR, business: 599 }));
    const cut = maxCostPerCreditUsd({ ...PLAN_PRICE_SAR, business: 549 });
    expect(estimateBatch("article").usdPerCredit).toBeGreaterThan(cut);
  });

  it("more credits for the money fail it too: Business at 2,700 credits puts article over (2,500 does not)", () => {
    expect(estimateBatch("article").usdPerCredit).toBeLessThan(maxCostPerCreditUsd(undefined, { ...PLAN_CREDITS, business: 2500 }));
    expect(estimateBatch("article").usdPerCredit).toBeGreaterThan(maxCostPerCreditUsd(undefined, { ...PLAN_CREDITS, business: 2700 }));
  });

  it("VAT-inclusive prices (ceiling $0.0618) keep the floor for every type; article is the closest, at about 64% of it", () => {
    const vat = maxCostPerCreditUsd(undefined, undefined, true);
    expect(TASK_TYPES.map(gate).filter((e) => e.usdPerCredit > vat).map((e) => e.type)).toEqual([]);
    expect(estimateBatch("article").usdPerCredit / vat).toBeCloseTo(0.64, 2);
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

  it("it leaves no type to a login's Run since rule 901; the dearest cold types are at about 72% of the ceiling", () => {
    // followup_seq left the list on 2026-10-09 on Opus 5.5 ($0.0653 cold), article the same day when Sonnet 5.5 took it
    // over ($0.0773 cold on Opus 5.5, $0.0482 now).
    expect(HANDOFF_TYPES.filter((t) => !AUTO_TYPES.includes(t))).toEqual([]);
    expect(estimateBatch("article", { cache: "cold" }).usdPerCredit).toBeCloseTo(0.048175, 6);
    const dearest = Math.max(...HANDOFF_TYPES.map((t) => estimateBatch(t, { cache: "cold" }).usdPerCredit));
    expect(dearest).toBeCloseTo(0.0515, 6);
    expect(dearest / ceiling).toBeCloseTo(0.725, 2);
  });
});

describe("the estimates price the models the code calls (rule 241)", () => {
  const src = (p: string) => readFileSync(p, "utf8");

  it("each call site sends route(purpose).model for its own purpose", () => {
    // That the estimates price exactly the routing's defaults (`ESTIMATE_MODELS`) is pinned once, in tests/model-route.test.ts.
    // The calls: no literal (tests/model-route-calls.test.ts scans all of src), each site asks for its own purpose; that
    // test also runs every site and checks the model each request really carries, so the source pins below stay few.
    const noor = src("src/lib/noor.ts");
    // Since rule 901 the writer and the reviewer (`critique`) are per task type: routing reads TASK_MODELS with the type.
    expect(noor).toContain('model: opts.model ?? route("generate", { task: type }).model,');
    expect(noor).toContain('const serverFallback = params.model === automaticFor("generate", type);');
    // The reviewer asks for "review" with its type; the cross-agent review asks once for "xreview" and both reviewers use it.
    expect(noor.match(/model: route\("review", \{ task: type \}\)\.model,/g)?.length).toBe(1);
    expect(noor.match(/const model = route\("xreview"\)\.model;/g)?.length).toBe(1);
    expect(src("src/lib/judge.ts")).toContain('model: route("judge", { generatedBy: ctx.generatedBy, task: type }).model,');
    // Onboarding asks once; its three parts and a retry run on the same model.
    expect(src("src/lib/onboard.ts")).toContain('const model = route("onboard").model;');
    expect(src("src/lib/media/prompts.ts")).toContain('model: route("imagePrompt").model,');
    expect(src("src/app/api/tools/[tool]/route.ts")).toContain('model: route("tool").model,');
    expect(src("src/lib/secretary-meeting.ts")).toContain('model: route("meeting").model,');
  });

  it("estimateBatch prices each type's own writer and reviewer, the models routing runs with no pick (rule 901)", () => {
    for (const t of TASK_TYPES) {
      expect(route("generate", { task: t }).model, t).toBe(TASK_MODELS[t].write);
      expect(route("review", { task: t }).model, t).toBe(TASK_MODELS[t].review);
      const e = estimateBatch(t, { cache: "cold" });
      expect(e.generateUsd, t).toBe(estimateBatch(t, { cache: "cold", model: TASK_MODELS[t].write }).generateUsd);
    }
  });

  it("the cross-agent review runs on a model no dearer than any type's reviewer on every bucket", () => {
    // `estimateBatch` does not add the cross-review; its cost is worked out by hand at the reviewer's rates (docs/system/costs.md,
    // the `xreview` table, every row under the ceiling). A dearer `DEFAULTS.xreview` would make that table wrong without a test failing.
    const xreview = modelById(route("xreview").model)!;
    for (const t of TASK_TYPES) {
      const est = modelById(TASK_MODELS[t].review)!.rate;
      for (const b of ["in", "out", "cacheRead", "cacheWrite"] as const) expect(xreview.rate[b], `${t}: ${xreview.id} ${b}`).toBeLessThanOrEqual(est[b]);
    }
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
    for (const [type, m] of Object.entries(TASK_MODELS)) for (const model of [m.write, m.review]) expect(hasRate(model), `${type}: ${model}`).toBe(true);
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
    expect(src("src/lib/generate-batch.ts").replace(/\s+/g, "")).toContain('constcost=creditsFor(base,model,"generate",type);');
    expect(src("src/lib/chat.ts").replace(/\s+/g, "")).toContain('generateBatch(user,email,{type,notes:String(input.brief??""),count,');
  });

  it("every draft keeps the floor, one-item drafts included (no exemption since 2026-10-09)", () => {
    expect(rows.filter((e) => e.usdPerCredit > ceiling).map((e) => `${e.type} x${e.items}: ${usd(e.usdPerCredit)} per credit`)).toEqual([]);
    // Opus 5.5 writes social and ads, Sonnet 5.5 whatsapp and gbp (rule 901).
    expect(DRAFT_TYPES.map((t) => [t, estimateDraft(t, 1).usdPerCredit])).toEqual([["social", expect.closeTo(0.06045, 6)], ["whatsapp", expect.closeTo(0.04255, 6)], ["ads", expect.closeTo(0.06045, 6)], ["gbp", expect.closeTo(0.04255, 6)]]);
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
 * model is charged its base credits times that model's tier multiplier, relative to the TYPE's own writer (rule 902,
 * 2026-10-10: `TASK_MODELS[type].write`, so Automatic is always x1; Opus 5.5 on a Sonnet-written type x2, Sonnet 5.5 on
 * an Opus-written type x0.5; src/lib/models/credits.ts). The cost per CHARGED credit (after rounding up, at least 1) must
 * keep the floor for every catalog model that routing or a customer may use (`auto` or `pick`), on every task type the
 * model allows (`tasks`; unset means all). Every model is checked on a COLD cache, the dearest case (`estimateFor`), with
 * no exemption: the article exemption on the old single default (Opus) ended with rule 901, which moved article to Sonnet.
 *
 * When a model misses the floor on a type, the fix is its `tasks` allow-list in src/lib/models/catalog.ts, never a lower
 * floor.
 */
const pickable = MODELS.filter((m) => m.auto || m.pick);
const charged = (type: TaskType, model: string) => creditsFor(TASK_COST[type], model, "generate", type);
const perCredit = (type: TaskType, model: string) => estimateFor(type, model) / charged(type, model);

describe("every catalog model keeps the floor on every task type it allows, per charged credit, cold (rule 241 by tier, rule 902)", () => {
  it("the catalog models routing or a customer may use are the three current Claude models (rule 809; the spike adds the rest)", () => {
    expect(pickable.map((m) => m.id).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  });

  it("no model costs more per charged credit than the ceiling on any type it allows, on a cold cache", () => {
    const over: string[] = [];
    for (const m of pickable) {
      for (const t of TASK_TYPES.filter((t) => modelAllowsTask(m, t))) {
        const pc = perCredit(t, m.id);
        if (pc > ceiling) over.push(`${m.id} on ${t}: ${usd(pc)} per credit cold at ${charged(t, m.id)} credits (ceiling ${usd(ceiling)})`);
      }
    }
    expect(over).toEqual([]);
  });

  it("Automatic is x1 on every type: the type's own writer is charged today's TASK_COST, so no customer price moves", () => {
    for (const t of TASK_TYPES) {
      expect(route("generate", { task: t }).model, t).toBe(TASK_MODELS[t].write);
      expect(tierMultiplier(TASK_MODELS[t].write, "generate", t), t).toBe(1);
      expect(charged(t, TASK_MODELS[t].write), t).toBe(TASK_COST[t]);
      // The writer may run its own type: an allow-list that left it out would make the task_not_allowed fallback refuse too.
      expect(modelAllowsTask(modelById(TASK_MODELS[t].write)!, t), t).toBe(true);
    }
  });

  it("a pick is priced against the type's writer: Opus on a Sonnet type x2, Sonnet on an Opus type x0.5, the same model x1", () => {
    const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5-5";
    for (const t of TASK_TYPES) {
      const w = TASK_MODELS[t].write;
      expect(tierMultiplier(OPUS, "generate", t), t).toBe(w === OPUS ? 1 : 2);
      expect(tierMultiplier(SONNET, "generate", t), t).toBe(w === SONNET ? 1 : 0.5);
    }
    // Rounded up as before: article (2, Sonnet-written) on Opus is 4; unit_economics (4, Opus-written) on Sonnet is 2.
    expect([charged("article", OPUS), charged("unit_economics", SONNET), charged("social", SONNET)]).toEqual([4, 2, 5]);
    // Without a task (chat, and any caller that names none) the old reference stands: PRICED_AT.generate.
    expect(tierMultiplier(SONNET, "generate")).toBe(0.5);
    expect(PRICED_AT.generate).toBe(OPUS);
  });

  it("every catalog id customers may pick is in the set checked here (the auto-run's floor check relies on it)", () => {
    const picks = MODELS.filter((m) => m.pick).map((m) => m.id);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.filter((id) => !pickable.some((m) => m.id === id))).toEqual([]);
  });

  /**
   * Majed's auto-run checks the floor on the type's automatic writer (`autoUnderFloor`, src/lib/handoffs.ts), while the
   * batch it starts runs on the brand's pick when route() accepts it, and on the automatic writer otherwise (a pick not
   * allowed for the type falls back, `task_not_allowed`). That is safe only while the automatic check is never looser than
   * a pick's: every type it lets through keeps the floor cold on every pickable model that allows the type.
   */
  it("the auto-run's check on the automatic writer is never looser than a brand pick: what it lets through keeps the floor cold on every pick", () => {
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

  it("no pickable model has an allow-list today but Haiku 5.5, which writes no task and no customer can pick", () => {
    expect(pickable.filter((m) => m.tasks).map((m) => [m.id, [...m.tasks!]])).toEqual([["claude-haiku-5-5", []]]);
  });

  it("an allow-list names only real task types, and is empty only on a model no customer can pick", () => {
    for (const m of MODELS) {
      if (!m.tasks) continue;
      if (m.pick) expect(m.tasks.length, m.id).toBeGreaterThan(0);
      expect(m.tasks.filter((t) => !isTaskType(t)), m.id).toEqual([]);
      expect(new Set(m.tasks).size, m.id).toBe(m.tasks.length);
    }
  });

  it("the floor divides by the CHARGED credits: a 2-credit Opus-written type at x0.5 would be charged 1 (none exists; the 2-credit types are Sonnet-written)", () => {
    const twos = TASK_TYPES.filter((t) => TASK_COST[t] === 2);
    expect(twos.length).toBeGreaterThan(0);
    for (const t of twos) expect(TASK_MODELS[t].write, t).toBe("claude-sonnet-5-5");
    expect(creditsFor(2, "claude-sonnet-5-5", "generate", "unit_economics")).toBe(1);
    expect(creditsFor(1, "claude-sonnet-5-5", "generate", "unit_economics")).toBe(1);
  });

  it("today's dearest figures cold: Sonnet 5.5 $0.0482, Opus 5.5 $0.0515 per charged credit (about 68% and 72% of the ceiling)", () => {
    const max = (id: string) => Math.max(...TASK_TYPES.filter((t) => modelAllowsTask(MODELS.find((m) => m.id === id)!, t)).map((t) => perCredit(t, id)));
    expect(max("claude-sonnet-5-5")).toBeCloseTo(0.04817, 4);
    expect(max("claude-opus-5-5")).toBeCloseTo(0.0515, 4);
  });

  it("the watch list on picks: no model is above 95% of the ceiling cold on any type", () => {
    const near = pickable.flatMap((m) => TASK_TYPES.filter((t) => modelAllowsTask(m, t) && perCredit(t, m.id) > 0.95 * ceiling).map((t) => `${m.id}:${t}`));
    expect(near).toEqual([]);
  });

  it("chat drafts on a model other than the type's writer keep the floor cold at every size, with no exemption", () => {
    const over: string[] = [];
    for (const m of pickable) {
      for (const t of DRAFT_TYPES.filter((t) => modelAllowsTask(m, t) && TASK_MODELS[t].write !== m.id)) {
        for (const n of [1, 2, 3]) {
          const c = creditsFor(draftCredits(t, n), m.id, "generate", t);
          const e = estimateBatch(t, { items: n, credits: c, cache: "cold", model: m.id });
          if (e.usdPerCredit > ceiling) over.push(`${m.id} ${t} x${n}: ${usd(e.usdPerCredit)} per credit at ${c}`);
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
 * the memory at the cap. On 2026-10-10 Reem B2b and B3 (the free_slots tool and two help entries, which every agent
 * carries) made it 65,974 to 73,956 and 108,893 to 116,875: at the cap a full thread now keeps only the newest message. The pinned figures use round sizes just above the live maxima (P_EMPTY, P_CAP, V), so
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
  const P_EMPTY = 74_000, P_CAP = 117_000, V = 1_000;
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
      ["claude-sonnet-5-5", 6132, 16],
      ["claude-opus-5-5", 6132, 16],
    ]);
  });

  it("pinned at P_CAP: Automatic and Opus 5.5 drop all but the newest message and still answer", () => {
    const row = (model: string) => { const f = fit(model, P_CAP); return [model, f.maxTokens, f.messages.length]; };
    expect(chatModels.map((m) => row(m.id))).toEqual([
      ["claude-sonnet-5-5", 4081, 1],
      ["claude-opus-5-5", 4081, 1],
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
