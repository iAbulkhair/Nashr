import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";

// The real ledger, wrapped so a test can make one call throw (a ledger lock timeout, a transient Redis error).
vi.mock("@/lib/credits", async (orig) => {
  const real = await orig<typeof import("@/lib/credits")>();
  return { ...real, charge: vi.fn(real.charge), refund: vi.fn(real.refund) };
});

import { db } from "@/lib/db";
import { agentSpendFor, charge, monthKey, refund } from "@/lib/credits";
import { createUser, getUser, saveUser, type User } from "@/lib/auth";
import { getTask, saveTask, type Task } from "@/lib/brand";
import { wipeAccount } from "@/lib/account";
import { listNotifs } from "@/lib/notifications";
import { MEDIA_MODELS, type MediaModelId } from "@/lib/media-catalog";
import { offModels } from "@/lib/media/config";
import { mk } from "@/lib/media/keys";
import { ProviderError, type AdvanceOpts, type MediaJob, type StartInput, type StartResult } from "@/lib/media/types";
import { BUSY_RETRY_S, KIE_CREATES, advance, getJob, jobForHook, maybeSweep, publicJob, startMedia, sweepMedia } from "@/lib/media/jobs";
import { fakeAdapter, fakeDeps, mediaEnv, noNetwork, resetMediaCounters } from "./helpers/media";
import { newUser } from "./helpers/session";

const net = noNetwork();
afterAll(() => {
  net.restore();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  resetMediaCounters();
  mediaEnv({ fal: true, kie: true, higgsfield: true, blob: true, models: "all" });
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(net.hosts, "a media engine test reached the network").toEqual([]);
});

async function owner(over: Partial<User> = {}): Promise<User> {
  const u = await newUser("mj");
  if (Object.keys(over).length) {
    Object.assign(u, over);
    await saveUser(u);
  }
  return u;
}
let taskN = 0;
async function taskFor(u: User, over: Partial<Task> = {}): Promise<Task> {
  const t: Task = { id: `t${++taskN}${randomBytes(3).toString("hex")}`, type: "social", channel: "instagram", title: "Weekend offer", body: "Two for one this weekend.", status: "pending", createdAt: new Date().toISOString(), lang: "ar", ...over };
  await saveTask(u.email, t, true);
  return t;
}
/** plan "pro" unless a test is about trials: the engine reads the plan from here, not from the account. */
const input = (u: User, t: Task, model: MediaModelId, over: Partial<StartInput> = {}): StartInput => ({
  scope: u.email, email: u.email, lang: u.lang, accountSince: u.createdAt, plan: "pro", balance: u.credits, agent: "noor", taskId: t.id, model,
  aspect: "square", deadline: Date.now() + 100_000, prompt: async () => "a test prompt", ...over,
});
const balance = async (u: User) => (await getUser(u.email))!.credits;
const counter = async (key: string) => Number((await db.get<number>(key)) ?? 0);
const spend = (model: MediaModelId, part: string) => `${mk.spend(monthKey())}:m:${model}:${part}`;
const sweep = (deadline = Date.now() + 100_000): AdvanceOpts => ({ force: true, deadline, via: "sweep" });
const poll = (deadline = Date.now() + 100_000): AdvanceOpts => ({ deadline, via: "poll" });
const kieId = () => `kie${randomBytes(6).toString("hex")}`;
const RESULT = "https://tempfile.kie.example/result.png";
const done = (providerCredits?: number) => ({ state: "done" as const, urls: [RESULT], ...(providerCredits != null ? { providerCredits } : {}) });
/** A clock the engine reads through deps.now. Locks and TTLs in the memory store keep real time. */
function clockAt(t = Date.now()) {
  const c = { t, now: () => c.t, add: (ms: number) => { c.t += ms; } };
  return c;
}
function started(r: StartResult): MediaJob {
  if (!r.ok) throw new Error(`start refused: ${r.status} ${r.error}`);
  return r.job;
}
const flightFree = async (u: User, t: Task, kind: "image" | "video" = "image") => {
  const won = await db.lock(mk.flight(u.email, t.id, kind), 5);
  if (won) await db.unlock(mk.flight(u.email, t.id, kind));
  return won;
};
const recent = async () => (await db.lrange(mk.recent(), 0, -1)).map((s) => JSON.parse(s) as Record<string, unknown>);

