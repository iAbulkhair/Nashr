import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { User } from "@/lib/auth";
import type { Task } from "@/lib/brand";

/**
 * Rules 4620-4669 (docs/system/tests/4620-v2-plans.md): Thakeen v2 phase 2, goals and plans (C3) on the durable queue (C7).
 * Both ship off (src/lib/v2-flags.ts); this file switches `PLANS` and `QUEUE` per test through the flags module, so the
 * real tool, routes, approval, tick and wipe run as they will once the switches are flipped. The batch itself is replaced
 * by a stand-in that saves one pending task per step and runs the caller's `commit`, as `generateBatch` does.
 */
const flag = vi.hoisted(() => ({ plans: true, queue: true }));
vi.mock("@/lib/v2-flags", () => ({
  GATEWAY_MODE: "off",
  RUN_LOG: false,
  MEMORY_V2: false,
  COMPACTION: false,
  get PLANS() {
    return flag.plans;
  },
  get QUEUE() {
    return flag.queue;
  },
  SELF_CHECK: false,
  TEAM_CHAT: false,
  RESEARCH: false,
}));
const g = vi.hoisted(() => ({ n: 0, calls: [] as Record<string, unknown>[], refuse: null as null | string }));
vi.mock("@/lib/generate-batch", async (orig) => {
  const real = await orig<typeof import("@/lib/generate-batch")>();
  const { DEFAULT_GOV } = await import("@/lib/governance");
  const { saveTask } = await import("@/lib/brand");
  return {
    ...real,
    generateBatch: async (_u: User, scope: string, opts: Record<string, unknown>) => {
      g.calls.push(opts);
      if (g.refuse)
        return { ok: false, reason: g.refuse, ...(g.refuse === "failed" ? { error: new Error("x"), credits: 0 } : {}) };
      g.n++;
      const t: Task = {
        id: `${g.n}`.padStart(16, "a"),
        type: opts.type as Task["type"],
        channel: "instagram",
        title: "عنوان",
        body: "نص",
        status: "pending",
        createdAt: new Date().toISOString(),
        lang: "ar",
        ...(opts.plan ? { plan: opts.plan as Task["plan"] } : {}),
      };
      await saveTask(scope, t, true);
      await (opts.commit as (ts: Task[]) => Promise<unknown>)([t]);
      return {
        ok: true,
        tasks: [t],
        credits: 90,
        receipt: { ok: true, credits: 90 },
        cost: 2,
        agent: "noor",
        gov: DEFAULT_GOV,
      };
    },
  };
});

import { json, newUser, params, signIn } from "./helpers/session";
import { acct, currentUser, getUser, saveUser, sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { globalKey, wsKey } from "@/lib/keys";
import { byOf } from "@/lib/actor";
import { agentForTask } from "@/lib/agents";
import { TASK_COST, updateTask } from "@/lib/brand";
import { saveGov } from "@/lib/governance";
import type { ToolCtx } from "@/lib/chat-gates";
import { toolsFor } from "@/lib/chat-tools";
import {
  PLAN_APPROVE_DAYS,
  PLAN_MAX_STEPS,
  PLAN_TYPES,
  cancelPlan,
  createPlan,
  getPlan,
  parsePlan,
  pausePlan,
  planKeys,
  planView,
  readySteps,
  resumePlan,
  savePlan,
  type Plan,
} from "@/lib/plans";
import { PLAN_TOOL, runMakePlan } from "@/lib/plan-tool";
import { approvePlan, leadBriefOf, tickScope } from "@/lib/plan-run";
import { QUEUE_MAX_ATTEMPTS, listQueued, queueKeys, queueScopes } from "@/lib/queue";
import { wipeAccount } from "@/lib/account";
import { turnParts } from "@/lib/chat-reply";
import * as planRoute from "@/app/api/plans/[id]/route";
import * as queueCron from "@/app/api/cron/queue/route";
import { GOAL_PLAN_COPY } from "@/components/app/GoalPlanCard";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
async function owner(prefix: string, credits = 500): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...(await getUser(acct(u)))!, credits });
  await signIn(u.email);
  return (await currentUser())!;
}
const turn = (u: User, extra: Partial<ToolCtx> = {}): ToolCtx =>
  ({ agent: "majed", by: byOf(u), via: "app", conv: "c1", ...extra }) as ToolCtx;
