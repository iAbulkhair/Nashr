import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { newUser, settle } from "./helpers/session";
import { getUser, saveUser, type User } from "@/lib/auth";
import { agentSpendFor } from "@/lib/credits";
import { db } from "@/lib/db";
import type { Brand } from "@/lib/brand";
import { PRICED_AT, TIER_MULTIPLIER, type Surface } from "@/lib/models/tiers";
import { MODELS, modelById, type ModelEntry } from "@/lib/models/catalog";
import { chatHoldFor, chatTurnMaxUsd, chatUnitsFor, creditsFor, tierMultiplier } from "@/lib/models/credits";
import { CHAT_TURN_MAX_USD, chatOverflowHold, maxCostPerCreditUsd } from "@/lib/pricing";
import { TASK_COST, TASK_TYPES } from "@/lib/tasks";
import { ESTIMATE_MODELS, estimateBatch, estimateFor } from "@/lib/task-costs";
import { CHAT_MODEL, type ChatTurn } from "@/lib/chat";
import { CHAT_MIN_OUT, nextMaxTokens } from "@/lib/chat-budget";
import { chatStatus, reserveChatTurn, runChatTurn, settleChatTurn } from "@/lib/chat-allowance";
import { chatCredKey, chatMsgKey, chatOverKey } from "@/lib/usage";

/**
 * Credits by tier (spec 2026-10-08-straitly-model-routing, section 6; plan Task 4). A task's credits and a chat message's
 * ceiling scale with the tier of the model that runs them, RELATIVE TO THE SURFACE'S DEFAULT MODEL (`PRICED_AT` in
 * src/lib/models/tiers.ts): the default model of each surface is x1, so today's prices do not move. Generation is priced
 * at Opus 5 (premium), so a standard model is x0.5 and an economy one x0.3; chat is priced at Sonnet 5.5 (standard), so
 * Opus 5 is x2 and an economy model x0.6. Money code: every amount is an integer of at least 1, an id that is not exactly
 * a catalog id never makes a task cheaper, and a refund gives back exactly what was charged.
 */

// Since 2026-10-09 (rule 809) only the 5.5 models can be picked or routed to; Opus 5 and Sonnet 5 stay for their rates.
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const SONNET55 = "claude-sonnet-5-5";
/** Not in the catalog: added by the mocked catalog below, so the economy tier is tested without editing `MODELS`. */
const ECONOMY: ModelEntry = {
  id: "test-economy-1",
  label: { ar: "نموذج اقتصادي تجريبي", en: "Test economy model" },
  vendor: "acme",
  hosting: "west",
  tier: "economy",
  dialect: "chat",
  caps: { tools: true, strict: false, thinking: false, cache: true, vision: false },
  rate: { in: 0.4, out: 2, cacheRead: 0.04, cacheWrite: 0.5 },
  auto: false,
  pick: true,
};
/** A catalog entry the routing may not offer (neither `auto` nor `pick`): internal only, outside the floor test's set. */
const INTERNAL: ModelEntry = { ...ECONOMY, id: "test-internal-1", label: { ar: "نموذج داخلي تجريبي", en: "Test internal model" }, tier: "standard", auto: false, pick: false };
/** An offered entry without tool use: it may generate, never run chat. */
const NOTOOLS: ModelEntry = { ...ECONOMY, id: "test-notools-1", label: { ar: "نموذج بلا أدوات", en: "Test model without tools" }, tier: "standard", caps: { ...ECONOMY.caps, tools: false } };
const EXTRA: readonly ModelEntry[] = [ECONOMY, INTERNAL, NOTOOLS];
const extraById = (id: unknown) => EXTRA.find((e) => e.id === id);
/** Ids that are not exactly a catalog id: they must price like the surface's default, never cheaper, never NaN. */
const NOT_IDS: unknown[] = ["claude-unknown-9", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "", " claude-opus-5", "CLAUDE-OPUS-5", undefined, null, 5, {}, []];

/** A fresh credits module over a catalog that also holds the economy entry. */
async function withEconomy() {
  vi.resetModules();
  vi.doMock("@/lib/models/catalog", async (orig) => {
    const m = await orig<typeof import("@/lib/models/catalog")>();
    return { ...m, MODELS: [...m.MODELS, ...EXTRA], modelById: (id: unknown) => extraById(id) ?? m.modelById(id) };
  });
  return import("@/lib/models/credits");
}

