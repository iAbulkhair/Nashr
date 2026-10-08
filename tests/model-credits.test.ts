import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { newUser, settle } from "./helpers/session";
import { getUser, saveUser, type User } from "@/lib/auth";
import { agentSpendFor } from "@/lib/credits";
import { db } from "@/lib/db";
import type { Brand } from "@/lib/brand";
import { PRICED_AT, TIER_MULTIPLIER, type Surface } from "@/lib/models/tiers";
import { MODELS, modelById, type ModelEntry } from "@/lib/models/catalog";
import { chatHoldFor, chatTurnMaxUsd, creditsFor, tierMultiplier } from "@/lib/models/credits";
import { CHAT_TURN_MAX_USD, chatOverflowHold, maxCostPerCreditUsd } from "@/lib/pricing";
import { TASK_COST, TASK_TYPES } from "@/lib/tasks";
import { ESTIMATE_MODELS, estimateBatch, estimateFor } from "@/lib/task-costs";
import { CHAT_MODEL } from "@/lib/chat";
import { CHAT_MIN_OUT, nextMaxTokens } from "@/lib/chat-budget";
import { chatStatus, reserveChatTurn } from "@/lib/chat-allowance";
import { chatMsgKey } from "@/lib/usage";

/**
 * Credits by tier (spec 2026-10-08-straitly-model-routing, section 6; plan Task 4). A task's credits and a chat message's
 * ceiling scale with the tier of the model that runs them, RELATIVE TO THE SURFACE'S DEFAULT MODEL (`PRICED_AT` in
 * src/lib/models/tiers.ts): the default model of each surface is x1, so today's prices do not move. Generation is priced
 * at Opus 5 (premium), so a standard model is x0.5 and an economy one x0.3; chat is priced at Sonnet 5.5 (standard), so
 * Opus 5 is x2 and an economy model x0.6. Money code: every amount is an integer of at least 1, an id that is not exactly
 * a catalog id never makes a task cheaper, and a refund gives back exactly what was charged.
 */

const OPUS = "claude-opus-5";
const SONNET = "claude-sonnet-5";
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
/** Ids that are not exactly a catalog id: they must price like the surface's default, never cheaper, never NaN. */
const NOT_IDS: unknown[] = ["claude-unknown-9", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "", " claude-opus-5", "CLAUDE-OPUS-5", undefined, null, 5, {}, []];

/** A fresh credits module over a catalog that also holds the economy entry. */
async function withEconomy() {
  vi.resetModules();
  vi.doMock("@/lib/models/catalog", async (orig) => {
    const m = await orig<typeof import("@/lib/models/catalog")>();
    return { ...m, MODELS: [...m.MODELS, ECONOMY], modelById: (id: unknown) => (id === ECONOMY.id ? ECONOMY : m.modelById(id)) };
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
      expect(son.generateUsd, t).toBeCloseTo(opus.generateUsd / 2.5, 12);
      expect([son.reviewUsd, son.judgeUsd], t).toEqual([opus.reviewUsd, opus.judgeUsd]);
    }
  });

  it("refuses a model that is not exactly a catalog id rather than pricing it as Opus", () => {
    for (const id of NOT_IDS) expect(() => estimateFor("social", id as string), String(id)).toThrow(/bad_estimate_model/);
  });
});

