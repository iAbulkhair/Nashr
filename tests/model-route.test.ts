import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, OVERRIDABLE, route, type Purpose } from "@/lib/models/route";
import { MODELS, modelById, type ModelEntry } from "@/lib/models/catalog";
import { PRICED_AT } from "@/lib/models/tiers";
import { ESTIMATE_MODELS } from "@/lib/task-costs";

/**
 * `route(purpose, ctx)` is the one place that decides which model a call runs on (spec 2026-10-08-straitly-model-routing,
 * section 4; plan Task 5). The first release keeps today's models, so every purpose resolves to the model its call
 * site used to hard-code; a customer's stored pick (Task 6 supplies it) changes only `chat` and `generate`, and only
 * when it passes every check here. Automatic choices (the defaults, a judge alternative) are west-hosted and `auto`,
 * checked in this file and not only in the catalog's data.
 */
const OPUS = "claude-opus-5";
const SONNET = "claude-sonnet-5";
const SONNET55 = "claude-sonnet-5-5";
const PURPOSES = ["chat", "generate", "review", "xreview", "judge", "onboard", "imagePrompt", "tool"] as const satisfies readonly Purpose[];
const FIXED = ["review", "xreview", "judge", "onboard", "imagePrompt", "tool"] as const satisfies readonly Purpose[];

/** A test-only catalog entry. The real catalog holds the three Claude models; the mocked ones below add to or change them. */
const entry = (o: Partial<ModelEntry> & { id: string }): ModelEntry => ({
  label: { ar: "نموذج تجريبي", en: "Test model" },
  vendor: "acme",
  hosting: "west",
  tier: "standard",
  dialect: "messages",
  caps: { tools: true, strict: true, thinking: true, cache: true, vision: false },
  rate: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  auto: true,
  pick: true,
  ...o,
});
const rate = (r: Partial<ModelEntry["rate"]>): ModelEntry["rate"] => ({ in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5, ...r });

/** A fresh route module over a catalog that has `extra` added and `patch` applied to the real entries. */
async function withCatalog(extra: ModelEntry[] = [], patch: (m: ModelEntry) => ModelEntry = (m) => m) {
  vi.resetModules();
  vi.doMock("@/lib/models/catalog", async (orig) => {
    const m = await orig<typeof import("@/lib/models/catalog")>();
    const all = [...m.MODELS.map(patch), ...extra];
    return { ...m, MODELS: all, modelById: (id: unknown) => all.find((e) => e.id === id), autoModels: () => all.filter((e) => e.auto), pickModels: () => all.filter((e) => e.pick) };
  });
  return import("@/lib/models/route");
}

afterEach(() => {
  vi.doUnmock("@/lib/models/catalog");
});

describe("the defaults are today's models, one per purpose", () => {
  it("defaults equal today's models for every purpose", () => {
    expect({ ...DEFAULTS }).toEqual({
      chat: SONNET55,
      generate: OPUS,
      review: SONNET,
      xreview: SONNET,
      judge: SONNET,
      onboard: OPUS,
      imagePrompt: SONNET,
      tool: SONNET,
    });
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    expect(Object.keys(DEFAULTS).sort()).toEqual([...PURPOSES].sort());
  });

  it("with no context, route() returns the default, not overridden, with nothing rejected, for every purpose", () => {
    for (const p of PURPOSES) expect(route(p), p).toEqual({ model: DEFAULTS[p], overridden: false });
    expect(Object.hasOwn(route("chat"), "rejected")).toBe(false);
  });

  it("only chat and generate can be overridden", () => {
    expect([...OVERRIDABLE]).toEqual(["chat", "generate"]);
    expect(Object.isFrozen(OVERRIDABLE)).toBe(true);
  });

  it("the credit multiplier is relative to PRICED_AT, so DEFAULTS.chat and DEFAULTS.generate must equal it", () => {
    expect(DEFAULTS.chat).toBe(PRICED_AT.chat);
    expect(DEFAULTS.generate).toBe(PRICED_AT.generate);
  });

  it("every default is a catalog entry that automatic routing may use: auto, hosted in the west", () => {
    for (const p of PURPOSES) {
      const m = modelById(DEFAULTS[p]);
      expect(m, `${p}: ${DEFAULTS[p]}`).toBeDefined();
      expect(m!.auto, `${p}: auto`).toBe(true);
      expect(m!.hosting, `${p}: hosting`).toBe("west");
    }
  });

  it("ESTIMATE_MODELS prices the defaults: one source for the estimates and for the calls", () => {
    expect({ ...ESTIMATE_MODELS }).toEqual({ generate: DEFAULTS.generate, review: DEFAULTS.review, judge: DEFAULTS.judge, onboard: DEFAULTS.onboard, mediaPrompt: DEFAULTS.imagePrompt });
  });

  it("route() is synchronous and never throws for a normal call, whatever the context holds", () => {
    const r = route("chat");
    expect(r).not.toBeInstanceOf(Promise);
    expect(typeof r.model).toBe("string");
    const weird: unknown[] = [undefined, null, 5, "", {}, [], "constructor", "__proto__", true];
    for (const p of PURPOSES) {
      for (const stored of weird) expect(() => route(p, { stored }), `${p} ${String(stored)}`).not.toThrow();
      expect(() => route(p, { generatedBy: "nonsense" }), p).not.toThrow();
    }
  });

  it("a purpose that is not one of the eight throws rather than guessing a model (prototype names included)", () => {
    for (const p of ["constructor", "__proto__", "toString", "hasOwnProperty", "", "Chat"]) expect(() => route(p as Purpose), p).toThrow(/unknown_purpose/);
  });
});

