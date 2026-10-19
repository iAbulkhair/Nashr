import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, newUser, settle, signIn } from "./helpers/session";
import { claudeOn } from "./helpers/model";
import { getUser, saveUser, type User } from "@/lib/auth";
import { agentSpendFor } from "@/lib/credits";
import { db } from "@/lib/db";
import { saveGov } from "@/lib/governance";
import { listTasks, saveTask, type Brand, type Task } from "@/lib/brand";
import { addBrand, scopeFor } from "@/lib/brands";
import { wipeAccount } from "@/lib/account";
import { agentForTask } from "@/lib/agents";
import { decisionOf, recordDecisions } from "@/lib/decisions";
import { getSchedule, saveSchedule } from "@/lib/schedule";
import { statsFor } from "@/lib/stats";
import { listNotifs } from "@/lib/notifications";
import { TASK_COST } from "@/lib/tasks";
import { OWNER_SYNC_KEY, ROUTINES, ROUTINE_IDS, dueRoutines, isRoutineId, markOwnerSync, periodOf, ranThisPeriod, routineKeys, routineOn, runRoutine, type RoutineId } from "@/lib/routines";
import type { SalesSnapshot } from "@/lib/connectors/sales";
import * as scheduleRoute from "@/app/api/schedule/route";
import * as cronRoutines from "@/app/api/cron/routines/route";

/**
 * Rules 111-115: routines give Dana, Noor, Razan and Majed recurring work the owner turns on per brand. They are off by
 * default, run at most once per week or month, only on real input data (checked in code, "idle" or "no_data" charge
 * nothing), refuse before any charge while Claude is paused or without a key, stay inside the weekly cap and the
 * agent's monthly cap, refund a failed generation, and leave nothing behind when the account is deleted.
 */
const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const DAY = 864e5;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const snap = (at: string, over: Partial<SalesSnapshot> = {}): SalesSnapshot => ({
  provider: "salla", at, days: 30,
  orders: { count: 40, read: 40, canceled: 2, revenue: { SAR: 12500 }, top: [{ name: "عود ملكي", qty: 12 }] },
  carts: { count: 7, read: 7, value: { SAR: 900 }, top: [{ name: "مسك أبيض", qty: 4 }] },
  unread: 0, ...over,
});
const item = (id: string, over: Partial<Task> = {}): Task => ({ id, type: "social", channel: "instagram", title: `title ${id}`, body: "نص العنصر", status: "pending", createdAt: new Date().toISOString(), lang: "ar", source: "manual", ...over });
/**
 * An owner with a brand file and these routines switched on in the default brand. Since rule 1486 a routine is on unless
 * switched off, so every routine not named here is stored off: these tests keep running only the routines they name.
 */
async function owner(prefix: string, routines: Partial<Record<RoutineId, boolean>> = {}): Promise<User> {
  const u = await newUser(prefix);
  const all = { ...Object.fromEntries(ROUTINE_IDS.map((id) => [id, false])), ...routines } as Record<RoutineId, boolean>;
  await Promise.all([db.set(`brand:${u.email}`, brand), saveSchedule(u.email, { routines: all })]);
  return (await getUser(u.email))!;
}
const credits = async (email: string) => (await getUser(email))!.credits;
const spend = async (email: string, scope = email) => agentSpendFor((await getUser(email))!, scope);
const allOn = Object.fromEntries(ROUTINE_IDS.map((id) => [id, true])) as Record<RoutineId, boolean>;

type Params = { system: string | { text: string }[]; messages: { role: string; content: unknown }[]; output_config?: { format?: unknown } };
const reply = (text: string) => ({ model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: "text", text }] });
const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };

/**
 * The SDK, replaced and counted, with the model state forced (Claude "on" by default). `prompts` holds each generation's
 * user message, so what the agent was given can be read back; `made` counts clients, so "no model call" is a number.
 */
