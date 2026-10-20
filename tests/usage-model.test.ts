import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Metering by model and provider, and the rejected-pick counter (spec 2026-10-08-straitly-model-routing, sections 4, 5
 * and 8; plan Task 8). `meter` adds four GLOBAL counters per call, `usage:_all:{month}:model:{key}:{calls|usd_micro}` and
 * `usage:_all:{month}:provider:{provider}:{calls|usd_micro}`; a pick `route()` refused adds one to
 * `usage:_all:{month}:pickreject:{purpose}:{reason}`. None of them has an account in its key, so `wipeAccount` has nothing
 * to miss and a model that leaves the catalog cannot leave an account-linked key behind. `getUsage("_all")` returns them
 * (`models`, `providers`, `rejectedPicks`); `getUsage(email)` returns them empty and reads nothing extra.
 *
 * Most tests pin the clock to a month of their own (Date only), so the global counters of one test never count in another.
 * The chat route and `generateBatch` run for real against a scripted SDK.
 */
const sdk = vi.hoisted(() => ({ calls: [] as { api: "generate" | "stream" | "create"; model: string }[], usage: { input_tokens: 1000, output_tokens: 200 } }));

/** A patched allow-list for Sonnet 5.5 (no pickable model has one since rule 902), so the task_not_allowed fallback stays tested. */
const cat = vi.hoisted(() => ({ sonnetTasks: undefined as readonly string[] | undefined }));
vi.mock("@/lib/models/catalog", async (orig) => {
  const m = await orig<typeof import("@/lib/models/catalog")>();
  const byId = (id: unknown) => {
    const e = m.modelById(id);
    return e && cat.sonnetTasks && e.id === "claude-sonnet-5-5" ? { ...e, tasks: cat.sonnetTasks } : e;
  };
  return { ...m, modelById: byId };
});
vi.mock("@anthropic-ai/sdk", () => {
  const items = JSON.stringify([{ channel: "instagram", title: "قهوة اليوم", body: "نص تجريبي للعنصر يكفي للمراجعة" }]);
  const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };
  const sysText = (s: unknown): string => (typeof s === "string" ? s : Array.isArray(s) ? String((s[0] as { text?: string } | undefined)?.text ?? "") : "");
  const answer = (model: string, text: string) => ({ model, stop_reason: "end_turn", usage: sdk.usage, content: [{ type: "text", text }] });
  return {
    default: class {
      static BadRequestError = class extends Error {};
      beta = {
        messages: {
          stream: (p: { model: string }) => ({
            finalMessage: async () => {
              sdk.calls.push({ api: "generate", model: p.model });
              return answer(p.model, items);
            },
          }),
        },
      };
      messages = {
        chat: (p: { model: string }) => ({
          finalMessage: async () => {
            sdk.calls.push({ api: "stream", model: p.model });
            return answer(p.model, "أهلاً");
          },
        }),
        create: async (p: { model: string; system: unknown }) => {
          sdk.calls.push({ api: "create", model: p.model });
          if (sysText(p.system).startsWith("You are the quality judge")) return answer(p.model, JSON.stringify([verdict, verdict, verdict, verdict, verdict]));
          return answer(p.model, JSON.stringify([{ ok: true, id: 1, verdict: "ok" }]));
        },
        stream(p: { tools?: unknown; tool_choice?: unknown; output_config?: { format?: unknown } }, o?: unknown) { return (p.tools && !p.tool_choice) || p.output_config?.format ? (this.chat as (...a: unknown[]) => unknown)(p, o) : { finalMessage: async () => (this.create as (...a: unknown[]) => unknown)(p, o) }; },
      };
    },
  };
});

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import { currentUser, getUser, saveUser, sc, type User } from "@/lib/auth";
import type { Brand } from "@/lib/brand";
import { wipeAccount } from "@/lib/account";
import { createConversation, type Conversation } from "@/lib/conversations";
import { MODELS } from "@/lib/models/catalog";
import { DEFAULTS, type Rejected } from "@/lib/models/route";
import { generateBatch } from "@/lib/generate-batch";
import { overview } from "@/lib/admin-stats";
import { costUsd, getUsage, meter, noteRejectedPick, usageMonthKeys } from "@/lib/usage";
import { json, newUser, settle, signIn, signOut } from "./helpers/session";
import { adminConsoleSrc } from "./helpers/admin-console";
import * as chatRoute from "@/app/api/chat/route";
import * as overviewRoute from "@/app/api/admin/overview/route";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const SONNET55 = "claude-sonnet-5-5";
/** A third model, for a month that saw only it (rule 970: Opus 5 and Sonnet 5 left the catalog). */
const HAIKU = "claude-haiku-5-5";