describe("a purpose outside OVERRIDABLE ignores ctx.stored", () => {
  it("review, xreview, judge, onboard, imagePrompt and tool return the default even for a valid stored pick", () => {
    for (const p of FIXED) {
      for (const stored of [OPUS, SONNET, SONNET55, "claude-unknown-9", "constructor", 5, null]) {
        expect(route(p, { stored, confirmedChina: true }), `${p} ${String(stored)}`).toEqual({ model: DEFAULTS[p], overridden: false });
      }
    }
  });
});

describe("a stored pick for chat or generate", () => {
  it("a valid stored pick returns it with overridden true", () => {
    expect(route("chat", { stored: OPUS })).toEqual({ model: OPUS, overridden: true });
    expect(route("generate", { stored: SONNET })).toEqual({ model: SONNET, overridden: true });
    expect(route("generate", { stored: SONNET55 })).toEqual({ model: SONNET55, overridden: true });
    // A pick equal to the default is still the owner's pick.
    expect(route("chat", { stored: SONNET55 })).toEqual({ model: SONNET55, overridden: true });
  });

  it("nothing stored (undefined) is the default with nothing rejected", () => {
    for (const p of OVERRIDABLE) expect(route(p, { stored: undefined })).toEqual({ model: DEFAULTS[p], overridden: false });
  });

  it("unknown, removed and prototype ids fall back to the default with rejected set to unknown", () => {
    const bad: unknown[] = ["claude-unknown-9", "claude-opus-4", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "", " claude-opus-5", "claude-opus-5 ", "CLAUDE-OPUS-5", 5, true, {}, [], [OPUS], { id: OPUS }, null];
    for (const p of OVERRIDABLE) {
      for (const stored of bad) expect(route(p, { stored }), `${p} ${JSON.stringify(stored)}`).toEqual({ model: DEFAULTS[p], overridden: false, rejected: "unknown" });
    }
  });

  it("an entry that is not pickable is rejected not_pickable, even when automatic routing may use it", async () => {
    const r = await withCatalog([entry({ id: "test-internal-1", auto: true, pick: false })]);
    for (const p of r.OVERRIDABLE) expect(r.route(p, { stored: "test-internal-1" }), p).toEqual({ model: r.DEFAULTS[p], overridden: false, rejected: "not_pickable" });
  });

  it("a china-hosted model without confirmedChina is rejected china_unconfirmed; with confirmedChina: true it is accepted", async () => {
    const r = await withCatalog([entry({ id: "test-china-1", hosting: "china", auto: false, pick: true, tier: "economy" })]);
    for (const p of r.OVERRIDABLE) {
      expect(r.route(p, { stored: "test-china-1" }), p).toEqual({ model: r.DEFAULTS[p], overridden: false, rejected: "china_unconfirmed" });
      expect(r.route(p, { stored: "test-china-1", confirmedChina: false }), p).toMatchObject({ overridden: false, rejected: "china_unconfirmed" });
      expect(r.route(p, { stored: "test-china-1", confirmedChina: true }), p).toEqual({ model: "test-china-1", overridden: true });
    }
    // Only the boolean true confirms: a truthy string, a number or an object does not.
    for (const confirmedChina of ["true", 1, {}, "yes"]) {
      expect(r.route("chat", { stored: "test-china-1", confirmedChina: confirmedChina as unknown as boolean }), String(confirmedChina)).toMatchObject({ overridden: false, rejected: "china_unconfirmed" });
    }
    // The confirmation covers china-hosted picks only: it makes no other rejection go away.
    expect(r.route("chat", { stored: "claude-unknown-9", confirmedChina: true })).toMatchObject({ rejected: "unknown" });
  });

  it("chat needs caps.tools, otherwise rejected needs_tools; generation calls no tools and accepts the same model", async () => {
    const r = await withCatalog([entry({ id: "test-notools-1", caps: { tools: false, strict: false, thinking: false, cache: true, vision: false } })]);
    expect(r.route("chat", { stored: "test-notools-1" })).toEqual({ model: r.DEFAULTS.chat, overridden: false, rejected: "needs_tools" });
    expect(r.route("generate", { stored: "test-notools-1" })).toEqual({ model: "test-notools-1", overridden: true });
  });

  it("the checks run in a fixed order: unknown, then not_pickable, then china_unconfirmed, then needs_tools", async () => {
    const r = await withCatalog([
      entry({ id: "test-all-bad", hosting: "china", pick: false, auto: false, caps: { tools: false, strict: false, thinking: false, cache: true, vision: false } }),
      entry({ id: "test-china-notools", hosting: "china", pick: true, auto: false, caps: { tools: false, strict: false, thinking: false, cache: true, vision: false } }),
    ]);
    expect(r.route("chat", { stored: "test-all-bad" })).toMatchObject({ rejected: "not_pickable" });
    expect(r.route("chat", { stored: "test-china-notools" })).toMatchObject({ rejected: "china_unconfirmed" });
    expect(r.route("chat", { stored: "test-china-notools", confirmedChina: true })).toMatchObject({ rejected: "needs_tools" });
  });
});