describe("starting a render: charge, submit, deliver", () => {
  it("fal answers at once: charged once, the task gets our copy, the job is done and every hold is released", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const fal = fakeAdapter("fal");
    const deps = fakeDeps({ fal });
    const r = await startMedia(input(u, t, "img-fast"), deps);
    const job = started(r);
    expect(r.ok && r.credits).toBe(49);
    expect(await balance(u)).toBe(49);
    expect(vi.mocked(charge)).toHaveBeenCalledTimes(1);
    expect(job.state).toBe("done");
    expect(deps.stored).toHaveLength(1);
    expect(deps.stored[0].source).toBe("https://v3.fal.media/files/test.jpg");
    const task = (await getTask(u.email, t.id))!;
    expect(task).toMatchObject({ imageUrl: deps.stored[0].url, imageProvider: "fal", imageModel: "img-fast", imagePrompt: "a test prompt", mediaCredits: 1 });
    expect(task.mediaJob).toBeUndefined();
    expect(r.ok && r.task?.imageUrl).toBe(deps.stored[0].url);
    expect((await getJob(u.email, job.id))!).toMatchObject({ state: "done", url: deps.stored[0].url, costUsd: 0.003 });
    expect(await db.smembers(mk.open("fal"))).toEqual([]);
    expect(await counter(spend("img-fast", "jobs"))).toBe(1);
    expect(await counter(spend("img-fast", "credits"))).toBe(1);
    expect(await counter(spend("img-fast", "usd_micro"))).toBe(3000);
    // The flight lock was released: a second render of the same task starts.
    expect(started(await startMedia(input(u, t, "img-fast"), deps)).state).toBe("done");
  });

  it("fal without a Blob store keeps the fal URL; with one whose copy fails it still delivers the fal URL and refunds nothing", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const noBlob = fakeDeps({ fal: fakeAdapter("fal") }, { blob: false });
    started(await startMedia(input(u, t, "img-fast"), noBlob));
    expect(noBlob.stored).toEqual([]);
    expect((await getTask(u.email, t.id))!.imageUrl).toBe("https://v3.fal.media/files/test.jpg");

    const t2 = await taskFor(u);
    const failing = fakeDeps({ fal: fakeAdapter("fal") }, { storeFails: true });
    const job = started(await startMedia(input(u, t2, "img-fast"), failing));
    expect(job).toMatchObject({ state: "done", url: "https://v3.fal.media/files/test.jpg" });
    expect(await balance(u)).toBe(48);
    expect(vi.mocked(refund)).not.toHaveBeenCalled();
  });

  it("a fal content refusal answers 422 nsfw with the credit back and no image on the task", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const deps = fakeDeps({ fal: fakeAdapter("fal", { submit: () => ({ state: "failed", reason: "nsfw" }) }) });
    const r = await startMedia(input(u, t, "img-fast"), deps);
    expect(r).toMatchObject({ ok: false, status: 422, error: "nsfw", credits: 50 });
    expect(await balance(u)).toBe(50);
    const task = (await getTask(u.email, t.id))!;
    expect(task.imageUrl).toBeUndefined();
    expect(task.mediaCredits).toBeUndefined();
    expect(task.mediaJob).toBeUndefined();
    expect(task.mediaLast?.image).toMatchObject({ error: "nsfw", credits: 1, refunded: true });
    expect(await flightFree(u, t)).toBe(true);
  });

  it("a kie or Higgsfield model without a working Blob store is refused before anything moves", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const kie = fakeAdapter("kie");
    const r = await startMedia(input(u, t, "img-balanced"), fakeDeps({ kie }, { blob: false }));
    expect(r).toMatchObject({ ok: false, status: 409, error: "model_unavailable" });
    expect(kie.submits).toHaveLength(0);
    expect(await balance(u)).toBe(50);
    expect(await flightFree(u, t)).toBe(true);
  });

  it("kie hands back a task id: 202 path, webhook pointer saved, the task points at the job while it is queued, a done status delivers once", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const id = kieId();
    let seen: string | undefined;
    const kie = fakeAdapter("kie", {
      submit: async () => {
        seen = (await getTask(u.email, t.id))?.mediaJob?.image;
        return { state: "pending", providerTaskId: id };
      },
      status: () => done(8),
    });
    const deps = fakeDeps({ kie });
    const r = await startMedia(input(u, t, "img-balanced"), deps);
    const job = started(r);
    expect(job).toMatchObject({ state: "running", providerTaskId: id });
    expect(publicJob(job).state).toBe("running");
    expect(seen, "task.mediaJob is written with the queued job, before the submit").toBe(job.id);
    expect(await db.get(mk.ref("kie", id))).toEqual({ scope: u.email, jobId: job.id });
    expect(r.ok && r.task?.mediaJob?.image).toBe(job.id);

    const after = await advance(job, deps, poll());
    expect(after.state).toBe("done");
    expect(kie.statusCalls).toBe(1);
    expect(deps.stored[0].source).toBe(RESULT);
    expect((await getTask(u.email, t.id))!).toMatchObject({ imageUrl: deps.stored[0].url, imageProvider: "kie", imageModel: "img-balanced", mediaCredits: 1 });
    expect((await getJob(u.email, job.id))!).toMatchObject({ providerCredits: 8, costUsd: 0.04 });

    // Done is done: neither the returned job nor a stale running copy of it reaches the provider again.
    expect(await advance(after, deps, sweep())).toEqual(after);
    expect((await advance(job, deps, sweep())).state).toBe("done");
    expect(kie.statusCalls).toBe(1);
    expect(await balance(u)).toBe(49);
  });

  it("a provider that is busy answers 429 busy with the credit back; any other submit error answers 502, and no provider text is logged", async () => {
    const u = await owner();
    const busy = fakeDeps({ kie: fakeAdapter("kie", { submit: () => { throw new ProviderError("busy", 429); } }) });
    const r = await startMedia(input(u, await taskFor(u), "img-balanced"), busy);
    expect(r).toMatchObject({ ok: false, status: 429, error: "busy", credits: 50, retryAfter: BUSY_RETRY_S });
    expect((await recent())[0]).toMatchObject({ state: "failed", error: "submit_failed" });

    const broken = fakeDeps({ kie: fakeAdapter("kie", { submit: () => { throw new Error("upstream said <html>sk-secret-body</html>"); } }) });
    const r2 = await startMedia(input(u, await taskFor(u), "img-balanced"), broken);
    expect(r2).toMatchObject({ ok: false, status: 502, error: "media_failed", credits: 50 });
    expect(await balance(u)).toBe(50);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("sk-secret-body");
  });

  it("a double click renders once: one start wins, the other is 409 in_progress; image and video of one task may run together", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const kie = fakeAdapter("kie");
    const deps = fakeDeps({ kie });
    const both = await Promise.all([startMedia(input(u, t, "img-balanced"), deps), startMedia(input(u, t, "img-balanced"), deps)]);
    const won = both.filter((r) => r.ok);
    expect(won).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, status: 409, error: "in_progress" });
    expect(kie.submits).toHaveLength(1);
    expect(await balance(u)).toBe(49);
    // Once the task points at the job, the 409 carries it, so the inbox can follow the render already running.
    const again = await startMedia(input(u, t, "img-balanced"), deps);
    expect(again).toMatchObject({ ok: false, status: 409, error: "in_progress", job: { id: won[0].ok && won[0].job.id, state: "running" } });

    const t2 = await taskFor(u);
    const pair = await Promise.all([startMedia(input(u, t2, "img-balanced"), deps), startMedia(input(u, t2, "vid-quick"), deps)]);
    expect(pair.map((r) => r.ok)).toEqual([true, true]);
    expect(await balance(u)).toBe(50 - 1 - 1 - 12);
  });

  it("refusals that cost nothing come first: a 409 and a balance pre-check 402 move no limit and no provider throttle", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const deps = fakeDeps({ kie: fakeAdapter("kie") });
    started(await startMedia(input(u, t, "img-balanced"), deps));
    const hourKey = `rate:media:image:h:${u.email}`;
    expect(await counter(hourKey)).toBe(1);
    expect(await counter("rate:kie:create")).toBe(1);
    expect(await startMedia(input(u, t, "img-balanced"), deps)).toMatchObject({ status: 409, error: "in_progress" });
    expect(await counter(hourKey)).toBe(1);
    expect(await counter("rate:kie:create")).toBe(1);

    const poor = await owner({ credits: 0 });
    const r = await startMedia(input(poor, await taskFor(poor), "img-balanced"), deps);
    expect(r).toEqual({ ok: false, status: 402, error: "no_credits", need: 1, have: 0 });
    expect(await db.get(`rate:media:image:h:${poor.email}`)).toBeNull();
    expect(await counter("rate:kie:create")).toBe(1);
    expect(vi.mocked(charge)).toHaveBeenCalledTimes(1);
  });

  it("the balance the ledger holds decides: a stale session balance still ends 402 at the charge, with the flight free", async () => {
    const u = await owner({ credits: 0 });
    const t = await taskFor(u);
    const r = await startMedia(input(u, t, "img-balanced", { balance: 50 }), fakeDeps({ kie: fakeAdapter("kie") }));
    expect(r).toMatchObject({ ok: false, status: 402, error: "no_credits", need: 1, have: 0 });
    expect(await flightFree(u, t)).toBe(true);
  });

  it("kie creates are throttled for every tenant together: the 19th in 10 s is 429 busy, uncharged, with the flight free", async () => {
    const u = await owner();
    const tasks = await Promise.all(Array.from({ length: 19 }, () => taskFor(u)));
    const deps = fakeDeps({ kie: fakeAdapter("kie") });
    for (const t of tasks.slice(0, 18)) expect((await startMedia(input(u, t, "img-balanced"), deps)).ok).toBe(true);
    expect(await startMedia(input(u, tasks[18], "img-balanced"), deps)).toMatchObject({ ok: false, status: 429, error: "busy", retryAfter: KIE_CREATES.windowS });
    expect(await balance(u)).toBe(32);
    expect(await flightFree(u, tasks[18])).toBe(true);
  });

  it("the account render limit answers 429 too_many before the charge, with the window that refused (rule 672)", async () => {
    const u = await owner();
    const t = await taskFor(u);
    await db.set(`rate:media:image:h:${u.email}`, 30, 3600);
    const fal = fakeAdapter("fal");
    expect(await startMedia(input(u, t, "img-fast"), fakeDeps({ fal }))).toMatchObject({ ok: false, status: 429, error: "too_many", retryAfter: 3600 });
    expect(fal.submits).toHaveLength(0);
    expect(await balance(u)).toBe(50);
    expect(await flightFree(u, t)).toBe(true);
    // The day spent too: the longer wait is the one to report.
    await db.set(`rate:media:image:d:${u.email}`, 150, 86400);
    expect(await startMedia(input(u, t, "img-fast"), fakeDeps({ fal }))).toMatchObject({ ok: false, status: 429, error: "too_many", retryAfter: 86400 });
    await db.del(`rate:media:image:h:${u.email}`);
    expect(await startMedia(input(u, t, "img-fast"), fakeDeps({ fal }))).toMatchObject({ ok: false, status: 429, error: "too_many", retryAfter: 86400 });
    expect(fal.submits).toHaveLength(0);
  });

  it("no credits: 402 with need and have, the flight free and no counter moved", async () => {
    const u = await owner({ credits: 0 });
    const t = await taskFor(u);
    expect(await startMedia(input(u, t, "vid-quick"), fakeDeps({ kie: fakeAdapter("kie") }))).toEqual({ ok: false, status: 402, error: "no_credits", need: 12, have: 0 });
    expect(await flightFree(u, t, "video")).toBe(true);
    expect(await db.get(`rate:media:video:h:${u.email}`)).toBeNull();
  });

  it("the agent's monthly cap: a pre-check 402 moves nothing, the ledger decides for a stale session, and a later refund lowers the agent's counter", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const kie = fakeAdapter("kie", { submit: () => ({ state: "pending", providerTaskId: kieId() }), status: () => ({ state: "failed", reason: "provider_failed" }) });
    const deps = fakeDeps({ kie });
    const noorSpent = async () => agentSpendFor((await getUser(u.email))!, u.email);

    // The session already shows the cap reached: refused before any limit, throttle, flight or charge.
    expect(await startMedia(input(u, t, "vid-quick", { cap: 12, spent: 1 }), deps)).toEqual({ ok: false, status: 402, error: "agent_cap", agent: "noor", spent: 1, cap: 12 });
    expect(await db.get(`rate:media:video:h:${u.email}`)).toBeNull();
    expect(await flightFree(u, t, "video")).toBe(true);
    expect(vi.mocked(charge)).not.toHaveBeenCalled();

    // Under the cap: charged to the agent that owns the item, in the job's scope, and the job keeps what its refund needs.
    const job = started(await startMedia(input(u, t, "vid-quick", { cap: 12, spent: 0 }), deps));
    expect(job.spend).toEqual({ scope: u.email, agent: "noor", month: monthKey() });
    expect(await noorSpent()).toEqual({ noor: 12 });

    // A stale session that still reads 0 passes the pre-check, and the ledger refuses it: nothing charged, the flight free.
    const t2 = await taskFor(u);
    expect(await startMedia(input(u, t2, "img-balanced", { cap: 12, spent: 0 }), deps)).toEqual({ ok: false, status: 402, error: "agent_cap", agent: "noor", spent: 12, cap: 12 });
    expect(await balance(u)).toBe(38);
    expect(await flightFree(u, t2)).toBe(true);

    // The render fails at a later sweep: the balance and the agent's counter both come back.
    expect((await advance(job, deps, sweep())).state).toBe("failed");
    expect(await balance(u)).toBe(50);
    expect(await noorSpent()).toEqual({ noor: 0 });
  });

  it("a ledger lock timeout at the charge answers 429 busy: nothing charged, the flight free", async () => {
    const u = await owner();
    const t = await taskFor(u);
    vi.mocked(charge).mockRejectedValueOnce(new Error("user_lock_timeout"));
    const deps = fakeDeps({ fal: fakeAdapter("fal") });
    expect(await startMedia(input(u, t, "img-fast"), deps)).toMatchObject({ ok: false, status: 429, error: "busy", retryAfter: BUSY_RETRY_S });
    expect(await balance(u)).toBe(50);
    expect((await startMedia(input(u, t, "img-fast"), deps)).ok).toBe(true);
  });

  it("a Redis write failing after the charge refunds at once under the marker, and a record written anyway is never refunded twice", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const kie = fakeAdapter("kie");
    const deps = fakeDeps({ kie });
    const realSet = db.set;
    const refused: { key?: string; job?: MediaJob } = {};
    vi.spyOn(db, "set").mockImplementation(async (key: string, value: unknown, ttl?: number) => {
      if (!refused.key && key.startsWith("mjob:")) {
        refused.key = key;
        refused.job = value as MediaJob;
        throw new Error("redis_down");
      }
      return realSet(key, value, ttl);
    });
    const r = await startMedia(input(u, t, "img-balanced"), deps);
    vi.mocked(db.set).mockRestore();
    expect(r).toMatchObject({ ok: false, status: 502, error: "media_failed", credits: 50 });
    expect(await balance(u)).toBe(50);
    const job = refused.job!;
    expect(await db.get(mk.refundOnce(job.id))).toBeTruthy();
    expect(kie.submits).toHaveLength(0);
    expect(await flightFree(u, t)).toBe(true);
    expect((await getTask(u.email, t.id))!.mediaJob, "the task no longer points at a job that may not exist").toBeUndefined();

    // The record reached Redis after all: three minutes on it ends submit_lost, and the balance is still 50.
    await realSet(refused.key!, job, 3600);
    const later = fakeDeps({ kie }, { now: () => Date.now() + 4 * 60_000 });
    const lost = await advance(job, later, sweep(Date.now() + 4 * 60_000 + 100_000));
    expect(lost).toMatchObject({ state: "failed", error: "submit_lost", refunded: true });
    expect(await balance(u)).toBe(50);
    expect(vi.mocked(refund)).toHaveBeenCalledTimes(1);
  });

  it("with less than 5 s before the deadline nothing is submitted and the credit comes back", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const kie = fakeAdapter("kie");
    const r = await startMedia(input(u, t, "img-balanced", { deadline: Date.now() + 4_000 }), fakeDeps({ kie }));
    expect(r).toMatchObject({ ok: false, status: 502, error: "media_failed", credits: 50 });
    expect(kie.submits).toHaveLength(0);
    expect((await getTask(u.email, t.id))!.mediaLast?.image?.error).toBe("submit_failed");
  });

  it("a submit that never answers is cut at the deadline and refunded", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const kie = fakeAdapter("kie", { submit: (_i, _n, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) });
    const t0 = Date.now();
    const r = await startMedia(input(u, t, "img-balanced", { deadline: Date.now() + 5_500 }), fakeDeps({ kie }));
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(r).toMatchObject({ ok: false, status: 502, error: "media_failed", credits: 50 });
    expect(await balance(u)).toBe(50);
  }, 15_000);

  it("the adapter gets a live abort signal and exactly what mediaImageFor allowed", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const seen: { aborted?: boolean } = {};
    const fal = fakeAdapter("fal", { submit: (_i, _n, signal) => { seen.aborted = signal.aborted; return { state: "done", urls: ["https://v3.fal.media/files/x.jpg"] }; } });
    started(await startMedia(input(u, t, "img-fast"), fakeDeps({ fal })));
    expect(fal.signals[0]).toBeDefined();
    expect(seen.aborted).toBe(false);
    expect(fal.submits[0]).toEqual({ model: "img-fast", prompt: "a test prompt", aspect: "square" });

    const kie = fakeAdapter("kie");
    const img = "https://abc.public.blob.vercel-storage.com/media/x.jpg";
    const job = started(await startMedia(input(u, await taskFor(u), "vid-quick", { aspect: "portrait", imageUrl: img }), fakeDeps({ kie })));
    expect(kie.submits[0]).toEqual({ model: "vid-quick", prompt: "a test prompt", aspect: "portrait", imageUrl: img });
    expect(job.imageUrl).toBe(img);
  });

  it("a queued job is reachable through the task while its submit runs, and another tab leaves it to the start request", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const c = clockAt();
    const gate: { open?: () => void; entered?: () => void } = {};
    const opened = new Promise<void>((r) => (gate.open = r));
    const inSubmit = new Promise<void>((r) => (gate.entered = r));
    const id = kieId();
    const kie = fakeAdapter("kie", { submit: async () => { gate.entered!(); await opened; return { state: "pending", providerTaskId: id }; } });
    const deps = fakeDeps({ kie }, { now: c.now });
    const starting = startMedia(input(u, t, "img-balanced", { deadline: c.t + 100_000 }), deps);
    await inSubmit;
    const jobId = (await getTask(u.email, t.id))!.mediaJob!.image!;
    const queued = (await getJob(u.email, jobId))!;
    expect(queued.state).toBe("queued");
    expect(await advance(queued, deps, poll(c.t + 100_000))).toEqual(queued);
    // Past the lost threshold, but the start request still holds the job lock: untouched.
    c.add(4 * 60_000);
    expect((await advance(queued, deps, sweep(c.t + 100_000))).state).toBe("queued");
    expect(await balance(u)).toBe(49);
    gate.open!();
    expect(started(await starting)).toMatchObject({ id: jobId, state: "running", providerTaskId: id });
  });
});