type Mem = { kv: Map<string, unknown>; lists: Map<string, string[]>; sets: Map<string, Set<string>> };
const mem = () => (globalThis as unknown as { __nashrMem: Mem }).__nashrMem;
const allKeys = () => [...mem().kv.keys(), ...mem().lists.keys(), ...mem().sets.keys()];
/** The micro-dollars `meter` writes for one call, the same arithmetic. */
const micro = (model: string, u: Parameters<typeof costUsd>[1]) => Math.round(costUsd(model, u) * 1e6);
/** `getUsage`'s rounding of a micro-dollar total. */
const usdOf = (m: number) => Math.round(m / 100) / 1e4;
const pin = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

const U_OPUS = { input_tokens: 1000, output_tokens: 1000 }; // 0.024 USD
const U_SONNET = { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 3000 }; // 0.0096 USD
const U_SMALL = { input_tokens: 10, output_tokens: 10 }; // 0.00024 USD on Opus 5.5

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  vi.stubEnv("LLM_PROVIDER", "");
  vi.stubEnv("STRAITLY_API_KEY", ""); // the machine running the tests may carry one: the default provider depends on it
  sdk.calls = [];
});
afterEach(async () => {
  vi.useRealTimers();
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("meter records calls and money per model", () => {
  it("two models: calls and micro-dollars per model match costUsd, and getUsage('_all') returns them", async () => {
    pin("2031-01-15T12:00:00Z");
    const u = await newUser("um-two");
    await meter(u.email, OPUS, "generate", U_OPUS);
    await meter(u.email, SONNET, "judge", U_SONNET);
    await meter(u.email, OPUS, "chat", U_SMALL, "sami");
    expect(await db.get("usage:_all:2031-01:model:claude-opus-5-5:calls")).toBe(2);
    expect(await db.get("usage:_all:2031-01:model:claude-opus-5-5:usd_micro")).toBe(micro(OPUS, U_OPUS) + micro(OPUS, U_SMALL));
    expect(await db.get("usage:_all:2031-01:model:claude-sonnet-5-5:calls")).toBe(1);
    expect(await db.get("usage:_all:2031-01:model:claude-sonnet-5-5:usd_micro")).toBe(micro(SONNET, U_SONNET));
    // The same numbers, hard-coded, so a change of rate or of rounding shows here too.
    expect(micro(OPUS, U_OPUS)).toBe(24000);
    expect(micro(SONNET, U_SONNET)).toBe(9600);
    expect(micro(OPUS, U_SMALL)).toBe(240);

    const all = await getUsage("_all", "2031-01");
    expect(all.models).toEqual({ [OPUS]: { calls: 2, usd: usdOf(24240) }, [SONNET]: { calls: 1, usd: usdOf(9600) } });
    // Only entries with calls: the catalog's third model has none this month.
    expect(all.models).not.toHaveProperty(HAIKU);
    // The per-model numbers add up to the month's totals.
    expect(Object.values(all.models).reduce((s, m) => s + m.calls, 0)).toBe(all.calls);
    expect(Math.round(Object.values(all.models).reduce((s, m) => s + m.usd, 0) * 100) / 100).toBe(all.usd);
  });

  it("a call with no usage writes nothing, and an anonymous call (no email) still counts globally", async () => {
    pin("2031-10-20T12:00:00Z");
    await meter(undefined, HAIKU, "tool", null);
    await meter(undefined, HAIKU, "tool", undefined);
    expect((await getUsage("_all", "2031-10")).models).toEqual({});
    await meter(undefined, HAIKU, "tool", U_SMALL);
    expect((await getUsage("_all", "2031-10")).models).toEqual({ [HAIKU]: { calls: 1, usd: usdOf(micro(HAIKU, U_SMALL)) } });
  });
});

describe("meter records the provider", () => {
  it("the provider the client really uses by default: anthropic when LLM_PROVIDER is unset or a typo, straitly only with LLM_PROVIDER=straitly AND the Straitly key, anthropic for straitly with only the Anthropic key", async () => {
    pin("2031-02-10T12:00:00Z");
    const u = await newUser("um-prov-default");
    // 1. Unset, and a typo even with a Straitly key lying around: Anthropic.
    await meter(u.email, OPUS, "generate", U_OPUS);
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("STRAITLY_API_KEY", "gw-test-key");
    await meter(u.email, OPUS, "generate", U_OPUS);
    expect((await getUsage("_all", "2031-02")).providers).toEqual({ anthropic: { calls: 2, usd: usdOf(48000) } });
    // 2. Straitly with its key: the gateway.
    vi.stubEnv("LLM_PROVIDER", "straitly");
    await meter(u.email, SONNET, "judge", U_SONNET);
    expect(await db.get("usage:_all:2031-02:provider:straitly:calls")).toBe(1);
    expect(await db.get("usage:_all:2031-02:provider:straitly:usd_micro")).toBe(9600);
    expect((await getUsage("_all", "2031-02")).providers).toEqual({ anthropic: { calls: 2, usd: usdOf(48000) }, straitly: { calls: 1, usd: usdOf(9600) } });
    // 3. Straitly without its key but with ANTHROPIC_API_KEY (a supported setup): anthropic() builds the plain Anthropic
    // client, every call goes direct, so it is counted under anthropic and not under the gateway.
    vi.stubEnv("STRAITLY_API_KEY", "");
    await meter(u.email, SONNET, "judge", U_SONNET);
    expect((await getUsage("_all", "2031-02")).providers).toEqual({ anthropic: { calls: 3, usd: usdOf(57600) }, straitly: { calls: 1, usd: usdOf(9600) } });
    expect(allKeys().filter((k) => k.startsWith("usage:_all:2031-02:provider:")).sort()).toEqual([
      "usage:_all:2031-02:provider:anthropic:calls", "usage:_all:2031-02:provider:anthropic:usd_micro",
      "usage:_all:2031-02:provider:straitly:calls", "usage:_all:2031-02:provider:straitly:usd_micro",
    ]);
  });

  it("an explicit provider overrides the effective one, in both directions, whatever the keys", async () => {
    pin("2031-11-11T12:00:00Z");
    const u = await newUser("um-prov-explicit");
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    await meter(u.email, SONNET, "judge", U_SONNET, undefined, "straitly");
    vi.stubEnv("LLM_PROVIDER", "straitly");
    vi.stubEnv("STRAITLY_API_KEY", "gw-test-key");
    await meter(u.email, OPUS, "generate", U_OPUS, "faris", "anthropic");
    expect((await getUsage("_all", "2031-11")).providers).toEqual({ straitly: { calls: 1, usd: usdOf(9600) }, anthropic: { calls: 1, usd: usdOf(24000) } });
  });

  it("a provider that is not one of the two is ignored: the effective one is used and no other key is made", async () => {
    pin("2031-12-12T12:00:00Z");
    const u = await newUser("um-prov-bogus");
    vi.stubEnv("LLM_PROVIDER", "straitly");
    vi.stubEnv("STRAITLY_API_KEY", "gw-test-key"); // so the effective default is straitly, not the other value
    const bogus: unknown[] = ["openai", "constructor", "__proto__", "straitly:calls", "evil\nusage:x", "", "ANTHROPIC", 7, null, {}, ["anthropic"]];
    for (const p of bogus) await meter(u.email, OPUS, "generate", U_SMALL, undefined, p as never);
    expect((await getUsage("_all", "2031-12")).providers).toEqual({ straitly: { calls: bogus.length, usd: usdOf(240 * bogus.length) } });
    const keys = allKeys().filter((k) => k.startsWith("usage:_all:2031-12:provider:"));
    expect(keys.sort()).toEqual(["usage:_all:2031-12:provider:straitly:calls", "usage:_all:2031-12:provider:straitly:usd_micro"]);
  });
});

describe("requests the gateway sent direct", () => {
  it("one global counter (written by src/lib/model.ts), returned by getUsage('_all') as fallbacks and never as a provider; an account's read is 0", async () => {
    const k = "usage:_all:2032-02:provider:fallback";
    await db.incrby(k, 3);
    const all = await getUsage("_all", "2032-02");
    expect(all.fallbacks).toBe(3);
    expect(all.providers).toEqual({});
    const u = await newUser("um-fallback");
    expect((await getUsage(u.email, "2032-02")).fallbacks).toBe(0);
    expect((await getUsage("_all", "2032-03")).fallbacks).toBe(0);
  });
});

describe("the model key is never a free string", () => {
  it("an unknown id, a prototype name, or an id with ':' or whitespace lands in 'other' and creates no other key", async () => {
    pin("2031-03-10T12:00:00Z");
    const u = await newUser("um-hostile");
    const hostile: unknown[] = ["constructor", "__proto__", "toString", "hasOwnProperty", "claude-opus-5:calls", "claude-opus-5 ", " claude-opus-5", "CLAUDE-OPUS-5", "claude opus 5", "x\nusage:evil@test.example:2031-03:calls", "", "claude-unknown-9", "anthropic/claude-opus-5", "claude-opus-5-20261001", "claude-opus-5", "claude-sonnet-5", 5, null, undefined, {}];
    const before = new Set(allKeys());
    for (const model of hostile) await meter(u.email, model as string, "generate", U_SMALL);
    await meter(undefined, "a:b", "tool", U_SMALL);
    const modelKeys = allKeys().filter((k) => k.startsWith("usage:_all:2031-03:model:")).sort();
    expect(modelKeys).toEqual(["usage:_all:2031-03:model:other:calls", "usage:_all:2031-03:model:other:usd_micro"]);
    expect(await db.get("usage:_all:2031-03:model:other:calls")).toBe(hostile.length + 1);
    // Whatever the id (a retired one included, rule 970), the money is priced at the highest catalog rates: 240 micro-dollars each.
    expect(await db.get("usage:_all:2031-03:model:other:usd_micro")).toBe(240 * (hostile.length + 1));
    const made = allKeys().filter((k) => !before.has(k));
    expect(made.filter((k) => /evil|hasOwnProperty|constructor|__proto__/.test(k)), "an id leaked into a key").toEqual([]);
    expect((await getUsage("_all", "2031-03")).models).toEqual({ other: { calls: hostile.length + 1, usd: usdOf(240 * (hostile.length + 1)) } });
  });

  it("every catalog id has its own key", async () => {
    pin("2031-04-11T12:00:00Z");
    for (const m of MODELS) await meter(undefined, m.id, "tool", U_SMALL);
    expect(Object.keys((await getUsage("_all", "2031-04")).models).sort()).toEqual(MODELS.map((m) => m.id).sort());
  });
});

describe("months written before this release", () => {
  it("rows with only the old counters read back with empty models, providers and rejected picks, and correct old totals", async () => {
    const k = "usage:_all:2030-12";
    await Promise.all([
      db.incrby(`${k}:in`, 5000), db.incrby(`${k}:out`, 2000), db.incrby(`${k}:calls`, 7), db.incrby(`${k}:usd_micro`, 123456),
      db.incrby(`${k}:kind:generate`, 4), db.incrby(`${k}:kind:generate:in`, 3000), db.incrby(`${k}:kind:generate:out`, 1500), db.incrby(`${k}:kind:generate:usd_micro`, 100000),
      db.incrby(`${k}:agent:faris:calls`, 4), db.incrby(`${k}:agent:faris:usd_micro`, 100000),
    ]);
    const old = await getUsage("_all", "2030-12");
    expect(old).toMatchObject({ month: "2030-12", in: 5000, out: 2000, calls: 7, usd: 0.12, kinds: { generate: 4 }, byKind: { generate: { calls: 4, in: 3000, out: 1500, usd: 0.1 } }, byAgent: { faris: { calls: 4, usd: 0.1 } } });
    expect(old.models).toEqual({});
    expect(old.providers).toEqual({});
    expect(old.rejectedPicks).toEqual({});
    expect(old.fallbacks).toBe(0);
  });

  it("a month with new calls on top of old ones: the old calls are in the totals only, the new ones in models", async () => {
    pin("2031-05-10T12:00:00Z");
    const k = "usage:_all:2031-05";
    await Promise.all([db.incrby(`${k}:calls`, 3), db.incrby(`${k}:usd_micro`, 90000), db.incrby(`${k}:in`, 100), db.incrby(`${k}:out`, 100)]);
    await meter(undefined, OPUS, "generate", U_OPUS);
    const s = await getUsage("_all", "2031-05");
    expect(s.calls).toBe(4);
    expect(s.models).toEqual({ [OPUS]: { calls: 1, usd: 0.024 } });
  });
});

describe("getUsage for one account", () => {
  it("returns empty models, providers and rejected picks, and reads none of the global counters", async () => {
    pin("2031-06-10T12:00:00Z");
    const u = await newUser("um-account");
    await meter(u.email, OPUS, "generate", U_OPUS);
    await noteRejectedPick("chat", "unknown");
    const mget = vi.spyOn(db, "mget");
    const get = vi.spyOn(db, "get");
    const mine = await getUsage(u.email, "2031-06");
    expect(mine.calls).toBe(1);
    expect(mine.models).toEqual({});
    expect(mine.providers).toEqual({});
    expect(mine.rejectedPicks).toEqual({});
    expect(mine.fallbacks).toBe(0);
    expect(mget, "no extra round trip per account in the founder's user list").not.toHaveBeenCalled();
    expect(get.mock.calls.map((c) => String(c[0])).filter((key) => /:model:|:provider:|:pickreject:/.test(key))).toEqual([]);
    // The global view of the same month has them.
    expect((await getUsage("_all", "2031-06")).models).toEqual({ [OPUS]: { calls: 1, usd: 0.024 } });
  });
});

describe("noteRejectedPick", () => {
  it("counts per purpose and reason, globally, and getUsage('_all') returns only the non-zero ones", async () => {
    pin("2031-07-10T12:00:00Z");
    await noteRejectedPick("chat", "not_pickable");
    await noteRejectedPick("chat", "not_pickable");
    await noteRejectedPick("generate", "task_not_allowed");
    expect(await db.get("usage:_all:2031-07:pickreject:chat:not_pickable")).toBe(2);
    expect(await db.get("usage:_all:2031-07:pickreject:generate:task_not_allowed")).toBe(1);
    expect((await getUsage("_all", "2031-07")).rejectedPicks).toEqual({ "chat:not_pickable": 2, "generate:task_not_allowed": 1 });
    // Every reason of the union has a counter (a new reason added to `Rejected` must be counted, not ignored).
    const reasons: Rejected[] = ["unknown", "not_pickable", "china_unconfirmed", "needs_tools", "task_not_allowed"];
    for (const r of reasons) { await noteRejectedPick("chat", r); await noteRejectedPick("generate", r); }
    const s = (await getUsage("_all", "2031-07")).rejectedPicks;
    expect(Object.keys(s).sort()).toEqual(reasons.flatMap((r) => [`chat:${r}`, `generate:${r}`]).sort());
  });

  it("a purpose or reason that is not on the fixed lists is ignored, never keyed, and never throws", async () => {
    pin("2032-01-11T12:00:00Z");
    const before = new Set(allKeys());
    const badPurpose: unknown[] = ["tool", "review", "constructor", "__proto__", "chat:unknown", "", "CHAT", undefined, null, 5, {}];
    const badReason: unknown[] = ["bogus", "constructor", "__proto__", "unknown:x", "x\nusage:evil", "", "UNKNOWN", undefined, null, 5, {}];
    for (const p of badPurpose) await expect(noteRejectedPick(p as never, "unknown")).resolves.toBeUndefined();
    for (const r of badReason) await expect(noteRejectedPick("chat", r as never)).resolves.toBeUndefined();
    for (const p of badPurpose) for (const r of badReason) await noteRejectedPick(p as never, r as never);
    expect(allKeys().filter((k) => !before.has(k) && k.includes("pickreject"))).toEqual([]);
    expect((await getUsage("_all", "2032-01")).rejectedPicks).toEqual({});
  });

  it("a failing store never throws out of it and nothing of the failure is logged but a fixed line", async () => {
    pin("2031-07-12T12:00:00Z");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const incr = vi.spyOn(db, "incrby").mockRejectedValue(new Error("redis exploded for secret@owner.example key usage:_all"));
    await expect(noteRejectedPick("chat", "unknown")).resolves.toBeUndefined();
    // Written once, and it is exactly the fixed line: no key, id, email or error text as an argument.
    expect(err.mock.calls).toEqual([["pick_reject_counter_failed"]]);
    incr.mockImplementation(() => { throw new Error("sync failure for secret@owner.example"); });
    await expect(noteRejectedPick("generate", "needs_tools")).resolves.toBeUndefined();
    expect(err.mock.calls).toEqual([["pick_reject_counter_failed"], ["pick_reject_counter_failed"]]);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(incr).toHaveBeenCalled();
    const logged = JSON.stringify([...err.mock.calls, ...warn.mock.calls, ...log.mock.calls]);
    expect(logged).not.toContain("secret@owner.example");
    expect(logged).not.toContain("redis exploded");
    expect(logged).not.toContain("usage:_all");
    expect(logged).not.toContain("chat");
    expect(logged).not.toContain("generate");
  });
});

describe("no account-linked key gains model, provider or pickreject", () => {
  it("usageMonthKeys has none, a metered account has none, and wipeAccount leaves the global counters alone", async () => {
    pin("2031-08-10T12:00:00Z");
    // No shadow membership: this pins a person who holds nothing else, so the deletion takes the login too (multi-org M1).
    const u = await newUser("um-keys", { shadow: false });
    await meter(u.email, OPUS, "generate", U_OPUS, "faris", "straitly");
    await meter(u.email, "mystery-model", "chat", U_SMALL, "sami");
    await noteRejectedPick("chat", "unknown");
    const list = usageMonthKeys(u.email, "2031-08");
    expect(list.filter((k) => /model:|provider:|pickreject:/.test(k))).toEqual([]);
    expect(list).toContain(`usage:${u.email}:2031-08:calls`);
    const mine = allKeys().filter((k) => k.includes(u.email));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.filter((k) => /model:|provider:|pickreject:/.test(k))).toEqual([]);
    // Every account counter of the month is on the list `wipeAccount` deletes.
    expect(mine.filter((k) => k.startsWith("usage:") && !list.includes(k))).toEqual([]);
    await wipeAccount(u.email);
    expect(allKeys().filter((k) => k.includes(u.email) && mem().kv.get(k) !== null)).toEqual([]);
    const after = await getUsage("_all", "2031-08");
    expect(after.models[OPUS]).toEqual({ calls: 1, usd: 0.024 });
    expect(after.models.other?.calls).toBe(1);
    expect(after.providers.straitly?.calls).toBe(1);
    expect(after.rejectedPicks).toEqual({ "chat:unknown": 1 });
  });
});

const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "رخيص", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };

/** A signed-in owner on a paid plan with a brand file and credits to spare, and one conversation. */
async function owner(prefix: string): Promise<{ u: User; conv: string }> {
  const n = await newUser(prefix);
  await saveUser({ ...n, plan: "starter", credits: 500 });
  await db.set(`brand:${n.email}`, brand);
  await signIn(n.email);
  const u = (await currentUser())!;
  const c = await createConversation(sc(u), "t");
  return { u, conv: c.id };
}
const convOf = (u: User, id: string) => db.get<Conversation>(`conv:${sc(u)}:${id}`);
const send = (body: Record<string, unknown>) => chatRoute.POST(json("/api/chat", "POST", { text: "مرحبا", ...body }));
const picks = async () => (await getUsage("_all")).rejectedPicks;
/** `db.incrby` that fails only for the rejected-pick counter, every other counter going through. */
function failPickCounter() {
  const real = db.incrby.bind(db);
  return vi.spyOn(db, "incrby").mockImplementation((key: string, n: number) => {
    if (key.includes(":pickreject:")) throw new Error("counter store down");
    return real(key, n);
  });
}

describe("the chat route counts a rejected pick", () => {
  it("one count for a turn whose stored pick route() refused, under purpose 'chat' and the reason; none without a pick or with an accepted one", async () => {
    const { u, conv } = await owner("um-chat");
    const base = await picks();
    // No pick: nothing counted.
    expect((await send({ conv })).status).toBe(200);
    expect(await picks()).toEqual(base);
    // An accepted pick: nothing counted.
    await db.set(`conv:${sc(u)}:${conv}`, { ...(await convOf(u, conv))!, model: SONNET55 });
    expect((await send({ conv })).status).toBe(200);
    expect(await picks()).toEqual(base);
    // A pick the catalog no longer holds: counted once per turn, plain and streamed.
    await db.set(`conv:${sc(u)}:${conv}`, { ...(await convOf(u, conv))!, model: "claude-retired-1" });
    expect((await send({ conv })).status).toBe(200);
    expect((await picks())["chat:unknown"] ?? 0).toBe((base["chat:unknown"] ?? 0) + 1);
    await (await send({ conv, stream: true })).text();
    expect((await picks())["chat:unknown"] ?? 0).toBe((base["chat:unknown"] ?? 0) + 2);
    // The turn itself ran on the automatic choice and was metered under it, with the provider that was configured.
    expect(sdk.calls.filter((c) => c.api === "stream").map((c) => c.model).slice(-2)).toEqual([DEFAULTS.chat, DEFAULTS.chat]);
    const all = await getUsage("_all");
    expect(all.models[DEFAULTS.chat]?.calls).toBeGreaterThanOrEqual(3);
    expect(all.providers.anthropic?.calls).toBeGreaterThanOrEqual(4);
  });

  it("a failing counter changes neither the status nor the reply", async () => {
    const { u, conv } = await owner("um-chat-fail");
    await db.set(`conv:${sc(u)}:${conv}`, { ...(await convOf(u, conv))!, model: "claude-retired-1" });
    const ok = await send({ conv });
    const okBody = (await ok.json()) as { message: { content: string }; ok: boolean };
    const base = await picks();
    const incr = failPickCounter();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await send({ conv });
    expect(res.status).toBe(ok.status);
    const body = (await res.json()) as { message: { content: string }; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.message.content).toBe(okBody.message.content);
    const streamed = await (await send({ conv, stream: true })).text();
    expect(streamed).toContain('"type":"message"');
    expect(streamed).not.toContain('"type":"error"');
    expect(incr.mock.calls.some((c) => String(c[0]).includes(":pickreject:"))).toBe(true);
    expect(JSON.stringify(err.mock.calls)).not.toContain("counter store down");
    incr.mockRestore();
    expect(await picks()).toEqual(base);
  });
});