describe("automatic routing never returns a china entry", () => {
  const CHINA = entry({ id: "test-china-auto", hosting: "china", auto: true, pick: true, tier: "economy", rate: rate({ in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.12 }) });

  it("the real routing, for every purpose and every context, returns an auto, west-hosted entry unless the owner's confirmed pick says otherwise", () => {
    const ctxs = [undefined, {}, { stored: OPUS }, { stored: "constructor" }, { generatedBy: SONNET }, { generatedBy: OPUS }, { generatedBy: SONNET55 }, { stored: 7, confirmedChina: true }];
    for (const p of PURPOSES) {
      for (const ctx of ctxs) {
        const m = modelById(route(p, ctx).model);
        expect(m, `${p} ${JSON.stringify(ctx)}`).toBeDefined();
        expect(m!.hosting, `${p} ${JSON.stringify(ctx)}`).toBe("west");
        expect(m!.auto, `${p} ${JSON.stringify(ctx)}`).toBe(true);
      }
    }
  });

  it("a china entry wrongly flagged auto: true is still never chosen: not as a judge alternative, not as a stored pick without the owner's confirmation", async () => {
    const r = await withCatalog([CHINA]);
    expect(r.route("judge", { generatedBy: SONNET }).model).not.toBe(CHINA.id);
    for (const p of r.OVERRIDABLE) expect(r.route(p, { stored: CHINA.id }), p).toMatchObject({ model: r.DEFAULTS[p], overridden: false, rejected: "china_unconfirmed" });
    for (const p of PURPOSES) expect(r.route(p).model, p).not.toBe(CHINA.id);
  });

  it("a default whose catalog entry is china-hosted or not auto is refused, for every purpose, and never called", async () => {
    // Every default is one of the three Claude models; make them all china-hosted while still flagged auto.
    const china = await withCatalog([], (m) => ({ ...m, hosting: "china", auto: true }));
    for (const p of PURPOSES) expect(() => china.route(p), p).toThrow(new RegExp(`^default_model_not_auto:${p}:`));
    const off = await withCatalog([], (m) => ({ ...m, auto: false }));
    for (const p of PURPOSES) expect(() => off.route(p), p).toThrow(/^default_model_not_auto:/);
  });

  it("a default that is not in the catalog at all is refused too", async () => {
    const gone = await withCatalog([], (m) => (m.id === SONNET ? { ...m, id: "claude-sonnet-renamed" } : m));
    expect(() => gone.route("review")).toThrow(/^default_model_not_auto:review:claude-sonnet-5$/);
    // A purpose whose default is still there is unaffected.
    expect(gone.route("generate").model).toBe(OPUS);
  });
});

