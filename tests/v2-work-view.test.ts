import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Rules 4770-4789 (docs/system/tests/4720-v2-team.md): Thakeen v2 phase 3, the work view (C9). It reads the run log, so it
 * follows `RUN_LOG`, which ships off (src/lib/v2-flags.ts). This file switches it on through the flags module to read the
 * route; the pure parts and the step listener take the switch as an argument.
 */
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/v2-flags", () => ({
  GATEWAY_MODE: "off",
  get RUN_LOG() {
    return flag.on;
  },
  MEMORY_V2: false,
  COMPACTION: false,
  PLANS: false,
  QUEUE: false,
  SELF_CHECK: false,
  TEAM_CHAT: false,
  RESEARCH: false,
}));

import { newMember, newUser, signIn, signOut } from "./helpers/session";
import { acct, getUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { wsKey, type Scope } from "@/lib/keys";
import { appDict } from "@/lib/app-i18n";
import { runEvent, withRun, type Run, type RunEvent } from "@/lib/runs";
import { agreeWithRuns, workRun, workStep, type WorkStep } from "@/lib/work-view";
import type { AgentStatus } from "@/lib/agent-status";
import RunTimeline, { stepLabel } from "@/components/app/RunTimeline";
import WorkPanel from "@/components/app/WorkPanel";

const SONNET = "claude-sonnet-5-5";
const src = (p: string) => readFileSync(p, "utf8");
async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  await signIn(u.email);
  return (await getUser(acct(u)))!;
}
const CONV = "c_" + "a".repeat(16);
const run = (over: Partial<Run> = {}): Run => ({
  v: 1,
  id: "r-" + Math.random().toString(36).slice(2),
  kind: "chat",
  agent: "noor",
  via: "app",
  startedAt: new Date().toISOString(),
  ms: 2400,
  ok: true,
  events: [
    { t: "tool", at: 30, tool: "generate_content", outcome: "ran", ms: 4, verdict: "allow", rule: "authority_auto" },
    { t: "model", at: 5, model: SONNET, kind: "chat", agent: "noor", in: 1200, out: 300, ok: true },
    { t: "check", at: 40, score: 72, rewritten: true },
  ],
  dropped: 0,
  ...over,
});
async function seedRun(s: Scope, r: Run) {
  await Promise.all([db.set(wsKey.run(s, r.id), r), db.lpush(wsKey.runs(s), r.id)]);
}
async function getRuns(q = "") {
  const route = await import("@/app/api/runs/route");
  const res = await route.GET(new Request("https://nashr.test/api/runs" + q));
  return {
    status: res.status,
    body: (await res.json()) as { ok: boolean; runs?: ReturnType<typeof workRun>[]; meters?: unknown[] },
  };
}