describe("generateBatch counts a rejected pick", () => {
  it("one count under purpose 'generate' and the reason when the brand's pick is refused; none without a pick or with an accepted one", async () => {
    const { u } = await owner("um-gen");
    const base = await picks();
    const run = async (type: "social" | "ads") => {
      const r = await generateBatch((await getUser(u.email))!, sc(u), { type, source: "manual", via: "app" });
      await settle();
      return r;
    };
    expect((await run("social")).ok).toBe(true);
    expect(await picks()).toEqual(base);
    await db.set(`brand:${sc(u)}`, { ...brand, model: SONNET55 });
    expect((await run("social")).ok).toBe(true);
    expect(await picks()).toEqual(base);
    // An accepted model that may not run the type: task_not_allowed (an allow-list patched in; no pick has one since rule 902).
    cat.sonnetTasks = ["social"];
    const art = await run("ads").finally(() => { cat.sonnetTasks = undefined; });
    expect(art.ok && art.modelRejected).toBe("task_not_allowed");
    expect((await picks())["generate:task_not_allowed"] ?? 0).toBe((base["generate:task_not_allowed"] ?? 0) + 1);
    // A model the catalog does not hold: unknown.
    await db.set(`brand:${sc(u)}`, { ...brand, model: "claude-retired-1" });
    const gone = await run("social");
    expect(gone.ok && gone.modelRejected).toBe("unknown");
    expect((await picks())["generate:unknown"] ?? 0).toBe((base["generate:unknown"] ?? 0) + 1);
    // A caller that names its own model asks route() nothing, so nothing is counted.
    const named = await generateBatch((await getUser(u.email))!, sc(u), { type: "social", source: "manual", via: "app", model: DEFAULTS.generate });
    await settle();
    expect(named.ok).toBe(true);
    expect((await picks())["generate:unknown"] ?? 0).toBe((base["generate:unknown"] ?? 0) + 1);
    // The batch was metered under the model it ran on.
    expect((await getUsage("_all")).models[DEFAULTS.generate]?.calls).toBeGreaterThanOrEqual(2);
  });

  it("a failing counter changes nothing about the batch: same result, same charge, same items", async () => {
    const { u } = await owner("um-gen-fail");
    await db.set(`brand:${sc(u)}`, { ...brand, model: "claude-retired-1" });
    const before = (await getUser(u.email))!.credits;
    const okRun = await generateBatch(u, sc(u), { type: "social", source: "manual", via: "app" });
    await settle();
    const spent = before - (await getUser(u.email))!.credits;
    const base = await picks();
    const incr = failPickCounter();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const mid = (await getUser(u.email))!.credits;
    const failRun = await generateBatch((await getUser(u.email))!, sc(u), { type: "social", source: "manual", via: "app" });
    await settle();
    expect(okRun.ok).toBe(true);
    expect(failRun.ok).toBe(true);
    expect(failRun.ok && failRun.modelRejected).toBe("unknown");
    expect(failRun.ok && failRun.tasks.length).toBe(okRun.ok ? okRun.tasks.length : -1);
    expect(mid - (await getUser(u.email))!.credits).toBe(spent);
    expect(incr.mock.calls.some((c) => String(c[0]).includes(":pickreject:"))).toBe(true);
    expect(JSON.stringify(err.mock.calls)).not.toContain("counter store down");
    incr.mockRestore();
    expect(await picks()).toEqual(base);
  });
});