function sdk(opts: { genFails?: boolean; state?: "on" | "paused"; hang?: { on: boolean } } = {}) {
  vi.resetModules();
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  if (opts.state === "paused") vi.doMock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "paused" as const }));
  else claudeOn();
  const seen = { made: 0, prompts: [] as string[] };
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      static BadRequestError = class extends Error {};
      constructor() { seen.made++; }
      beta = { messages: { stream: (p: Params) => ({ finalMessage: async () => { seen.prompts.push(String(p.messages[0].content)); if (opts.genFails) throw new Error("model down"); if (opts.hang?.on) return new Promise<never>(() => {}); // As many items as the prompt asks for, so no batch is a short one (rule 2276).
      const n = Number(/Return exactly (\d+) item/.exec(String(p.messages[0].content))?.[1] ?? 1);
      return reply(JSON.stringify(Array.from({ length: n }, () => ({ channel: "doc", title: "t", body: "نص تجريبي للعنصر يكفي للمراجعة" })))); } }) } };
      messages = {
        chat: () => ({ finalMessage: async () => reply("تمام") }),
        create: async (p: Params) => {
          const sys = typeof p.system === "string" ? p.system : p.system[0].text;
          return reply(sys.startsWith("You are the quality judge") ? JSON.stringify([verdict]) : JSON.stringify([{ ok: true }]));
        },
        stream(p: { tools?: unknown; tool_choice?: unknown; output_config?: { format?: unknown } }, o?: unknown) { return (p.tools && !p.tool_choice) || p.output_config?.format ? (this.chat as (...a: unknown[]) => unknown)(p, o) : { finalMessage: async () => (this.create as (...a: unknown[]) => unknown)(p, o) }; },
      };
    },
  }));
  return seen;
}
const load = () => import("@/lib/routines");
const tries = (scope: string, id: RoutineId) => db.get<number>(`routinetry:${scope}:${id}:${periodOf(ROUTINES.find((r) => r.id === id)!.cadence)}`);

afterEach(() => { vi.doUnmock("@anthropic-ai/sdk"); vi.doUnmock("@/lib/model"); vi.unstubAllEnvs(); });

describe("the routine registry (rule 111)", () => {
  it("has four routines, each charged to the agent that owns its type, and ids are checked by membership", () => {
    expect(ROUTINE_IDS).toEqual(["dana_weekly_report", "noor_cart_recovery", "razan_cash_forecast", "majed_monthly_review"]);
    for (const r of ROUTINES) expect(agentForTask(r.type).id, r.id).toBe(r.agent);
    expect(ROUTINES.map((r) => [r.id, r.type, r.cadence])).toEqual([["dana_weekly_report", "weekly_report", "weekly"], ["noor_cart_recovery", "cart_recovery", "weekly"], ["razan_cash_forecast", "cash_forecast", "monthly"], ["majed_monthly_review", "strategy_review", "monthly"]]);
    for (const bad of ["constructor", "toString", "__proto__", "weekly_plan", "", 42, null]) expect(isRoutineId(bad)).toBe(false);
    expect(isRoutineId("razan_cash_forecast")).toBe(true);
  });

  it("every routine is on by default, on added brands too, and the owner's off stays off (rule 1486)", async () => {
    const u = await newUser("rt-default");
    expect((await getSchedule(u.email)).routines).toBeUndefined();
    await db.set(`brand:${u.email}`, brand);
    for (const id of ROUTINE_IDS) expect(routineOn(await getSchedule(u.email), id), id).toBe(true);
    expect((await dueRoutines([u])).map((x) => x.id).sort()).toEqual([...ROUTINE_IDS].sort());
    // An added brand's routines are on too (unlike its Sunday plan, rule 247).
    const added = scopeFor(u.email, "b2");
    for (const id of ROUTINE_IDS) expect(routineOn(await getSchedule(added), id), id).toBe(true);
    // The owner's explicit off is kept, and only that routine is off.
    await saveSchedule(u.email, { routines: { razan_cash_forecast: false } });
    expect(await runRoutine(u, "razan_cash_forecast")).toBe("off");
    expect((await dueRoutines([u])).map((x) => x.id)).not.toContain("razan_cash_forecast");
    expect((await dueRoutines([u])).length).toBe(ROUTINE_IDS.length - 1);
    // Plan caps are unchanged: the runner still checks trial, gate, weekly cap, agent cap and credits before charging.
    const src = readFileSync("src/lib/routines.ts", "utf8");
    expect(src).toMatch(/if \(!routineOn\(sched, id\)\) return "off";/);
    for (const k of ["trialOver(user)", "holdBatch(scope", "generateBatch(user"]) expect(src).toContain(k);
    expect(readFileSync("src/components/app/TasksPanel.tsx", "utf8")).toContain("on={s.routines?.[x.id] !== false");
  });
});