describe("rules 4770-4772: a stored step as the person sees it", () => {
  it("maps each kind with its state and tokens, and never carries a model id or a gateway rule", () => {
    expect(
      workStep({ t: "model", at: 1, model: SONNET, kind: "chat", agent: "faris", in: 10, out: 5, ok: false }),
    ).toEqual({
      kind: "model",
      at: 1,
      agent: "faris",
      name: "chat",
      state: "error",
      tokens: 15,
    });
    const tool = (outcome: "ran" | "refused" | "error") =>
      workStep({ t: "tool", at: 2, tool: "publish_item", outcome, ms: 1 }).state;
    expect([tool("ran"), tool("refused"), tool("error")]).toEqual(["ok", "refused", "error"]);
    expect(workStep({ t: "publish", at: 3, provider: "composio", ok: true })).toMatchObject({
      name: "composio",
      state: "ok",
    });
    expect(workStep({ t: "check", at: 4, score: 55, rewritten: false })).toEqual({
      kind: "check",
      at: 4,
      name: "self_check",
      state: "ok",
      score: 55,
      rewritten: false,
    });
    const r = workRun(run());
    expect(r.steps.map((s) => s.kind)).toEqual(["model", "tool", "check"]);
    expect(r.tokens).toBe(1500);
    const out = JSON.stringify(r);
    expect(out).not.toContain(SONNET);
    expect(out).not.toContain("authority_auto");
  });

  it("rules 4772-4773: the self-check records its score in the open run, and a batch run names its agent", () => {
    expect(src("src/lib/self-check.ts")).toMatch(
      /for \(const t of out\)\s+if \(typeof t\.selfCheck\?\.first === "number"\)\s+runEvent\(\{ t: "check", score: t\.selfCheck\.first, rewritten: t\.selfCheck\.rewritten \}\);/,
    );
    expect(src("src/lib/generate-batch.ts")).toMatch(/withRun\(\{[^}]*agent: agentForTask\(opts\.type\)\.id/);
  });
});

describe("rule 4774: a turn's steps reach the chat as they happen", () => {
  it("withRun hands each step to the listener; a listener that throws changes nothing", async () => {
    const u = await owner("wv-live");
    const seen: RunEvent[] = [];
    const out = await withRun(
      { scope: sc(u), kind: "chat", agent: "noor", onStep: (e) => seen.push(e) },
      async () => {
        runEvent({ t: "check", score: 80, rewritten: false });
        runEvent({ t: "publish", provider: "composio", ok: true });
        return 7;
      },
      true,
    );
    expect(out).toBe(7);
    expect(seen.map((e) => e.t)).toEqual(["check", "publish"]);
    const ids = await db.lrange(wsKey.runs(sc(u)), 0, -1);
    const stored = await db.get<Run & { onStep?: unknown }>(wsKey.run(sc(u), ids[0]));
    expect(stored?.events).toHaveLength(2);
    expect(stored && "onStep" in stored).toBe(false);

    const again = await withRun(
      {
        scope: sc(u),
        kind: "chat",
        onStep: () => {
          throw new Error("closed");
        },
      },
      async () => {
        runEvent({ t: "check", score: 1, rewritten: false });
        return "fine";
      },
      true,
    );
    expect(again).toBe("fine");
  });

  it("the chat route streams a step event, and the chat passes the listener and its thread to the run", () => {
    expect(src("src/app/api/chat/route.ts")).toMatch(
      /onStep: \(e\) => send\(\{ type: "step", step: workStep\(e\) \}\)/,
    );
    expect(src("src/lib/chat.ts")).toMatch(/\.\.\.runConv\(conv\), onStep: opts\.onStep \}/);
    expect(src("src/components/app/ChatPanel.tsx")).toMatch(
      /else if \(ev\.type === "step"\) setWork\(\(p\) => \[\.\.\.p, ev\.step\]\);/,
    );
  });
});

describe("rules 4775-4777: GET /api/runs", () => {
  it("reads only the caller's own runs, with each step's view and the thread's meters", async () => {
    const b = await owner("wv-b");
    await seedRun(sc(b), run());
    const a = await owner("wv-a");
    const mine = run();
    const thread = run({
      conv: CONV,
      agent: "faris",
      events: [{ t: "model", at: 1, model: SONNET, kind: "chat", agent: "faris", in: 500, out: 1, ok: true }],
    });
    await Promise.all([seedRun(sc(a), mine), seedRun(sc(a), thread)]);

    const all = await getRuns();
    expect(all.status).toBe(200);
    expect(all.body.runs?.map((r) => r.id).sort()).toEqual([mine.id, thread.id].sort());
    expect(JSON.stringify(all.body)).not.toContain(SONNET);
    expect(all.body.meters).toEqual([expect.objectContaining({ agent: "noor", used: 1200 })]);

    const one = await getRuns("?conv=" + CONV);
    expect(one.body.runs?.map((r) => r.id)).toEqual([thread.id]);
    expect(one.body.meters).toEqual([expect.objectContaining({ agent: "faris", used: 500, hot: false })]);
    expect((await getRuns("?conv=" + "x".repeat(65))).status).toBe(400);
  });

  it("a viewer reads it; signed out it is refused; off it is not found", async () => {
    const o = await owner("wv-view");
    await seedRun(sc(o), run());
    const v = await newMember(o, "viewer", "wv-viewer");
    await signIn(v.email);
    const seen = await getRuns();
    expect(seen.status).toBe(200);
    expect(seen.body.runs).toHaveLength(1);
    signOut();
    expect((await getRuns()).status).toBe(401);
    await owner("wv-off");
    flag.on = false;
    try {
      expect((await getRuns()).status).toBe(404);
    } finally {
      flag.on = true;
    }
  });
});

