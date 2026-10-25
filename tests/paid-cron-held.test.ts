import { describe, expect, it, vi } from "vitest";
import { claudeOn } from "./helpers/model";
import { readFileSync } from "node:fs";
import { json, newOpaqueUser, newUser, signIn } from "./helpers/session";
import { acct } from "@/lib/account-id";
import { accountKey } from "@/lib/keys";
import { currentUser, getUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { chargeOnce } from "@/lib/credits";
import { RUN_STALE_MS, beginRun, deliverRun, oweRun, readRun } from "@/lib/run-receipt";
import { sweepHolds } from "@/lib/hold-sweep";
import { routineClaim, periodOf } from "@/lib/routines";
import { createHandoff, handoffClaim } from "@/lib/handoffs";
import { listActivity } from "@/lib/activity";
import { listNotifs } from "@/lib/notifications";
import { runCronBatch } from "@/lib/cron-batch";
import { cronStatuses } from "@/lib/cron-heartbeat";
import { systemBy } from "@/lib/actor";
import * as scheduleRoute from "@/app/api/schedule/route";

/**
 * Rules 2470-2485 (spec docs/superpowers/specs/2026-10-20-paid-cron-held-for-review-design.md): paid scheduled work is
 * charged once per claim, an undelivered hold is refunded by the daily sweep, a run killed after it began is held for the
 * owner instead of run again, and the founder sees each batch's counts. The end-to-end kill and resume of a routine and of
 * the Sunday plan are in tests/routines.test.ts and tests/weekly-money.test.ts.
 */
const COST = 4;
async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  return (await getUser(acct(u)))!;
}
const credits = async (id: string) => (await getUser(id))!.credits;
/** Charge a claim, then age its hold past the sweep's settle time, as a run killed after its charge leaves it. */
async function held(u: User, claim: string, agent: "dana" | "sami" = "dana") {
  await chargeOnce(acct(u), COST, { scope: acct(u), agent }, claim);
  const rec = (await getUser(acct(u)))!;
  const old = new Date(Date.now() - RUN_STALE_MS - 60e3).toISOString();
  await db.set(`user:${acct(u)}`, { ...rec, paidOnce: { ...rec.paidOnce, [claim]: { ...rec.paidOnce![claim], at: old } } });
}

describe("rules 2476-2477: the run receipt", () => {
  it("started, in flight, delivered; a stale start is held once; only the owner's resume runs over a hold", async () => {
    const c = "routine:rr@test.example:dana_weekly_report:2026-10-18";
    expect(await beginRun(c, 600)).toBe("go");
    expect((await readRun(c))?.state).toBe("started");
    expect(await beginRun(c, 600), "a run of it began a moment ago").toBe("in_flight");
    const later = Date.now() + RUN_STALE_MS + 1000;
    expect(await beginRun(c, 600, { now: later }), "the cron finds a killed run").toBe("held_now");
    expect(await beginRun(c, 600, { now: later }), "told once").toBe("held");
    expect(await beginRun(c, 600, { now: later, resume: true }), "the owner's Run").toBe("go");
    await deliverRun(c, 600, ["t1"]);
    expect(await beginRun(c, 600, { resume: true })).toBe("delivered");
    expect(await readRun(c)).toMatchObject({ state: "delivered", tasks: ["t1"] });
  });
});

