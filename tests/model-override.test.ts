import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Customer model overrides, stored under the caller's scope (spec 2026-10-08-straitly-model-routing, sections 4, 7, 8;
 * plan Task 6). A conversation can hold a chat pick (`Conversation.model`), the active brand a generation pick
 * (`Brand.model`), and the owner's account one confirmation for China-hosted models (`User.chinaHostingOk`). Set and
 * cleared only by `PUT /api/models`; read only at call time by the chat routes and `generateBatch`, which hand them to
 * `route()`; a pick `route()` rejects falls back to the automatic choice and the customer is told, in the reply language.
 *
 * The SDK is scripted and records every request it receives, betas and fallbacks included. `route` is wrapped, not
 * replaced: every call runs for real and is recorded with its context.
 */
type Req = { api: "generate" | "stream" | "create"; model: string; system: string; betas?: unknown; fallbacks?: unknown };
const sdk = vi.hoisted(() => ({ calls: [] as { api: "generate" | "stream" | "create"; model: string; system: string; betas?: unknown; fallbacks?: unknown }[], usage: { input_tokens: 1000, output_tokens: 200 } }));
const rt = vi.hoisted(() => ({ asked: [] as { purpose: string; ctx: Record<string, unknown> | undefined }[] }));
const ms = vi.hoisted(() => ({ state: "on" as "on" | "paused" | "mock" }));

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
          stream: (p: { model: string; system: unknown; betas?: unknown; fallbacks?: unknown }) => ({
            finalMessage: async () => {
              sdk.calls.push({ api: "generate", model: p.model, system: sysText(p.system), ...("betas" in p ? { betas: p.betas } : {}), ...("fallbacks" in p ? { fallbacks: p.fallbacks } : {}) });
              return answer(p.model, items);
            },
          }),
        },
      };
      messages = {
        chat: (p: { model: string; system: unknown }) => ({
          finalMessage: async () => {
            sdk.calls.push({ api: "stream", model: p.model, system: sysText(p.system) });
            return answer(p.model, "أهلاً");
          },
        }),
        create: async (p: { model: string; system: unknown }) => {
          const system = sysText(p.system);
          sdk.calls.push({ api: "create", model: p.model, system });
          if (system.startsWith("You are the quality judge")) return answer(p.model, JSON.stringify([verdict, verdict, verdict, verdict, verdict]));
          return answer(p.model, JSON.stringify([{ ok: true, id: 1, verdict: "ok" }]));
        },
        stream(p: { tools?: unknown; tool_choice?: unknown; output_config?: { format?: unknown } }, o?: unknown) { return (p.tools && !p.tool_choice) || p.output_config?.format ? (this.chat as (...a: unknown[]) => unknown)(p, o) : { finalMessage: async () => (this.create as (...a: unknown[]) => unknown)(p, o) }; },
      };
    },
  };
});
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => ms.state }));
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
vi.mock("@/lib/models/route", async (orig) => {
  const m = await orig<typeof import("@/lib/models/route")>();
  return {
    ...m,
    route: (purpose: Parameters<typeof m.route>[0], ctx?: Parameters<typeof m.route>[1]) => {
      rt.asked.push({ purpose, ctx: ctx as Record<string, unknown> | undefined });
      return m.route(purpose, ctx);
    },
  };
});

import { db } from "@/lib/db";
import { currentUser, getUser, saveUser, sc, type User } from "@/lib/auth";
import type { Brand, Task } from "@/lib/brand";
import { createConversation, deleteConversation, liveConversations, renameConversation, setConversationModel, touchConversation, type Conversation } from "@/lib/conversations";
import { wipeAccount } from "@/lib/account";
import { PAUSED_REPLY } from "@/lib/model";
import { DEFAULTS } from "@/lib/models/route";
import { TASK_MODELS } from "@/lib/task-models";
import { MODELS, modelAllowsTask, modelById, pickerView, type ModelEntry } from "@/lib/models/catalog";
import { chatHoldFor, chatUnitsFor, creditsFor, tierMultiplier } from "@/lib/models/credits";
import { MODEL_UNAVAILABLE } from "@/lib/models/overrides";
import { MODEL_PICKS_PER_HOUR } from "@/lib/rate";
import { TASK_COST, TASK_TYPES } from "@/lib/tasks";
import { chatMsgKey } from "@/lib/usage";
import { generate } from "@/lib/noor";
import { scoreItems } from "@/lib/judge";
import { buildFromSite } from "@/lib/onboard";
import { generateBatch } from "@/lib/generate-batch";
import { chatStatus, reserveChatTurn } from "@/lib/chat-allowance";
import { readFileSync } from "node:fs";
import { json, newMember, newUser, settle, signIn, signOut } from "./helpers/session";
import * as modelsRoute from "@/app/api/models/route";
import * as chatRoute from "@/app/api/chat/route";
import * as brandRoute from "@/app/api/brand/route";
import * as generateRoute from "@/app/api/generate/route";
import * as conversationsRoute from "@/app/api/conversations/route";

// Since 2026-10-09 (rule 809) only the 5.5 models can be picked or routed to; Opus 5 and Sonnet 5 stay for their rates.
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const SONNET55 = "claude-sonnet-5-5";
const FOUNDER = "override-founder@test.example";

const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "رخيص", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };

const put = (body: unknown) => modelsRoute.PUT(json("/api/models", "PUT", body));
const getModels = () => modelsRoute.GET();
const convOf = (u: User, id: string) => db.get<Conversation>(`conv:${sc(u)}:${id}`);
const brandOf = (scope: string) => db.get<Brand>(`brand:${scope}`);
const askedFor = (purpose: string) => rt.asked.filter((a) => a.purpose === purpose);
const count = async (u: Pick<User, "email">) => Number((await db.get<number>(chatMsgKey(u.email))) ?? 0);
const send = (body: Record<string, unknown>, headers: Record<string, string> = {}) => chatRoute.POST(json("/api/chat", "POST", { text: "مرحبا", ...body }, headers));

/** A signed-in owner on a paid plan with a brand file and credits to spare, and one conversation. */
async function owner(prefix: string, extra: Partial<User> = {}): Promise<{ u: User; conv: string }> {
  const n = await newUser(prefix);
  await saveUser({ ...n, plan: "starter", credits: 500, ...extra });
  await db.set(`brand:${n.email}`, brand);
  await signIn(n.email);
  const u = (await currentUser())!;
  const c = await createConversation(sc(u), "t");
  return { u, conv: c.id };
}

/** A test-only catalog entry added next to the real three. */
const entry = (o: Partial<ModelEntry> & { id: string }): ModelEntry => ({
  label: { ar: "نموذج تجريبي", en: "Test model" },
  vendor: "acme",
  hosting: "west",
  tier: "standard",
  dialect: "messages",
  caps: { tools: true, strict: true, thinking: true, cache: true, vision: false },
  rate: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  auto: false,
  pick: true,
  ...o,
});

