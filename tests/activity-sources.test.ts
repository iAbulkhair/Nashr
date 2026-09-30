import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { json, newUser, settle, signIn, signOut } from "./helpers/session";
import { fakeAdapter, fakeDeps, mediaEnv, noNetwork, resetMediaCounters } from "./helpers/media";
import { CAPS, db } from "@/lib/db";
import { currentUser, getUser, type User } from "@/lib/auth";
import { saveGov } from "@/lib/governance";
import { getBrand, saveTask, type Brand, type Task } from "@/lib/brand";
import { createMcpToken } from "@/lib/mcp";
import { saveSchedule } from "@/lib/schedule";
import { TASK_COST } from "@/lib/tasks";
import { actSkipKey, listActivity, recordRun } from "@/lib/activity";
import { periodOf } from "@/lib/routines";
import { wipeAccount } from "@/lib/account";
import type { MediaModelId } from "@/lib/media-catalog";
import type { AdvanceOpts, MediaJob, StartInput, StartResult } from "@/lib/media/types";
import type { SalesSnapshot } from "@/lib/connectors/sales";

/**
 * Rules 232, 234 and 235: the activity rows of the paid and scheduled work. A batch is one `generated` row (and a
 * refusal at the charge one `cap_reached` or `no_credits` row) with the owning agent, who asked and where; the judge adds
 * one `judged` row and one `autofail` row per trigger; a routine or the Sunday plan adds its outcome once; a render adds
 * its start and its end under the scope and agent the server stored on the job.
 */
const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
type Item = { channel: string; title: string; body: string };
const ITEMS: Item[] = [{ channel: "instagram", title: "قهوة اليوم", body: "نص أول" }, { channel: "instagram", title: "عرض الجمعة", body: "نص ثانٍ" }];
type Params = { system: string | { text: string }[]; messages: { role: string; content: unknown }[] };
type Turn = { stop_reason: string; content: unknown[] };
const reply = (text: string) => ({ model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: "text", text }] });
const clean = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };

async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await db.set(`brand:${u.email}`, brand);
  return (await getUser(u.email))!;
}
const rows = async (scope: string) => (await listActivity(scope, { limit: CAPS.activity })).rows;
const kinds = async (scope: string) => (await rows(scope)).map((r) => r.kind).sort();

/** A fresh module graph with the model on (or mock), a scripted SDK: items for generation, `verdicts` for the judge, `turns` for chat. */
async function load(o: { state?: "on" | "mock"; verdicts?: object[]; turns?: Turn[] } = {}) {
  vi.resetModules();
  const state = o.state ?? "on";
  vi.stubEnv("ANTHROPIC_API_KEY", state === "mock" ? "" : "test");
  vi.doMock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => state }));
  const turns = [...(o.turns ?? [])];
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      static BadRequestError = class extends Error {};
      beta = { messages: { stream: () => ({ finalMessage: async () => reply(JSON.stringify(ITEMS)) }) } };
      messages = {
        stream: () => ({ finalMessage: async () => { const t = turns.shift(); return t ? { model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 }, ...t } : reply("تمام"); } }),
        create: async (p: Params) => {
          const sys = typeof p.system === "string" ? p.system : p.system[0].text;
          if (!sys.startsWith("You are the quality judge")) return reply(JSON.stringify([{ ok: true }]));
          return reply(JSON.stringify(o.verdicts ?? ITEMS.map(() => clean)));
        },
      };
    },
  }));
  await import("@/lib/schedule");
  return {
    generate: await import("@/app/api/generate/route"),
    mcp: await import("@/app/api/mcp/route"),
    schedule: await import("@/app/api/schedule/route"),
    chat: await import("@/lib/chat"),
    routines: await import("@/lib/routines"),
    weekly: await import("@/lib/schedule"),
    /** The store as this module graph holds it (a spy on the test's own import would not reach it). */
    db: (await import("@/lib/db")).db,
  };
}

afterEach(async () => {
  await settle();
  for (const m of ["@anthropic-ai/sdk", "@/lib/model"]) vi.doUnmock(m);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  signOut();
});