describe("rules 4778-4779: the timeline and the panel", () => {
  const steps: WorkStep[] = workRun(run()).steps;
  it("says each step in words in both languages, the state in words beside the tone", () => {
    const en = renderToStaticMarkup(createElement(RunTimeline, { steps, t: appDict.en }));
    expect(en).toContain('data-step="tool"');
    expect(en).toContain('data-state="ok"');
    expect(en).toContain(stepLabel(appDict.en, steps[1]));
    expect(en).toContain("1500 tokens");
    expect(stepLabel(appDict.en, steps[2])).toContain("72");
    expect(stepLabel(appDict.ar, steps[2])).toContain(appDict.ar.work.rewritten);
    const empty = renderToStaticMarkup(createElement(RunTimeline, { steps: [], t: appDict.ar }));
    expect(empty).toContain(appDict.ar.work.empty);
    expect(en).not.toMatch(/[٠-٩]/);
    expect(renderToStaticMarkup(createElement(RunTimeline, { steps, t: appDict.ar }))).not.toMatch(/[٠-٩]/);
  });

  it("the panel opens with the server's read and shows a hot meter with its words", () => {
    const html = renderToStaticMarkup(
      createElement(WorkPanel, {
        t: appDict.en,
        lang: "en",
        initial: {
          runs: [workRun(run())],
          meters: [{ agent: "noor", used: 900, budget: 1000, pct: 0.9, hot: true, at: new Date().toISOString() }],
        },
      }),
    );
    expect(html).toContain("data-work-panel");
    expect(html).toMatch(/<details[^>]*open/);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="90"');
    expect(html).toContain(appDict.en.work.meterHot);
    const closed = renderToStaticMarkup(createElement(WorkPanel, { t: appDict.en, lang: "en", conv: CONV }));
    expect(closed).not.toMatch(/<details[^>]*open/);
  });

  it("the pages mount it only while the run log is on, and the client imports no server module", () => {
    expect(src("src/app/[lang]/app/b/[brand]/page.tsx")).toMatch(/\{RUN_LOG && <WorkPanel /);
    expect(src("src/app/[lang]/app/b/[brand]/chat/page.tsx")).toMatch(/workView=\{RUN_LOG\}/);
    const panel = src("src/components/app/WorkPanel.tsx");
    for (const m of panel.matchAll(/^import (.+) from "@\/lib\/(.+)";$/gm)) expect(m[1]).toMatch(/^type /);
  });

  it("every work string exists in both languages", () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v).map((x) => k + "." + x) : [k]));
    expect(keys(appDict.ar.work).sort()).toEqual(keys(appDict.en.work).sort());
  });
});

describe("rule 4780: the status board agrees with the run log", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const st = (over: Partial<AgentStatus> = {}): AgentStatus => ({
    agent: "noor",
    state: "done",
    waiting: 0,
    log: [],
    ...over,
  });
  const failed = (iso: string, agent: Run["agent"] = "noor") => run({ ok: false, startedAt: iso, agent });
  it("a failed newest run newer than the row marks its agent stuck", () => {
    const out = agreeWithRuns(
      [st({ since: "2026-10-26T09:00:00Z" }), st({ agent: "faris", state: null })],
      [failed("2026-10-26T10:00:00Z")],
      now,
    );
    expect(out[0]).toMatchObject({ state: "stuck", since: "2026-10-26T10:00:00Z" });
    expect(out[1].state).toBeNull();
  });
  it("an older, a successful or a stale run changes nothing", () => {
    const s = st({ since: "2026-10-26T11:00:00Z" });
    expect(agreeWithRuns([s], [failed("2026-10-26T10:00:00Z")], now)).toEqual([s]);
    expect(agreeWithRuns([st()], [run({ startedAt: "2026-10-26T10:00:00Z" })], now)).toEqual([st()]);
    expect(agreeWithRuns([st()], [failed("2026-10-20T10:00:00Z")], now)).toEqual([st()]);
    expect(
      agreeWithRuns([st()], [run({ startedAt: "2026-10-26T10:00:00Z" }), failed("2026-10-26T09:00:00Z")], now),
    ).toEqual([st()]);
  });
});