const INPUT = {
  goal: "إطلاق منتج جديد",
  steps: [
    { type: "article", brief: "مقال عن المنتج" },
    { type: "social", brief: "منشورات الإطلاق", after: [0] },
  ],
};
const later = () => Date.now() + 300_000;
async function proposed(u: User, input: Record<string, unknown> = INPUT): Promise<Plan> {
  const d = parsePlan(input);
  if (!d.ok) throw new Error(d.error);
  return createPlan(sc(u), d.draft, { requestedBy: byOf(u), conv: "c1" });
}
const act = (id: string, action: string) =>
  planRoute.POST(json(`/api/plans/${id}`, "POST", { action }), params({ id }));

beforeEach(() => {
  flag.plans = true;
  flag.queue = true;
  g.calls = [];
  g.refuse = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rule 4620: the switches ship off, and off changes nothing", () => {
  it("the flags are false in the shipped module", () => {
    const f = src("src/lib/v2-flags.ts");
    for (const k of ["PLANS", "QUEUE", "SELF_CHECK"])
      expect(f).toMatch(new RegExp(`export const ${k}: boolean = false;`));
  });
  it("off: Majed is not offered make_plan, the tool is unknown, the routes are 404, the tick and the cron read nothing", async () => {
    flag.plans = false;
    flag.queue = false;
    const u = await owner("plan-off");
    expect(toolsFor("majed").map((t) => t.name)).not.toContain(PLAN_TOOL.name);
    const actions: string[] = [];
    expect(await runMakePlan(u, INPUT, turn(u), actions)).toBe("Unknown tool.");
    expect(actions).toEqual([]);
    expect(await db.lrange(wsKey.goalPlans(sc(u)), 0, -1)).toEqual([]);
    expect(
      (await planRoute.GET(json("/api/plans/aaaaaaaaaaaaaaaa", "GET"), params({ id: "aaaaaaaaaaaaaaaa" }))).status,
    ).toBe(404);
    expect((await act("aaaaaaaaaaaaaaaa", "approve")).status).toBe(404);
    expect(await tickScope(u, later())).toBe("off");
    vi.stubEnv("CRON_SECRET", "q".repeat(40));
    const r = await queueCron.GET(
      new Request("http://x/api/cron/queue", { headers: { authorization: `Bearer ${"q".repeat(40)}` } }),
    );
    expect(await r.json()).toEqual({ ok: true, off: true });
  });
  it("on: only Majed is offered make_plan", () => {
    expect(toolsFor("majed").map((t) => t.name)).toContain(PLAN_TOOL.name);
    for (const a of ["noor", "dana", "reem"] as const)
      expect(toolsFor(a).map((t) => t.name)).not.toContain(PLAN_TOOL.name);
  });
  it("the queue cron refuses a wrong bearer", async () => {
    vi.stubEnv("CRON_SECRET", "q".repeat(40));
    expect(
      (await queueCron.GET(new Request("http://x/api/cron/queue", { headers: { authorization: "Bearer nope" } })))
        .status,
    ).toBe(401);
  });
});