describe("the founder console", () => {
  it("overview() carries the month's per-model, per-provider and rejected-pick numbers from getUsage('_all')", async () => {
    pin("2031-09-10T12:00:00Z");
    await meter(undefined, OPUS, "generate", U_OPUS, "faris", "straitly");
    await meter(undefined, SONNET, "judge", U_SONNET);
    await noteRejectedPick("generate", "task_not_allowed");
    const ov = await overview();
    const all = await getUsage("_all", "2031-09");
    expect(ov.modelUsage).toEqual({ month: "2031-09", models: all.models, providers: all.providers, fallbacks: all.fallbacks, rejectedPicks: all.rejectedPicks });
    expect(ov.modelUsage.models[OPUS]).toEqual({ calls: 1, usd: 0.024 });
    expect(ov.modelUsage.providers).toEqual({ straitly: { calls: 1, usd: 0.024 }, anthropic: { calls: 1, usd: 0.0096 } });
    expect(ov.modelUsage.rejectedPicks).toEqual({ "generate:task_not_allowed": 1 });
  });

  it("GET /api/admin/overview serves it to the founder only: 401 and no figure without the key", async () => {
    pin("2031-09-11T12:00:00Z");
    vi.stubEnv("WAITLIST_ADMIN_KEY", "um-admin-key-0123456789");
    await meter(undefined, OPUS, "generate", U_OPUS);
    signOut();
    const denied = await overviewRoute.GET(json("/api/admin/overview", "GET", undefined, { "x-forwarded-for": "198.51.100.77" }));
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toMatch(/modelUsage|claude-opus-5|usd/);
    const wrong = await overviewRoute.GET(json("/api/admin/overview", "GET", undefined, { "x-admin-key": "um-admin-key-0123456780", "x-forwarded-for": "198.51.100.78" }));
    expect(wrong.status).toBe(401);
    const ok = await overviewRoute.GET(json("/api/admin/overview", "GET", undefined, { "x-admin-key": "um-admin-key-0123456789", "x-forwarded-for": "198.51.100.79" }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { modelUsage: { models: Record<string, unknown> } }).modelUsage.models).toHaveProperty(OPUS);
  });

  it("no customer-facing file reads getUsage, and nothing outside usage.ts and admin-stats.ts names the new fields", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.(ts|tsx)$/.test(f) ? [join(d, f)] : []));
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const files = walk("src");
    const readers = files.filter((f) => /\bgetUsage\b/.test(strip(readFileSync(f, "utf8")))).sort();
    // The founder's routes, the golden set (its own account's cost), the founder overview, and usage.ts itself.
    expect(readers).toEqual(["src/app/api/admin/plan/route.ts", "src/app/api/admin/users/[email]/route.ts", "src/lib/admin-stats.ts", "src/lib/golden.ts", "src/lib/usage.ts"]);
    const namers = files.filter((f) => /\b(rejectedPicks|modelUsage|noteRejectedPick)\b/.test(strip(readFileSync(f, "utf8")))).sort();
    expect(namers).toEqual(["src/app/api/chat/route.ts", "src/app/api/instructions/test/route.ts", "src/components/admin/Billing.tsx", "src/components/admin/shared.tsx", "src/lib/admin-stats.ts", "src/lib/generate-batch.ts", "src/lib/usage.ts"]);
    // And the console is behind the founder's own page and routes: it names no customer route.
    const consoleSrc = adminConsoleSrc();
    expect(consoleSrc).toContain("ov.modelUsage");
  });

  it("the console shows the three tables in both languages with logical CSS only and no faded ink", () => {
    const src = adminConsoleSrc();
    const block = src.slice(src.indexOf("modelUsage-section"), src.indexOf("modelUsage-section-end"));
    expect(block.length).toBeGreaterThan(400);
    for (const key of ["llmModels", "llmModel", "llmCalls", "llmPerCall", "llmProviders", "llmProvider", "llmCaveat", "llmFallbacks", "llmRejected", "llmNone"]) {
      expect(src.match(new RegExp(`\\b${key}:`, "g"))?.length, `${key} in both languages`).toBe(2);
      expect(block, key).toContain(`O.${key}`);
    }
    expect(block).toContain("ov.modelUsage.models");
    expect(block).toContain("ov.modelUsage.providers");
    expect(block).toContain("ov.modelUsage.rejectedPicks");
    expect(block).toContain("ov.modelUsage.fallbacks");
    expect(block).not.toMatch(/text-ink\/\d|text-foreground\/\d|\btext-(left|right)\b|\b(ml|mr|pl|pr)-\d|\b(left|right)-\d/);
    expect(block).toContain("text-foreground-muted"); // text-muted until the rule 1200 codemod
  });

  it("the console block has its own column headers (Provider, and the Arabic word for model) and one muted line saying what the figures are", () => {
    const src = adminConsoleSrc();
    const block = src.slice(src.indexOf("modelUsage-section"), src.indexOf("modelUsage-section-end"));
    // The providers table's first header is "Provider", not the section's own "Per provider"; the model column does not reuse the
    // render table's `O.model`, whose Arabic is the word for "type".
    expect(block).toMatch(/<th[^>]*>\{O\.llmProvider\}<\/th>/);
    expect(block).not.toMatch(/<th[^>]*>\{O\.llmProviders\}<\/th>/);
    expect(block).toMatch(/<th[^>]*>\{O\.llmModel\}<\/th>/);
    expect(block).not.toMatch(/<th[^>]*>\{O\.model\}<\/th>/);
    expect(src).toMatch(/\bllmModel: "النموذج"/);
    expect(src).toMatch(/\bllmModel: "Model"/);
    expect(src).toMatch(/\bllmProvider: "Provider"/);
    // The caveat: one muted paragraph under the providers table, in both languages, with no number in it.
    expect(block).toMatch(/<p className="[^"]*\btext-foreground-muted\b[^"]*">\{O\.llmCaveat\}<\/p>/);
    const caveats = [...src.matchAll(/\bllmCaveat: "([^"]+)"/g)].map((m) => m[1]);
    expect(caveats).toHaveLength(2);
    expect(caveats[0]).toMatch(/catalog/i);
    expect(caveats[0]).toMatch(/Anthropic/);
    expect(caveats[0]).toMatch(/straitly/i);
    expect(caveats[1]).toMatch(/[\u0600-\u06FF]/);
    expect(caveats[1]).toMatch(/Anthropic/);
    for (const c of caveats) expect(c).not.toMatch(/\d/);
  });

  it("an overview answer without modelUsage (an older server, a rollback while the page is open) renders nothing for it and does not throw", () => {
    const src = adminConsoleSrc();
    const block = src.slice(src.indexOf("modelUsage-section"), src.indexOf("modelUsage-section-end"));
    // The client type says it may be absent, so the compiler enforces the guard, and the whole block sits behind it.
    expect(src).toMatch(/\bmodelUsage\?: \{/);
    const guard = block.indexOf("ov.modelUsage && (");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("ov.modelUsage.month")).toBeGreaterThan(guard);
    // Nothing of the block's reads comes before the guard.
    expect(block.slice(0, guard)).not.toMatch(/ov\.modelUsage\./);
  });
});