describe("a batch is one row with the owning agent, who asked and where; the judge adds its own (rule 232)", () => {
  it("the generate route: one `generated` row, then one `judged` row with the mean score and one `autofail` row per trigger", async () => {
    const m = await load({ verdicts: [clean, { ...clean, honesty: 30, autofail: "invented_fact", notes: "made up" }] });
    const u = await owner("as-gen");
    await signIn(u.email);
    expect((await m.generate.POST(json("/api/generate", "POST", { type: "pricing_review" }))).status).toBe(200);
    await settle();
    const got = await rows(u.email);
    const gen = got.find((r) => r.kind === "generated")!;
    expect(gen).toMatchObject({ agent: "razan", by: { kind: "owner", email: u.email }, via: "app", type: "pricing_review", count: 2, credits: TASK_COST.pricing_review });
    expect(gen.tasks).toHaveLength(2);
    const tasks = await Promise.all(gen.tasks!.map(async (id) => (await import("@/lib/brand")).getTask(u.email, id)));
    const mean = Math.round(tasks.reduce((s, t) => s + t!.quality!.score, 0) / 2);
    expect(got.find((r) => r.kind === "judged")).toMatchObject({ agent: "razan", by: { kind: "system" }, via: "app", type: "pricing_review", count: 2, score: mean, tasks: gen.tasks });
    const failed = tasks.find((t) => t!.quality!.autofail)!;
    expect(got.find((r) => r.kind === "autofail")).toMatchObject({ agent: "razan", count: 1, autofail: "invented_fact", tasks: [failed.id] });
    expect(got).toHaveLength(3);
  });

  it("the judge names only items that still exist, and writes nothing for an account deleted while it worked", async () => {
    await load();
    const { judgeTasks } = await import("@/lib/judge");
    const t = (id: string): Task => ({ id, type: "pricing_review", channel: "doc", title: id, body: "نص", status: "pending", createdAt: new Date().toISOString(), lang: "ar" });
    const u = await owner("as-judge-gone");
    await Promise.all([saveTask(u.email, t("j1"), true), saveTask(u.email, t("j2"), true)]);
    await db.del(`task:${u.email}:j2`); // the owner deleted it while the judge worked
    await judgeTasks(u.email, u.email, brand, [t("j1"), t("j2")]);
    expect(await rows(u.email)).toEqual([expect.objectContaining({ kind: "judged", tasks: ["j1"], count: 1 })]);

    const v = await owner("as-judge-wiped");
    await Promise.all([saveTask(v.email, t("k1"), true), saveTask(v.email, t("k2"), true)]);
    await wipeAccount(v.email);
    await judgeTasks(v.email, v.email, brand, [t("k1"), t("k2")]);
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown>; lists: Map<string, string[]> } }).__nashrMem;
    expect([...mem.kv.keys(), ...mem.lists.keys()].filter((k) => k.startsWith("activity:") && k.includes(v.email)), "no log recreated for a wiped account").toEqual([]);
    expect(await db.get(`task:${v.email}:k1`)).toBeNull();
  });

  it("a refusal at the charge is one row, nothing charged: `cap_reached` with spent/cap, `no_credits` with the cost", async () => {
    const m = await load({ state: "mock" });
    const u = await owner("as-cap");
    await signIn(u.email);
    await saveGov(u.email, { agentCaps: { razan: 0 } });
    expect((await m.generate.POST(json("/api/generate", "POST", { type: "pricing_review" }))).status).toBe(402);
    const broke = await owner("as-broke");
    await db.set(`user:${broke.email}`, { ...broke, credits: 0 });
    await signIn(broke.email);
    expect((await m.generate.POST(json("/api/generate", "POST", { type: "social" }))).status).toBe(402);
    expect(await rows(u.email)).toEqual([expect.objectContaining({ kind: "cap_reached", agent: "razan", by: { kind: "owner", email: u.email }, via: "app", type: "pricing_review", credits: TASK_COST.pricing_review, outcome: "0/0" })]);
    expect(await rows(broke.email)).toEqual([expect.objectContaining({ kind: "no_credits", agent: "noor", via: "app", credits: TASK_COST.social })]);
  });

  it("MCP: via `mcp`, by the token; chat: the turn's login and agent reach the batch and the files", async () => {
    const m = await load({ state: "mock" });
    const u = await owner("as-mcp");
    const token = await createMcpToken(u.email);
    const res = await m.mcp.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_content", arguments: { type: "gbp" } } }) }));
    expect(((await res.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(await rows(u.email)).toEqual([expect.objectContaining({ kind: "generated", agent: "noor", by: { kind: "token", email: u.email }, via: "mcp", type: "gbp" })]);

    const v = await owner("as-chat");
    const member = { kind: "member" as const, email: "sara@team.example", role: "member" as const };
    await m.chat.runTool(v, "draft_items", { type: "sales_script", count: 1, brief: "b" }, [], [], undefined, { agent: "majed", by: member });
    // The batch's agent is the type's owner, not the talking agent; `by` is the turn's.
    expect(await rows(v.email)).toEqual([expect.objectContaining({ kind: "generated", agent: "sami", by: member, via: "chat", count: 1 })]);
  });

  it("a chat turn passes its agent and its login: the founder's support access talking to Sami is recorded as the founder, with Sami", async () => {
    const m = await load({ turns: [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "update_brand", input: { field: "tone", value: "هادئة" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "تم" }] },
    ] });
    const u = await owner("as-turn");
    // Support access as the console starts it: a session on this account whose record names the founder (`imp`).
    await signIn(u.email, { imp: "support-founder@test.example" });
    const s = (await currentUser())!;
    await m.chat.chat(s, "غيّر النبرة", undefined, "sami", { lang: "ar" });
    expect(await rows(u.email)).toEqual([expect.objectContaining({ kind: "brand_changed", agent: "sami", by: { kind: "founder", email: u.email, imp: "support-founder@test.example" }, via: "chat", note: "tone" })]);
    expect((await getBrand(u.email))!.tone).toBe("هادئة");
  });
});