describe("moving a job forward: refunds exactly once, throttles, copies", () => {
  it("six concurrent sweeps of a failed render refund it once", async () => {
    const u = await owner();
    const kie = fakeAdapter("kie", { status: () => ({ state: "failed", reason: "provider_failed" }) });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced"), deps));
    await Promise.all(Array.from({ length: 6 }, () => advance(job, deps, sweep())));
    expect(await balance(u)).toBe(50);
    expect(await db.get(mk.refundOnce(job.id))).toBeTruthy();
    expect((await getJob(u.email, job.id))!).toMatchObject({ state: "failed", error: "provider_failed", refunded: true });
    expect(kie.statusCalls).toBe(1);
    expect(vi.mocked(refund)).toHaveBeenCalledTimes(1);
  });

  it("the refund marker alone stops a second refund, even when the failed record was lost", async () => {
    const u = await owner();
    const kie = fakeAdapter("kie", { status: () => ({ state: "failed", reason: "provider_failed" }) });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced"), deps));
    await advance(job, deps, sweep());
    await db.set(mk.job(u.email, job.id), job, 3600); // as if the failed save never landed
    const again = await advance(job, deps, sweep());
    expect(again).toMatchObject({ state: "failed", refunded: true });
    expect(await balance(u)).toBe(50);
    expect(vi.mocked(refund)).toHaveBeenCalledTimes(1);
  });

  it("a done and a failed answer racing: one status call, one terminal state, a refund only if it failed", async () => {
    const u = await owner();
    const kie = fakeAdapter("kie", {
      status: async (n) => (n === 1 ? (await new Promise((r) => setTimeout(r, 30)), done()) : { state: "failed", reason: "provider_failed" }),
    });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced"), deps));
    const [a, b] = await Promise.all([advance(job, deps, sweep()), advance(job, deps, sweep())]);
    expect(kie.statusCalls).toBe(1);
    const final = (await getJob(u.email, job.id))!;
    expect(final.state).toBe("done");
    expect([a.state, b.state].sort()).toEqual(["done", "running"]);
    expect(await advance(job, deps, sweep())).toMatchObject({ state: "done" });
    expect(await balance(u)).toBe(49);
    expect(vi.mocked(refund)).not.toHaveBeenCalled();
  });

  it("pending past the max age is cancelled, failed as timeout, refunded, and counted by the breaker", async () => {
    const u = await owner();
    const c = clockAt();
    const kie = fakeAdapter("kie");
    const deps = fakeDeps({ kie }, { now: c.now });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced", { deadline: c.t + 100_000 }), deps));
    c.add(9 * 60_000);
    expect((await advance(job, deps, poll(c.t + 100_000))).state).toBe("running");
    c.add(2 * 60_000);
    const late = await advance(job, deps, sweep(c.t + 100_000));
    expect(late).toMatchObject({ state: "failed", error: "timeout", refunded: true });
    expect(kie.cancels).toBe(1);
    expect(await balance(u)).toBe(50);
    expect(await counter("rate:mfail:img-balanced")).toBe(1);
  });

  it("a start request that died leaves a queued job: lost after 3 minutes with its lock free, never before, never while held", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const deps = fakeDeps({ kie: fakeAdapter("kie") });
    const queued = async (ageMs: number): Promise<MediaJob> => {
      await charge(u.email, 1);
      const at = new Date(Date.now() - ageMs).toISOString();
      const job: MediaJob = { id: randomBytes(16).toString("hex"), scope: u.email, email: u.email, accountSince: u.createdAt, lang: "ar", taskId: t.id, kind: "image", model: "img-balanced", provider: "kie", credits: 1, prompt: "", state: "queued", createdAt: at, updatedAt: at };
      await Promise.all([db.set(mk.job(u.email, job.id), job, 3600), db.sadd(mk.open("kie"), mk.openMember(u.email, job.id))]);
      return job;
    };
    const young = await queued(60_000);
    expect(await advance(young, deps, sweep())).toEqual(young);
    const held = await queued(4 * 60_000);
    await db.lock(mk.jobLock(held.id), 120);
    expect((await advance(held, deps, sweep())).state).toBe("queued");
    expect(await balance(u)).toBe(48);
    const old = await queued(4 * 60_000);
    expect(await advance(old, deps, poll())).toMatchObject({ state: "failed", error: "submit_lost", refunded: true });
    expect(await balance(u)).toBe(48);
    expect(await db.smembers(mk.open("kie"))).not.toContain(mk.openMember(u.email, old.id));
  });

  it("status calls are throttled per job: polls and webhook hints share one call per 4 s, force skips only that, never the job lock", async () => {
    const u = await owner();
    const kie = fakeAdapter("kie");
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced"), deps));
    await advance(job, deps, poll());
    await advance(job, deps, poll());
    expect(kie.statusCalls).toBe(1);
    for (let i = 0; i < 5; i++) await advance(job, deps, { deadline: Date.now() + 100_000, via: "hook" });
    expect(kie.statusCalls).toBe(1);
    await advance(job, deps, sweep());
    expect(kie.statusCalls).toBe(2);
    await db.lock(mk.jobLock(job.id), 120);
    await advance(job, deps, sweep());
    expect(kie.statusCalls, "a job being finalized elsewhere gets no status call").toBe(2);
    await db.unlock(mk.jobLock(job.id));
  });

  it("with too little time for a status call nothing is asked", async () => {
    const u = await owner();
    const kie = fakeAdapter("kie");
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced"), deps));
    expect((await advance(job, deps, sweep(Date.now() + 14_000))).state).toBe("running");
    expect(kie.statusCalls).toBe(0);
  });

  it("a result found with too little time left for the copy is kept for the next poll or sweep, which copies it without a status call", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const kie = fakeAdapter("kie", { status: () => done(8) });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, t, "img-balanced"), deps));
    // 20 s left: enough for the 15 s status call, not for the 25 s an image copy may take.
    const kept = await advance(job, deps, sweep(Date.now() + 20_000));
    expect(kept).toMatchObject({ state: "running", resultUrls: [RESULT], providerCredits: 8 });
    expect(deps.stored).toEqual([]);
    expect((await getJob(u.email, job.id))!.resultUrls).toEqual([RESULT]);
    expect(await advance(kept, deps, sweep())).toMatchObject({ state: "done", providerCredits: 8 });
    expect(kie.statusCalls).toBe(1);
    expect((await getTask(u.email, t.id))!.imageUrl).toBe(deps.stored[0].url);
  });

  it("a failed copy keeps the result and retries without another status call, 30 s apart; three failures end store_failed, refunded, with the cost recorded", async () => {
    const u = await owner();
    const c = clockAt();
    const kie = fakeAdapter("kie", { status: () => done(8) });
    const once = fakeDeps({ kie }, { storeFails: 1, now: c.now });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced", { deadline: c.t + 100_000 }), once));
    const kept = await advance(job, once, sweep(c.t + 100_000));
    expect(kept).toMatchObject({ state: "running", resultUrls: [RESULT], storeTries: 1, providerCredits: 8 });
    // The next non-forced poll waits the 30 s retry gap, not the 4 s one.
    expect(await advance(kept, once, poll(c.t + 100_000))).toEqual(kept);
    c.add(31_000);
    const delivered = await advance(kept, once, sweep(c.t + 100_000));
    expect(delivered.state).toBe("done");
    expect(kie.statusCalls).toBe(1);
    expect(once.stored[0].source).toBe(RESULT);

    const kie2 = fakeAdapter("kie", { status: () => done(8) });
    const never = fakeDeps({ kie: kie2 }, { storeFails: true, now: c.now });
    const j2 = started(await startMedia(input(u, await taskFor(u), "img-balanced", { deadline: c.t + 100_000 }), never));
    await advance(j2, never, sweep(c.t + 100_000));
    c.add(31_000);
    await advance(j2, never, sweep(c.t + 100_000));
    c.add(31_000);
    const failed = await advance(j2, never, sweep(c.t + 100_000));
    expect(failed).toMatchObject({ state: "failed", error: "store_failed", refunded: true, costUsd: 0.04 });
    expect(kie2.statusCalls).toBe(1);
    expect(await balance(u)).toBe(49);
    expect(await counter(spend("img-balanced", "usd_micro"))).toBe(2 * 40_000);
    expect(await counter(spend("img-balanced", "failed"))).toBe(1);
  });

  it("a refund that throws once releases the marker and leaves the job open; the next advance refunds exactly once", async () => {
    const u = await owner();
    const kie = fakeAdapter("kie", { status: () => ({ state: "failed", reason: "provider_failed" }) });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced"), deps));
    vi.mocked(refund).mockRejectedValueOnce(new Error("redis_down"));
    await expect(advance(job, deps, sweep())).rejects.toThrow("redis_down");
    expect((await getJob(u.email, job.id))!.state).toBe("running");
    expect(await db.get(mk.refundOnce(job.id))).toBeNull();
    expect(await balance(u)).toBe(49);
    expect(await advance(job, deps, sweep())).toMatchObject({ state: "failed", refunded: true });
    expect(await balance(u)).toBe(50);
    expect(vi.mocked(refund)).toHaveBeenCalledTimes(2);
  });

  it("a deleted account is never refunded or notified, and the same address registered again gets nothing from the old job", async () => {
    const u = await owner();
    const kie = fakeAdapter("kie", { status: () => ({ state: "failed", reason: "provider_failed" }) });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced"), deps));
    await wipeAccount(u.email);
    const failed = await advance(job, deps, sweep());
    expect(failed).toMatchObject({ state: "failed", refunded: false });
    expect(await db.smembers(mk.open("kie"))).not.toContain(mk.openMember(u.email, job.id));
    expect(await db.get(mk.refundOnce(job.id))).toBeTruthy();
    expect(await db.get(`notifs:${u.email}`)).toBeNull();
    const again = await createUser({ email: u.email, name: "Again", phone: "", password: "abc12345", lang: "ar" });
    await advance(job, deps, sweep());
    await advance(failed, deps, sweep());
    expect(await balance(again)).toBe(50);
  });

  it("an address deleted and registered again before the failure: the new account is not refunded the old charge", async () => {
    const u = await owner();
    const kie = fakeAdapter("kie", { status: () => ({ state: "failed", reason: "provider_failed" }) });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced"), deps));
    await wipeAccount(u.email);
    const again = await createUser({ email: u.email, name: "Again", phone: "", password: "abc12345", lang: "ar" });
    expect(await advance(job, deps, sweep())).toMatchObject({ state: "failed", refunded: false });
    expect(await balance(again)).toBe(50);
    expect(await listNotifs(u.email)).toEqual([]);
  });

  it("a result arriving after a refund is never delivered", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const kie = fakeAdapter("kie", { status: () => done() });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, t, "img-balanced"), deps));
    await db.set(mk.refundOnce(job.id), "done", 3600); // a fail refunded, then could not save
    expect(await advance(job, deps, sweep())).toMatchObject({ state: "failed", refunded: true });
    expect(deps.stored).toEqual([]);
    const task = (await getTask(u.email, t.id))!;
    expect(task.imageUrl).toBeUndefined();
    expect(task.mediaCredits).toBeUndefined();
    expect(await balance(u)).toBe(49);
  });

  it("a task deleted before the result: the job is done, the task is not recreated, nothing is refunded", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const deps = fakeDeps({ kie: fakeAdapter("kie", { status: () => done() }) });
    const job = started(await startMedia(input(u, t, "img-balanced"), deps));
    await db.del(`task:${u.email}:${t.id}`);
    expect((await advance(job, deps, sweep())).state).toBe("done");
    expect(await getTask(u.email, t.id)).toBeNull();
    expect(await balance(u)).toBe(49);
  });

  it("a late, older job does not overwrite a newer render but its credit is still counted", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const deps = fakeDeps({ kie: fakeAdapter("kie", { status: () => done() }) });
    const a = started(await startMedia(input(u, t, "img-balanced"), deps));
    const newer = "b".repeat(32), newerUrl = "https://s1.public.blob.vercel-storage.com/media/newer.jpg";
    await saveTask(u.email, { ...(await getTask(u.email, t.id))!, mediaJob: { image: newer }, imageUrl: newerUrl, imageProvider: "kie", mediaCredits: 1 });
    const finished = await advance(a, deps, sweep());
    expect(finished).toMatchObject({ state: "done", url: deps.stored[0].url });
    expect((await getTask(u.email, t.id))!).toMatchObject({ imageUrl: newerUrl, mediaJob: { image: newer }, mediaCredits: 2 });
  });

  it("a legacy fal image keeps its credit in mediaCredits after a re-render", async () => {
    const u = await owner();
    const t = await taskFor(u, { imageUrl: "https://v3.fal.media/files/old.jpg", imageProvider: "fal" });
    started(await startMedia(input(u, t, "img-fast"), fakeDeps({ fal: fakeAdapter("fal") })));
    expect((await getTask(u.email, t.id))!.mediaCredits).toBe(2);
  });

  it("a job older than the flight lock does not release a newer job's hold on the task", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const c = clockAt();
    const deps = fakeDeps({ kie: fakeAdapter("kie", { status: () => done() }) }, { now: c.now });
    const a = started(await startMedia(input(u, t, "img-balanced", { deadline: c.t + 100_000 }), deps));
    c.add(16 * 60_000);
    await db.unlock(mk.flight(u.email, t.id, "image")); // A's hold expired
    const b = started(await startMedia(input(u, t, "img-balanced", { deadline: c.t + 100_000 }), deps));
    expect((await advance(a, deps, sweep(c.t + 100_000))).state).toBe("done");
    expect(await flightFree(u, t), "B still holds the task").toBe(false);
    expect((await getTask(u.email, t.id))!.mediaJob?.image).toBe(b.id);
  });
});

