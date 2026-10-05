import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";

/**
 * Whole-task writes (review finding: lost updates). saveTask replaces the whole task, so a writer that read the task,
 * did slow work and saved its copy erased whatever landed in between: a publish or an approval undid a render that
 * finished meanwhile (paid, and never shown again), and a finalize undid an approval. Every such writer now goes through
 * updateTask (src/lib/brand.ts): re-read under a short per-task lock, apply its own fields, save.
 *
 * The render here is the real engine over a scripted kie provider; each test lands its finalize inside the other
 * writer's window, the one place the old code lost it.
 */
const h = vi.hoisted(() => ({ duringPublish: null as null | (() => Promise<unknown>), duringGov: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/connectors/publish", async (orig) => ({
  ...(await orig<typeof import("@/lib/connectors/publish")>()),
  publishTask: async (_e: string, _t: unknown, provider: string) => {
    await h.duringPublish?.();
    return { provider, url: "https://t.me/x/1", id: "1", status: "published" as const };
  },
}));
vi.mock("@/lib/governance", async (orig) => {
  const real = await orig<typeof import("@/lib/governance")>();
  return { ...real, getGov: async (scope: string) => { await h.duringGov?.(); return real.getGov(scope); } };
});

import { db } from "@/lib/db";
import { getTask, saveTask, updateTask, type Task } from "@/lib/brand";
import { saveConnection } from "@/lib/connectors/store";
import { runTool } from "@/lib/chat";
import { advance, startMedia } from "@/lib/media/jobs";
import type { MediaJob, StartInput } from "@/lib/media/types";
import { fakeAdapter, fakeDeps, noNetwork, resetMediaCounters } from "./helpers/media";
import { newUser, params, settle, signIn } from "./helpers/session";
import { vjson } from "./helpers/version";
import { currentUser, type User } from "@/lib/auth";
import * as publishRoute from "@/app/api/publish/[id]/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";

const net = noNetwork();
afterAll(() => net.restore());
beforeEach(() => {
  resetMediaCounters();
  h.duringPublish = null;
  h.duringGov = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await settle();
  vi.restoreAllMocks();
  expect(net.hosts, "a task-write test reached the network").toEqual([]);
});

const CLIP = "https://tempfile.kie.example/clip.mp4";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function taskFor(u: User, over: Partial<Task> = {}): Promise<Task> {
  const t: Task = { id: `tw${randomBytes(4).toString("hex")}`, type: "social", channel: "instagram", title: "Weekend offer", body: "Two for one this weekend.", status: "pending", createdAt: new Date().toISOString(), lang: "ar", ...over };
  await saveTask(u.email, t, true);
  return t;
}
/** A 12-credit kie video running on the task, and the advance that finishes it. */
async function runningVideo(u: User, t: Task) {
  const deps = fakeDeps({ kie: fakeAdapter("kie", { status: () => ({ state: "done", urls: [CLIP] }) }) });
  const input: StartInput = {
    scope: u.email, email: u.email, lang: u.lang, accountSince: u.createdAt, plan: "pro", balance: u.credits, agent: "noor", taskId: t.id, model: "vid-quick",
    aspect: "portrait", deadline: Date.now() + 100_000, prompt: async () => "a test prompt",
  };
  const r = await startMedia(input, deps);
  if (!r.ok) throw new Error(`start refused: ${r.error}`);
  const finish = async () => {
    const j: MediaJob = await advance(r.job, deps, { force: true, deadline: Date.now() + 100_000, via: "sweep" });
    expect(j.state).toBe("done");
  };
  return { job: r.job, deps, finish };
}

describe("updateTask", () => {
  it("writers that run together each keep the other's fields, and a deleted task is never recreated", async () => {
    const u = await newUser("tw");
    const t = await taskFor(u);
    await Promise.all([
      updateTask(u.email, t.id, (c) => ({ ...c, videoUrl: "https://s.public.blob.vercel-storage.com/media/v.mp4" })),
      updateTask(u.email, t.id, (c) => ({ ...c, status: "approved" })),
      updateTask(u.email, t.id, (c) => ({ ...c, scheduledFor: "2026-10-01" })),
    ]);
    expect(await getTask(u.email, t.id)).toMatchObject({ videoUrl: expect.any(String), status: "approved", scheduledFor: "2026-10-01" });
    expect(await updateTask(u.email, "nope", (c) => c)).toBeNull();
    expect(await getTask(u.email, "nope")).toBeNull();
  });

  it("a mutate that declines leaves the stored task, and what it returns, unchanged", async () => {
    const u = await newUser("tw");
    const t = await taskFor(u);
    const back = await updateTask(u.email, t.id, (c) => { c.status = "approved"; return null; });
    expect(back!.status).toBe("pending");
    expect((await getTask(u.email, t.id))!.status).toBe("pending");
  });
});