afterEach(async () => {
  await settle();
  for (const m of ["@/lib/models/catalog", "@/lib/models/tiers", "@anthropic-ai/sdk", "@/lib/model", "@/lib/credits"]) vi.doUnmock(m);
  vi.unstubAllEnvs();
});

describe("PRICED_AT: the model whose tier is x1 on each surface", () => {
  it("chat is priced at Sonnet 5.5 and generation at Opus 5, the models each surface calls today", () => {
    expect({ ...PRICED_AT }).toEqual({ chat: SONNET55, generate: OPUS });
    expect(Object.isFrozen(PRICED_AT)).toBe(true);
    for (const s of Object.keys(PRICED_AT) as Surface[]) expect(modelById(PRICED_AT[s]), s).toBeDefined();
    // The defaults the code calls today are the models the prices are set at (Task 5 asserts the same of route()).
    expect(ESTIMATE_MODELS.generate).toBe(PRICED_AT.generate);
    expect(CHAT_MODEL).toBe(PRICED_AT.chat);
  });
});

describe("tierMultiplier is relative to the surface's default model", () => {
  it("generate: Opus 5 x1, the Sonnets x0.5, an economy model x0.3", async () => {
    expect([OPUS, SONNET, SONNET55].map((m) => tierMultiplier(m, "generate"))).toEqual([1, 0.5, 0.5]);
    const eco = await withEconomy();
    expect(eco.tierMultiplier(ECONOMY.id, "generate")).toBeCloseTo(0.3, 12);
    expect(eco.tierMultiplier(ECONOMY.id, "generate")).toBe(TIER_MULTIPLIER.economy / TIER_MULTIPLIER.premium);
  });

  it("chat: the Sonnets x1, Opus 5 x2, an economy model x0.6", async () => {
    expect([SONNET55, SONNET, OPUS].map((m) => tierMultiplier(m, "chat"))).toEqual([1, 1, 2]);
    const eco = await withEconomy();
    expect(eco.tierMultiplier(ECONOMY.id, "chat")).toBe(0.6);
  });

  it("an id that is not exactly a catalog id is priced as the surface's default: x1, never NaN, never cheaper", () => {
    for (const id of NOT_IDS) {
      for (const s of ["generate", "chat"] as const) expect(tierMultiplier(id as string, s), `${String(id)} on ${s}`).toBe(1);
    }
  });

  it("a surface that is not one of PRICED_AT's own keys throws (no default to fall back to)", () => {
    for (const s of ["constructor", "__proto__", "toString", "review", ""]) expect(() => tierMultiplier(OPUS, s as Surface), s).toThrow(/unknown_surface/);
  });
});