describe("the runner refuses before any charge (rule 112)", () => {
  it("while Claude is paused every routine answers retry:paused: no charge, no model, no lock left", async () => {
    const seen = sdk({ state: "paused" });
    const u = await owner("rt-paused", allOn);
    // Every gate would pass: a fresh store sync, recent activity and decisions.
    await db.set(`storesales:${u.email}`, snap(new Date().toISOString()));
    const done = [item("a1"), item("a2"), item("a3")];
    await Promise.all(done.map((t) => saveTask(u.email, t, true)));
    await recordDecisions(u.email, done.map((t) => decisionOf(t, "approve", new Date().toISOString())));
    const { runRoutine: run } = await load();
    for (const id of ROUTINE_IDS) expect(await run(u, id), id).toBe("retry:paused");
    expect(seen.made).toBe(0);
    expect(await credits(u.email)).toBe(50);
    expect(await spend(u.email)).toEqual({});
    expect((await listTasks(u.email)).filter((t) => t.source === "scheduled")).toEqual([]);
    for (const id of ROUTINE_IDS) expect(await db.get(`routinelock:${u.email}:${id}`)).toBeNull();
  });

  it("without a model key the output would be placeholders, so every routine answers skip:mock and charges nothing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const u = await owner("rt-mock", allOn);
    await db.set(`storesales:${u.email}`, snap(new Date().toISOString()));
    for (const id of ROUTINE_IDS) {
      const r = await runRoutine(u, id);
      expect(r, id).toBe("skip:mock");
      expect(r.startsWith("retry"), "final for the day, not left open").toBe(false);
    }
    expect(await credits(u.email)).toBe(50);
    expect(await listTasks(u.email)).toEqual([]);
  });

  it("no brand, an ended trial and a held lock charge nothing either", async () => {
    const seen = sdk();
    const { runRoutine: run } = await load();
    const bare = await newUser("rt-nobrand");
    await saveSchedule(bare.email, { routines: allOn });
    expect(await run(bare, "dana_weekly_report")).toBe("no_brand");

    const u = await owner("rt-trial", { dana_weekly_report: true });
    await saveTask(u.email, item("x1"), true);
    const ended = { ...u, trialEnds: ago(1) };
    await saveUser(ended);
    expect(await run(ended, "dana_weekly_report")).toBe("trial_over");

    const v = await owner("rt-lock", { dana_weekly_report: true });
    await saveTask(v.email, item("x2"), true);
    await db.lock(`routinelock:${v.email}:dana_weekly_report`, 300);
    expect(await run(v, "dana_weekly_report")).toBe("retry:locked");
    expect(seen.made).toBe(0);
    expect(await credits(u.email)).toBe(50);
    expect(await credits(v.email)).toBe(50);
  });
});