describe("a render finishing while another writer holds the task", () => {
  it("the publish route keeps a clip that finished during the publish, and its credits", async () => {
    const u = await newUser("tw");
    await signIn(u.email);
    await saveConnection(u.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    const t = await taskFor(u);
    const video = await runningVideo(u, t);
    h.duringPublish = video.finish;
    const res = await publishRoute.POST(await vjson(`/api/publish/${t.id}`, "POST", { provider: "telegram" }), params({ id: t.id }));
    expect(res.status).toBe(200);
    const saved = (await getTask(u.email, t.id))!;
    expect(saved).toMatchObject({ videoUrl: video.deps.stored[0].url, videoModel: "vid-quick", mediaCredits: 12, status: "approved", published: [{ provider: "telegram" }] });
    expect(saved.mediaJob).toBeUndefined();
    expect(((await res.json()) as { task: Task }).task.videoUrl).toBe(video.deps.stored[0].url);
  });

  it("the chat tool publish_item keeps a clip that finished during the publish", async () => {
    const u = await newUser("tw");
    await saveConnection(u.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    // Approved by a person (decidedAt): publish_item refuses an item only auto-approval passed (rule 214).
    const t = await taskFor(u, { status: "approved", decidedAt: new Date().toISOString() });
    const video = await runningVideo(u, t);
    h.duringPublish = video.finish;
    // The owner, resolved the way a request is: publish_item is refused to a user with no actor (tests/role-gates.test.ts).
    await signIn(u.email);
    const me = (await currentUser())!;
    expect(await runTool(me, "publish_item", { task_id: t.id, provider: "telegram" }, [])).toMatch(/^Published to telegram/);
    expect((await getTask(u.email, t.id))!).toMatchObject({ videoUrl: video.deps.stored[0].url, mediaCredits: 12, published: [{ provider: "telegram" }] });
  });

  it("an approval keeps a clip that finished while the approve request was in flight", async () => {
    const u = await newUser("tw");
    await signIn(u.email);
    const t = await taskFor(u);
    const video = await runningVideo(u, t);
    h.duringGov = video.finish;
    const res = await taskRoute.PATCH(await vjson(`/api/tasks/${t.id}`, "PATCH", { status: "approved" }), params({ id: t.id }));
    expect(res.status).toBe(200);
    expect((await getTask(u.email, t.id))!).toMatchObject({ status: "approved", videoUrl: video.deps.stored[0].url, mediaCredits: 12 });
  });

  it("a finalize and an approval landing together keep both: the engine's own read-to-write window", async () => {
    const u = await newUser("tw");
    await signIn(u.email);
    const t = await taskFor(u);
    const video = await runningVideo(u, t);
    const key = `task:${u.email}:${t.id}`;
    const realGet = db.get.bind(db);
    let reads = 0;
    let patching: Promise<Response> | null = null;
    let patchRead: () => void = () => {};
    const patchHasRead = new Promise<void>((r) => (patchRead = r));
    vi.spyOn(db, "get").mockImplementation(async <T,>(k: string) => {
      const v = await realGet<T>(k);
      if (k === key && ++reads === 1) {
        // The finalize has just read the task: the owner approves now. Before the fix the approval read the same task
        // at once and one of the two writes erased the other; with the task lock it waits for the finalize to save.
        patching = taskRoute.PATCH(await vjson(`/api/tasks/${t.id}`, "PATCH", { status: "approved" }), params({ id: t.id }));
        await Promise.race([patchHasRead, sleep(100)]);
      } else if (k === key && reads === 2) patchRead();
      return v;
    });
    await video.finish();
    expect(patching).not.toBeNull();
    expect((await patching!).status).toBe(200);
    expect((await getTask(u.email, t.id))!).toMatchObject({ status: "approved", videoUrl: video.deps.stored[0].url, mediaCredits: 12 });
  });
});