describe("chatTurnMaxUsd and the overflow hold scale with the chat tier (rules 311-313)", () => {
  it("the ceiling: Sonnet 5.5 $0.14 (CHAT_TURN_MAX_USD, unchanged), Opus 5 $0.28, an economy model $0.084", async () => {
    expect(CHAT_TURN_MAX_USD).toBe(0.14);
    expect(chatTurnMaxUsd(SONNET55)).toBe(CHAT_TURN_MAX_USD);
    expect(chatTurnMaxUsd(SONNET)).toBe(CHAT_TURN_MAX_USD);
    expect(chatTurnMaxUsd(OPUS)).toBeCloseTo(0.28, 12);
    for (const id of NOT_IDS) expect(chatTurnMaxUsd(id as string), String(id)).toBe(CHAT_TURN_MAX_USD);
    const eco = await withEconomy();
    expect(eco.chatTurnMaxUsd(ECONOMY.id)).toBeCloseTo(0.084, 12);
  });

  it("the hold: 2 credits at x1 (today's chatOverflowHold), 4 on Opus 5, 2 on an economy model", async () => {
    expect(chatOverflowHold()).toBe(2);
    expect([SONNET55, SONNET, OPUS].map(chatHoldFor)).toEqual([2, 2, 4]);
    expect(chatOverflowHold(maxCostPerCreditUsd(), 0.28)).toBe(4);
    for (const id of NOT_IDS) expect(chatHoldFor(id as string), String(id)).toBe(2);
    const eco = await withEconomy();
    expect(eco.chatHoldFor(ECONOMY.id)).toBe(2);
  });

  it("each call's output cap follows the model's own ceiling: Opus 5 has room where $0.14 would leave none", () => {
    // $0.14 already spent: at x1 nothing is left, at Opus 5's $0.28 the other $0.14 buys 5,600 output tokens.
    expect(nextMaxTokens(CHAT_MODEL, CHAT_TURN_MAX_USD, 0)).toBe(0);
    expect(nextMaxTokens(OPUS, CHAT_TURN_MAX_USD, 0)).toBe(5600);
    expect(nextMaxTokens(OPUS, 0.28 - (CHAT_MIN_OUT - 1) * 25e-6, 0)).toBe(0);
    // An explicit ceiling still wins (the tests of rule 311 pass one).
    expect(nextMaxTokens(OPUS, CHAT_TURN_MAX_USD, 0, CHAT_TURN_MAX_USD)).toBe(0);
  });
});

describe("the chat allowance per tier", () => {
  async function owner(): Promise<User> {
    const u = await newUser("mc-chat");
    await saveUser({ ...u, plan: "starter", chatOverflow: true, credits: 10 });
    return (await getUser(u.email))!;
  }

  it("the default model reserves one message and holds 2 credits in overflow, as before", async () => {
    const u = await owner();
    const g = await reserveChatTurn(u);
    expect(g).toMatchObject({ ok: true, mode: "included" });
    expect((await chatStatus(u)).overflow.hold).toBe(2);
    expect((await chatStatus(u, SONNET)).overflow.hold).toBe(2);
  });

  it("a model above x1 is refused in code before anything is counted: counting it per tier awaits a decision", async () => {
    const u = await owner();
    await expect(reserveChatTurn(u, OPUS)).rejects.toThrow(/chat_allowance_unpriced/);
    expect(await db.get<number>(chatMsgKey(u.email))).toBeFalsy();
    // An id that is not exactly a catalog id is refused the same way, never priced as the default.
    for (const id of ["claude-unknown-9", "constructor", "__proto__", ""]) await expect(reserveChatTurn(u, id), id).rejects.toThrow(/unknown_model/);
    expect(await db.get<number>(chatMsgKey(u.email))).toBeFalsy();
    // A model at or below x1 counts one message, as the default does.
    expect(await reserveChatTurn(u, SONNET)).toMatchObject({ ok: true, mode: "included" });
    expect(await db.get<number>(chatMsgKey(u.email))).toBe(1);
  });

  it("past the allowance with the switch on, the gate carries the model's own hold to the settle", async () => {
    const u = await owner();
    await db.set(chatMsgKey(u.email), 250);
    const g = await reserveChatTurn(u, SONNET);
    expect(g).toMatchObject({ ok: true, mode: "overflow", hold: chatHoldFor(SONNET) });
    expect(g.ok && g.status.overflow.hold).toBe(2);
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
    return { ...m, MODELS: [...m.MODELS, ECONOMY], modelById: (id: unknown) => (id === ECONOMY.id ? ECONOMY : m.modelById(id)) };
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
  });
});