describe("Higgsfield admission (spec A10)", () => {
  it("two live jobs of two accounts fill the cap: a third account is 429 busy and not charged", async () => {
    const hf = fakeAdapter("higgsfield");
    const deps = fakeDeps({ higgsfield: hf });
    const [a, b, c] = await Promise.all([owner(), owner(), owner()]);
    started(await startMedia(input(a, await taskFor(a), "img-lifestyle"), deps));
    started(await startMedia(input(b, await taskFor(b), "img-lifestyle"), deps));
    const tc = await taskFor(c);
    expect(await startMedia(input(c, tc, "img-lifestyle"), deps)).toMatchObject({ ok: false, status: 429, error: "busy", retryAfter: BUSY_RETRY_S });
    expect(await balance(c)).toBe(50);
    expect(hf.submits).toHaveLength(2);
    expect(await flightFree(c, tc)).toBe(true);
  });

  it("one live job per account: its second start is 429 one_open", async () => {
    const deps = fakeDeps({ higgsfield: fakeAdapter("higgsfield") });
    const a = await owner();
    started(await startMedia(input(a, await taskFor(a), "img-lifestyle"), deps));
    expect(await startMedia(input(a, await taskFor(a), "img-design"), deps)).toMatchObject({ ok: false, status: 429, error: "one_open", retryAfter: BUSY_RETRY_S });
    expect(await balance(a)).toBe(49);
  });

  it("videos keep a slot for images: with one live video another video is busy, an image is admitted", async () => {
    const deps = fakeDeps({ higgsfield: fakeAdapter("higgsfield") });
    const [a, b, c] = await Promise.all([owner(), owner(), owner()]);
    started(await startMedia(input(a, await taskFor(a), "vid-cinematic", { aspect: "portrait" }), deps));
    expect(await startMedia(input(b, await taskFor(b), "vid-cinematic", { aspect: "portrait" }), deps)).toMatchObject({ ok: false, status: 429, error: "busy" });
    expect((await startMedia(input(c, await taskFor(c), "img-lifestyle"), deps)).ok).toBe(true);
  });

  it("jobs past their max age do not block: they are advanced to timeout and refunded, and the new start is admitted", async () => {
    const cl = clockAt();
    const hf = fakeAdapter("higgsfield");
    const deps = fakeDeps({ higgsfield: hf }, { now: cl.now });
    const [a, b, c] = await Promise.all([owner(), owner(), owner()]);
    const ja = started(await startMedia(input(a, await taskFor(a), "img-lifestyle", { deadline: cl.t + 100_000 }), deps));
    const jb = started(await startMedia(input(b, await taskFor(b), "img-design", { deadline: cl.t + 100_000 }), deps));
    cl.add(31 * 60_000);
    expect((await startMedia(input(c, await taskFor(c), "img-lifestyle", { deadline: cl.t + 100_000 }), deps)).ok).toBe(true);
    expect(await getJob(a.email, ja.id)).toMatchObject({ state: "failed", error: "timeout", refunded: true });
    expect(await getJob(b.email, jb.id)).toMatchObject({ state: "failed", error: "timeout", refunded: true });
    expect(hf.cancels).toBe(2);
    expect([await balance(a), await balance(b), await balance(c)]).toEqual([50, 50, 49]);
  });

  it("members whose record is gone, or that do not parse, are removed", async () => {
    const ghost = mk.openMember("ghost@test.example", "c".repeat(32));
    await Promise.all([db.sadd(mk.open("higgsfield"), ghost), db.sadd(mk.open("higgsfield"), "garbage")]);
    const a = await owner();
    const job = started(await startMedia(input(a, await taskFor(a), "img-lifestyle"), fakeDeps({ higgsfield: fakeAdapter("higgsfield") })));
    expect(await db.smembers(mk.open("higgsfield"))).toEqual([mk.openMember(a.email, job.id)]);
  });
});