describe("judge: a different model from the one that generated the batch, when there is a cheaper-or-equal alternative", () => {
  it("judge returns a different model from ctx.generatedBy when the catalog has an auto alternative", () => {
    // Sonnet 5 generated: Sonnet 5.5 has the same rates on every bucket and is the alternative.
    expect(route("judge", { generatedBy: SONNET })).toEqual({ model: SONNET55, overridden: false });
    // Otherwise the default already differs from the generating model.
    for (const generatedBy of [OPUS, SONNET55, undefined, "claude-unknown-9", ""]) expect(route("judge", { generatedBy }), String(generatedBy)).toEqual({ model: SONNET, overridden: false });
    // A judge never judges its own work, whichever Claude generated (the default or the alternative).
    for (const generatedBy of [OPUS, SONNET, SONNET55]) expect(route("judge", { generatedBy }).model, generatedBy).not.toBe(generatedBy);
  });

  it("the judge's own choice is never an override: overridden stays false and a stored pick is ignored", () => {
    expect(route("judge", { generatedBy: SONNET, stored: OPUS })).toEqual({ model: SONNET55, overridden: false });
  });

  it("the alternative must cost no more than the default judge on EVERY bucket, so the estimate stays an upper bound", async () => {
    // Cheaper on in and out, dearer on the cache write: not an alternative.
    const pricey = entry({ id: "test-dear-cache", rate: rate({ in: 1, out: 5, cacheRead: 0.1, cacheWrite: 3 }) });
    const a = await withCatalog([pricey], (m) => (m.id === SONNET55 ? { ...m, auto: false } : m));
    expect(a.route("judge", { generatedBy: SONNET }).model).toBe(SONNET);
    // Each bucket on its own, one cent over the default's rate.
    for (const over of [{ in: 2.01 }, { out: 10.01 }, { cacheRead: 0.21 }, { cacheWrite: 2.51 }]) {
      const b = await withCatalog([entry({ id: "test-over", rate: rate(over) })], (m) => (m.id === SONNET55 ? { ...m, auto: false } : m));
      expect(b.route("judge", { generatedBy: SONNET }).model, JSON.stringify(over)).toBe(SONNET);
    }
    // Equal on every bucket is allowed (Sonnet 5.5 is exactly that today).
    expect(route("judge", { generatedBy: SONNET }).model).toBe(SONNET55);
  });

  it("among alternatives it takes the lowest rate, then catalog order", async () => {
    const cheap = entry({ id: "test-cheap", rate: rate({ in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 }) });
    const cheaper = entry({ id: "test-cheaper", rate: rate({ in: 0.5, out: 2, cacheRead: 0.05, cacheWrite: 0.6 }) });
    const tieA = entry({ id: "test-tie-a", rate: rate({ in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 }) });
    const tieB = entry({ id: "test-tie-b", rate: rate({ in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 }) });
    expect((await withCatalog([cheap, cheaper])).route("judge", { generatedBy: SONNET }).model).toBe("test-cheaper");
    expect((await withCatalog([cheaper, cheap])).route("judge", { generatedBy: SONNET }).model).toBe("test-cheaper");
    // Equal rates: the one that comes first in the catalog.
    expect((await withCatalog([tieA, tieB])).route("judge", { generatedBy: SONNET }).model).toBe("test-tie-a");
    expect((await withCatalog([tieB, tieA])).route("judge", { generatedBy: SONNET }).model).toBe("test-tie-b");
  });

  it("only an auto, west-hosted entry can be the alternative: not an internal one, not a china one, not the generating model", async () => {
    const cheap = { rate: rate({ in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 }) };
    const r = await withCatalog([
      entry({ id: "test-internal", auto: false, pick: true, ...cheap }),
      entry({ id: "test-china", hosting: "china", auto: true, ...cheap }),
    ], (m) => (m.id === SONNET55 ? { ...m, auto: false } : m));
    expect(r.route("judge", { generatedBy: SONNET }).model).toBe(SONNET);
    // When the cheap west entry is the one that generated, it is skipped too.
    const s = await withCatalog([entry({ id: "test-west", ...cheap })]);
    expect(s.route("judge", { generatedBy: "test-west" }).model).toBe(SONNET);
    expect(s.route("judge", { generatedBy: SONNET }).model).toBe("test-west");
  });

  it("with no alternative the default stays, even when it generated the batch", async () => {
    const r = await withCatalog([], (m) => (m.id === SONNET ? m : { ...m, auto: false }));
    expect(() => r.route("review")).not.toThrow();
    expect(r.route("judge", { generatedBy: SONNET })).toEqual({ model: SONNET, overridden: false });
  });
});

describe("the catalog is untouched by routing", () => {
  it("route() reads the catalog and changes nothing in it", () => {
    const before = JSON.stringify(MODELS);
    for (const p of PURPOSES) route(p, { stored: OPUS, generatedBy: SONNET, confirmedChina: true });
    expect(JSON.stringify(MODELS)).toBe(before);
  });
});
