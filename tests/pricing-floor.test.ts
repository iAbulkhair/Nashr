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
import { agentForTask } from "@/lib/agents";
import { MODELS, modelAllowsTask, modelById } from "@/lib/models/catalog";
import { route } from "@/lib/models/route";
import { PRICED_AT } from "@/lib/models/tiers";
import { chatHoldFor, chatTurnMaxUsd, chatUnitsFor, creditsFor, tierMultiplier } from "@/lib/models/credits";
import { CHAT_FIRST_MIN_OUT } from "@/lib/chat-budget";

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

  it("it leaves exactly article and followup_seq to a login's Run, the handoff types over the ceiling cold", () => {
    const left = HANDOFF_TYPES.filter((t) => !AUTO_TYPES.includes(t));
    expect(left).toEqual(["article", "followup_seq"]);
    expect(left.map((t) => estimateBatch(t, { cache: "cold" }).usdPerCredit)).toEqual([expect.closeTo(0.0917875, 6), expect.closeTo(0.0773438, 6)]);
    // On a hit (the owner pressing Run in the app) both keep the floor, as the table above checks them.
    for (const t of left) expect(estimateBatch(t).usdPerCredit, t).toBeLessThanOrEqual(ceiling);
  });
});

describe("the estimates price the models the code calls (rule 241)", () => {
  const src = (p: string) => readFileSync(p, "utf8");

  it("each call site sends route(purpose).model, and the estimates price exactly what route() resolves for that purpose", () => {
    // One table: the estimates read the routing's defaults, so a model change in route.ts moves the estimates with it.
    expect({ ...ESTIMATE_MODELS }).toEqual({
      generate: route("generate").model,
      review: route("review").model,
      judge: route("judge").model,
      onboard: route("onboard").model,
      mediaPrompt: route("imagePrompt").model,
    });
    // The calls: no literal, each site asks for its own purpose (tests/model-route-calls.test.ts runs them and checks what is sent).
    const noor = src("src/lib/noor.ts");
    expect(noor).toContain('model: opts.model ?? route("generate").model,');
    // The reviewer (`critique`) asks for "review"; the cross-agent review asks once for "xreview" and both reviewers use it.
    expect(noor.match(/model: route\("review"\)\.model,/g)?.length).toBe(1);
    expect(noor.match(/const model = route\("xreview"\)\.model;/g)?.length).toBe(1);
    expect(noor.match(/^\s+model,$/gm)?.length).toBe(1);
    expect(src("src/lib/judge.ts")).toContain('model: route("judge", { generatedBy: ctx.generatedBy }).model,');
    // Onboarding asks once; its three parts and a retry run on the same model.
    expect(src("src/lib/onboard.ts")).toContain('const model = route("onboard").model;');
    expect(src("src/lib/onboard.ts").match(/^\s+model,$/gm)?.length).toBe(1);
    expect(src("src/lib/media/prompts.ts")).toContain('model: route("imagePrompt").model,');
    expect(src("src/app/api/tools/[tool]/route.ts")).toContain('model: route("tool").model,');
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
    // The estimate uses the same formula as the chat's draft_items charge: the tool passes `count` to generateBatch
    // (src/lib/chat.ts), which charges `countCost` (src/lib/generate-batch.ts).
    for (const t of TASK_TYPES) expect([1, 2, 3].map((n) => countCost(t, n)), t).toEqual([1, 2, 3].map((n) => draftCredits(t, n)));
    expect(src("src/lib/generate-batch.ts").replace(/\s+/g, "")).toContain("Math.max(1,Math.ceil((TASK_COST[type]/(TASK_COUNT[type]||1))*count))");
    // The base is the batch's or the draft's share; the charge is that base at the batch model's tier (rule 241 by tier, below).
    expect(src("src/lib/generate-batch.ts").replace(/\s+/g, "")).toContain("constbase=opts.count?countCost(type,opts.count):TASK_COST[type];");
    expect(src("src/lib/generate-batch.ts").replace(/\s+/g, "")).toContain('constcost=creditsFor(base,model,"generate");');
    expect(src("src/lib/chat.ts").replace(/\s+/g, "")).toContain('generateBatch(user,email,{type,notes:String(input.brief??""),count,');
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
    expect(top.usdPerCredit).toBeCloseTo(0.05875, 5);
  });
});

/**
 * Rule 241 over the model catalog (spec 2026-10-08-straitly-model-routing, section 6; plan Task 4). A task run on another
 * model is charged its base credits times that model's tier multiplier, relative to the generation default
 * (`PRICED_AT.generate`, Opus 5: x1; a standard model x0.5; an economy one x0.3; src/lib/models/credits.ts). The cost per
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
 * NAMED EXEMPTION (founder decision 2026-09-29, rules 241 and 296): on the generation default (Opus 5), article and
 * followup_seq are over the ceiling on a cold cache. That is today's price, not a new one: an owner pressing Run finds the
 * cache warm (both keep the floor on a hit, checked above and here), and Majed's auto-run, the only cron path that could
 * start them, leaves both to a login (`autoBlock`, rule 296). `maxColdUsdPerCredit` is today's cold figure: if either
 * gets dearer this test fails and the price must be decided again. No other model and no other type is exempt.
 */