describe("a routine runs only on real input (rule 113)", () => {
  it("Dana's weekly report: idle without the owner's activity in 7 days; any of six signals is activity", async () => {
    const seen = sdk();
    const { runRoutine: run } = await load();
    // Nothing at all; then only items created on their own; then only an owner's item older than 7 days.
    const quiet = await owner("rt-dana-quiet", { dana_weekly_report: true });
    expect(await run(quiet, "dana_weekly_report")).toBe("idle");
    await saveTask(quiet.email, item("s1", { source: "scheduled", type: "weekly_plan" }), true);
    expect(await run(quiet, "dana_weekly_report"), "the routines must not keep each other busy").toBe("idle");
    await saveTask(quiet.email, item("old", { createdAt: ago(10) }), true);
    expect(await run(quiet, "dana_weekly_report")).toBe("idle");
    expect(seen.made).toBe(0);
    expect(await credits(quiet.email)).toBe(50);

    const signals: Record<string, (u: User) => Promise<unknown>> = {
      "an item the owner created": (u) => saveTask(u.email, item("n1"), true),
      "a decision in the light index": (u) => saveTask(u.email, item("d1", { createdAt: ago(20), status: "approved", decidedAt: new Date().toISOString() }), true),
      "a decision record on an older item": (u) => recordDecisions(u.email, [decisionOf(item("d2", { createdAt: ago(20) }), "reject", new Date().toISOString())]),
      "a store sync": (u) => db.set(`storesales:${u.email}`, snap(ago(2))),
      "an ad-account sync": (u) => db.set(`adsync:${u.email}:snapchat`, ago(1)),
      // Rule 736: a click on Refresh for the site or social results; the daily cron's reads of them never count.
      "an owner's site or social refresh": (u) => markOwnerSync(u.email, new Date(Date.now() - 2 * DAY)),
    };
    for (const [what, add] of Object.entries(signals)) {
      const u = await owner("rt-dana", { dana_weekly_report: true });
      await add(u);
      expect(await run(u, "dana_weekly_report"), what).toBe("ok:1");
      expect(await credits(u.email), what).toBe(50 - TASK_COST.weekly_report);
      expect(await spend(u.email), what).toEqual({ dana: TASK_COST.weekly_report });
    }
    await settle();
  });

  it("a run saves the batch as scheduled with the routine as its brief, records the run and tells the owner once", async () => {
    sdk();
    const { runRoutine: run } = await load();
    const u = await owner("rt-save", { dana_weekly_report: true });
    await saveTask(u.email, item("n1"), true);
    expect(await run(u, "dana_weekly_report")).toBe("ok:1");
    const made = (await listTasks(u.email)).filter((t) => t.type === "weekly_report");
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ source: "scheduled", brief: "dana_weekly_report", status: "pending" });
    const last = await db.get<string>(`routinelast:${u.email}:dana_weekly_report`);
    expect(last && Date.now() - Date.parse(last)).toBeLessThan(60_000);
    const notes = (await listNotifs(u.email)).filter((n) => n.agent === "dana");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "pending", title: "التقرير الأسبوعي من دانة في صندوق الموافقة", href: "/ar/app/" });
    expect(await db.get(`notifseen:${u.email}:routine:${u.email}:dana_weekly_report:${periodOf("weekly")}`)).toBe(1);
    await settle();
  });

  it("Noor's cart recovery: no_data without carts, and idle until the store is synced again after its last run", async () => {
    const seen = sdk();
    const { runRoutine: run } = await load();
    const u = await owner("rt-cart", { noor_cart_recovery: true });
    expect(await run(u, "noor_cart_recovery")).toBe("no_data");
    await db.set(`storesales:${u.email}`, snap(ago(9), { carts: { count: 0, read: 0, value: {}, top: [] } }));
    expect(await run(u, "noor_cart_recovery"), "a sync with no carts left is nothing to recover").toBe("no_data");
    // Last run 8 days ago (an earlier week), after the sync 9 days ago: nothing new since.
    await db.set(`storesales:${u.email}`, snap(ago(9)));
    await db.set(`routinelast:${u.email}:noor_cart_recovery`, ago(8));
    expect(await run(u, "noor_cart_recovery")).toBe("idle");
    expect(seen.made).toBe(0);
    expect(await credits(u.email)).toBe(50);
    await db.set(`storesales:${u.email}`, snap(ago(1)));
    // The full batch of five a cart-recovery run asks for.
    expect(await run(u, "noor_cart_recovery")).toBe("ok:5");
    expect(seen.prompts.at(-1)).toContain("<cart_data>");
    expect(await spend(u.email)).toEqual({ noor: 3 });
    await settle();
  });

  it("Razan's cash forecast: no_data without a sync in 35 days; with one, she is given the STORE DATA", async () => {
    const seen = sdk();
    const { runRoutine: run } = await load();
    const u = await owner("rt-cash", { razan_cash_forecast: true });
    expect(await run(u, "razan_cash_forecast")).toBe("no_data");
    await db.set(`storesales:${u.email}`, snap(ago(40)));
    expect(await run(u, "razan_cash_forecast")).toBe("no_data");
    expect(seen.made).toBe(0);
    await db.set(`storesales:${u.email}`, snap(ago(10)));
    expect(await run(u, "razan_cash_forecast")).toBe("ok:1");
    const prompt = seen.prompts.at(-1)!;
    expect(prompt).toContain("STORE DATA");
    expect(prompt).toContain("<store_data>");
    expect(await spend(u.email)).toEqual({ razan: 4 });
    await settle();
  });

  it("Majed's monthly review: idle under 3 decided items in 30 days; records and the light index both count, each item once", async () => {
    const seen = sdk();
    const { runRoutine: run } = await load();
    const u = await owner("rt-majed", { majed_monthly_review: true });
    const now = new Date().toISOString();
    const a = item("m1", { createdAt: ago(40) }), b = item("m2", { createdAt: ago(40) });
    // Three records, two items: approved, reopened and approved again is still one item. One record is too old.
    await recordDecisions(u.email, [decisionOf(a, "approve", ago(3)), decisionOf(a, "reopen", ago(2)), decisionOf(a, "approve", now), decisionOf(b, "reject", now), decisionOf(item("m0"), "approve", ago(31))]);
    expect(await run(u, "majed_monthly_review")).toBe("idle");
    expect(seen.made).toBe(0);
    // A third item, decided before decision records existed: only the light index knows.
    await saveTask(u.email, item("m3", { createdAt: ago(5), status: "approved", decidedAt: ago(4) }), true);
    expect(await run(u, "majed_monthly_review")).toBe("ok:1");
    expect(seen.prompts.at(-1)).toContain("WORKSPACE DATA");
    expect(await spend(u.email)).toEqual({ majed: 5 });
    await settle();
  });
});