describe("the breaker (spec A22)", () => {
  it("three store_failed renders of one model within an hour switch it off", async () => {
    const u = await owner();
    const c = clockAt();
    const deps = fakeDeps({ kie: fakeAdapter("kie", { status: () => done() }) }, { storeFails: true, now: c.now });
    const jobs = [];
    for (let i = 0; i < 3; i++) jobs.push(started(await startMedia(input(u, await taskFor(u), "img-balanced", { deadline: c.t + 100_000 }), deps)));
    c.add(11 * 60_000); // past the max age: the first failed copy is final
    await advance(jobs[0], deps, sweep(c.t + 100_000));
    await advance(jobs[1], deps, sweep(c.t + 100_000));
    expect((await offModels())["img-balanced"]).toBeUndefined();
    expect(await advance(jobs[2], deps, sweep(c.t + 100_000))).toMatchObject({ state: "failed", error: "store_failed" });
    expect((await offModels())["img-balanced"]).toMatchObject({ reason: "store_failed" });
    expect(await balance(u)).toBe(50);
  });

  it("three rejected submits switch the model off; busy answers never do", async () => {
    const u = await owner();
    const busy = fakeDeps({ kie: fakeAdapter("kie", { submit: () => { throw new ProviderError("busy", 429); } }) });
    for (let i = 0; i < 4; i++) await startMedia(input(u, await taskFor(u), "img-text"), busy);
    expect(await offModels()).toEqual({});
    expect(await db.get("rate:mfail:img-text")).toBeNull();
    const rejected = fakeDeps({ kie: fakeAdapter("kie", { submit: () => { throw new ProviderError("rejected", 422); } }) });
    for (let i = 0; i < 3; i++) await startMedia(input(u, await taskFor(u), "img-text"), rejected);
    expect(Object.keys(await offModels())).toEqual(["img-text"]);
    expect(await balance(u)).toBe(50);
  });

  it("a kie render billed above 110 % of its expected credits switches the model off, and the owner keeps the render", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const deps = fakeDeps({ kie: fakeAdapter("kie", { status: () => ({ state: "done", urls: ["https://tempfile.kie.example/c.mp4"], providerCredits: 250 }) }) });
    const job = started(await startMedia(input(u, t, "vid-sound", { aspect: "portrait" }), deps));
    expect(await advance(job, deps, sweep())).toMatchObject({ state: "done", providerCredits: 250, costUsd: 1.25 });
    expect((await offModels())["vid-sound"]).toMatchObject({ reason: "overbilled" });
    expect((await getTask(u.email, t.id))!).toMatchObject({ videoUrl: deps.stored[0].url, videoProvider: "kie", videoModel: "vid-sound", mediaCredits: 12 });
  });

  it("an empty provider balance switches every model of that provider off for an hour", async () => {
    const u = await owner();
    const deps = fakeDeps({ kie: fakeAdapter("kie", { submit: () => { throw new ProviderError("no_balance", 402); } }) });
    const before = Date.now();
    expect(await startMedia(input(u, await taskFor(u), "img-balanced"), deps)).toMatchObject({ ok: false, status: 502, error: "media_failed", credits: 50 });
    const off = await offModels();
    const kieModels = MEDIA_MODELS.filter((m) => m.provider === "kie").map((m) => m.id);
    expect(Object.keys(off).sort()).toEqual([...kieModels].sort());
    for (const id of kieModels) {
      expect(off[id]!.until).toBeGreaterThanOrEqual(before + 3600_000);
      expect(off[id]!.until).toBeLessThan(before + 3600_000 + 60_000);
    }
  });
});