describe("creditsFor: base credits times the multiplier, rounded up, at least 1", () => {
  it("generate, base 4: Opus 5 gives 4, Sonnet 5 gives 2, an economy model gives 2 (1.2 rounded up)", async () => {
    expect([OPUS, SONNET, SONNET55].map((m) => creditsFor(4, m, "generate"))).toEqual([4, 2, 2]);
    const eco = await withEconomy();
    expect(eco.creditsFor(4, ECONOMY.id, "generate")).toBe(2);
    expect(eco.creditsFor(10, ECONOMY.id, "generate")).toBe(3);
  });

  it("a floating-point excess is never charged as a whole extra credit (a x1.1 tier: 50 x 1.1 = 55.00000000000001)", async () => {
    expect(50 * 1.1, "the trap is real").toBeGreaterThan(55);
    vi.resetModules();
    vi.doMock("@/lib/models/tiers", async (orig) => {
      const m = await orig<typeof import("@/lib/models/tiers")>();
      return { ...m, TIER_MULTIPLIER: Object.freeze({ economy: 1.1, standard: 1, premium: 1 }) };
    });
    vi.doMock("@/lib/models/catalog", async (orig) => {
      const m = await orig<typeof import("@/lib/models/catalog")>();
      return { ...m, modelById: (id: unknown) => (id === ECONOMY.id ? ECONOMY : m.modelById(id)) };
    });
    const c = await import("@/lib/models/credits");
    expect([50, 90, 100, 110].map((b) => c.creditsFor(b, ECONOMY.id, "generate"))).toEqual([55, 99, 110, 121]);
    expect(c.creditsFor(51, ECONOMY.id, "generate"), "56.1 still rounds up").toBe(57);
  });

  it("chat: Sonnet 5.5 x1, Opus 5 x2, an economy model x0.6", async () => {
    expect([SONNET55, SONNET, OPUS].map((m) => creditsFor(4, m, "chat"))).toEqual([4, 4, 8]);
    const eco = await withEconomy();
    expect(eco.creditsFor(4, ECONOMY.id, "chat")).toBe(3);
  });

  it("rounding: a 1-credit task at x0.5, x0.6 or x0.3 is charged 1, never 0; 3 at x0.5 is 2; a base of 0 is 1", async () => {
    expect(creditsFor(1, SONNET, "generate")).toBe(1);
    expect(creditsFor(3, SONNET, "generate")).toBe(2);
    expect(creditsFor(0, OPUS, "generate")).toBe(1);
    expect(creditsFor(0.2, OPUS, "generate")).toBe(1);
    const eco = await withEconomy();
    expect(eco.creditsFor(1, ECONOMY.id, "chat")).toBe(1);
    expect(eco.creditsFor(1, ECONOMY.id, "generate")).toBe(1);
  });

  it("is exactly the rational ceiling for every integer base up to 500 on every tier: no floating-point overcharge", async () => {
    const eco = await withEconomy();
    // Multipliers as exact fractions (TIER_MULTIPLIER ratios): ceil(base * num / den) in integers.
    const cases: [string, Surface, number, number][] = [
      [OPUS, "generate", 1, 1], [SONNET, "generate", 1, 2], [ECONOMY.id, "generate", 3, 10],
      [SONNET55, "chat", 1, 1], [OPUS, "chat", 2, 1], [ECONOMY.id, "chat", 3, 5],
    ];
    for (const [model, s, num, den] of cases) {
      for (let base = 0; base <= 500; base++) {
        const exact = Math.max(1, Math.floor((base * num + den - 1) / den));
        expect(eco.creditsFor(base, model, s), `${model} ${s} base ${base}`).toBe(exact);
      }
    }
  });

  it("is always an integer of at least 1, for every model, unknown ids included, on both surfaces", async () => {
    const eco = await withEconomy();
    const ids: unknown[] = [...MODELS.map((m) => m.id), ECONOMY.id, ...NOT_IDS];
    for (const id of ids) {
      for (const s of ["generate", "chat"] as const) {
        for (const base of [0, 0.4, 1, 1.5, 2, 3, 4, 5, 7, 10, 25, 99, 1500]) {
          const n = eco.creditsFor(base, id as string, s);
          expect(Number.isInteger(n) && n >= 1, `${String(id)} ${s} ${base}: ${n}`).toBe(true);
        }
      }
    }
  });

  it("an unknown or prototype id is never cheaper than the surface's default model", () => {
    for (const id of NOT_IDS) {
      for (const t of TASK_TYPES) {
        expect(creditsFor(TASK_COST[t], id as string, "generate"), `${String(id)} ${t}`).toBe(creditsFor(TASK_COST[t], PRICED_AT.generate, "generate"));
      }
      expect(creditsFor(4, id as string, "chat")).toBe(4);
    }
  });

  it("throws on a base that is not a finite number of at least 0: a bad cost is never charged as 1", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5, "4", null, undefined]) {
      expect(() => creditsFor(bad as number, OPUS, "generate"), String(bad)).toThrow(/invalid_cost/);
    }
  });
});

describe("estimateFor: one batch, cold cache, at the model's catalog rate", () => {
  it("at the default model it is today's cold estimate, for every type", () => {
    for (const t of TASK_TYPES) expect(estimateFor(t, PRICED_AT.generate), t).toBe(estimateBatch(t, { cache: "cold" }).totalUsd);
  });

  it("a Sonnet batch costs less than an Opus one (the generation call is cheaper; the reviewer and judge are the same)", () => {
    for (const t of TASK_TYPES) {
      const opus = estimateBatch(t, { cache: "cold" });
      const son = estimateBatch(t, { cache: "cold", model: SONNET });
      expect(son.totalUsd, t).toBe(estimateFor(t, SONNET));
      // Opus 5.5 is Sonnet 5.5 x 2 on every bucket but the cache read, which costs the same on both.
      expect(son.generateUsd, t).toBeLessThan(opus.generateUsd);
      expect(son.generateUsd, t).toBeGreaterThanOrEqual(opus.generateUsd / 2);
      expect([son.reviewUsd, son.judgeUsd], t).toEqual([opus.reviewUsd, opus.judgeUsd]);
    }
  });

  it("refuses a model that is not exactly a catalog id rather than pricing it as Opus; an explicit undefined is the default", () => {
    for (const id of NOT_IDS.filter((x) => x !== undefined)) expect(() => estimateFor("social", id as string), String(id)).toThrow(/bad_estimate_model/);
    // The same rule as generateBatch's `model`: left out or undefined, the default; anything else must be a catalog id.
    expect(estimateFor("social", undefined as unknown as string)).toBe(estimateFor("social", PRICED_AT.generate));
    expect(estimateBatch("social", { cache: "cold", model: undefined })).toEqual(estimateBatch("social", { cache: "cold" }));
    expect(() => estimateBatch("social", { cache: "cold", model: null as unknown as string })).toThrow(/bad_estimate_model/);
  });
});