describe("once per period, inside the weekly cap and the agent's cap (rule 114)", () => {
  it("a second run in the same week or month is refused and charged once", async () => {
    sdk();
    const { runRoutine: run } = await load();
    const u = await owner("rt-once", { dana_weekly_report: true, razan_cash_forecast: true });
    await Promise.all([saveTask(u.email, item("n1"), true), db.set(`storesales:${u.email}`, snap(ago(1)))]);
    expect(await run(u, "dana_weekly_report")).toBe("ok:1");
    expect(await run(u, "dana_weekly_report")).toBe("already_this_period");
    expect(await run(u, "razan_cash_forecast")).toBe("ok:1");
    expect(await run(u, "razan_cash_forecast")).toBe("already_this_period");
    expect(await credits(u.email)).toBe(50 - TASK_COST.weekly_report - TASK_COST.cash_forecast);
    expect(await dueRoutines([u])).toEqual([]);
    await settle();
  });

  it("a run that finished between the period check and the lock is not repeated", async () => {
    const seen = sdk();
    const { runRoutine: run } = await load();
    const { db: store } = await import("@/lib/db");
    const u = await owner("rt-race", { dana_weekly_report: true });
    await saveTask(u.email, item("n1"), true);
    // Another invocation (a chain hop) completes the routine just before this one takes the lock.
    const lock = store.lock.bind(store);
    const spy = vi.spyOn(store, "lock").mockImplementationOnce(async (key, ttl) => { await store.set(`routinelast:${u.email}:dana_weekly_report`, new Date().toISOString()); return lock(key, ttl); });
    expect(await run(u, "dana_weekly_report")).toBe("already_this_period");
    spy.mockRestore();
    expect(seen.made).toBe(0);
    expect(await credits(u.email)).toBe(50);
    expect(await store.lock(`routinelock:${u.email}:dana_weekly_report`, 1), "the lock was released").toBe(true);
  });

  it("the period is the UTC week from Sunday or the UTC month", () => {
    const sunday = new Date("2026-09-27T00:30:00Z");
    expect(periodOf("weekly", sunday)).toBe("2026-09-27");
    expect(ranThisPeriod("weekly", "2026-09-26T23:59:00.000Z", sunday)).toBe(false);
    expect(ranThisPeriod("weekly", "2026-09-27T00:00:00.000Z", sunday)).toBe(true);
    expect(ranThisPeriod("weekly", "2026-09-27T00:00:00.000Z", new Date("2026-10-03T23:59:00Z"))).toBe(true);
    const first = new Date("2026-10-01T06:00:00Z");
    expect(periodOf("monthly", first)).toBe("2026-10");
    expect(ranThisPeriod("monthly", "2026-09-30T23:59:00.000Z", first)).toBe(false);
    expect(ranThisPeriod("monthly", "2026-10-01T00:00:00.000Z", first)).toBe(true);
    expect(ranThisPeriod("monthly", null, first)).toBe(false);
  });

  it("the weekly cap counts the whole batch on top of what was created on its own in 7 days", async () => {
    const seen = sdk();
    const { runRoutine: run } = await load();
    const u = await owner("rt-cap", { noor_cart_recovery: true });
    await db.set(`storesales:${u.email}`, snap(ago(1)));
    // A cart-recovery batch is 5 items.
    await saveGov(u.email, { weeklyCap: 4 });
    expect(await run(u, "noor_cart_recovery")).toBe("cap_reached");
    await Promise.all([1, 2, 3].map((n) => saveTask(u.email, item(`s${n}`, { source: "scheduled" }), true)));
    await saveGov(u.email, { weeklyCap: 7 });
    expect(await run(u, "noor_cart_recovery"), "3 + 5 is over 7").toBe("cap_reached");
    expect(seen.made).toBe(0);
    expect(await credits(u.email)).toBe(50);
    await saveGov(u.email, { weeklyCap: 8 });
    expect(await run(u, "noor_cart_recovery")).toBe("ok:5");
    await settle();
  });

  it("the agent's monthly cap and the balance stop a run before anything is charged or any model is called", async () => {
    const seen = sdk();
    const { runRoutine: run } = await load();
    const u = await owner("rt-agentcap", { dana_weekly_report: true });
    await saveTask(u.email, item("n1"), true);
    await saveGov(u.email, { agentCaps: { dana: 1 } });
    expect(await run(u, "dana_weekly_report")).toBe("agent_cap");
    expect(await credits(u.email)).toBe(50);
    expect(await spend(u.email)).toEqual({});
    await saveGov(u.email, { agentCaps: { dana: null } });
    await saveUser({ ...(await getUser(u.email))!, credits: 1 });
    expect(await run(u, "dana_weekly_report")).toBe("no_credits");
    expect(await credits(u.email)).toBe(1);
    expect(seen.made).toBe(0);
    expect(await db.get(`routinelast:${u.email}:dana_weekly_report`)).toBeNull();
    expect(await tries(u.email, "dana_weekly_report"), "a refused charge is not an attempt").toBe(0);
  });

  it("a failed generation gives back the credits and the agent's count, records no run and releases the lock", async () => {
    sdk({ genFails: true });
    const { runRoutine: run } = await load();
    const u = await owner("rt-fail", { dana_weekly_report: true });
    await saveTask(u.email, item("n1"), true);
    await expect(run(u, "dana_weekly_report")).rejects.toThrow("model down");
    expect(await credits(u.email)).toBe(50);
    expect(await spend(u.email)).toEqual({ dana: 0 });
    expect(await db.get(`routinelast:${u.email}:dana_weekly_report`)).toBeNull();
    expect(await db.lock(`routinelock:${u.email}:dana_weekly_report`, 1)).toBe(true);
    expect((await listTasks(u.email)).filter((t) => t.type === "weekly_report")).toEqual([]);
    expect(await tries(u.email, "dana_weekly_report"), "a refunded charge is not left behind").toBe(0);
    expect(await db.get(`routinehold:${u.email}:dana_weekly_report`)).toBeNull();
  });

  it("two routines of one brand started together cannot both pass a weekly cap that fits one batch", async () => {
    const seen = sdk();
    const { runRoutine: run } = await load();
    const u = await owner("rt-cap-race", { dana_weekly_report: true, razan_cash_forecast: true });
    // A fresh store sync passes both gates; each batch is one item, and the cap fits one.
    await db.set(`storesales:${u.email}`, snap(ago(1)));
    await saveGov(u.email, { weeklyCap: 1 });
    const out = await Promise.all([run(u, "dana_weekly_report"), run(u, "razan_cash_forecast")]);
    expect([...out].sort()).toEqual(["cap_reached", "ok:1"]);
    expect((await listTasks(u.email)).filter((t) => t.source === "scheduled")).toHaveLength(1);
    expect(seen.prompts).toHaveLength(1);
    const won = out[0] === "ok:1" ? "dana" : "razan";
    const cost = TASK_COST[won === "dana" ? "weekly_report" : "cash_forecast"];
    expect(await spend(u.email)).toEqual({ [won]: cost });
    expect(await credits(u.email)).toBe(50 - cost);
    for (const id of ROUTINE_IDS) expect(await db.get(`routinehold:${u.email}:${id}`), id).toBeNull();
    expect(await db.get(`routinecap:${u.email}`)).toBeNull();
    await settle();
  });

  it("a run the platform kills after the charge is charged at most twice in its period, not once a day", async () => {
    const hang = { on: true };
    const seen = sdk({ hang });
    const { runRoutine: run } = await load();
    const u = await owner("rt-killed", { dana_weekly_report: true });
    await saveTask(u.email, item("n1"), true);
    // Each "day": the cron starts the run, the generation outlives the function, and the platform ends it. Nothing is
    // refunded or saved and no last run is recorded; the lock and the hold expire before the next day's cron.
    for (const day of [1, 2]) {
      void run(u, "dana_weekly_report");
      await vi.waitFor(() => expect(seen.prompts).toHaveLength(day));
      await Promise.all([db.unlock(`routinelock:${u.email}:dana_weekly_report`), db.del(`routinehold:${u.email}:dana_weekly_report`)]);
      expect(await credits(u.email)).toBe(50 - TASK_COST.weekly_report * day);
    }
    expect(await dueRoutines([u]), "still due: it never ran").toHaveLength(1);
    hang.on = false;
    expect(await run(u, "dana_weekly_report")).toBe("attempts_exhausted");
    expect(await run(u, "dana_weekly_report")).toBe("attempts_exhausted");
    expect(seen.prompts, "no third generation").toHaveLength(2);
    expect(await credits(u.email)).toBe(50 - 2 * TASK_COST.weekly_report);
    expect(await spend(u.email)).toEqual({ dana: 2 * TASK_COST.weekly_report });
  });
});