describe("rules 4621-4625: the plan is parsed in code", () => {
  it("2 to 8 steps of plan types, each with a brief, waiting only for earlier steps", () => {
    expect(parsePlan({ ...INPUT, goal: " " })).toEqual({ ok: false, error: "no_goal" });
    expect(parsePlan({ ...INPUT, steps: [INPUT.steps[0]] })).toEqual({ ok: false, error: "steps" });
    expect(parsePlan({ ...INPUT, steps: Array.from({ length: PLAN_MAX_STEPS + 1 }, () => INPUT.steps[0]) })).toEqual({
      ok: false,
      error: "steps",
    });
    expect(parsePlan({ ...INPUT, steps: [INPUT.steps[0], { type: "nope", brief: "x" }] })).toEqual({
      ok: false,
      error: "bad_type",
    });
    const reem = ["whatsapp", "weekly_plan", "social", "article", "ads", "gbp", "cart_recovery"].find(
      (t) => !PLAN_TYPES.includes(t as never),
    );
    if (reem)
      expect(parsePlan({ ...INPUT, steps: [INPUT.steps[0], { type: reem, brief: "x" }] })).toEqual({
        ok: false,
        error: "own_type",
      });
    expect(parsePlan({ ...INPUT, steps: [INPUT.steps[0], { type: "social", brief: "" }] })).toEqual({
      ok: false,
      error: "no_brief",
    });
    expect(parsePlan({ ...INPUT, steps: [INPUT.steps[0], { type: "social", brief: "x", after: [1] }] })).toEqual({
      ok: false,
      error: "bad_after",
    });
    expect(parsePlan({ ...INPUT, steps: [{ type: "social", brief: "x", after: [0] }, INPUT.steps[0]] })).toEqual({
      ok: false,
      error: "bad_after",
    });
    expect(PLAN_TYPES.every((t) => agentForTask(t).id !== "reem")).toBe(true);
  });
  it("hidden characters are stripped and the agent and the cost come from code", async () => {
    const d = parsePlan({
      goal: "هدف‮",
      steps: [
        { type: "article", brief: "a" },
        { type: "social", brief: "b", after: [0, 0] },
      ],
    });
    expect(d.ok && d.draft.goal).toBe("هدف");
    expect(d.ok && d.draft.steps[1].after).toEqual([0]);
    const u = await owner("plan-parse");
    const p = await proposed(u);
    expect(p.steps.map((s) => [s.agent, s.cost, s.status])).toEqual([
      [agentForTask("article").id, TASK_COST.article, "waiting"],
      [agentForTask("social").id, TASK_COST.social, "waiting"],
    ]);
    expect(p.total).toBe(TASK_COST.article + TASK_COST.social);
    expect(leadBriefOf(p, 1)).toContain("step (2 of 2)");
  });
});

describe("rules 4626-4628: make_plan stores a proposal and nothing else", () => {
  it("only Majed, never over MCP or for a token, one plan a reply", async () => {
    const u = await owner("plan-tool");
    expect(await runMakePlan(u, INPUT, turn(u, { agent: "noor" }), [])).toMatch(/^Not done: only Majed/);
    expect(await runMakePlan(u, INPUT, turn(u, { via: "mcp" }), [])).toMatch(/^Not done: plans are made only/);
    const actions: string[] = [];
    expect(await runMakePlan(u, INPUT, turn(u), actions)).toMatch(/^Not started: the plan is saved as a proposal/);
    expect(await runMakePlan(u, INPUT, turn(u), actions)).toMatch(/already carries a plan/);
    expect(actions).toHaveLength(1);
    const id = actions[0].slice("goalplan:".length);
    const p = (await getPlan(sc(u), id))!;
    expect(p.status).toBe("proposed");
    expect(g.calls).toEqual([]);
    expect(await listQueued(sc(u))).toEqual([]);
    expect(turnParts(actions, [], []).goalPlan).toEqual({ id });
    expect(turnParts(["goalplan:../x"], [], []).goalPlan).toBeUndefined();
  });
  it("a refused draft saves nothing", async () => {
    const u = await owner("plan-bad");
    const actions: string[] = [];
    expect(await runMakePlan(u, { goal: "x", steps: [] }, turn(u), actions)).toMatch(/^Not saved/);
    expect(actions).toEqual([]);
    expect(await db.lrange(wsKey.goalPlans(sc(u)), 0, -1)).toEqual([]);
  });
});