describe("chatTurnMaxUsd and the overflow hold scale with the chat tier (rules 311-313)", () => {
  it("the ceiling: Sonnet 5.5 $0.14 (CHAT_TURN_MAX_USD, unchanged), Opus 5.5 $0.28, an economy model $0.084", async () => {
    expect(CHAT_TURN_MAX_USD).toBe(0.14);
    expect(chatTurnMaxUsd(SONNET55)).toBe(CHAT_TURN_MAX_USD);
    expect(chatTurnMaxUsd(SONNET)).toBe(CHAT_TURN_MAX_USD);
    expect(chatTurnMaxUsd(OPUS)).toBeCloseTo(0.28, 12);
    for (const id of NOT_IDS) expect(chatTurnMaxUsd(id as string), String(id)).toBe(CHAT_TURN_MAX_USD);
    const eco = await withEconomy();
    expect(eco.chatTurnMaxUsd(ECONOMY.id)).toBeCloseTo(0.084, 12);
  });

  it("the hold: 2 credits at x1 (today's chatOverflowHold), 4 on Opus 5.5, 2 on an economy model", async () => {
    expect(chatOverflowHold()).toBe(2);
    expect([SONNET55, SONNET, OPUS].map(chatHoldFor)).toEqual([2, 2, 4]);
    expect(chatOverflowHold(maxCostPerCreditUsd(), 0.28)).toBe(4);
    for (const id of NOT_IDS) expect(chatHoldFor(id as string), String(id)).toBe(2);
    const eco = await withEconomy();
    expect(eco.chatHoldFor(ECONOMY.id)).toBe(2);
  });

  it("each call's output cap follows the model's own ceiling: Opus 5.5 has room where $0.14 would leave none", () => {
    // $0.14 already spent: at x1 nothing is left, at Opus 5.5's $0.28 the other $0.14 buys 7,000 output tokens ($20 a million).
    expect(nextMaxTokens(CHAT_MODEL, CHAT_TURN_MAX_USD, 0)).toBe(0);
    expect(nextMaxTokens(OPUS, CHAT_TURN_MAX_USD, 0)).toBe(7000);
    expect(nextMaxTokens(OPUS, 0.28 - (CHAT_MIN_OUT - 1) * 20e-6, 0)).toBe(0);
    // An explicit ceiling still wins (the tests of rule 311 pass one).
    expect(nextMaxTokens(OPUS, CHAT_TURN_MAX_USD, 0, CHAT_TURN_MAX_USD)).toBe(0);
  });
});