describe("webhook lookup, sweeps and the console's counters", () => {
  it("jobForHook finds a job only by its own provider and task id", async () => {
    const u = await owner();
    const id = kieId();
    const deps = fakeDeps({ kie: fakeAdapter("kie", { submit: () => ({ state: "pending", providerTaskId: id }) }) });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced"), deps));
    expect((await jobForHook("kie", id))?.id).toBe(job.id);
    expect(await jobForHook("higgsfield", id)).toBeNull();
    expect(await jobForHook("kie", kieId())).toBeNull();
    expect(await jobForHook("kie", "../x")).toBeNull();
    expect(await jobForHook("fal", id)).toBeNull();
    expect(await jobForHook("constructor" as never, id)).toBeNull();
    // A pointer that disagrees with the job it names is ignored.
    const other = kieId();
    await db.set(mk.ref("kie", other), { scope: u.email, jobId: job.id }, 3600);
    expect(await jobForHook("kie", other)).toBeNull();
  });

  it("a sweep drops orphans, fails and refunds a pending job past its max age, delivers a done one, and leaves young jobs alone", async () => {
    const [a, b, y] = await Promise.all([owner(), owner(), owner()]);
    const c = clockAt();
    const kie = fakeAdapter("kie");
    const hf = fakeAdapter("higgsfield", { status: () => done() });
    const deps = fakeDeps({ kie, higgsfield: hf }, { now: c.now });
    const pending = started(await startMedia(input(a, await taskFor(a), "img-balanced", { deadline: c.t + 100_000 }), deps));
    const ready = started(await startMedia(input(b, await taskFor(b), "img-lifestyle", { deadline: c.t + 100_000 }), deps));
    await Promise.all([db.sadd(mk.open("kie"), mk.openMember("gone@test.example", "d".repeat(32))), db.sadd(mk.open("fal"), "junk")]);
    c.add(11 * 60_000);
    const young = started(await startMedia(input(y, await taskFor(y), "img-balanced", { deadline: c.t + 100_000 }), deps));

    const report = await sweepMedia(deps, { deadline: c.t + 100_000 });
    expect(report).toEqual({ open: 3, advanced: 2, done: 1, failed: 1, dropped: 2, skipped: 0 });
    expect(await getJob(a.email, pending.id)).toMatchObject({ state: "failed", error: "timeout", refunded: true });
    expect(await getJob(b.email, ready.id)).toMatchObject({ state: "done" });
    expect(await getJob(y.email, young.id)).toMatchObject({ state: "running" });
    expect(kie.statusCalls).toBe(1);
    expect([await balance(a), await balance(b)]).toEqual([50, 49]);
    expect(await db.smembers(mk.open("fal"))).toEqual([]);
    expect(await db.smembers(mk.open("kie"))).toEqual([mk.openMember(y.email, young.id)]);

    // Less than 20 s left: nothing is started.
    c.add(3 * 60_000);
    expect(await sweepMedia(deps, { deadline: c.t + 10_000 })).toMatchObject({ advanced: 0, skipped: 1 });
    expect(kie.statusCalls).toBe(1);
  });

  it("the opportunistic sweep runs at most once per lock, and never without 30 s left", async () => {
    const deps = fakeDeps({});
    expect(await maybeSweep(deps, Date.now() + 10_000)).toBeNull();
    expect(await maybeSweep(deps, Date.now() + 100_000)).toMatchObject({ open: 0 });
    expect(await maybeSweep(deps, Date.now() + 100_000)).toBeNull();
  });

  it("spend counters are integers even for fractional kie credits", async () => {
    const u = await owner();
    const incr = vi.spyOn(db, "incrby");
    const deps = fakeDeps({ kie: fakeAdapter("kie", { status: (n) => ({ state: "done", urls: ["https://tempfile.kie.example/v.mp4"], providerCredits: n === 1 ? 35 : 8.2 }) }) });
    for (let i = 0; i < 2; i++) {
      const job = started(await startMedia(input(u, await taskFor(u), "vid-premium", { aspect: "portrait" }), deps));
      expect((await advance(job, deps, sweep())).state).toBe("done");
    }
    expect(incr.mock.calls.length).toBeGreaterThan(0);
    for (const [key, n] of incr.mock.calls) expect(Number.isInteger(n), `${key} += ${n}`).toBe(true);
    expect(await counter(`${mk.spend(monthKey())}:kie_centicredits`)).toBe(4320);
    expect(await counter(spend("vid-premium", "usd_micro"))).toBe(175_000 + 41_000);
    expect(await counter(spend("vid-premium", "credits"))).toBe(48);
  });

  it("every terminal transition pushes one recent entry without email, scope or prompt, and the list stays at 50", async () => {
    const u = await owner();
    await Promise.all(Array.from({ length: 60 }, (_, i) => db.lpush(mk.recent(), JSON.stringify({ i }))));
    await db.ltrim(mk.recent(), 49);
    expect(await db.lrange(mk.recent(), 0, -1)).toHaveLength(49);
    const ok = started(await startMedia(input(u, await taskFor(u), "img-fast"), fakeDeps({ fal: fakeAdapter("fal") })));
    const list = await recent();
    expect(list).toHaveLength(50);
    expect(list[0]).toMatchObject({ id: ok.id, model: "img-fast", state: "done", costUsd: 0.003 });
    await startMedia(input(u, await taskFor(u), "img-fast"), fakeDeps({ fal: fakeAdapter("fal", { submit: () => ({ state: "failed", reason: "nsfw" }) }) }));
    const after = await recent();
    expect(after).toHaveLength(50);
    expect(after[0]).toMatchObject({ state: "failed", error: "nsfw" });
    for (const e of after.slice(0, 2)) for (const k of ["email", "scope", "prompt"]) expect(e).not.toHaveProperty(k);
    expect(JSON.stringify(after)).not.toContain(u.email);
  });
});