/** Fresh route modules over a catalog with `extra` added. The store and the session are global, so they carry over. */
async function withCatalog(extra: ModelEntry[]) {
  vi.resetModules();
  vi.doMock("@/lib/models/catalog", async (orig) => {
    const m = await orig<typeof import("@/lib/models/catalog")>();
    const all = [...m.MODELS, ...extra];
    const byId = (id: unknown) => (typeof id === "string" ? all.find((e) => e.id === id) : undefined);
    return { ...m, MODELS: all, modelById: byId, pickModels: () => all.filter((e) => e.pick), pickerView: () => m.toPickerView(all.filter((e) => e.pick)) };
  });
  return { models: await import("@/app/api/models/route"), chat: await import("@/app/api/chat/route") };
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  sdk.calls = [];
  rt.asked = [];
  ms.state = "on";
});
afterEach(async () => {
  await settle();
  vi.doUnmock("@/lib/models/catalog");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GET and PUT /api/models: authentication and rate limit", () => {
  it("401 without a session", async () => {
    signOut();
    expect((await getModels()).status).toBe(401);
    expect((await put({ target: "brand", model: SONNET })).status).toBe(401);
    expect((await put({ confirmChina: true })).status).toBe(401);
  });

  it("rate limited by the existing user limit: past MODEL_PICKS_PER_HOUR the PUT answers 429 with Retry-After and writes nothing", async () => {
    const { u, conv } = await owner("mo-rate");
    expect(MODEL_PICKS_PER_HOUR).toBeGreaterThan(0);
    await db.set(`rate:modelpick:${u.email}`, MODEL_PICKS_PER_HOUR);
    const r = await put({ target: "conversation", id: conv, model: SONNET });
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("3600");
    expect((await convOf(u, conv))!.model).toBeUndefined();
    // The bucket is the account's, from the session: a member of the same account shares it.
    const m = await newMember((await getUser(u.email))!, "admin");
    await signIn(m.email);
    expect((await put({ target: "brand", model: SONNET })).status).toBe(429);
    expect((await brandOf(u.email))!.model).toBeUndefined();
  });
});

describe("GET /api/models", () => {
  it("lists the pickable models with per-surface multipliers and chat units worked out on the server, and no rates", async () => {
    const { u } = await owner("mo-get");
    const r = await getModels();
    expect(r.status).toBe(200);
    const j = (await r.json()) as { models: { id: string; tools: boolean }[]; multipliers: { chat: Record<string, number>; generate: Record<string, number> }; generateByTask: Record<string, Record<string, number>>; chatUnits: Record<string, number>; chinaConfirmed: boolean };
    expect(Object.keys(j).sort()).toEqual(["chatUnits", "chinaConfirmed", "generateByTask", "models", "multipliers"]);
    expect(j.models).toEqual(pickerView());
    expect(j.models.length).toBeGreaterThan(0);
    for (const row of j.models) {
      expect(modelById(row.id)!.pick, row.id).toBe(true);
      expect(Object.keys(row).sort(), row.id).toEqual(["hosting", "id", "label", "tier", "tools"]);
      expect(row.tools, row.id).toBe(modelById(row.id)!.caps.tools);
    }
    const ids = j.models.map((m) => m.id);
    expect(j.multipliers.chat).toEqual(Object.fromEntries(ids.map((id) => [id, tierMultiplier(id, "chat")])));
    expect(j.multipliers.generate).toEqual(Object.fromEntries(ids.map((id) => [id, tierMultiplier(id, "generate")])));
    expect(j.chatUnits).toEqual(Object.fromEntries(ids.map((id) => [id, chatUnitsFor(id)])));
    expect(j.multipliers.chat[OPUS]).toBe(2);
    expect(j.multipliers.generate[SONNET]).toBe(0.5);
    expect(j.chatUnits[OPUS]).toBe(2);
    // Rule 902: the generation multiplier per task type, relative to that type's writer, worked out on the server.
    expect(Object.keys(j.generateByTask).sort()).toEqual([...TASK_TYPES].sort());
    for (const t of TASK_TYPES) {
      expect(j.generateByTask[t], t).toEqual(Object.fromEntries(ids.filter((id) => modelAllowsTask(modelById(id)!, t)).map((id) => [id, tierMultiplier(id, "generate", t)])));
      expect(j.generateByTask[t][TASK_MODELS[t].write], t).toBe(1);
    }
    expect([j.generateByTask.article[OPUS], j.generateByTask.article[SONNET], j.generateByTask.social[SONNET]]).toEqual([2, 1, 0.5]);
    expect(j.chinaConfirmed).toBe(false);
    // No rate leaves the server, and nothing else of the catalog entry beyond the picker row.
    const text = JSON.stringify(j);
    // `tools` is the one capability the picker reads, as a plain boolean; the other capabilities stay on the server.
    for (const k of ["\"rate\"", "cacheRead", "cacheWrite", "\"in\"", "\"out\"", "\"vendor\"", "\"dialect\"", "\"caps\"", "\"strict\"", "\"thinking\"", "\"cache\"", "\"vision\"", "\"tasks\"", "\"auto\"", "\"pick\""]) expect(text, k).not.toContain(k);
    expect(MODELS.filter((m) => m.pick).map((m) => m.id)).toEqual(ids);
    // The owner's confirmation shows once it is stored.
    await saveUser({ ...(await getUser(u.email))!, chinaHostingOk: true });
    expect(((await (await getModels()).json()) as { chinaConfirmed: boolean }).chinaConfirmed).toBe(true);
  });
});

