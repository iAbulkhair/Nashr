import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MODELS, autoModels, modelById, pickModels, pickerView, toPickerView, validateCatalog, type ModelEntry } from "@/lib/models/catalog";
import { TIERS, TIER_MULTIPLIER } from "@/lib/models/tiers";
import { costUsd, hasRate } from "@/lib/usage";
import { checkModels, missingIds, modelsUrl, parseModelList } from "../scripts/check-models";

/**
 * The model catalog (spec 2026-10-08-straitly-model-routing, sections 3 and 6): which models exist, which tier prices
 * them, what each costs us. Server and test only, except `tiers.ts`, which the browser may import.
 *
 * Tests that need a China-hosted entry, a model nobody may pick or a broken rate build their own lists and feed them to
 * `validateCatalog` / `toPickerView`; the real `MODELS` is never edited to make a test pass.
 */

/** A valid non-Claude style entry; every test overrides only what it is about. */
const entry = (o: Partial<ModelEntry> & { id: string }): ModelEntry => ({
  label: { ar: "نموذج تجريبي", en: "Test model" },
  vendor: "acme",
  hosting: "west",
  tier: "standard",
  dialect: "chat",
  caps: { tools: true, strict: false, thinking: false, cache: true, vision: false },
  rate: { in: 1, out: 4, cacheRead: 0.1, cacheWrite: 1.25 },
  auto: false,
  pick: true,
  ...o,
});