describe("the owner's switches and the cron (rule 115)", () => {
  it("PUT /api/schedule keeps only real routine ids with boolean values, merges them, and writes the caller's active brand only", async () => {
    const a = await newUser("rt-put");
    const b = await newUser("rt-other");
    await signIn(a.email);
    const put = async (body: unknown) => { const res = await scheduleRoute.PUT(json("/api/schedule", "PUT", body)); expect(res.status).toBe(200); return ((await res.json()) as { schedule: { routines?: unknown } }).schedule; };
    // Parsed from text so "__proto__" is an own key, as it is in a request body.
    const hostile = JSON.parse(`{"routines": {"dana_weekly_report": true, "constructor": true, "__proto__": true, "bogus": true, "razan_cash_forecast": "yes"}, "scope": "${b.email}", "email": "${b.email}"}`);
    expect((await put(hostile)).routines).toEqual({ dana_weekly_report: true });
    expect((await put({ routines: { majed_monthly_review: true } })).routines).toEqual({ dana_weekly_report: true, majed_monthly_review: true });
    expect((await put({ routines: { dana_weekly_report: false }, weeklyPlan: false })).routines).toEqual({ dana_weekly_report: false, majed_monthly_review: true });
    expect((await put(null)).routines, "a null body changes nothing").toEqual({ dana_weekly_report: false, majed_monthly_review: true });
    expect((await put({ routines: ["dana_weekly_report"] })).routines).toEqual({ dana_weekly_report: false, majed_monthly_review: true });
    expect((await getSchedule(a.email)).weeklyPlan).toBe(false);
    expect((await getSchedule(b.email)).routines).toBeUndefined();

    await saveUser({ ...(await getUser(a.email))!, plan: "agency" });
    const second = await addBrand((await getUser(a.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    expect((await put({ routines: { noor_cart_recovery: true } })).routines).toEqual({ noor_cart_recovery: true });
    expect((await getSchedule(scopeFor(a.email, second.id))).routines).toEqual({ noor_cart_recovery: true });
    expect((await getSchedule(a.email)).routines).toEqual({ dana_weekly_report: false, majed_monthly_review: true });
  });

  it("the cron route needs the exact bearer secret", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-abcdef");
    const call = (auth?: string) => cronRoutines.GET(new Request("https://nashr.test/api/cron/routines", { headers: auth ? { authorization: auth } : {} }));
    for (const auth of [undefined, "Bearer cron-secret-abcdeX", "Bearer ", "cron-secret-abcdef-extra"]) expect((await call(auth)).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(401);
  });

  it("the cron schedules only routines that are on and have not run in their period, per brand", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-abcdef");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const on = await owner("rt-cron-on", { dana_weekly_report: true, noor_cart_recovery: false });
    const off = await owner("rt-cron-off");
    const ran = await owner("rt-cron-ran", { razan_cash_forecast: true, majed_monthly_review: true });
    await db.set(`routinelast:${ran.email}:razan_cash_forecast`, new Date().toISOString());
    await db.set(`routinelast:${ran.email}:majed_monthly_review`, ago(40)); // last month: due again
    const multi = await owner("rt-cron-brand");
    await saveUser({ ...multi, plan: "agency" });
    const second = await addBrand((await getUser(multi.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const scope = scopeFor(multi.email, second.id);
    await Promise.all([db.set(`brand:${scope}`, brand), saveSchedule(scope, { routines: { ...Object.fromEntries(ROUTINE_IDS.map((id) => [id, false])), noor_cart_recovery: true } })]);

    const res = await cronRoutines.GET(new Request("https://nashr.test/api/cron/routines", { headers: { authorization: "Bearer cron-secret-abcdef" } }));
    expect(res.status).toBe(200);
    const report = (await res.json()) as { job: string; results: Record<string, string> };
    expect(report.job).toBe("routines");
    const mine = Object.fromEntries(Object.entries(report.results).filter(([k]) => [on, off, ran, multi].some((u) => k.startsWith(u.email))));
    expect(mine).toEqual({ [`${on.email}:dana_weekly_report`]: "skip:mock", [`${ran.email}:majed_monthly_review`]: "skip:mock", [`${scope}:noor_cart_recovery`]: "skip:mock" });
  });
});

describe("data blocks and deletion (rules 113, 115)", () => {
  it("statsFor gives the cash forecast STORE DATA only, and the strategy review WORKSPACE DATA plus STORE DATA when synced", async () => {
    const u = await newUser("rt-stats");
    expect(await statsFor("cash_forecast", u.email)).toBe("");
    const plain = await statsFor("strategy_review", u.email);
    expect(plain).toContain("WORKSPACE DATA");
    expect(plain).not.toContain("STORE DATA");
    await db.set(`storesales:${u.email}`, snap(ago(1)));
    const cash = await statsFor("cash_forecast", u.email);
    expect(cash).toContain("STORE DATA (the owner's connected store");
    expect(cash).toContain("<store_data>");
    expect(cash).not.toContain("WORKSPACE DATA");
    const review = await statsFor("strategy_review", u.email);
    expect(review).toContain("WORKSPACE DATA");
    expect(review).toContain("<store_data>");
    // The rest of Razan's and Majed's work is unchanged.
    for (const t of ["pricing_review", "unit_economics", "okrs", "decision_memo"] as const) expect(await statsFor(t, u.email), t).toBe("");
  });

  it("wipeAccount deletes every routine's keys and run notices in every brand", async () => {
    const u = await owner("rt-wipe", allOn);
    await saveUser({ ...u, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const scopes = [u.email, scopeFor(u.email, second.id)];
    const keys = scopes.flatMap((s) => routineKeys(s));
    // Per brand: the cap lock, and per routine its last run, lock, hold and the attempt counts of two periods.
    expect(keys).toHaveLength(2 * (1 + ROUTINE_IDS.length * 5));
    for (const s of scopes) {
      expect(keys).toEqual(expect.arrayContaining([`routinecap:${s}`, `routinehold:${s}:noor_cart_recovery`, `routinetry:${s}:razan_cash_forecast:${periodOf("monthly")}`, `routinetry:${s}:dana_weekly_report:${periodOf("weekly")}`]));
    }
    // The run notices name the brand and live 8 or 35 days: a new account at the same address must get its own.
    const seen = scopes.flatMap((s) => ROUTINES.map((r) => `notifseen:${u.email}:routine:${s}:${r.id}:${periodOf(r.cadence)}`));
    await Promise.all([...keys, ...seen].map((k) => db.set(k, new Date().toISOString())));
    await wipeAccount(u.email);
    for (const k of [...keys, ...seen]) expect(await db.get(k), k).toBeNull();
  });

  it("wipeAccount deletes the owner's refresh mark in every brand (rules 736, 747)", async () => {
    const u = await owner("rt-ownersync");
    await saveUser({ ...u, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const scopes = [u.email, scopeFor(u.email, second.id)];
    expect(scopes.map(OWNER_SYNC_KEY)).toEqual(scopes.map((s) => `ownersync:${s}`));
    await Promise.all(scopes.map((s) => markOwnerSync(s)));
    for (const s of scopes) expect(await db.get(OWNER_SYNC_KEY(s)), s).not.toBeNull();
    await wipeAccount(u.email);
    for (const s of scopes) expect(await db.get(OWNER_SYNC_KEY(s)), s).toBeNull();
  });
});