describe("PUT /api/models: validation", () => {
  it("unknown, constructor and __proto__ ids are rejected unknown_model, and so is anything that is not a string; nothing is written", async () => {
    const { u, conv } = await owner("mo-unknown");
    const bad: unknown[] = ["claude-unknown-9", "constructor", "__proto__", "toString", "hasOwnProperty", "", " claude-opus-5-5", "CLAUDE-OPUS-5", 5, true, false, {}, [], [OPUS], { id: OPUS }, undefined];
    for (const model of bad) {
      for (const target of ["conversation", "brand"]) {
        const r = await put({ target, id: target === "conversation" ? conv : undefined, model });
        expect(r.status, `${target} ${JSON.stringify(model)}`).toBe(400);
        expect(await r.json(), `${target} ${JSON.stringify(model)}`).toEqual({ error: "unknown_model" });
      }
    }
    expect((await convOf(u, conv))!).not.toHaveProperty("model");
    expect((await brandOf(u.email))!).not.toHaveProperty("model");
  });

  it("an entry customers may not pick is rejected not_pickable, even when automatic routing may use it", async () => {
    const { u, conv } = await owner("mo-notpick");
    const r = await withCatalog([entry({ id: "test-internal-1", auto: true, pick: false })]);
    for (const target of ["conversation", "brand"]) {
      const res = await r.models.PUT(json("/api/models", "PUT", { target, id: target === "conversation" ? conv : undefined, model: "test-internal-1" }));
      expect(res.status, target).toBe(400);
      expect(await res.json(), target).toEqual({ error: "not_pickable" });
    }
    expect((await convOf(u, conv))!).not.toHaveProperty("model");
    expect((await brandOf(u.email))!).not.toHaveProperty("model");
  });

  it("a conversation pick needs tool use: a pickable model without it is not_pickable for chat, and accepted for the brand", async () => {
    const { u, conv } = await owner("mo-notools");
    const r = await withCatalog([entry({ id: "test-notools-1", caps: { tools: false, strict: false, thinking: false, cache: true, vision: false } })]);
    const c = await r.models.PUT(json("/api/models", "PUT", { target: "conversation", id: conv, model: "test-notools-1" }));
    expect(c.status).toBe(400);
    expect(await c.json()).toEqual({ error: "not_pickable" });
    expect((await r.models.PUT(json("/api/models", "PUT", { target: "brand", model: "test-notools-1" }))).status).toBe(200);
    expect((await brandOf(u.email))!.model).toBe("test-notools-1");
  });

  it("a china model without stored confirmation is rejected china_unconfirmed even when the UI was skipped; after the owner confirms it is accepted", async () => {
    const { u, conv } = await owner("mo-china");
    const r = await withCatalog([entry({ id: "test-china-1", hosting: "china", tier: "economy" })]);
    const call = (body: unknown) => r.models.PUT(json("/api/models", "PUT", body));
    for (const target of ["conversation", "brand"]) {
      const res = await call({ target, id: target === "conversation" ? conv : undefined, model: "test-china-1" });
      expect(res.status, target).toBe(409);
      expect(await res.json(), target).toEqual({ error: "china_unconfirmed" });
    }
    // A confirmation in the request is not the stored one: only `{ confirmChina: true }` alone stores it.
    expect((await call({ target: "conversation", id: conv, model: "test-china-1", chinaHostingOk: true, confirmedChina: true })).status).toBe(409);
    expect((await convOf(u, conv))!).not.toHaveProperty("model");
    expect((await getUser(u.email))!.chinaHostingOk).toBeUndefined();
    expect((await call({ confirmChina: true })).status).toBe(200);
    expect((await getUser(u.email))!.chinaHostingOk).toBe(true);
    expect((await call({ target: "conversation", id: conv, model: "test-china-1" })).status).toBe(200);
    expect((await convOf(u, conv))!.model).toBe("test-china-1");
  });

  it("a body that is not an object or names no known target is a bad request", async () => {
    await owner("mo-bad");
    for (const body of [null, [], "x", 5, {}, { target: "account", model: SONNET }, { target: "Conversation", model: SONNET }, { target: "__proto__", model: SONNET }]) {
      const r = await modelsRoute.PUT(new Request("https://nashr.test/api/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json(), JSON.stringify(body)).toEqual({ error: "bad_request" });
    }
  });

  it("{ confirmChina: true } sent with a target, an id or a model is a bad request and writes nothing at all", async () => {
    const { u, conv } = await owner("mo-mixed");
    const before = { user: await getUser(u.email), conv: await convOf(u, conv), brand: await brandOf(sc(u)) };
    const sets = vi.spyOn(db, "set");
    for (const extra of [{ target: "conversation", id: conv, model: SONNET }, { target: "brand", model: SONNET }, { target: "conversation" }, { id: conv }, { model: null }, { model: SONNET }]) {
      const r = await put({ confirmChina: true, ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(await r.json(), JSON.stringify(extra)).toEqual({ error: "bad_request" });
    }
    expect(sets.mock.calls.filter(([k]) => !String(k).startsWith("rate:"))).toEqual([]);
    expect({ user: await getUser(u.email), conv: await convOf(u, conv), brand: await brandOf(sc(u)) }).toEqual(before);
    // Alone it still works.
    expect((await put({ confirmChina: true })).status).toBe(200);
  });
});

describe("PUT /api/models: tenant isolation", () => {
  it("a conversation or brand outside the caller's scope is not_found and nothing is written", async () => {
    const victim = await owner("mo-victim");
    const victimConvBefore = await convOf(victim.u, victim.conv);
    const victimBrandBefore = await brandOf(victim.u.email);
    const { u } = await owner("mo-attacker");
    const sets = vi.spyOn(db, "set");
    // The victim's conversation id, sent by another account: read under the caller's scope, where it does not exist.
    const r = await put({ target: "conversation", id: victim.conv, model: SONNET });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
    // A brand id that is not the caller's active brand.
    for (const id of ["other-brand", victim.u.email, `${victim.u.email}#b1`, "constructor"]) {
      const b = await put({ target: "brand", id, model: SONNET });
      expect(b.status, id).toBe(404);
      expect(await b.json(), id).toEqual({ error: "not_found" });
    }
    // Ids that would reach other keys if they were pasted in: refused before any read.
    for (const id of [`${victim.conv}:x`, "../x", "", 5, null, {}, "a".repeat(65)]) {
      const c = await put({ target: "conversation", id, model: SONNET });
      expect(c.status, String(id)).toBe(404);
    }
    // The default thread has no record, so it holds no pick.
    expect((await put({ target: "conversation", id: "default", model: SONNET })).status).toBe(404);
    expect(sets.mock.calls.filter(([k]) => !String(k).startsWith("rate:"))).toEqual([]);
    expect(await convOf(victim.u, victim.conv)).toEqual(victimConvBefore);
    expect(await brandOf(victim.u.email)).toEqual(victimBrandBefore);
    expect(await db.get(`conv:${sc(u)}:${victim.conv}`)).toBeNull();
    // An account with no brand file has nothing to hold a brand pick.
    const bare = await newUser("mo-bare");
    await signIn(bare.email);
    expect((await put({ target: "brand", model: SONNET })).status).toBe(404);
    expect(await brandOf(bare.email)).toBeNull();
  });

  it("the stored key is built from sc(u), never from a request scope or email", async () => {
    const victim = await owner("mo-victim2");
    const { u, conv } = await owner("mo-keys");
    const sets = vi.spyOn(db, "set");
    const smuggle = { scope: victim.u.email, email: victim.u.email, owner: victim.u.email, brandId: "b1" };
    expect((await put({ ...smuggle, target: "conversation", id: conv, model: SONNET })).status).toBe(200);
    expect((await put({ ...smuggle, target: "brand", model: SONNET })).status).toBe(200);
    expect((await put({ ...smuggle, target: "brand", id: "default", model: OPUS })).status).toBe(200);
    expect((await put({ ...smuggle, confirmChina: true })).status).toBe(200);
    const keys = sets.mock.calls.map(([k]) => String(k)).filter((k) => !k.startsWith("rate:"));
    expect(keys).toEqual([`conv:${sc(u)}:${conv}`, `brand:${sc(u)}`, `brand:${sc(u)}`, `user:${u.email}`]);
    for (const k of keys) expect(k).not.toContain(victim.u.email);
    expect((await convOf(u, conv))!.model).toBe(SONNET);
    expect((await brandOf(sc(u)))!.model).toBe(OPUS);
    expect((await getUser(u.email))!.chinaHostingOk).toBe(true);
    expect((await getUser(victim.u.email))!.chinaHostingOk).toBeUndefined();
    expect((await brandOf(victim.u.email))!).not.toHaveProperty("model");
  });

  it("{ confirmChina: true } writes the caller's account only: the owner, never a member, an admin or a founder impersonating", async () => {
    vi.stubEnv("ADMIN_EMAILS", FOUNDER);
    const { u } = await owner("mo-confirm");
    const acc = (await getUser(u.email))!;
    for (const role of ["member", "admin"] as const) {
      const m = await newMember(acc, role);
      await signIn(m.email);
      const r = await put({ confirmChina: true });
      expect(r.status, role).toBe(403);
    }
    await signIn(u.email, { imp: FOUNDER });
    expect((await put({ confirmChina: true })).status).toBe(403);
    expect((await getUser(u.email))!.chinaHostingOk).toBeUndefined();
    await signIn(u.email);
    for (const v of ["true", 1, false, null, {}]) expect((await put({ confirmChina: v })).status, JSON.stringify(v)).toBe(400);
    expect((await getUser(u.email))!.chinaHostingOk).toBeUndefined();
    const before = (await getUser(u.email))!;
    expect(await (await put({ confirmChina: true })).json()).toEqual({ ok: true });
    // Only the one field changed on the account.
    expect(await getUser(u.email)).toEqual({ ...before, chinaHostingOk: true });
  });

  it("roles: any member may set a conversation's pick; the brand's default needs brand.write (admin or owner)", async () => {
    const { u, conv } = await owner("mo-roles");
    const acc = (await getUser(u.email))!;
    const member = await newMember(acc, "member");
    await signIn(member.email);
    expect((await put({ target: "conversation", id: conv, model: SONNET })).status).toBe(200);
    expect((await convOf(u, conv))!.model).toBe(SONNET);
    expect((await put({ target: "brand", model: SONNET })).status).toBe(403);
    expect((await brandOf(u.email))!).not.toHaveProperty("model");
    const admin = await newMember(acc, "admin");
    await signIn(admin.email);
    expect((await put({ target: "brand", model: SONNET })).status).toBe(200);
    expect((await brandOf(u.email))!.model).toBe(SONNET);
  });
});

describe("PUT /api/models: setting and clearing", () => {
  it("model null clears the override: the field is deleted, never stored as a string", async () => {
    const { u, conv } = await owner("mo-clear");
    expect(await (await put({ target: "conversation", id: conv, model: OPUS })).json()).toMatchObject({ ok: true });
    expect(await (await put({ target: "brand", model: SONNET })).json()).toEqual({ ok: true });
    expect((await convOf(u, conv))!.model).toBe(OPUS);
    expect((await brandOf(u.email))!.model).toBe(SONNET);
    expect(await (await put({ target: "conversation", id: conv, model: null })).json()).toMatchObject({ ok: true });
    expect(await (await put({ target: "brand", model: null })).json()).toEqual({ ok: true });
    const c = (await convOf(u, conv))!;
    const b = (await brandOf(u.email))!;
    expect(c).not.toHaveProperty("model");
    expect(b).not.toHaveProperty("model");
    expect(JSON.stringify([c, b])).not.toContain("null");
    // The rest of each record is untouched, and clearing what is already clear is fine.
    expect(b).toEqual(brand);
    expect((await put({ target: "brand", model: null })).status).toBe(200);
  });

  it("a conversation pick answers the account's chat status for the model that conversation now runs on, worked out on the server; a brand pick and the confirmation answer none", async () => {
    const { u, conv } = await owner("mo-chatstatus");
    // Some of the allowance already used, so the answer is visibly the account's own counter.
    await db.set(chatMsgKey(u.email), 3);
    const opus = await put({ target: "conversation", id: conv, model: OPUS });
    expect(opus.status).toBe(200);
    const j = (await opus.json()) as { ok: boolean; chat: Awaited<ReturnType<typeof chatStatus>> };
    // The answer's keys are pinned: no rate and nothing of the catalog entry, only the status the chat page already shows.
    expect(Object.keys(j).sort()).toEqual(["chat", "ok"]);
    expect(j.ok).toBe(true);
    expect(Object.keys(j.chat).sort()).toEqual(["allowance", "counted", "left", "overflow", "period", "used"]);
    expect(Object.keys(j.chat.overflow).sort()).toEqual(["available", "credits", "hold", "on", "used"]);
    // The same server function and resolver the chat page uses, on the conversation as just written.
    expect(j.chat).toEqual(await chatStatus(u, OPUS));
    expect(j.chat.used).toBe(3);
    expect(j.chat.overflow.hold).toBe(chatHoldFor(OPUS));
    expect(chatHoldFor(OPUS)).toBeGreaterThan(chatHoldFor(DEFAULTS.chat));
    const text = JSON.stringify(j);
    for (const k of ["\"rate\"", "cacheRead", "cacheWrite", "\"in\"", "\"out\"", "usd", "Usd", "\"model\"", OPUS]) expect(text, k).not.toContain(k);
    // Clearing the pick answers the default chat model's hold (Automatic).
    const cleared = (await (await put({ target: "conversation", id: conv, model: null })).json()) as typeof j;
    expect(cleared.chat).toEqual(await chatStatus(u, DEFAULTS.chat));
    expect(cleared.chat.overflow.hold).toBe(chatHoldFor(DEFAULTS.chat));
    // A brand pick and the China confirmation change no chat ceiling: they answer exactly { ok: true }.
    expect(await (await put({ target: "brand", model: OPUS })).json()).toEqual({ ok: true });
    expect(await (await put({ confirmChina: true })).json()).toEqual({ ok: true });
  });

  it("the chat status a pick answers is the caller's account's: a member's pick answers the owner's counter, another account's conversation answers 404 with no status", async () => {
    const { u, conv } = await owner("mo-chatstatus-acc");
    await db.set(chatMsgKey(u.email), 5);
    const member = await newMember((await getUser(u.email))!, "member");
    await signIn(member.email);
    const j = (await (await put({ target: "conversation", id: conv, model: OPUS })).json()) as { chat: { used: number } };
    expect(j.chat.used).toBe(5);
    const other = await owner("mo-chatstatus-other");
    await signIn(other.u.email);
    const r = await put({ target: "conversation", id: conv, model: OPUS });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
  });

  it("a pick that landed stays landed when the status read after it fails: 200 { ok: true } without a status, the pick stored, and a warning that names nothing (re-review minor 1)", async () => {
    const { u, conv } = await owner("mo-chatstatus-fail");
    const counter = chatMsgKey(u.email);
    const real = db.get.bind(db) as (k: string) => Promise<unknown>;
    let failed = 0;
    // The counter GET fails once, as an Upstash HTTP error would; its message names the key, so it must not be logged.
    vi.spyOn(db, "get").mockImplementation((async (k: string) => {
      if (k === counter && failed === 0) {
        failed++;
        throw new Error(`upstash: GET ${k} failed`);
      }
      return real(k);
    }) as typeof db.get);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await put({ target: "conversation", id: conv, model: OPUS });
    expect(failed).toBe(1);
    expect(r.status).toBe(200);
    // No `chat`: the client's `pickedChat` hands over nothing and the allowance line keeps its value.
    expect(await r.json()).toEqual({ ok: true });
    expect((await convOf(u, conv))!.model).toBe(OPUS);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    for (const s of [u.email, conv, OPUS, sc(u), counter, "upstash"]) expect(logged, s).not.toContain(s);
    // Only that read is caught: the next pick answers the status again.
    const again = (await (await put({ target: "conversation", id: conv, model: null })).json()) as { chat?: unknown };
    expect(again.chat).toEqual(await chatStatus(u, DEFAULTS.chat));
  });

  it("the brand pick does not change the brand file's content or its updatedAt", async () => {
    const { u } = await owner("mo-brandfile");
    await put({ target: "brand", model: SONNET });
    expect(await brandOf(u.email)).toEqual({ ...brand, model: SONNET });
  });

  it("the picker reads the stored pick back through the existing scoped routes: GET /api/conversations and GET /api/brand carry `model` while it is set", async () => {
    const { u, conv } = await owner("mo-readback");
    const listed = async () => ((await (await conversationsRoute.GET(json("/api/conversations", "GET"))).json()) as { conversations: Conversation[] }).conversations.find((c) => c.id === conv)!;
    const brandNow = async () => ((await (await brandRoute.GET(new Request("http://t/api/brand"))).json()) as { brand: Brand }).brand;
    expect(await listed()).not.toHaveProperty("model");
    expect(await brandNow()).not.toHaveProperty("model");
    await put({ target: "conversation", id: conv, model: OPUS });
    await put({ target: "brand", model: SONNET });
    expect((await listed()).model).toBe(OPUS);
    expect((await brandNow()).model).toBe(SONNET);
    await put({ target: "conversation", id: conv, model: null });
    await put({ target: "brand", model: null });
    expect(await listed()).not.toHaveProperty("model");
    expect(await brandNow()).not.toHaveProperty("model");
    // Another account sees neither pick: each route reads under its caller's own scope.
    await put({ target: "conversation", id: conv, model: OPUS });
    const other = await owner("mo-readback-other");
    expect(((await (await conversationsRoute.GET(json("/api/conversations", "GET"))).json()) as { conversations: Conversation[] }).conversations.map((c) => c.id)).toEqual([other.conv]);
    expect(await brandNow()).not.toHaveProperty("model");
    expect(sc(other.u)).not.toBe(sc(u));
  });

  it("PUT /api/brand keeps the stored pick, and its body can never set one", async () => {
    const { u } = await owner("mo-brandput");
    await put({ target: "brand", model: SONNET });
    const save = (b: Record<string, unknown>) => brandRoute.PUT(json("/api/brand", "PUT", { ...brand, name: "مقهى جديد", ...b }));
    expect((await save({})).status).toBe(200);
    expect((await brandOf(u.email))!).toMatchObject({ name: "مقهى جديد", model: SONNET });
    expect((await save({ model: OPUS })).status).toBe(200);
    expect((await brandOf(u.email))!.model).toBe(SONNET);
    await put({ target: "brand", model: null });
    expect((await save({ model: OPUS })).status).toBe(200);
    expect((await brandOf(u.email))!).not.toHaveProperty("model");
  });
});

/**
 * The four writers of a conversation record (the pick, a turn's touch, a rename, a delete) each read the whole record and
 * write it back, so a writer that read before another one wrote would put back what it read. They share one lock per
 * conversation (`convlock:{scope}:{id}`, src/lib/conversations.ts). Each test below holds one writer between its read and
 * its write, starts another, and only then lets the first one go: without the lock the second runs in that gap.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Hold the first `db.get` (after it read) or `db.del` (before it deletes) of `key` until `release()`. */
function hold(method: "get" | "del", key: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let arrive!: () => void;
  const reached = new Promise<void>((r) => (arrive = r));
  let held = false;
  const stop = async (k: string) => {
    if (held || k !== key) return;
    held = true;
    arrive();
    await gate;
  };
  if (method === "get") {
    const real = db.get.bind(db) as (k: string) => Promise<unknown>;
    vi.spyOn(db, "get").mockImplementation((async (k: string) => {
      const v = await real(k);
      await stop(k);
      return v;
    }) as typeof db.get);
  } else {
    const real = db.del.bind(db);
    vi.spyOn(db, "del").mockImplementation(async (k: string) => {
      await stop(k);
      return real(k);
    });
  }
  return { reached, release };
}
const convKey = (u: User, id: string) => `conv:${sc(u)}:${id}`;
const indexed = async (u: User, id: string) => (await db.lrange(`convs:${sc(u)}`, 0, -1)).includes(id);
const patchConv = (body: unknown) => conversationsRoute.PATCH(json("/api/conversations", "PATCH", body));
const deleteConv = (id: string) => conversationsRoute.DELETE(json(`/api/conversations?id=${encodeURIComponent(id)}`, "DELETE"));

describe("conversation writers share one lock: no stale copy is written back, no deleted record comes back", () => {
  it("clear vs touch: an owner clearing the pick while a turn's touch is between its read and its write; the cleared pick never comes back", async () => {
    const { u, conv } = await owner("mo-lock-touch");
    await put({ target: "conversation", id: conv, model: OPUS });
    const before = (await convOf(u, conv))!;
    const h = hold("get", convKey(u, conv));
    const touch = touchConversation(sc(u), conv, "مرحبا");
    await h.reached;
    const clear = put({ target: "conversation", id: conv, model: null });
    await wait(200);
    h.release();
    const [, r] = await Promise.all([touch, clear]);
    expect(r.status).toBe(200);
    const after = (await convOf(u, conv))!;
    expect(after, "the stale copy holding the pick was written back").not.toHaveProperty("model");
    expect(after.count, "the touch still counted").toBe(before.count + 1);
  });

  it("pick vs delete: a pick read before a delete and written after it does not recreate the record outside the index", async () => {
    const { u, conv } = await owner("mo-lock-pickdel");
    const h = hold("get", convKey(u, conv));
    const pick = put({ target: "conversation", id: conv, model: OPUS });
    await h.reached;
    const del = deleteConversation(sc(u), conv);
    await wait(200);
    h.release();
    await Promise.all([pick, del]);
    expect(await db.get(convKey(u, conv)), "the record came back after its delete").toBeNull();
    expect(await indexed(u, conv)).toBe(false);
    expect([...(await liveConversations(sc(u), [conv]))], "an orphan record reads as a live thread").toEqual([]);
  });

  it("delete vs pick: a pick that waits for a delete in progress finds no record, answers not_found and writes nothing", async () => {
    const { u, conv } = await owner("mo-lock-delpick");
    const h = hold("del", convKey(u, conv));
    const del = deleteConversation(sc(u), conv);
    await h.reached;
    const pick = put({ target: "conversation", id: conv, model: OPUS });
    await wait(200);
    h.release();
    const [, r] = await Promise.all([del, pick]);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
    expect(await db.get(convKey(u, conv))).toBeNull();
    expect(await indexed(u, conv)).toBe(false);
  });

  it("rename vs delete: a rename read before a delete and written after it does not recreate the record", async () => {
    const { u, conv } = await owner("mo-lock-rename");
    const h = hold("get", convKey(u, conv));
    const rename = renameConversation(sc(u), conv, "اسم جديد");
    await h.reached;
    const del = deleteConversation(sc(u), conv);
    await wait(200);
    h.release();
    await Promise.all([rename, del]);
    expect(await db.get(convKey(u, conv))).toBeNull();
    expect(await indexed(u, conv)).toBe(false);
    expect([...(await liveConversations(sc(u), [conv]))]).toEqual([]);
  });

  it("touch and rename never create a record that does not exist", async () => {
    const { u } = await owner("mo-lock-none");
    await touchConversation(sc(u), "abcdef012345", "مرحبا");
    await renameConversation(sc(u), "abcdef012345", "x");
    expect(await db.get(`conv:${sc(u)}:abcdef012345`)).toBeNull();
  });

  it("the lock key is the caller's scope and the checked id, and an id that fails the check takes no lock and reads nothing", async () => {
    const { u, conv } = await owner("mo-lock-key");
    const locks = vi.spyOn(db, "lockOwned");
    const convLocks = () => locks.mock.calls.map(([k]) => String(k)).filter((k) => k.startsWith("convlock:"));
    expect((await put({ target: "conversation", id: conv, model: SONNET })).status).toBe(200);
    await touchConversation(sc(u), conv, "x");
    expect(await renameConversation(sc(u), conv, "x")).toBe("ok");
    expect(await deleteConversation(sc(u), conv)).toBe("ok");
    expect(convLocks()).toEqual(Array(4).fill(`convlock:${sc(u)}:${conv}`));
    locks.mockClear();
    const gets = vi.spyOn(db, "get");
    for (const id of ["../x", `${conv}:x`, "", "a".repeat(65), "a b"]) {
      await touchConversation(sc(u), id, "x");
      expect(await renameConversation(sc(u), id, "x"), id).toBe("not_found");
      expect(await deleteConversation(sc(u), id), id).toBe("not_found");
    }
    expect(convLocks()).toEqual([]);
    expect(gets.mock.calls.map(([k]) => String(k)).filter((k) => k.startsWith("conv:"))).toEqual([]);
  });

  it("a lock not taken within its bound: the pick, a rename and a delete answer 503 busy and write nothing; the touch is skipped and the chat turn still answers", async () => {
    const { u, conv } = await owner("mo-lock-busy");
    await put({ target: "conversation", id: conv, model: OPUS });
    const before = await db.get(convKey(u, conv));
    // Another writer holds the conversation's lock for longer than anyone waits.
    const token = await db.lockOwned(`convlock:${sc(u)}:${conv}`, 60);
    expect(token).not.toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sets = vi.spyOn(db, "set");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const settled = async <T>(p: Promise<T>) => {
        await vi.advanceTimersByTimeAsync(10_000);
        return p;
      };
      const r = await settled(put({ target: "conversation", id: conv, model: null }));
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "busy" });
      expect(r.headers.get("Retry-After")).toBe("1");
      expect(await settled(touchConversation(sc(u), conv, "x"))).toBeUndefined();
      expect(await settled(renameConversation(sc(u), conv, "x"))).toBe("busy");
      const p = await settled(patchConv({ id: conv, title: "x" }));
      expect(p.status).toBe(503);
      expect(await p.json()).toEqual({ ok: false, error: "busy" });
      const d = await settled(deleteConv(conv));
      expect(d.status).toBe(503);
      expect(await d.json()).toEqual({ ok: false, error: "busy" });
      // A turn whose touch cannot take the lock still answers: only the sidebar's count and time wait for the next turn.
      const turn = await settled(send({ conv }));
      expect(turn.status).toBe(200);
      expect(((await turn.json()) as { message: { content: string } }).message.content).toBe("أهلاً");
    } finally {
      vi.useRealTimers();
    }
    expect(await db.get(convKey(u, conv))).toEqual(before);
    expect(await indexed(u, conv)).toBe(true);
    expect(sets.mock.calls.map(([k]) => String(k)).filter((k) => k.startsWith("conv:"))).toEqual([]);
    expect(warn).toHaveBeenCalled();
    // Nothing the warning logs names the account or the conversation.
    expect(JSON.stringify(warn.mock.calls)).not.toContain(u.email);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(conv);
    await db.unlockOwned(`convlock:${sc(u)}:${conv}`, token!);
  });

  it("a brand pick whose lock is not taken answers the same 503 busy with Retry-After as a conversation pick, and writes nothing (rule 906)", async () => {
    const { u, conv } = await owner("mo-lock-brandbusy");
    expect((await put({ target: "brand", model: OPUS })).status).toBe(200);
    const before = await brandOf(sc(u));
    expect(await db.lock(`brandlock:${sc(u)}`, 60)).toBe(true);
    const saves = vi.spyOn(db, "set");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const settled = async <T>(p: Promise<T>) => {
        await vi.advanceTimersByTimeAsync(10_000);
        return p;
      };
      const brandPick = await settled(put({ target: "brand", model: null }));
      expect(brandPick.status, "a held brand lock answers like a held conversation lock").toBe(503);
      expect(await brandPick.json()).toEqual({ error: "busy" });
      expect(brandPick.headers.get("Retry-After")).toBe("1");
      // The conversation's own answer, for comparison, is the same.
      const token = await db.lockOwned(`convlock:${sc(u)}:${conv}`, 60);
      const convPick = await settled(put({ target: "conversation", id: conv, model: null }));
      expect([convPick.status, await convPick.json(), convPick.headers.get("Retry-After")]).toEqual([503, { error: "busy" }, "1"]);
      await db.unlockOwned(`convlock:${sc(u)}:${conv}`, token!);
    } finally {
      vi.useRealTimers();
      await db.unlock(`brandlock:${sc(u)}`);
    }
    expect(await brandOf(sc(u))).toEqual(before);
    expect(saves.mock.calls.map(([k]) => String(k)).filter((k) => k === `brand:${sc(u)}`)).toEqual([]);
  });
});