describe("what the owner sees", () => {
  it("a failure found by a sweep is notified in the job's language with the credits returned; the same failure seen by a poll is not", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const failing = () => fakeDeps({ kie: fakeAdapter("kie", { status: () => ({ state: "failed", reason: "provider_failed" }) }) });
    const d1 = failing();
    await advance(started(await startMedia(input(u, t, "img-balanced"), d1)), d1, sweep());
    const notes = await listNotifs(u.email);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "info", title: "لم تكتمل الصورة لـ«Weekend offer»", body: "أُعيدت 1 كريدت.", href: "/ar/app" });

    const v = await owner();
    const d2 = failing();
    await advance(started(await startMedia(input(v, await taskFor(v), "img-balanced"), d2)), d2, poll());
    expect(await listNotifs(v.email)).toEqual([]);
  });

  it("a video finished by a webhook hint tells an English-speaking owner it is ready", async () => {
    const u = await owner({ lang: "en" });
    const t = await taskFor(u, { title: "Ramadan hours" });
    const deps = fakeDeps({ kie: fakeAdapter("kie", { status: () => ({ state: "done", urls: ["https://tempfile.kie.example/v.mp4"] }) }) });
    const job = started(await startMedia(input(u, t, "vid-quick", { aspect: "portrait" }), deps));
    expect((await advance(job, deps, { deadline: Date.now() + 100_000, via: "hook" })).state).toBe("done");
    expect(await listNotifs(u.email)).toMatchObject([{ kind: "info", title: "Your video is ready: Ramadan hours", body: "It's in your inbox.", href: "/en/app" }]);
    expect((await getTask(u.email, t.id))!).toMatchObject({ videoUrl: deps.stored[0].url, videoPrompt: "a test prompt", videoProvider: "kie", videoModel: "vid-quick", mediaCredits: 12 });
    expect(deps.stored[0].kind).toBe("video");
  });

  it("the last failure stays on the card until the next render of that kind", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const failing = fakeDeps({ kie: fakeAdapter("kie", { status: () => ({ state: "failed", reason: "provider_failed" }) }) });
    await advance(started(await startMedia(input(u, t, "vid-quick", { aspect: "portrait" }), failing)), failing, poll());
    expect((await getTask(u.email, t.id))!.mediaLast?.video).toMatchObject({ error: "provider_failed", credits: 12, refunded: true });
    const deps = fakeDeps({ kie: fakeAdapter("kie") });
    started(await startMedia(input(u, t, "img-balanced"), deps));
    expect((await getTask(u.email, t.id))!.mediaLast?.video?.error).toBe("provider_failed");
    const video = started(await startMedia(input(u, t, "vid-quick", { aspect: "portrait" }), deps));
    const task = (await getTask(u.email, t.id))!;
    expect(task.mediaLast?.video).toBeUndefined();
    expect(task.mediaJob?.video).toBe(video.id);
  });

  it("a trial keeps one video: a second is refused uncharged, a refunded one frees the slot, a paid account never touches it", async () => {
    const u = await owner();
    const trial = (t: Task) => input(u, t, "vid-quick", { plan: "trial", aspect: "portrait" });
    const kie = fakeAdapter("kie", { status: () => ({ state: "failed", reason: "provider_failed" }) });
    const deps = fakeDeps({ kie });
    const first = started(await startMedia(trial(await taskFor(u)), deps));
    expect(first.trialVideo).toBe(true);
    expect(await db.get(mk.trialVideo(u.email))).toBeTruthy();
    const t2 = await taskFor(u);
    expect(await startMedia(trial(t2), deps)).toMatchObject({ ok: false, status: 402, error: "trial_video_used" });
    expect(await balance(u)).toBe(38);
    expect(await flightFree(u, t2, "video")).toBe(true);
    await advance(first, deps, sweep());
    expect(await balance(u)).toBe(50);
    expect(await db.get(mk.trialVideo(u.email))).toBeNull();
    expect((await startMedia(trial(t2), deps)).ok).toBe(true);

    const paid = await owner({ plan: "pro" });
    started(await startMedia(input(paid, await taskFor(paid), "vid-quick", { aspect: "portrait" }), fakeDeps({ kie: fakeAdapter("kie") })));
    expect(await db.get(mk.trialVideo(paid.email))).toBeNull();
  });

  it("what the browser sees of a job carries no account, workspace or prompt, and a queued job reads as running", async () => {
    const u = await owner();
    const at = new Date().toISOString();
    const job: MediaJob = { id: "e".repeat(32), scope: `${u.email}#b1`, email: u.email, accountSince: u.createdAt, lang: "ar", taskId: "t1", kind: "image", model: "img-balanced", provider: "kie", credits: 1, prompt: "secret prompt", state: "queued", createdAt: at, updatedAt: at };
    expect(publicJob(job)).toEqual({ id: job.id, kind: "image", model: "img-balanced", credits: 1, createdAt: at, state: "running" });
    expect(publicJob({ ...job, state: "failed", error: "timeout" })).toMatchObject({ state: "failed", error: "timeout" });
  });

  it("a job id that is not 32 hex characters is never read", async () => {
    const get = vi.spyOn(db, "get");
    for (const id of ["not-an-id", "../x", "A".repeat(32), "a".repeat(31), `${"a".repeat(32)}:x`]) expect(await getJob("owner@test.example", id)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("no charge, result or refund is lost to a failed write (review fixes)", () => {
  it("Round A failing and its refund failing too: the job stays findable, holds the task, and the next sweep ends it submit_lost with the refund", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const c = clockAt();
    const kie = fakeAdapter("kie");
    const deps = fakeDeps({ kie }, { now: c.now });
    const realSet = db.set;
    let refused = false;
    vi.spyOn(db, "set").mockImplementation(async (key: string, value: unknown, ttl?: number) => {
      if (!refused && key.startsWith("mjob:")) {
        refused = true;
        throw new Error("redis_down");
      }
      return realSet(key, value, ttl);
    });
    vi.mocked(refund).mockRejectedValueOnce(new Error("user_lock_timeout"));
    const r = await startMedia(input(u, t, "img-balanced", { deadline: c.t + 100_000 }), deps);
    vi.mocked(db.set).mockRestore();
    // No `credits`: nothing was returned, so nothing may say it was.
    expect(r).toEqual({ ok: false, status: 502, error: "media_failed" });
    expect(await balance(u)).toBe(49);
    expect(kie.submits).toHaveLength(0);
    const jobId = (await getTask(u.email, t.id))!.mediaJob?.image;
    expect(jobId, "the task still points at the charged job").toBeTruthy();
    expect(await getJob(u.email, jobId!), "the record the failed save lost is written again").toMatchObject({ state: "queued", credits: 1 });
    expect(await db.smembers(mk.open("kie"))).toContain(mk.openMember(u.email, jobId!));
    expect(await db.get(mk.refundOnce(jobId!)), "the claim is released for the next pass").toBeNull();
    expect(await flightFree(u, t), "the charged job still holds the task").toBe(false);

    c.add(4 * 60_000);
    expect(await sweepMedia(deps, { deadline: c.t + 100_000 })).toMatchObject({ advanced: 1, failed: 1 });
    expect(await getJob(u.email, jobId!)).toMatchObject({ state: "failed", error: "submit_lost", refunded: true });
    expect(await balance(u)).toBe(50);
    expect(await flightFree(u, t)).toBe(true);
    expect((await getTask(u.email, t.id))!.mediaJob).toBeUndefined();
    expect(vi.mocked(refund)).toHaveBeenCalledTimes(2);
  });

  it("a task write failing at finalize leaves the job running with its result: the next pass delivers it, with no second status call", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const kie = fakeAdapter("kie", { status: () => done(8) });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, t, "img-balanced"), deps));
    const realSet = db.set;
    let fail = true;
    vi.spyOn(db, "set").mockImplementation(async (key: string, value: unknown, ttl?: number) => {
      if (fail && key === `task:${u.email}:${t.id}`) {
        fail = false;
        throw new Error("redis_down");
      }
      return realSet(key, value, ttl);
    });
    await expect(advance(job, deps, sweep())).rejects.toThrow("redis_down");
    vi.mocked(db.set).mockRestore();
    expect(await getJob(u.email, job.id), "not done: nothing would ever advance it again").toMatchObject({ state: "running", resultUrls: [RESULT], providerCredits: 8 });
    expect((await getTask(u.email, t.id))!.imageUrl).toBeUndefined();

    expect((await advance(job, deps, sweep())).state).toBe("done");
    expect(kie.statusCalls).toBe(1);
    const task = (await getTask(u.email, t.id))!;
    expect(task).toMatchObject({ imageUrl: deps.stored[1].url, imageProvider: "kie", mediaCredits: 1 });
    expect(task.mediaJob).toBeUndefined();
    expect(await balance(u)).toBe(49);
  });

  it("a task written but its index write lost: the retry finds the render already taken and counts its credit once", async () => {
    const u = await owner();
    const t = await taskFor(u);
    const deps = fakeDeps({ kie: fakeAdapter("kie", { status: () => done() }) });
    const job = started(await startMedia(input(u, t, "img-balanced"), deps));
    const realHset = db.hset;
    let fail = true;
    vi.spyOn(db, "hset").mockImplementation(async (key: string, field: string, value: unknown) => {
      if (fail && key.startsWith(`tidx:${u.email}:`) && field === t.id) {
        fail = false;
        throw new Error("redis_down");
      }
      return realHset(key, field, value);
    });
    await expect(advance(job, deps, sweep())).rejects.toThrow("redis_down");
    vi.mocked(db.hset).mockRestore();
    expect((await getTask(u.email, t.id))!).toMatchObject({ imageUrl: deps.stored[0].url, mediaCredits: 1, mediaApplied: [job.id] });
    expect((await advance(job, deps, sweep())).state).toBe("done");
    expect((await getTask(u.email, t.id))!).toMatchObject({ imageUrl: deps.stored[0].url, mediaCredits: 1, mediaApplied: [job.id] });
  });

  it("a render finished after its account was deleted writes no analytics for the address; a live account's still counts", async () => {
    const u = await owner();
    const deps = fakeDeps({ kie: fakeAdapter("kie", { status: () => done() }) });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced"), deps));
    await wipeAccount(u.email);
    expect((await advance(job, deps, sweep())).state).toBe("done");
    for (const key of [`ulast:${u.email}`, `uev:${u.email}:image`, `ufirst0:${u.email}:image`]) expect(await db.get(key), key).toBeNull();
    expect(await listNotifs(u.email)).toEqual([]);

    const v = await owner();
    const jv = started(await startMedia(input(v, await taskFor(v), "img-balanced"), deps));
    expect((await advance(jv, deps, sweep())).state).toBe("done");
    expect(await db.get(`uev:${v.email}:image`)).toBe(1);
  });

  it("a sweep waits the 30 s copy gap too: a failed copy is never retried sooner, whoever asks", async () => {
    const u = await owner();
    const c = clockAt();
    const deps = fakeDeps({ kie: fakeAdapter("kie", { status: () => done(8) }) }, { storeFails: 1, now: c.now });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced", { deadline: c.t + 100_000 }), deps));
    const kept = await advance(job, deps, sweep(c.t + 100_000));
    expect(kept).toMatchObject({ state: "running", storeTries: 1 });
    c.add(5_000);
    expect(await advance(kept, deps, sweep(c.t + 100_000))).toMatchObject({ state: "running", storeTries: 1 });
    expect(await sweepMedia(deps, { deadline: c.t + 100_000 })).toMatchObject({ open: 1, advanced: 0 });
    expect(deps.stored).toEqual([]);
    c.add(26_000);
    expect(await sweepMedia(deps, { deadline: c.t + 100_000 })).toMatchObject({ advanced: 1, done: 1 });
    expect(deps.stored).toHaveLength(1);
  });

  it("a refund claim left by a pass that died is not taken for a refund: the job stays open until the claim expires, then is refunded once", async () => {
    const u = await owner();
    const kie = fakeAdapter("kie", { status: () => ({ state: "failed", reason: "provider_failed" }) });
    const deps = fakeDeps({ kie });
    const job = started(await startMedia(input(u, await taskFor(u), "img-balanced"), deps));
    await db.lock(mk.refundOnce(job.id), 60); // claimed, then the function was killed before the ledger call
    await expect(advance(job, deps, sweep())).rejects.toThrow("refund_pending");
    expect(await getJob(u.email, job.id)).toMatchObject({ state: "running" });
    expect(await balance(u)).toBe(49);
    expect(await listNotifs(u.email), "nobody is told credits came back").toEqual([]);

    await db.unlock(mk.refundOnce(job.id)); // the claim expired
    expect(await advance(job, deps, sweep())).toMatchObject({ state: "failed", refunded: true });
    expect(await balance(u)).toBe(50);
    expect(await db.get(mk.refundOnce(job.id))).toBe("done");
    await db.set(mk.job(u.email, job.id), job, 3600); // as if the failed save never landed
    expect(await advance(job, deps, sweep())).toMatchObject({ state: "failed", refunded: true });
    expect(await balance(u)).toBe(50);
    expect(vi.mocked(refund)).toHaveBeenCalledTimes(1);
  });
});