const snap = (): SalesSnapshot => ({ provider: "salla", at: new Date().toISOString(), days: 30, orders: { count: 4, read: 4, canceled: 0, revenue: { SAR: 900 }, top: [{ name: "عود", qty: 2 }] }, carts: { count: 0, read: 0, value: {}, top: [] }, unread: 0 });

describe("a scheduled run adds its outcome once; nothing-new at most once a period (rule 234)", () => {
  it("a routine that ran: `generated` by the routine and `routine_ran`; at the agent's cap: only `routine_skipped`, no second refusal row", async () => {
    const m = await load({ state: "on" });
    const u = await owner("as-rt");
    await Promise.all([db.set(`storesales:${u.email}`, snap()), saveSchedule(u.email, { routines: { razan_cash_forecast: true } })]);
    const out = await m.routines.runRoutine(u, "razan_cash_forecast");
    expect(out).toMatch(/^ok:[1-9]$/);
    const n = Number(out.slice(3));
    const sys = { kind: "system", job: "routine" };
    const got = await rows(u.email);
    expect(got.find((r) => r.kind === "generated")).toMatchObject({ agent: "razan", by: sys, via: "routine", type: "cash_forecast", count: n });
    expect(got.find((r) => r.kind === "routine_ran")).toMatchObject({ agent: "razan", by: sys, via: "routine", type: "cash_forecast", count: n, outcome: out });

    const v = await owner("as-rt-cap");
    await Promise.all([db.set(`storesales:${v.email}`, snap()), saveSchedule(v.email, { routines: { razan_cash_forecast: true } }), saveGov(v.email, { agentCaps: { razan: 0 } })]);
    expect(await m.routines.runRoutine(v, "razan_cash_forecast")).toBe("agent_cap");
    expect(await rows(v.email)).toEqual([expect.objectContaining({ kind: "routine_skipped", agent: "razan", by: sys, via: "routine", outcome: "agent_cap" })]);
  });

  it("idle is one row a period however often the cron asks; off and retries are none; a throw is `error` and still throws", async () => {
    const m = await load({ state: "on" });
    const u = await owner("as-idle");
    await saveSchedule(u.email, { routines: { dana_weekly_report: true } });
    expect(await m.routines.runRoutine(u, "dana_weekly_report")).toBe("idle");
    expect(await m.routines.runRoutine(u, "dana_weekly_report")).toBe("idle");
    expect(await rows(u.email)).toEqual([expect.objectContaining({ kind: "routine_skipped", agent: "dana", outcome: "idle", type: "weekly_report" })]);
    expect(await db.get(actSkipKey(u.email, "dana_weekly_report", periodOf("weekly")))).not.toBeNull();
    await saveSchedule(u.email, { routines: { dana_weekly_report: false } });
    expect(await m.routines.runRoutine(u, "dana_weekly_report")).toBe("off");
    expect(await rows(u.email)).toHaveLength(1);

    // The same rules at the recorder: the next period records its idle again; retries, "off" and done periods never do.
    const run = { id: "dana_weekly_report", agent: "dana" as const, type: "weekly_report" as const, via: "routine" as const, by: { kind: "system" as const, job: "routine" as const }, ttlS: 60 };
    for (const o of ["retry:locked", "retry:paused", "off", "already_this_period", "skip:mock", "no_brand"]) await recordRun(u.email, { ...run, period: "p1" }, o);
    await recordRun(u.email, { ...run, period: "next-week" }, "idle");
    await recordRun(u.email, { ...run, period: "next-week" }, "no_data");
    for (const o of ["attempts_exhausted", "attempts_exhausted", "cap_reached", "trial_over", "no_credits"]) await recordRun(u.email, { ...run, period: "p1" }, o);
    expect((await rows(u.email)).map((r) => r.outcome).sort()).toEqual(["attempts_exhausted", "attempts_exhausted", "cap_reached", "idle", "idle", "no_credits", "trial_over"]);

    const v = await owner("as-throw");
    await Promise.all([db.set(`storesales:${v.email}`, snap()), saveSchedule(v.email, { routines: { razan_cash_forecast: true } })]);
    // The attempt counter's write fails after the lock: the run throws, and its outcome is still recorded.
    vi.spyOn(m.db, "incrby").mockRejectedValueOnce(new Error("upstash down"));
    await expect(m.routines.runRoutine(v, "razan_cash_forecast")).rejects.toThrow("upstash down");
    expect(await rows(v.email)).toEqual([expect.objectContaining({ kind: "routine_skipped", outcome: "error", agent: "razan" })]);
  });

  it("the Sunday plan: the cron's run is the system's, the owner's Run now is the owner's", async () => {
    const m = await load({ state: "on" });
    const u = await owner("as-week");
    const out = await m.weekly.runWeekly(u);
    expect(out).toMatch(/^ok:[1-9]$/);
    await settle();
    const cron = { kind: "system", job: "cron" };
    expect(await kinds(u.email)).toEqual(["generated", "judged", "routine_ran"]);
    expect((await rows(u.email)).find((r) => r.kind === "routine_ran")).toMatchObject({ agent: "noor", by: cron, via: "weekly", type: "weekly_plan", count: Number(out.slice(3)), outcome: out });
    expect((await rows(u.email)).find((r) => r.kind === "generated")).toMatchObject({ by: cron, via: "weekly" });
    // The judge's row carries the batch's via, not a default.
    expect((await rows(u.email)).find((r) => r.kind === "judged")).toMatchObject({ agent: "noor", by: { kind: "system" }, via: "weekly" });

    const v = await owner("as-week-now");
    await signIn(v.email);
    await m.schedule.POST(json("/api/schedule", "POST", { run: "weekly" }));
    await settle();
    expect((await rows(v.email)).filter((r) => r.kind !== "judged").map((r) => [r.kind, r.by])).toEqual(expect.arrayContaining([["generated", { kind: "owner", email: v.email }], ["routine_ran", { kind: "owner", email: v.email }]]));
  });
});