/**
 * Rule 905. `wipeAccount` used to delete a conversation's keys without its lock, so a writer that had read the record
 * and not yet written it put the record back after the wipe: a conversation of a deleted account, outside every index.
 * The wipe now deletes each conversation through `deleteConversation`, under the same lock, before anything else of it.
 */
describe("account wipe takes each conversation's lock: a writer in flight cannot bring a record back (rule 905)", () => {
  const writers: [string, (u: User, conv: string) => Promise<unknown>][] = [
    ["a turn's touch", (u, conv) => touchConversation(sc(u), conv, "مرحبا")],
    ["a rename", (u, conv) => renameConversation(sc(u), conv, "اسم جديد")],
    ["a pick", (u, conv) => setConversationModel(sc(u), conv, OPUS)],
  ];
  it.each(writers)("%s read the record before the wipe and writes after it: no record, no index entry, no live thread", async (name, write) => {
    const { u, conv } = await owner(`mo-wipe-${name.split(" ").pop()}`);
    const h = hold("get", convKey(u, conv));
    const writer = write(u, conv);
    await h.reached;
    const wipe = wipeAccount(u.email);
    await wait(200);
    h.release();
    await Promise.all([writer, wipe]);
    expect(await db.get(convKey(u, conv)), `the record of a wiped account came back after ${name}`).toBeNull();
    expect(await indexed(u, conv)).toBe(false);
    expect([...(await liveConversations(sc(u), [conv]))]).toEqual([]);
    expect(await db.get(`user:${u.email}`)).toBeNull();
  });

  it("every conversation goes through its own lock, past the newest 100, and the lock is released", async () => {
    const { u } = await owner("mo-wipe-all");
    const ids: string[] = [];
    for (let i = 0; i < 102; i++) ids.push((await createConversation(sc(u), `c${i}`)).id);
    const locks = vi.spyOn(db, "lockOwned");
    await wipeAccount(u.email);
    const taken = locks.mock.calls.map(([k]) => String(k)).filter((k) => k.startsWith("convlock:"));
    for (const id of ids) expect(taken, id).toContain(`convlock:${sc(u)}:${id}`);
    for (const id of ids) {
      expect(await db.get(convKey(u, id))).toBeNull();
      expect(await db.get(`convlock:${sc(u)}:${id}`)).toBeNull();
    }
    expect(await db.lrange(`convs:${sc(u)}`, 0, -1)).toEqual([]);
  });

  it("a conversation whose lock is not taken in time stops the wipe: the account is kept whole and a retry finishes it", async () => {
    const { u, conv } = await owner("mo-wipe-busy");
    const token = await db.lockOwned(`convlock:${sc(u)}:${conv}`, 60);
    expect(token).not.toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const wipe = wipeAccount(u.email);
      const failed = expect(wipe).rejects.toThrow(/conversation/);
      await vi.advanceTimersByTimeAsync(10_000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
    expect(await db.get(`user:${u.email}`), "the account record was deleted although a conversation could not be locked").not.toBeNull();
    expect(await db.get(convKey(u, conv))).not.toBeNull();
    await db.unlockOwned(`convlock:${sc(u)}:${conv}`, token!);
    await wipeAccount(u.email);
    expect(await db.get(`user:${u.email}`)).toBeNull();
    expect(await db.get(convKey(u, conv))).toBeNull();
  });
});

describe("call time: the chat routes", () => {
  it("a valid conversation pick runs the turn on it and counts its messages; the default thread stays automatic", async () => {
    const { u, conv } = await owner("mo-chat-pick");
    await put({ target: "conversation", id: conv, model: OPUS });
    // The pick resolved the conversation's model once for its chat status answer; count the turn's own resolution only.
    expect(askedFor("chat")).toHaveLength(1);
    rt.asked = [];
    const r = await send({ conv });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { message: { content: string } };
    expect(sdk.calls.filter((c) => c.api === "stream").map((c) => c.model)).toEqual([OPUS]);
    expect(await count(u)).toBe(chatUnitsFor(OPUS));
    expect(j.message.content).toBe("أهلاً");
    expect(askedFor("chat")).toHaveLength(1);
    expect(askedFor("chat")[0].ctx).toMatchObject({ stored: OPUS, confirmedChina: false });
    sdk.calls = [];
    expect((await send({})).status).toBe(200);
    expect(sdk.calls.filter((c) => c.api === "stream").map((c) => c.model)).toEqual([DEFAULTS.chat]);
  });

  it("a rejected stored override at call time falls back and the chat reply carries the unavailable notice in the reply language", async () => {
    const { u, conv } = await owner("mo-chat-reject");
    // A pick stored before the model left the catalog: the record holds it, routing refuses it.
    await db.set(`conv:${sc(u)}:${conv}`, { ...(await convOf(u, conv))!, model: "claude-retired-1" });
    const ar = (await (await send({ conv })).json()) as { message: { content: string } };
    expect(sdk.calls.filter((c) => c.api === "stream").map((c) => c.model)).toEqual([DEFAULTS.chat]);
    expect(await count(u)).toBe(chatUnitsFor(DEFAULTS.chat));
    expect(ar.message.content).toBe(`${MODEL_UNAVAILABLE.chat.ar}\n\nأهلاً`);
    const en = (await (await send({ conv }, { "x-lang": "en" })).json()) as { message: { content: string } };
    expect(en.message.content).toBe(`${MODEL_UNAVAILABLE.chat.en}\n\nأهلاً`);
    // The stream says the same.
    const body = await (await send({ conv, stream: true })).text();
    expect(body).toContain(JSON.stringify(`${MODEL_UNAVAILABLE.chat.ar}\n\nأهلاً`).slice(1, -1));
    // The saved thread holds the notice too, so a reload shows it.
    const hist = (await (await chatRoute.GET(new Request(`https://nashr.test/api/chat?conv=${conv}`))).json()) as { messages: { content: string }[] };
    expect(hist.messages.some((m) => m.content.startsWith(MODEL_UNAVAILABLE.chat.ar))).toBe(true);
  });

  it("a stored china pick without the stored confirmation falls back with the notice", async () => {
    const { u, conv } = await owner("mo-chat-china");
    const r = await withCatalog([entry({ id: "test-china-1", hosting: "china", tier: "economy" })]);
    await db.set(`conv:${sc(u)}:${conv}`, { ...(await convOf(u, conv))!, model: "test-china-1" });
    const res = await r.chat.POST(json("/api/chat", "POST", { text: "مرحبا", conv }));
    expect(res.status).toBe(200);
    expect(sdk.calls.filter((c) => c.api === "stream").map((c) => c.model)).toEqual([DEFAULTS.chat]);
    expect(((await res.json()) as { message: { content: string } }).message.content.startsWith(MODEL_UNAVAILABLE.chat.ar)).toBe(true);
  });

  it("GET /api/chat shows the hold of the conversation's model", async () => {
    const { conv } = await owner("mo-chat-get");
    await put({ target: "conversation", id: conv, model: OPUS });
    const a = (await (await chatRoute.GET(new Request(`https://nashr.test/api/chat?conv=${conv}`))).json()) as { chat: { overflow: { hold: number } } };
    expect(a.chat.overflow.hold).toBe(chatHoldFor(OPUS));
    const d = (await (await chatRoute.GET(new Request("https://nashr.test/api/chat"))).json()) as { chat: { overflow: { hold: number } } };
    expect(d.chat.overflow.hold).toBe(chatHoldFor(DEFAULTS.chat));
  });

  it("a trial that ended and a paused model behave as chat does today: refused before routing, or the paused reply with no notice", async () => {
    const { u, conv } = await owner("mo-chat-trial", { plan: "trial", trialEnds: new Date(Date.now() - 864e5).toISOString() });
    await db.set(`conv:${sc(u)}:${conv}`, { ...(await convOf(u, conv))!, model: "claude-retired-1" });
    const r = await send({ conv });
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "trial_over" });
    expect(askedFor("chat")).toHaveLength(0);
    expect(sdk.calls).toHaveLength(0);
    const p = await owner("mo-chat-paused");
    await db.set(`conv:${sc(p.u)}:${p.conv}`, { ...(await convOf(p.u, p.conv))!, model: "claude-retired-1" });
    ms.state = "paused";
    const res = (await (await send({ conv: p.conv })).json()) as { message: { content: string } };
    expect(res.message.content).toBe(PAUSED_REPLY.ar);
    expect(sdk.calls).toHaveLength(0);
    expect(await count(p.u)).toBe(0);
  });
});