describe("rules 2470-2471: routines and handoff items are charged under a claim", () => {
  it("both pass `once` to generateBatch, and a second charge of the same claim takes nothing", async () => {
    expect(readFileSync("src/lib/routines.ts", "utf8")).toMatch(/generateBatch\(user, scope, \{[^;]*once: claim,/);
    expect(readFileSync("src/lib/handoffs.ts", "utf8")).toContain("once: handoffClaim(scope, id, n)");
    const u = await owner("pc-once");
    const claim = routineClaim(acct(u), "dana_weekly_report", periodOf("weekly"));
    const before = await credits(acct(u));
    await chargeOnce(acct(u), COST, { scope: acct(u), agent: "dana" }, claim);
    await chargeOnce(acct(u), COST, { scope: acct(u), agent: "dana" }, claim);
    expect(await credits(acct(u))).toBe(before - COST);
  });
});

describe("rules 2473-2475: the daily sweep resolves every scheduled hold", () => {
  it("a routine hold is refunded when its run never delivered, and kept when it did; one row and one notice per refund", async () => {
    const u = await owner("pc-sweep");
    const start = await credits(acct(u));
    const lost = routineClaim(acct(u), "dana_weekly_report", "2026-10-11");
    const done = routineClaim(acct(u), "razan_cash_forecast", "2026-10");
    await held(u, lost);
    await held(u, done);
    await deliverRun(done, 600, ["t9"]);
    const r = await sweepHolds((await getUser(acct(u)))!);
    expect(r?.refunded.map((x) => x.claim)).toEqual([lost]);
    expect(r?.dropped).toEqual([done]);
    expect(await credits(acct(u))).toBe(start - COST);
    expect((await getUser(acct(u)))!.paidOnce ?? {}).toEqual({});
    expect(await sweepHolds((await getUser(acct(u)))!), "nothing left, nothing given twice").toBeNull();
    const rows = (await listActivity(acct(u))).rows.filter((a) => a.kind === "run_refunded");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credits: COST, agent: "dana", outcome: "routine" });
    expect((await listNotifs(acct(u))).some((n) => n.title.includes(String(COST)))).toBe(true);
  });

  it("a handoff item's hold is kept when the item is done and refunded otherwise", async () => {
    const u = await owner("pc-handoff");
    const start = await credits(acct(u));
    const h = await createHandoff(acct(u), { proposal: { items: [{ type: "sales_script", brief: "b" }, { type: "lead_qualifier", brief: "c" }] }, requestedBy: systemBy("cron"), origin: "web_chat", ownerMsg: "m" });
    const raw = (await db.get<{ items: Record<string, unknown>[] }>(`handoff:${acct(u)}:${h.id}`))!;
    await db.set(`handoff:${acct(u)}:${h.id}`, { ...raw, items: raw.items.map((it, i) => (i === 0 ? { ...it, status: "done", tasks: ["x"] } : { ...it, status: "running" })) });
    await held(u, handoffClaim(acct(u), h.id, 0), "sami");
    await held(u, handoffClaim(acct(u), h.id, 1), "sami");
    const r = await sweepHolds((await getUser(acct(u)))!);
    expect(r?.dropped).toEqual([handoffClaim(acct(u), h.id, 0)]);
    expect(r?.refunded.map((x) => x.claim)).toEqual([handoffClaim(acct(u), h.id, 1)]);
    expect(await credits(acct(u))).toBe(start - COST);
  });

  it("this week's Sunday-plan hold is refunded when its run was held, and left alone otherwise (rule 2474)", async () => {
    const { weeklyClaim } = await import("@/lib/schedule");
    const u = await owner("pc-weekheld");
    const start = await credits(acct(u));
    const c = weeklyClaim(acct(u));
    await held(u, c);
    expect(await sweepHolds((await getUser(acct(u)))!), "not held: its week has not ended").toBeNull();
    await db.set(`runrec:${c}`, { state: "held", at: new Date().toISOString() });
    const r = await sweepHolds((await getUser(acct(u)))!);
    expect(r?.refunded.map((x) => x.claim)).toEqual([c]);
    expect(await credits(acct(u))).toBe(start);
  });

  it("a hold younger than RUN_STALE_MS is left alone: its run may still be going", async () => {
    const u = await owner("pc-young");
    await chargeOnce(acct(u), COST, { scope: acct(u), agent: "dana" }, routineClaim(acct(u), "dana_weekly_report", "2026-10-18"));
    expect(await sweepHolds((await getUser(acct(u)))!)).toBeNull();
  });

  it("an account with an opaque id is refunded on its own record, where the charge was taken (rule 1980)", async () => {
    const o = await newOpaqueUser("pc-opaque");
    const id = acct(o);
    const rec = async () => (await db.get<User>(accountKey.user(id)))!;
    const start = (await rec()).credits;
    const claim = routineClaim(id, "dana_weekly_report", "2026-10-11");
    await chargeOnce(id, COST, { scope: id, agent: "dana" }, claim);
    const charged = await rec();
    const old = new Date(Date.now() - RUN_STALE_MS - 60e3).toISOString();
    await db.set(accountKey.user(id), { ...charged, paidOnce: { [claim]: { ...charged.paidOnce![claim], at: old } } });
    const r = await sweepHolds(await rec());
    expect(r?.refunded.map((x) => x.claim)).toEqual([claim]);
    expect((await rec()).credits).toBe(start);
    expect((await rec()).paidOnce ?? {}).toEqual({});
    expect(await db.get(accountKey.user(o.email)), "nothing written under the address").toBeNull();
  });
});