describe("new media after approval needs a person again (rule 576)", () => {
  it("an image delivered to an approved, unpublished item clears decidedAt; a pending or published item keeps its record", async () => {
    const u = await owner();
    const approved = await taskFor(u, { status: "approved", decidedAt: "2026-10-05T08:00:00.000Z" });
    const published = await taskFor(u, { status: "approved", decidedAt: "2026-10-05T08:00:00.000Z", published: [{ provider: "instagram", url: "https://instagram.com/p/1", status: "published", at: "2026-10-05T09:00:00.000Z" }] });
    const pending = await taskFor(u);
    const deps = fakeDeps({ fal: fakeAdapter("fal") });
    for (const t of [approved, published, pending]) started(await startMedia(input(u, t, "img-fast"), deps));
    const [a, p, q] = await Promise.all([getTask(u.email, approved.id), getTask(u.email, published.id), getTask(u.email, pending.id)]);
    expect(a!.imageUrl).toBeTruthy();
    expect(a!.status).toBe("approved");
    expect(a!.decidedAt, "chat publish_item needs decidedAt: a re-rendered image was never approved").toBeUndefined();
    expect(p!.decidedAt).toBe("2026-10-05T08:00:00.000Z");
    expect(q!.decidedAt).toBeUndefined();
  });
});