describe("call time: generation", () => {
  const base = TASK_COST.social;

  it("a brand pick runs the batch on it and charges its price, from one decision", async () => {
    const { u } = await owner("mo-gen-pick");
    await put({ target: "brand", model: SONNET });
    const before = (await getUser(u.email))!.credits;
    const r = await generateBatch(u, sc(u), { type: "social", source: "manual", via: "app" });
    await settle();
    expect(r.ok).toBe(true);
    expect(sdk.calls.filter((c) => c.api === "generate").map((c) => c.model)).toEqual([SONNET]);
    expect(before - (await getUser(u.email))!.credits).toBe(creditsFor(base, SONNET, "generate"));
    expect(r.ok && r.modelRejected).toBeUndefined();
    expect(askedFor("generate")).toHaveLength(1);
    expect(askedFor("generate")[0].ctx).toMatchObject({ stored: SONNET, confirmedChina: false, task: "social" });
  });

  it("a brand pick not allowed for the type falls back to the type's writer (task_not_allowed), charges the writer's price and says so", async () => {
    const { u } = await owner("mo-gen-task");
    await put({ target: "brand", model: SONNET });
    cat.sonnetTasks = ["social", "article"];
    try {
      expect(modelById(SONNET)!.tasks?.includes("ads")).toBe(false);
      const before = (await getUser(u.email))!.credits;
      const r = await generateBatch(u, sc(u), { type: "ads", source: "manual", via: "app" });
      await settle();
      expect(r.ok).toBe(true);
      expect(r.ok && r.modelRejected).toBe("task_not_allowed");
      expect(sdk.calls.filter((c) => c.api === "generate").map((c) => c.model)).toEqual([TASK_MODELS.ads.write]);
      expect(before - (await getUser(u.email))!.credits).toBe(TASK_COST.ads);
    } finally {
      cat.sonnetTasks = undefined;
    }
  });

  it("a brand pick of Sonnet 5.5 runs article, a Sonnet-written type, at x1 (rule 902)", async () => {
    const { u } = await owner("mo-gen-own");
    await put({ target: "brand", model: SONNET });
    const before = (await getUser(u.email))!.credits;
    const r = await generateBatch(u, sc(u), { type: "article", source: "manual", via: "app" });
    await settle();
    expect(r.ok && r.modelRejected).toBeUndefined();
    expect(sdk.calls.filter((c) => c.api === "generate").map((c) => c.model)).toEqual([SONNET]);
    expect(before - (await getUser(u.email))!.credits).toBe(TASK_COST.article);
  });

  it("a rejected brand pick falls back and POST /api/generate carries the notice in the reply language", async () => {
    const { u } = await owner("mo-gen-route");
    await db.set(`brand:${sc(u)}`, { ...brand, model: "claude-retired-1" });
    const r = await generateRoute.POST(json("/api/generate", "POST", { type: "social" }));
    await settle();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, notice: MODEL_UNAVAILABLE.generate.ar });
    expect(sdk.calls.filter((c) => c.api === "generate").map((c) => c.model)).toEqual([DEFAULTS.generate]);
    sdk.calls = [];
    const en = await generateRoute.POST(json("/api/generate", "POST", { type: "social" }, { "x-lang": "en" }));
    await settle();
    expect(await en.json()).toMatchObject({ ok: true, notice: MODEL_UNAVAILABLE.generate.en });
    // No pick, no notice.
    await db.set(`brand:${sc(u)}`, brand);
    const plain = (await (await generateRoute.POST(json("/api/generate", "POST", { type: "social" }))).json()) as Record<string, unknown>;
    await settle();
    expect(plain).not.toHaveProperty("notice");
  });

  it("generate() asks for the server-side fallback only on the default model; any other model gets neither betas nor fallbacks", async () => {
    await generate("social", brand, [], undefined, { reviewer: false, crossReview: false, model: DEFAULTS.generate });
    await generate("social", brand, [], undefined, { reviewer: false, crossReview: false, model: SONNET });
    await generate("social", brand, [], undefined, { reviewer: false, crossReview: false, model: SONNET55 });
    const gen = sdk.calls.filter((c): c is Req => c.api === "generate");
    expect(gen.map((c) => c.model)).toEqual([DEFAULTS.generate, SONNET, SONNET55]);
    expect(gen[0]).toMatchObject({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    for (const c of gen.slice(1)) {
      expect(c, c.model).not.toHaveProperty("betas");
      expect(c, c.model).not.toHaveProperty("fallbacks");
    }
  });
});