describe("rules 4629-4633: Approve is checked in code", () => {
  it("queue off: nothing approves", async () => {
    const u = await owner("plan-qoff");
    const p = await proposed(u);
    flag.queue = false;
    expect(await approvePlan(u, p.id, byOf(u))).toEqual({ ok: false, error: "queue_off" });
  });
  it("a fresh balance under the total is refused, and nothing is queued", async () => {
    const u = await owner("plan-poor", 1);
    const p = await proposed(u);
    expect(await approvePlan(u, p.id, byOf(u))).toMatchObject({
      ok: false,
      error: "no_credits",
      need: p.total,
      credits: 1,
    });
    expect((await getPlan(sc(u), p.id))!.status).toBe("proposed");
    expect(await listQueued(sc(u))).toEqual([]);
  });
  it("an agent's monthly cap that the steps would pass is refused", async () => {
    const u = await owner("plan-cap");
    await saveGov(sc(u), { agentCaps: { [agentForTask("social").id]: TASK_COST.social - 1 } });
    const p = await proposed(u);
    expect(await approvePlan(u, p.id, byOf(u))).toMatchObject({
      ok: false,
      error: "agent_cap",
      agent: agentForTask("social").id,
    });
  });
  it("an old proposal is expired, and a second Approve is not_proposed", async () => {
    const u = await owner("plan-old");
    const p = await proposed(u);
    const old = new Date(Date.now() - (PLAN_APPROVE_DAYS + 1) * 864e5).toISOString();
    await savePlan(sc(u), { ...p, createdAt: old });
    expect(planView((await getPlan(sc(u), p.id))!).expired).toBe(true);
    expect(await approvePlan(u, p.id, byOf(u))).toEqual({ ok: false, error: "expired" });
    const q = await proposed(u);
    expect((await approvePlan(u, q.id, byOf(u))).ok).toBe(true);
    expect(await approvePlan(u, q.id, byOf(u))).toEqual({ ok: false, error: "not_proposed" });
  });
  it("Approve queues the steps that wait for nothing, charges nothing and puts the scope in the tick's set", async () => {
    const u = await owner("plan-ok");
    const p = await proposed(u);
    const before = (await getUser(acct(u)))!.credits;
    const r = await approvePlan(u, p.id, byOf(u));
    expect(r.ok).toBe(true);
    const saved = (await getPlan(sc(u), p.id))!;
    expect(saved.status).toBe("approved");
    expect(saved.steps.map((s) => s.status)).toEqual(["queued", "waiting"]);
    expect((await listQueued(sc(u))).map((j) => j.step)).toEqual([0]);
    expect(await queueScopes()).toContain(sc(u));
    expect((await getUser(acct(u)))!.credits).toBe(before);
  });
  it("another account's plan id is 404 on both routes", async () => {
    const a = await owner("plan-a");
    const p = await proposed(a);
    await owner("plan-b");
    expect((await planRoute.GET(json(`/api/plans/${p.id}`, "GET"), params({ id: p.id }))).status).toBe(404);
    expect((await act(p.id, "approve")).status).toBe(404);
    expect((await act("../../x", "approve")).status).toBe(404);
  });
});

describe("rules 4634-4649: the tick runs one step at a time, and a later step waits for approved items", () => {
  it("a step runs under its own claim with its plan, and the next waits until its items are approved", async () => {
    const u = await owner("plan-run");
    const p = await proposed(u);
    await approvePlan(u, p.id, byOf(u));
    expect(await tickScope(u, later())).toBe("done");
    const call = g.calls[0];
    expect(call).toMatchObject({
      type: "article",
      source: "handoff",
      forcePending: true,
      once: `planstep:${sc(u)}:${p.id}:0`,
      plan: { id: p.id, step: 0 },
      selfCheck: true,
    });
    expect(String(call.leadBrief)).toContain(p.goal);
    let cur = (await getPlan(sc(u), p.id))!;
    expect(cur.steps.map((s) => s.status)).toEqual(["done", "waiting"]);
    // The item is still pending: step 2 waits.
    expect(await tickScope(u, later())).toBe("waiting");
    expect(g.calls).toHaveLength(1);
    await updateTask(sc(u), cur.steps[0].tasks![0], (t) => ({ ...t, status: "approved" }));
    expect(await tickScope(u, later())).toBe("done");
    cur = (await getPlan(sc(u), p.id))!;
    expect(cur.status).toBe("done");
    expect(g.calls[1]).toMatchObject({ type: "social", plan: { id: p.id, step: 1 } });
    // Nothing left: the scope leaves the set.
    expect(await tickScope(u, later())).toBe("idle");
    expect(await queueScopes()).not.toContain(sc(u));
  });
  it("too little time left starts nothing", async () => {
    const u = await owner("plan-late");
    const p = await proposed(u);
    await approvePlan(u, p.id, byOf(u));
    expect(await tickScope(u, Date.now() + 10_000)).toBe("retry:late");
    expect(g.calls).toEqual([]);
  });
  it("a refusal before the charge pauses the plan for the owner; Resume queues it again", async () => {
    const u = await owner("plan-refused");
    const p = await proposed(u);
    await approvePlan(u, p.id, byOf(u));
    g.refuse = "no_credits";
    expect(await tickScope(u, later())).toBe("refused:no_credits");
    const cur = (await getPlan(sc(u), p.id))!;
    expect(cur.status).toBe("paused");
    expect(cur.steps[0]).toMatchObject({ status: "failed", reason: "no_credits" });
    g.refuse = null;
    expect((await resumePlan(sc(u), p.id)).ok).toBe(true);
    expect(await tickScope(u, later())).toBe("done");
  });
  it("a failed run is tried again once, then the step stops", async () => {
    const u = await owner("plan-fail");
    const p = await proposed(u);
    await approvePlan(u, p.id, byOf(u));
    g.refuse = "failed";
    expect(await tickScope(u, later())).toBe("failed:retry");
    expect(QUEUE_MAX_ATTEMPTS).toBe(2);
    expect(await tickScope(u, later())).toBe("refused:failed");
    expect((await getPlan(sc(u), p.id))!.status).toBe("paused");
  });
  it("Pause takes the waiting jobs out; Cancel ends the plan and nothing more runs", async () => {
    const u = await owner("plan-pause");
    const p = await proposed(u);
    await approvePlan(u, p.id, byOf(u));
    expect((await pausePlan(sc(u), p.id)).ok).toBe(true);
    expect((await getPlan(sc(u), p.id))!.steps[0].status).toBe("waiting");
    expect(await tickScope(u, later())).not.toBe("done");
    expect(g.calls).toEqual([]);
    expect(await pausePlan(sc(u), p.id)).toEqual({ ok: false, error: "not_running" });
    expect((await cancelPlan(sc(u), p.id)).ok).toBe(true);
    expect((await getPlan(sc(u), p.id))!.steps.map((s) => s.status)).toEqual(["cancelled", "cancelled"]);
    expect(await cancelPlan(sc(u), p.id)).toEqual({ ok: false, error: "finished" });
    expect(readySteps((await getPlan(sc(u), p.id))!, new Set([0]))).toEqual([]);
  });
  it("the routes: a Viewer reads, the owner approves through POST and gets the view back", async () => {
    const u = await owner("plan-route");
    const p = await proposed(u);
    const got = await planRoute.GET(json(`/api/plans/${p.id}`, "GET"), params({ id: p.id }));
    expect(got.status).toBe(200);
    const view = ((await got.json()) as { plan: Record<string, unknown> }).plan;
    expect(view).not.toHaveProperty("requestedBy");
    const r = await act(p.id, "approve");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { plan: { status: string } }).plan.status).toBe("approved");
    expect((await act(p.id, "bogus")).status).toBe(400);
  });
});