describe("chatUnitsFor: one chat message counts ceil(its chat multiplier) messages of the allowance", () => {
  it("Sonnet 5.5 and Sonnet 5 count 1, Opus 5 counts 2, an economy model 1; an id not in the catalog 1", async () => {
    expect([SONNET55, SONNET, OPUS].map(chatUnitsFor)).toEqual([1, 1, 2]);
    for (const id of NOT_IDS) expect(chatUnitsFor(id as string), String(id)).toBe(1);
    const eco = await withEconomy();
    expect(eco.chatUnitsFor(ECONOMY.id)).toBe(1);
  });

  it("each unit carries at most CHAT_TURN_MAX_USD, the ceiling the allowances were priced at", async () => {
    for (const m of [SONNET55, SONNET, OPUS]) expect(chatTurnMaxUsd(m) / chatUnitsFor(m), m).toBeLessThanOrEqual(CHAT_TURN_MAX_USD + 1e-12);
    const eco = await withEconomy();
    expect(eco.chatTurnMaxUsd(ECONOMY.id) / eco.chatUnitsFor(ECONOMY.id)).toBeCloseTo(0.084, 12);
  });

  async function tiered(economy: number) {
    vi.resetModules();
    vi.doMock("@/lib/models/tiers", async (orig) => {
      const m = await orig<typeof import("@/lib/models/tiers")>();
      return { ...m, TIER_MULTIPLIER: Object.freeze({ economy, standard: 1, premium: 2 }) };
    });
    vi.doMock("@/lib/models/catalog", async (orig) => {
      const m = await orig<typeof import("@/lib/models/catalog")>();
      return { ...m, modelById: (id: unknown) => (id === ECONOMY.id ? ECONOMY : m.modelById(id)) };
    });
    return { credits: await import("@/lib/models/credits"), allowance: await import("@/lib/chat-allowance") };
  }

  it("rounds up without a floating-point extra unit: x1.1 counts 2, x1.0000000000000002 counts 1", async () => {
    expect((await tiered(1.1)).credits.chatUnitsFor(ECONOMY.id)).toBe(2);
    expect((await tiered(1.0000000000000002)).credits.chatUnitsFor(ECONOMY.id)).toBe(1);
  });

  it("a multiplier that is not a finite number above 0 throws chat_allowance_unpriced, and reserveChatTurn counts nothing", async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { credits: c, allowance: a } = await tiered(bad);
      expect(() => c.chatUnitsFor(ECONOMY.id), String(bad)).toThrow(/chat_allowance_unpriced/);
      const u = await newUser("mc-bad");
      await expect(a.reserveChatTurn(u, ECONOMY.id), String(bad)).rejects.toThrow(/chat_allowance_unpriced/);
      expect(await db.get<number>(chatMsgKey(u.email)), String(bad)).toBeFalsy();
    }
  });
});