describe("only chat and generate read a pick", () => {
  it("calls for review, judge and onboard never read conversation.model or brand.model", async () => {
    const reads: string[] = [];
    const watched = <T extends object>(o: T, name: string): T => new Proxy(o, { get: (t, k, r) => { if (k === "model") reads.push(name); return Reflect.get(t, k, r); } });
    // Every brand or conversation record the store hands out during these calls is watched too.
    const realGet = db.get.bind(db);
    const keys: string[] = [];
    vi.spyOn(db, "get").mockImplementation(async (key: string) => {
      keys.push(key);
      const v = await realGet(key);
      return v && typeof v === "object" && /^(brand|conv):/.test(key) ? watched(v as object, key) : v;
    });
    const picked = watched({ ...brand, model: SONNET }, "brand");
    // The reviewer and the cross-reviewers run inside generate(), on the batch's brand.
    await generate("gtm_plan", picked, [], undefined, { reviewer: true, crossReview: true, model: DEFAULTS.generate });
    // The judge, directly.
    const task = { id: "t1", type: "social", channel: "instagram", title: "t", body: "نص تجريبي" } as unknown as Task;
    await scoreItems("mo-spy@test.example", picked, "social", [task], 1, { generatedBy: OPUS });
    // Onboarding.
    const site = { url: "https://example.test", ok: true, platform: "unknown", title: "t", description: "d", links: [], text: "x" } as unknown as Parameters<typeof buildFromSite>[0];
    await buildFromSite(site, "ar", undefined, undefined, undefined, Date.now() + 285_000).catch(() => null);
    expect(reads).toEqual([]);
    expect(keys.filter((k) => /^(brand|conv):/.test(k))).toEqual([]);
    for (const p of ["review", "xreview", "judge", "onboard"]) {
      expect(askedFor(p).length, p).toBeGreaterThan(0);
      for (const a of askedFor(p)) expect(a.ctx ?? {}, p).not.toHaveProperty("stored");
    }
    expect(sdk.calls.filter((c) => c.api === "create").map((c) => c.model)).toEqual(expect.arrayContaining([DEFAULTS.review, DEFAULTS.judge]));
  });
});