describe("rules 4650-4669: the durable queue, the sweep and the wipe", () => {
  it("the wipe removes every plan, step receipt, job and the queue list", async () => {
    const u = await owner("plan-wipe");
    const p = await proposed(u);
    await approvePlan(u, p.id, byOf(u));
    await tickScope(u, later());
    const s = sc(u);
    const keys = [...(await planKeys(s)), ...(await queueKeys(s))];
    expect(keys).toContain(wsKey.goalPlan(s, p.id));
    expect(keys).toContain(wsKey.queue(s));
    expect(keys).toContain(globalKey.runReceipt(`planstep:${s}:${p.id}:0`));
    expect(await db.get(globalKey.runReceipt(`planstep:${s}:${p.id}:0`))).not.toBeNull();
    await wipeAccount(acct(u));
    expect(await Promise.all(keys.map((k) => db.get(k).catch(() => "non-string")))).toEqual(keys.map(() => null));
  });
  it("the daily sweep keeps a delivered planstep hold and refunds an undelivered one", () => {
    const sweep = src("src/lib/hold-sweep.ts");
    expect(sweep).toMatch(/\^\(routine\|handoff\|planstep\):/);
    expect(sweep).toMatch(/claim\.startsWith\("planstep:"\) \? receipt\.get\(claim\)\?\.state === "delivered"/);
  });
  it("the cron is listed, beats and is kicked by Reem's tick only while QUEUE is on", () => {
    expect(src("crons.json")).toContain('"/api/cron/queue"');
    expect(src("src/lib/cron-heartbeat.ts")).toMatch(/queue: 26 \* 3600/);
    expect(src("src/app/api/cron/queue/route.ts")).toMatch(/recordCronRun\("queue"\)/);
    expect(src("src/app/api/cron/secretary/route.ts")).toMatch(/QUEUE && /);
  });
  it("the card's words exist in both languages and the card renders no markup", () => {
    expect(Object.keys(GOAL_PLAN_COPY.ar).sort()).toEqual(Object.keys(GOAL_PLAN_COPY.en).sort());
    expect(src("src/components/app/GoalPlanCard.tsx")).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