describe("the chat allowance per tier: a message counts chatUnitsFor(model), computed once at the reserve", () => {
  async function owner(over: Partial<User> = {}): Promise<User> {
    const u = await newUser("mc-chat");
    await saveUser({ ...u, plan: "starter", chatOverflow: true, credits: 10, ...over });
    return (await getUser(u.email))!;
  }
  const msgs = async (u: User) => (await db.get<number>(chatMsgKey(u.email))) ?? 0;
  const over = async (u: User) => (await db.get<number>(chatOverKey(u.email))) ?? 0;
  const reply = (usd: number): ChatTurn => ({ role: "assistant", content: "ok", at: new Date().toISOString(), usd }) as ChatTurn;
  async function reserved(u: User, model?: string) {
    const g = await reserveChatTurn(u, model ?? SONNET55);
    if (!g.ok) throw new Error(`refused: ${g.error}`);
    return g;
  }

  it("the default model (Sonnet 5.5) reserves 1 and a failed turn gives back 1, as today", async () => {
    const u = await owner();
    const g = await reserved(u);
    expect(g).toMatchObject({ mode: "included", units: 1, model: SONNET55, status: { used: 1, left: 249, counted: 1 } });
    expect(await msgs(u)).toBe(1);
    const s = await settleChatTurn(u, g, null);
    expect(await msgs(u)).toBe(0);
    expect(s).toMatchObject({ charged: 0, status: { used: 0, left: 250, counted: 0 } });
    expect((await chatStatus(u, SONNET55)).overflow.hold).toBe(2);
    expect(await reserved(u, SONNET)).toMatchObject({ mode: "included", units: 1 });
  });

  it("Opus 5 reserves 2 and a failed turn gives back exactly 2; an answered one keeps 2", async () => {
    const u = await owner();
    const g = await reserved(u, OPUS);
    expect(g).toMatchObject({ mode: "included", units: 2, model: OPUS, status: { used: 2, left: 248, counted: 2 } });
    expect(await msgs(u)).toBe(2);
    expect(await settleChatTurn(u, g, null)).toMatchObject({ charged: 0, status: { used: 0, left: 250, counted: 0 } });
    expect(await msgs(u)).toBe(0);
    // The same through runChatTurn: a throw gives back the 2 before it is rethrown; a reply keeps them, nothing billed.
    await expect(runChatTurn(u, await reserved(u, OPUS), async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await msgs(u)).toBe(0);
    const r = await runChatTurn(u, await reserved(u, OPUS), async () => reply(0.2));
    expect(r).toMatchObject({ charged: 0, chat: { used: 2, left: 248 } });
    expect(await msgs(u)).toBe(2);
    expect((await getUser(u.email))!.credits).toBe(10);
  });

  it("the settle reads the count the reserve stored, never the model again; a gate with a bad count moves nothing", async () => {
    const src = readFileSync("src/lib/chat-allowance.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/\s+/g, "");
    expect(src.match(/chatUnitsFor\(/g), "one computation, in reserveChatTurn").toEqual(["chatUnitsFor("]);
    expect(src).toContain("constunits=chatUnitsFor(entry.id);");
    expect(src).toContain("db.incrby(gate.key,-gate.units)");
    const u = await owner();
    const g = await reserved(u, OPUS);
    for (const units of [0, -2, 1.5, Number.NaN, undefined]) {
      await expect(settleChatTurn(u, { ...g, units } as typeof g, null), String(units)).rejects.toThrow(/invalid_units/);
    }
    expect(await msgs(u)).toBe(2);
  });

  it("a message that would pass the allowance by its count is refused before any model call, the counter as it was", async () => {
    const u = await owner({ chatOverflow: false });
    await db.set(chatMsgKey(u.email), 249);
    const g = await reserveChatTurn(u, OPUS);
    expect(g).toMatchObject({ ok: false, error: "chat_allowance", status: { used: 249, left: 1 } });
    expect(await msgs(u)).toBe(249);
    // The last message is still there for a model that counts 1.
    expect(await reserved(u, SONNET55)).toMatchObject({ mode: "included", units: 1, status: { used: 250, left: 0 } });
    expect(await msgs(u)).toBe(250);
    // The route answers a refusal before chat() runs (rule 309); an allowance of 0 refuses Opus with the switch on too.
    const off = await owner({ chatAllowance: 0 });
    expect(await reserveChatTurn(off, OPUS)).toMatchObject({ ok: false, error: "chat_allowance" });
    expect(await msgs(off)).toBe(0);
  });

  it("past the allowance the overflow scales the same way: Opus needs a hold of 4, counts 2 on chat_over, gives back 2", async () => {
    const u = await owner({ credits: 3 });
    await db.set(chatMsgKey(u.email), 250);
    expect(await reserveChatTurn(u, OPUS)).toMatchObject({ ok: false, error: "chat_credits", need: 4, credits: 3 });
    expect([await msgs(u), await over(u)]).toEqual([250, 0]);
    // 3 credits cover a Sonnet message's hold of 2.
    const s = await reserved(u, SONNET55);
    expect(s).toMatchObject({ mode: "overflow", units: 1, hold: 2 });
    expect(await over(u)).toBe(1);
    await settleChatTurn(u, s, null);
    expect(await over(u)).toBe(0);

    const v = await owner({ credits: 10 });
    await db.set(chatMsgKey(v.email), 249); // one left: Opus counts 2, so the whole message goes on credits
    const g = await reserved(v, OPUS);
    expect(g).toMatchObject({ mode: "overflow", units: 2, hold: 4, status: { used: 249, overflow: { used: 2, hold: 4 } } });
    expect([await msgs(v), await over(v)]).toEqual([249, 2]);
    expect(await settleChatTurn(v, g, null)).toMatchObject({ charged: 0, status: { overflow: { used: 0 } } });
    expect([await msgs(v), await over(v), (await getUser(v.email))!.credits]).toEqual([249, 0, 10]);
    // Answered at its $0.28 ceiling: billed 3 credits at the floor rate (the rest carried), at most the hold of 4.
    const a = await reserved(v, OPUS);
    const r = await settleChatTurn(v, a, chatTurnMaxUsd(OPUS));
    expect(r.charged).toBe(Math.floor(Math.round(chatTurnMaxUsd(OPUS) * 1e6) / Math.round(maxCostPerCreditUsd() * 1e6)));
    expect(r.charged).toBe(3);
    expect([await over(v), await db.get<number>(chatCredKey(v.email)), (await getUser(v.email))!.credits]).toEqual([2, 3, 7]);
    // A metered cost past the ceiling is still billed at most the hold.
    const b = await reserved(v, OPUS);
    expect((await settleChatTurn(v, b, 1)).charged).toBe(4);
    expect([await over(v), (await getUser(v.email))!.credits]).toEqual([4, 3]);
  });

  it("an id that is not exactly a catalog id is refused before anything is counted", async () => {
    const u = await owner();
    for (const id of ["claude-unknown-9", "constructor", "__proto__", ""]) await expect(reserveChatTurn(u, id), id).rejects.toThrow(/unknown_model/);
    expect(await msgs(u)).toBe(0);
  });

  it("only an offered model with tools runs chat: an internal entry and one without tools are refused before counting", async () => {
    vi.resetModules();
    vi.doMock("@/lib/models/catalog", async (orig) => {
      const m = await orig<typeof import("@/lib/models/catalog")>();
      return { ...m, MODELS: [...m.MODELS, ...EXTRA], modelById: (id: unknown) => extraById(id) ?? m.modelById(id) };
    });
    const a = await import("@/lib/chat-allowance");
    const u = await owner();
    await expect(a.reserveChatTurn(u, INTERNAL.id)).rejects.toThrow(/^model_not_offered:test-internal-1$/);
    await expect(a.reserveChatTurn(u, NOTOOLS.id)).rejects.toThrow(/^model_not_chat:test-notools-1$/);
    expect(await msgs(u)).toBe(0);
    // An offered economy model with tools is accepted and counts 1.
    expect(await a.reserveChatTurn(u, ECONOMY.id)).toMatchObject({ ok: true, mode: "included", units: 1, model: ECONOMY.id });
    expect(await msgs(u)).toBe(1);
  });
});

// ---- charge then refund through the real pipeline, per tier ----

const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "رخيص", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };

/**
 * generateBatch with the model paused (chat path: charged, then generate() throws and the charge is refunded) over a
 * catalog that also holds the economy entry. `charges` records every amount the ledger was asked to take.
 */
async function load() {
  vi.resetModules();
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  vi.doMock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "paused" }));
  vi.doMock("@/lib/models/catalog", async (orig) => {
    const m = await orig<typeof import("@/lib/models/catalog")>();
    return { ...m, MODELS: [...m.MODELS, ...EXTRA], modelById: (id: unknown) => extraById(id) ?? m.modelById(id) };
  });
  const seen = { charges: [] as number[], onceCharges: [] as number[], refunds: [] as number[] };
  vi.doMock("@/lib/credits", async (orig) => {
    const m = await orig<typeof import("@/lib/credits")>();
    return {
      ...m,
      charge: (...a: Parameters<typeof m.charge>) => { seen.charges.push(a[1]); return m.charge(...a); },
      chargeOnce: (...a: Parameters<typeof m.chargeOnce>) => { seen.onceCharges.push(a[1]); return m.chargeOnce(...a); },
      refund: (...a: Parameters<typeof m.refund>) => { seen.refunds.push(a[1]); return m.refund(...a); },
      refundOnce: async (...a: Parameters<typeof m.refundOnce>) => { const r = await m.refundOnce(...a); seen.refunds.push(r.refunded); return r; },
    };
  });
  vi.doMock("@anthropic-ai/sdk", () => ({ default: class { static BadRequestError = class extends Error {}; constructor() { throw new Error("no model call in this test"); } } }));
  return { ...(await import("@/lib/generate-batch")), seen };
}