const CLAUDE = ["claude-opus-5", "claude-sonnet-5", "claude-sonnet-5-5"] as const;
const imports = (file: string) => readFileSync(file, "utf8").split("\n").filter((l) => /^\s*(import|export\s+(\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from)\s/.test(l) || /\brequire\(|\bimport\(/.test(l));

describe("tiers", () => {
  it("the tier multipliers are economy 0.6, standard 1, premium 2, and cannot be changed at run time", () => {
    expect(TIER_MULTIPLIER).toEqual({ economy: 0.6, standard: 1, premium: 2 });
    expect([...TIERS]).toEqual(["economy", "standard", "premium"]);
    expect(Object.isFrozen(TIER_MULTIPLIER)).toBe(true);
    // That tiers.ts imports nothing (the browser may import it) is pinned in tests/client-bundle.test.ts.
  });
});

describe("the real catalog", () => {
  it("catalog ids are unique", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry with hosting china has auto false", () => {
    for (const m of MODELS.filter((x) => x.hosting === "china")) expect(m.auto, m.id).toBe(false);
  });

  it("every entry has all four rates and rate.cacheRead < rate.in < rate.cacheWrite", () => {
    expect(MODELS.length).toBeGreaterThan(0);
    for (const m of MODELS) {
      for (const k of ["in", "out", "cacheRead", "cacheWrite"] as const) {
        expect(Number.isFinite(m.rate[k]) && m.rate[k] > 0, `${m.id}.rate.${k}`).toBe(true);
      }
      expect(m.rate.cacheRead, m.id).toBeLessThan(m.rate.in);
      expect(m.rate.in, m.id).toBeLessThan(m.rate.cacheWrite);
    }
  });

  it("passes its own validator, so a bad edit to MODELS fails here with the reason", () => {
    expect(validateCatalog(MODELS)).toEqual([]);
  });

  it("modelById returns undefined for constructor, __proto__, toString, non-strings and unknown ids", () => {
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype", "", "claude-unknown-9", " claude-opus-5", "CLAUDE-OPUS-5"]) {
      expect(modelById(id), JSON.stringify(id)).toBeUndefined();
    }
    for (const id of [undefined, null, 5, true, {}, [], ["claude-opus-5"], { id: "claude-opus-5" }, Symbol("claude-opus-5"), () => "claude-opus-5"]) {
      expect(modelById(id), String(typeof id)).toBeUndefined();
    }
    for (const m of MODELS) expect(modelById(m.id)).toBe(m);
  });

  it("the three Claude models used today are in the catalog with auto true", () => {
    for (const id of CLAUDE) {
      const m = modelById(id);
      expect(m, id).toBeDefined();
      expect(m).toMatchObject({ vendor: "anthropic", hosting: "west", dialect: "messages", auto: true, pick: true });
      expect(m!.caps, id).toEqual({ tools: true, strict: true, thinking: true, cache: true, vision: true });
      expect(autoModels().map((x) => x.id)).toContain(id);
      expect(pickModels().map((x) => x.id)).toContain(id);
    }
    expect(modelById("claude-opus-5")!.tier).toBe("premium");
    expect(modelById("claude-sonnet-5")!.tier).toBe("standard");
    expect(modelById("claude-sonnet-5-5")!.tier).toBe("standard");
    // Until the Straitly spike has run, these three are the whole catalog (plan Task 1 adds the rest).
    expect(MODELS.map((m) => m.id).sort()).toEqual([...CLAUDE].sort());
  });

  it("every label has an Arabic and an English text", () => {
    for (const m of MODELS) {
      expect(m.label.ar.trim().length, m.id).toBeGreaterThan(0);
      expect(m.label.en.trim().length, m.id).toBeGreaterThan(0);
    }
  });

  it("pickerView has no rate field", () => {
    const view = pickerView();
    expect(view.map((v) => v.id).sort()).toEqual(pickModels().map((m) => m.id).sort());
    for (const v of view) expect(Object.keys(v).sort(), v.id).toEqual(["hosting", "id", "label", "tier", "tools"]);
    // `tools` is the one capability the picker needs (the chat list shows only entries that can run chat's tools), as a
    // plain boolean; the rest of `caps` stays on the server.
    for (const v of view) expect(v.tools, v.id).toBe(modelById(v.id)!.caps.tools);
    // Keys, not words: a future label may contain "rate" ("Accurate") without leaking one.
    expect(JSON.stringify(view)).not.toMatch(/"(rate|in|out|cacheRead|cacheWrite|caps|strict|thinking|cache|vision|dialect|vendor|auto|pick|tasks)"\s*:/);
    // A copy: a caller that changes the view does not change the catalog.
    view[0].label.en = "changed";
    view[0].tier = "economy";
    expect(modelById(view[0].id)!.label.en).not.toBe("changed");
    expect(modelById(view[0].id)!.tier).not.toBe("economy");
  });

  it("the catalog and its rates cannot be changed at run time", () => {
    const m = modelById("claude-opus-5")!;
    expect(Object.isFrozen(MODELS) && Object.isFrozen(m) && Object.isFrozen(m.rate) && Object.isFrozen(m.label) && Object.isFrozen(m.caps)).toBe(true);
    expect(() => { (m.rate as { in: number }).in = 0; }).toThrow();
    expect(() => { (MODELS as ModelEntry[]).push(entry({ id: "x" })); }).toThrow();
  });

  it("catalog.ts imports only the tier types: not usage.ts (no cycle), not the store, not the SDK", () => {
    const lines = imports("src/lib/models/catalog.ts");
    expect(lines.every((l) => /from\s+["']\.\/tiers["']/.test(l)), lines.join("\n")).toBe(true);
  });
});

describe("validateCatalog and toPickerView on lists built here", () => {
  it("accepts a good list, a China-hosted entry that automatic routing may not use included", () => {
    const list = [entry({ id: "a", auto: true }), entry({ id: "b", hosting: "china", auto: false, tier: "economy" })];
    expect(validateCatalog(list)).toEqual([]);
  });

  it("reports a duplicate id", () => {
    expect(validateCatalog([entry({ id: "a" }), entry({ id: "a" })]).join("\n")).toMatch(/duplicate id "a"/);
  });

  it("reports a China-hosted entry that automatic routing could use", () => {
    expect(validateCatalog([entry({ id: "cn", hosting: "china", auto: true })]).join("\n")).toMatch(/cn.*china.*auto/i);
  });

  it("reports a missing, zero, negative or non-finite rate and a broken cacheRead < in < cacheWrite order", () => {
    const bad = (rate: Partial<ModelEntry["rate"]>) => validateCatalog([entry({ id: "r", rate: { in: 1, out: 4, cacheRead: 0.1, cacheWrite: 1.25, ...rate } })]);
    expect(bad({})).toEqual([]);
    expect(bad({ out: 0 }).join("\n")).toMatch(/rate\.out/);
    expect(bad({ in: -1 }).join("\n")).toMatch(/rate\.in/);
    expect(bad({ cacheRead: Number.NaN }).join("\n")).toMatch(/rate\.cacheRead/);
    expect(bad({ cacheWrite: Number.POSITIVE_INFINITY }).join("\n")).toMatch(/rate\.cacheWrite/);
    expect(bad({ cacheRead: undefined as unknown as number }).join("\n")).toMatch(/rate\.cacheRead/);
    expect(bad({ cacheRead: 1 }).join("\n")).toMatch(/cacheRead < in < cacheWrite/);
    expect(bad({ cacheWrite: 1 }).join("\n")).toMatch(/cacheRead < in < cacheWrite/);
  });

  it("reports an unknown tier, hosting or dialect, an empty label and a missing vendor", () => {
    const out = validateCatalog([
      entry({ id: "t", tier: "gold" as never }),
      entry({ id: "h", hosting: "moon" as never }),
      entry({ id: "d", dialect: "grpc" as never }),
      entry({ id: "l", label: { ar: "", en: "x" } }),
      entry({ id: "v", vendor: "" }),
      entry({ id: "constructor", tier: "constructor" as never }),
    ]).join("\n");
    for (const re of [/"t".*tier/, /"h".*hosting/, /"d".*dialect/, /"l".*label/, /"v".*vendor/, /"constructor".*tier/]) expect(out).toMatch(re);
  });

  it("toPickerView lists only entries a customer may pick, with hosting so the picker can say where it runs and tools so chat can leave out what cannot run its tools", () => {
    const noTools = entry({ id: "nt" });
    const list = [entry({ id: "a", pick: true }), entry({ id: "hidden", pick: false, auto: true }), entry({ id: "cn", hosting: "china", tier: "economy" }), { ...noTools, caps: { ...noTools.caps, tools: false } }];
    expect(toPickerView(list)).toEqual([
      { id: "a", label: { ar: "نموذج تجريبي", en: "Test model" }, tier: "standard", hosting: "west", tools: true },
      { id: "cn", label: { ar: "نموذج تجريبي", en: "Test model" }, tier: "economy", hosting: "china", tools: true },
      { id: "nt", label: { ar: "نموذج تجريبي", en: "Test model" }, tier: "standard", hosting: "west", tools: false },
    ]);
    expect(JSON.stringify(toPickerView(list))).not.toContain("rate");
  });
});

describe("costUsd and hasRate read the catalog first", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 };

  it("costUsd of a catalog model uses its catalog rate", () => {
    for (const m of MODELS) {
      const r = m.rate;
      expect(costUsd(m.id, usage), m.id).toBeCloseTo(r.in + r.out + r.cacheRead + r.cacheWrite, 9);
      expect(costUsd(m.id, { input_tokens: 500_000 }), m.id).toBeCloseTo(0.5 * r.in, 9);
      expect(costUsd(m.id, { output_tokens: 500_000 }), m.id).toBeCloseTo(0.5 * r.out, 9);
    }
  });

  it("the three Claude models cost what the Anthropic list price said before the catalog (no margin change)", () => {
    expect(costUsd("claude-opus-5", usage)).toBeCloseTo(5 + 25 + 0.5 + 6.25, 9);
    expect(costUsd("claude-sonnet-5", usage)).toBeCloseTo(2 + 10 + 0.2 + 2.5, 9);
    expect(costUsd("claude-sonnet-5-5", usage)).toBeCloseTo(2 + 10 + 0.2 + 2.5, 9);
  });

  it("an id in neither table is priced as Opus, as before, and `constructor` is not a rate", () => {
    const opus = costUsd("claude-opus-5", usage);
    for (const id of ["claude-unknown-9", "constructor", "__proto__", "toString", ""]) {
      expect(costUsd(id, usage), id).toBeCloseTo(opus, 9);
      expect(Number.isFinite(costUsd(id, usage)), id).toBe(true);
    }
  });

  it("hasRate is true for a catalog model, false for an id in neither table", () => {
    for (const m of MODELS) expect(hasRate(m.id), m.id).toBe(true);
    for (const id of ["claude-unknown-9", "constructor", "__proto__", "toString", ""]) expect(hasRate(id), id).toBe(false);
  });

  describe("with a catalog that differs from the old table", () => {
    afterEach(() => {
      vi.doUnmock("@/lib/models/catalog");
      vi.resetModules();
    });

    it("the catalog rate wins, the old table answers for an id the catalog lacks, and hasRate is true for either", async () => {
      vi.resetModules();
      vi.doMock("@/lib/models/catalog", () => ({
        modelById: (id: unknown) =>
          id === "gateway-only" ? { rate: { in: 1, out: 2, cacheRead: 0.1, cacheWrite: 1.5 } }
          : id === "claude-sonnet-5" ? { rate: { in: 7, out: 7, cacheRead: 1, cacheWrite: 8 } }
          : undefined,
      }));
      const u = await import("@/lib/usage");
      // catalog first: the old table says 2/10/0.2/2.5 for this id
      expect(u.costUsd("claude-sonnet-5", usage)).toBeCloseTo(7 + 7 + 1 + 8, 9);
      expect(u.costUsd("gateway-only", usage)).toBeCloseTo(1 + 2 + 0.1 + 1.5, 9);
      // not in the (stubbed) catalog: the old table
      expect(u.costUsd("claude-opus-5", usage)).toBeCloseTo(5 + 25 + 0.5 + 6.25, 9);
      // in neither: the Opus default
      expect(u.costUsd("nobody", usage)).toBeCloseTo(5 + 25 + 0.5 + 6.25, 9);
      expect(u.hasRate("gateway-only")).toBe(true);
      expect(u.hasRate("claude-opus-5")).toBe(true);
      expect(u.hasRate("nobody")).toBe(false);
    });
  });
});

describe("scripts/check-models.ts", () => {
  const KEY = "sk-test-SENTINEL-do-not-print";
  type F = (url: string, init: RequestInit) => Promise<Response>;
  const ok = (ids: string[]): F => async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
  const all = () => MODELS.map((m) => m.id);

  it("builds the list URL from the base: no double slash, no /v1 added twice by the default", () => {
    expect(modelsUrl("https://api.straitly.ai")).toBe("https://api.straitly.ai/v1/models");
    expect(modelsUrl("https://api.straitly.ai/")).toBe("https://api.straitly.ai/v1/models");
  });

  it("reads the id of every entry of the list, and nothing from a body of another shape", () => {
    expect(parseModelList({ data: [{ id: "a" }, { id: "b", extra: 1 }] })).toEqual(["a", "b"]);
    for (const body of [null, undefined, "x", 5, {}, { data: "x" }, { data: [{ id: 5 }] }, { data: [null] }]) expect(parseModelList(body), JSON.stringify(body)).toBeNull();
  });

  it("names the catalog ids the list lacks", () => {
    expect(missingIds(["a", "b", "c"], ["b", "x"])).toEqual(["a", "c"]);
    expect(missingIds(["a"], ["a"])).toEqual([]);
  });

  it("with no key it exits non-zero with a message and makes no request", async () => {
    const f = vi.fn<F>();
    for (const env of [{}, { STRAITLY_API_KEY: "" }, { STRAITLY_API_KEY: "   " }]) {
      const r = await checkModels(env, f);
      expect(r.code, JSON.stringify(env)).not.toBe(0);
      expect(r.lines.join("\n")).toMatch(/STRAITLY_API_KEY/);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("exits 0 when every catalog id is in the list, and sends the key only as a bearer header to /v1/models", async () => {
    const f = vi.fn<F>(ok([...all(), "some-other-model"]));
    const r = await checkModels({ STRAITLY_API_KEY: KEY }, f);
    expect(r.code).toBe(0);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.straitly.ai/v1/models");
    expect(init.method ?? "GET").toBe("GET");
    expect((init.headers as Record<string, string>).authorization ?? (init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(r.lines.join("\n")).not.toContain(KEY);
  });

  it("exits non-zero and names the ids the list lacks", async () => {
    const r = await checkModels({ STRAITLY_API_KEY: KEY }, ok(all().slice(1)));
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain(all()[0]);
    expect(r.lines.join("\n")).not.toContain(KEY);
    const r2 = await checkModels({ STRAITLY_API_KEY: KEY }, ok(all()), [...all(), "ghost-model-1"]);
    expect(r2.code).toBe(1);
    expect(r2.lines.join("\n")).toContain("ghost-model-1");
  });

  it("a refused request, a network error, an unreadable body or a paginated list is an error, never a pass, and never prints the key", async () => {
    const cases: Array<[string, () => Promise<Response>]> = [
      ["401", async () => new Response(`bad key ${KEY}`, { status: 401 })],
      ["500", async () => new Response("down", { status: 500 })],
      ["network", async () => { throw new Error(`socket closed for ${KEY}`); }],
      ["not json", async () => new Response("<html>", { status: 200 })],
      ["wrong shape", async () => new Response(JSON.stringify({ models: [] }), { status: 200 })],
      ["paginated", async () => new Response(JSON.stringify({ data: all().map((id) => ({ id })), has_more: true }), { status: 200 })],
    ];
    for (const [name, f] of cases) {
      const r = await checkModels({ STRAITLY_API_KEY: KEY }, f);
      expect(r.code, name).toBe(2);
      expect(r.lines.join("\n"), name).not.toContain(KEY);
    }
  });

  it("refuses a base URL that is not https (loopback excepted) before any request, so the key never travels in clear", async () => {
    const f = vi.fn<F>(ok(all()));
    for (const base of ["http://api.straitly.ai", "ftp://x", "not a url", "http://localhost.evil.test"]) {
      const r = await checkModels({ STRAITLY_API_KEY: KEY, STRAITLY_BASE_URL: base }, f);
      expect(r.code, base).toBe(2);
      expect(r.lines.join("\n"), base).not.toContain(KEY);
    }
    expect(f).not.toHaveBeenCalled();
    const r = await checkModels({ STRAITLY_API_KEY: KEY, STRAITLY_BASE_URL: "http://127.0.0.1:8787" }, f);
    expect(r.code).toBe(0);
    expect(f.mock.calls[0][0]).toBe("http://127.0.0.1:8787/v1/models");
  });
});