describe("rule 2480: a delivered run's owed share is given back in the sweep's own save", () => {
  it("the owed credits come back and the hold is dropped together; a second sweep gives nothing", async () => {
    const u = await owner("pc-owed");
    const start = await credits(acct(u));
    const c = routineClaim(acct(u), "noor_cart_recovery", "2026-10-11");
    await held(u, c);
    await deliverRun(c, 600, ["a", "b"]);
    await oweRun(c, 1, 600);
    const r = await sweepHolds((await getUser(acct(u)))!);
    expect(r?.refunded).toEqual([expect.objectContaining({ claim: c, credits: 1, partial: true })]);
    expect(r?.dropped).toEqual([c]);
    expect(await credits(acct(u))).toBe(start - COST + 1);
    expect(await sweepHolds((await getUser(acct(u)))!)).toBeNull();
  });
});

describe("rule 2479: the owner's Run of a held routine", () => {
  it("the route takes only a routine id and asks for a resume; a routine that was not held runs nothing", async () => {
    const u = await owner("pc-route");
    await signIn(u.email);
    const session = (await currentUser())!; // the session's user carries its scope, as the route hands it to runRoutine
    const res = await scheduleRoute.POST(json("/api/schedule", "POST", { run: "routine", id: "nope" }));
    expect(res.status).toBe(400);
    expect(readFileSync("src/app/api/schedule/route.ts", "utf8")).toContain("runRoutine(u, b.id, deadline, { resume: true })");
    // With the model on, a routine with no held run answers not_held before any lock, hold or charge.
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    claudeOn();
    try {
      const { runRoutine } = await import("@/lib/routines");
      await db.set(`brand:${acct(u)}`, { name: "x", languages: ["ar"], channels: [] });
      const before = await credits(acct(u));
      expect(await runRoutine(session, "dana_weekly_report", undefined, { resume: true })).toBe("not_held");
      expect(await credits(acct(u))).toBe(before);
    } finally {
      vi.doUnmock("@/lib/model");
      vi.unstubAllEnvs();
    }
  });
});

describe("rules 2484-2485: the founder sees each batch's counts beside the heartbeat", () => {
  it("runCronBatch stores counts only, held included, and cronStatuses returns them", async () => {
    const req = new Request("https://x.test/api/cron/routines");
    await runCronBatch({ job: "routines", period: "2026-10-20", items: ["a@x.test", "b@x.test", "c@x.test"], id: (s) => s, run: async (s) => (s.startsWith("a") ? "held" : s.startsWith("b") ? "ok:2" : "retry:paused"), concurrency: 2, startBudgetMs: 60e3, markerTtlSeconds: 60, req });
    const stored = await db.get<Record<string, unknown>>("cronreport:routines");
    expect(stored).toMatchObject({ period: "2026-10-20", total: 3, processed: 2, held: 1, failed: 0, remaining: 1 });
    expect(JSON.stringify(stored)).not.toContain("@");
    const st = (await cronStatuses()).find((c) => c.job === "routines");
    expect(st?.report).toMatchObject({ held: 1, processed: 2 });
  });
});