describe("a render is recorded at its start and its end, under the job's own scope and agent (rule 235)", () => {
  const net = noNetwork();
  beforeAll(() => { vi.resetModules(); });
  afterAll(() => net.restore());
  beforeEach(() => {
    resetMediaCounters();
    mediaEnv({ fal: true, kie: true, higgsfield: true, blob: true, models: "all" });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const taskFor = async (u: User, over: Partial<Task> = {}) => {
    const t: Task = { id: `t${randomBytes(4).toString("hex")}`, type: "social", channel: "instagram", title: "عرض", body: "نص", status: "pending", createdAt: new Date().toISOString(), lang: "ar", ...over };
    await saveTask(u.email, t, true);
    return t;
  };
  const input = (u: User, t: Task, model: MediaModelId, over: Partial<StartInput> = {}): StartInput => ({
    scope: u.email, email: u.email, lang: u.lang, accountSince: u.createdAt, plan: "pro", balance: u.credits, agent: "noor", taskId: t.id, model,
    aspect: "square", deadline: Date.now() + 100_000, prompt: async () => "a test prompt", ...over,
  });
  const started = (r: StartResult): MediaJob => { if (!r.ok) throw new Error(`refused ${r.error}`); return r.job; };
  const sweep = (): AdvanceOpts => ({ force: true, deadline: Date.now() + 100_000, via: "sweep" });

  it("a charge is `image_started` with who started it; the result is `render_done` by the engine; a failed one says whether the credits went back", async () => {
    const { startMedia, advance } = await import("@/lib/media/jobs");
    const u = await newUser("as-media");
    const t = await taskFor(u);
    const member = { kind: "member" as const, email: "sara@team.example", role: "admin" as const };
    started(await startMedia(input(u, t, "img-fast", { by: member, from: "chat" }), fakeDeps({ fal: fakeAdapter("fal") })));
    const got = await rows(u.email);
    expect(got.find((r) => r.kind === "image_started")).toMatchObject({ agent: "noor", by: member, via: "chat", tasks: [t.id], credits: 1, media: "image" });
    expect(got.find((r) => r.kind === "render_done")).toMatchObject({ agent: "noor", by: { kind: "system" }, via: "media", type: "social", tasks: [t.id], credits: 1, media: "image" });

    const v = await newUser("as-media-fail");
    const t2 = await taskFor(v);
    const kie = fakeAdapter("kie", { status: () => ({ state: "failed", reason: "provider_failed" }) });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(v, t2, "img-balanced"), deps));
    expect((await advance(job, deps, sweep())).state).toBe("failed");
    expect((await rows(v.email)).find((r) => r.kind === "render_failed")).toMatchObject({ agent: "noor", by: { kind: "system" }, via: "cron", outcome: "provider_failed", refunded: true, media: "image", tasks: [t2.id] });
    expect((await rows(v.email)).find((r) => r.kind === "image_started")).toMatchObject({ by: { kind: "owner", email: v.email }, via: "app" });
  });

  it("the row uses the job's stored scope and agent, and a job that ends after its account was wiped writes nothing", async () => {
    const { startMedia, advance } = await import("@/lib/media/jobs");
    const u = await newUser("as-media-own");
    // A second brand's scope, and an agent the job was charged to that is not the item's type owner: the end row must
    // take both from the job the server stored, not from the account or the item.
    const scope = `${u.email}#b2`;
    const t: Task = { id: `t${randomBytes(4).toString("hex")}`, type: "social", channel: "instagram", title: "عرض", body: "نص", status: "pending", createdAt: new Date().toISOString(), lang: "ar" };
    await saveTask(scope, t, true);
    const kie = fakeAdapter("kie", { status: () => ({ state: "done", urls: ["https://tempfile.kie.example/r.png"] }) });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, t, "img-balanced", { scope, agent: "dana" }), deps));
    expect(job.spend).toMatchObject({ scope, agent: "dana" });
    expect((await advance(job, deps, { deadline: Date.now() + 100_000, via: "poll" })).state).toBe("done");
    expect((await rows(scope)).find((r) => r.kind === "render_done")).toMatchObject({ agent: "dana", via: "media", type: "social", tasks: [t.id] });
    expect(await rows(u.email)).toEqual([]);

    const w = await newUser("as-media-gone");
    const tw = await taskFor(w);
    const pending = fakeAdapter("kie", { status: () => ({ state: "failed", reason: "provider_failed" }) });
    const d2 = fakeDeps({ kie: pending });
    const j2 = started(await startMedia(input(w, tw, "img-balanced"), d2));
    await wipeAccount(w.email);
    expect((await advance(j2, d2, sweep())).state).toBe("failed");
    expect(await db.lrange(`activity:${w.email}`, 0, -1)).toEqual([]);
  });

  it("a refusal at the agent's cap or the balance is one row, nothing charged", async () => {
    const { startMedia } = await import("@/lib/media/jobs");
    const u = await newUser("as-media-cap");
    const t = await taskFor(u);
    expect(await startMedia(input(u, t, "vid-quick", { cap: 12, spent: 1 }), fakeDeps({ kie: fakeAdapter("kie") }))).toMatchObject({ ok: false, error: "agent_cap" });
    expect(await startMedia(input(u, t, "img-fast", { balance: 0 }), fakeDeps({ fal: fakeAdapter("fal") }))).toMatchObject({ ok: false, error: "no_credits" });
    const got = await rows(u.email);
    expect(got.find((r) => r.kind === "cap_reached")).toMatchObject({ agent: "noor", media: "video", credits: 12, outcome: "1/12", tasks: [t.id] });
    expect(got.find((r) => r.kind === "no_credits")).toMatchObject({ agent: "noor", media: "image", credits: 1 });
    expect((await getUser(u.email))!.credits).toBe(50);
  });
});