const DEFAULT_MODEL_COLD_EXEMPTION = {
  model: PRICED_AT.generate,
  maxColdUsdPerCredit: { article: 0.0918, followup_seq: 0.0774 } as Partial<Record<TaskType, number>>,
  reason: "on-demand on a warm cache (hit) and kept off the auto-run, founder decision 2026-09-29",
} as const;
const exempt = (model: string, type: TaskType) => model === DEFAULT_MODEL_COLD_EXEMPTION.model && DEFAULT_MODEL_COLD_EXEMPTION.maxColdUsdPerCredit[type] !== undefined;

describe("every catalog model keeps the floor on every task type it allows, per charged credit, cold (rule 241 by tier)", () => {
  it("the catalog models routing or a customer may use are the three Claude models (the spike adds the rest)", () => {
    expect(pickable.map((m) => m.id).sort()).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-sonnet-5-5"]);
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

  it("the default model's exemption: exactly article and followup_seq, at no more than today's cold figures, both under on a hit", () => {
    const m = PRICED_AT.generate;
    const overCold = TASK_TYPES.filter((t) => perCredit(t, m) > ceiling);
    expect(overCold, "remove a type from the exemption once it keeps the floor cold").toEqual(Object.keys(DEFAULT_MODEL_COLD_EXEMPTION.maxColdUsdPerCredit));
    expect(overCold.map((t) => perCredit(t, m))).toEqual([expect.closeTo(0.0917875, 6), expect.closeTo(0.0773438, 6)]);
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

  it("an allow-list names only real task types, never an empty list", () => {
    for (const m of MODELS) {
      if (!m.tasks) continue;
      expect(m.tasks.length, m.id).toBeGreaterThan(0);
      expect(m.tasks.filter((t) => !isTaskType(t)), m.id).toEqual([]);
      expect(new Set(m.tasks).size, m.id).toBe(m.tasks.length);
    }
  });

  it("the floor divides by the CHARGED credits: a 2-credit type at x0.5 is charged 1, and its figure is per that 1", () => {
    for (const t of ["weekly_plan", "lead_qualifier", "dashboard_spec"] as const) {
      expect(TASK_COST[t], t).toBe(2);
      expect(creditsFor(TASK_COST[t], "claude-sonnet-5", "generate"), t).toBe(1);
      expect(perCredit(t, "claude-sonnet-5"), t).toBe(estimateFor(t, "claude-sonnet-5"));
    }
  });

  it("the watch list on the other models: only the three 2-credit medium types are above 95% of the ceiling cold (97%)", () => {
    const near = pickable.filter((m) => m.id !== PRICED_AT.generate).flatMap((m) => TASK_TYPES.filter((t) => modelAllowsTask(m, t) && perCredit(t, m.id) > 0.95 * ceiling).map((t) => `${m.id}:${t}`));
    expect(near.sort()).toEqual(["claude-sonnet-5-5:dashboard_spec", "claude-sonnet-5-5:lead_qualifier", "claude-sonnet-5-5:weekly_plan", "claude-sonnet-5:dashboard_spec", "claude-sonnet-5:lead_qualifier", "claude-sonnet-5:weekly_plan"]);
    expect(perCredit("weekly_plan", "claude-sonnet-5")).toBeCloseTo(0.06915, 6);
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
 * (`chatTurnMaxUsd`, CHAT_TURN_MAX_USD times the chat multiplier) at the floor rate, and be the smallest that does; the
 * ceiling must still buy a useful first answer on that model.
 */
describe("chat keeps the floor per tier: the hold covers each model's own ceiling (rule 313 by tier)", () => {
  const chatModels = pickable.filter((m) => m.caps.tools);

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

  it("today's figures: the Sonnets $0.14 and 2 credits, Opus 5 $0.28 and 4", () => {
    expect(chatModels.map((m) => [m.id, chatTurnMaxUsd(m.id), chatHoldFor(m.id)])).toEqual([
      ["claude-opus-5", expect.closeTo(0.28, 12), 4],
      ["claude-sonnet-5", 0.14, 2],
      ["claude-sonnet-5-5", 0.14, 2],
    ]);
  });

  it("the ceiling buys every chat model a first answer of at least CHAT_FIRST_MIN_OUT tokens", () => {
    for (const m of chatModels) {
      const tokens = chatTurnMaxUsd(m.id) / costUsd(m.id, { output_tokens: 1 });
      expect(tokens, m.id).toBeGreaterThanOrEqual(CHAT_FIRST_MIN_OUT);
    }
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
      ["claude-opus-5", 2, expect.closeTo(0.14, 12)],
      ["claude-sonnet-5", 1, 0.14],
      ["claude-sonnet-5-5", 1, 0.14],
    ]);
    const worstPerUnit = Math.max(...chatModels.map((m) => chatTurnMaxUsd(m.id) / chatUnitsFor(m.id)));
    const opusPerMessage = chatTurnMaxUsd("claude-opus-5");
    const pct = (usdPerUnit: number) => Object.fromEntries(SELF_SERVE.map((p) => [p, Math.round(((CHAT_ALLOWANCE[p] * usdPerUnit) / (creditRevenueUsd(p) * PLAN_CREDITS[p])) * 100)]));
    expect(pct(worstPerUnit)).toEqual({ starter: 44, pro: 68, business: 68 });
    expect(pct(opusPerMessage), "the hole counting one unit per Opus message would have left").toEqual({ starter: 88, pro: 137, business: 137 });
  });
});