describe("the allowance is priced for the routed model, named by every caller", () => {
  it("reserveChatTurn and chatStatus take the model as a required argument: no default model", async () => {
    const { u } = await owner("mo-required");
    expect(reserveChatTurn.length).toBe(2);
    expect(chatStatus.length).toBe(2);
    // @ts-expect-error the model is required: the caller passes the turn's routed model
    await expect(reserveChatTurn(u)).rejects.toThrow(/unknown_model/);
    expect(await count(u)).toBe(0);
  });

  it("the chat routes reserve with the routed model and every status reader names a model", () => {
    const chatSrc = readFileSync("src/app/api/chat/route.ts", "utf8");
    expect(chatSrc).toMatch(/const routed = chatRouteFor\(u, /);
    expect(chatSrc).toMatch(/reserveChatTurn\(u, routed\.model\)/);
    for (const f of ["src/app/api/chat/route.ts", "src/app/api/mcp/route.ts", "src/app/api/admin/plan/route.ts", "src/app/api/admin/users/[email]/route.ts", "src/app/api/profile/route.ts", "src/app/api/billing/chat-overflow/route.ts", "src/app/[lang]/app/chat/page.tsx", "src/app/[lang]/app/settings/billing/page.tsx"]) {
      const src = readFileSync(f, "utf8");
      const calls = src.match(/chatStatus\([^()]*(\([^()]*\))?[^()]*\)/g) ?? [];
      for (const c of calls) expect(c, f).toMatch(/chatStatus\(\w+, /);
    }
  });
});