async function brandOwner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await db.set(`brand:${u.email}`, brand);
  return (await getUser(u.email))!;
}
const credits = async (email: string) => (await getUser(email))!.credits;

describe("a charge then a refund returns exactly the charged credits, for each tier (generateBatch)", () => {
  const TIERS_ON_GENERATE: [string | undefined, number][] = [[undefined, 10], [OPUS, 10], [SONNET, 5], [SONNET55, 5], [ECONOMY.id, 3]];

  it("social (base 10) at each tier: one value is charged and the same value given back, the agent's month back to 0", async () => {
    const { generateBatch, seen } = await load();
    for (const [model, want] of TIERS_ON_GENERATE) {
      const u = await brandOwner("mc-tier");
      const before = await credits(u.email);
      const r = await generateBatch(u, u.email, { type: "social", source: "chat", via: "chat", ...(model ? { model } : {}) });
      const tag = model ?? "default";
      expect(!r.ok && r.reason === "failed" && (r.error as Error).name, tag).toBe("ModelPaused");
      expect(seen.charges.at(-1), `${tag}: charged`).toBe(want);
      expect(seen.refunds.at(-1), `${tag}: refunded`).toBe(want);
      expect([await credits(u.email), agentSpendFor((await getUser(u.email))!, u.email)], tag).toEqual([before, { noor: 0 }]);
    }
  });

  it("the claim path (chargeOnce, refundOnce) gives back the hold's credits, which are the charged ones", async () => {
    const { generateBatch, seen } = await load();
    for (const [model, want] of TIERS_ON_GENERATE) {
      const u = await brandOwner("mc-once");
      const before = await credits(u.email);
      const r = await generateBatch(u, u.email, { type: "social", source: "chat", via: "chat", once: `test:${model ?? "default"}`, ...(model ? { model } : {}) });
      const tag = model ?? "default";
      expect(r.ok, tag).toBe(false);
      expect([seen.onceCharges.at(-1), seen.refunds.at(-1)], tag).toEqual([want, want]);
      const after = (await getUser(u.email))!;
      expect([after.credits, after.paidOnce, agentSpendFor(after, u.email)], tag).toEqual([before, undefined, { noor: 0 }]);
    }
  });

  it("a one-item draft at x0.5 is charged 1 credit, never 0, and refunded 1", async () => {
    const { generateBatch, seen } = await load();
    const u = await brandOwner("mc-draft");
    const before = await credits(u.email);
    await generateBatch(u, u.email, { type: "social", source: "chat", via: "chat", count: 1, model: SONNET });
    expect([seen.charges.at(-1), seen.refunds.at(-1), await credits(u.email)]).toEqual([1, 1, before]);
  });

  it("an id that is not exactly a catalog id is refused before any read or charge", async () => {
    const { generateBatch, seen } = await load();
    const u = await brandOwner("mc-unknown");
    const before = await credits(u.email);
    for (const id of ["claude-unknown-9", "constructor", "__proto__", "", 5, null]) {
      await expect(generateBatch(u, u.email, { type: "social", source: "chat", via: "chat", model: id as string }), String(id)).rejects.toThrow(/unknown_model/);
    }
    expect([seen.charges, seen.onceCharges, await credits(u.email)]).toEqual([[], [], before]);
  });

  it("model: undefined is the default (10), the same as leaving it out", async () => {
    const { generateBatch, seen } = await load();
    const u = await brandOwner("mc-undef");
    await generateBatch(u, u.email, { type: "social", source: "chat", via: "chat", model: undefined });
    expect([seen.charges.at(-1), seen.refunds.at(-1)]).toEqual([10, 10]);
  });

  it("only an offered model may generate: an internal entry is refused before any read or charge; tools are not needed", async () => {
    const { generateBatch, seen } = await load();
    const u = await brandOwner("mc-internal");
    const before = await credits(u.email);
    await expect(generateBatch(u, u.email, { type: "social", source: "chat", via: "chat", model: INTERNAL.id })).rejects.toThrow(/^model_not_offered:test-internal-1$/);
    expect([seen.charges, seen.onceCharges, await credits(u.email)]).toEqual([[], [], before]);
    // Generation calls no tools: an offered model without them is priced at its tier (standard, x0.5) and runs.
    const r = await generateBatch(u, u.email, { type: "social", source: "chat", via: "chat", model: NOTOOLS.id });
    expect(!r.ok && r.reason).toBe("failed");
    expect([seen.charges.at(-1), seen.refunds.at(-1), await credits(u.email)]).toEqual([5, 5, before]);
  });

  it("a type outside the model's allow-list is refused before the charge (article on a Sonnet misses the floor)", async () => {
    const { generateBatch, seen } = await load();
    const u = await brandOwner("mc-allow");
    for (const t of ["article", "followup_seq"] as const) {
      await expect(generateBatch(u, u.email, { type: t, source: "chat", via: "chat", model: SONNET }), t).rejects.toThrow(/model_task_not_allowed/);
    }
    expect(seen.charges).toEqual([]);
  });

  it("charge and refund read one value in the source: creditsFor once, used by charge, chargeOnce and refund", () => {
    const src = readFileSync("src/lib/generate-batch.ts", "utf8").replace(/\s+/g, "");
    expect(src).toContain('constcost=creditsFor(base,model,"generate");');
    expect(src.match(/creditsFor\(/g)?.length).toBe(1);
    expect(src).toContain("chargeOnce(user.email,cost,meta,opts.once)");
    expect(src).toContain("charge(user.email,cost,meta)");
    expect(src).toContain("refund(user.email,cost,receipt)");
    // What is reported is what was charged: the price, or a reused hold's credits (chargeOnce reuses only an equal one).
    expect(src).toContain('constcharged="hold"inpaid?paid.hold.credits:cost;');
    expect(src).toContain("count:tasks.length,credits:charged}");
    expect(src).toContain("receipt,cost:charged,agent,gov,...(modelRejected?{modelRejected}:{})}");
  });
});
