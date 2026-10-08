import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "crypto";
import type { MediaDeps, PublicJob } from "@/lib/media/types";

/**
 * The media routes and the chat tool over the real engine, with scripted providers and store (plan P8). The registry
 * is the one seam: every route and the chat tool get `g.deps`, so no test reaches a provider or the Blob store.
 */
const g = vi.hoisted(() => ({ deps: null as unknown as MediaDeps, sdk: 0 }));
vi.mock("@/lib/media/registry", () => ({ mediaDeps: () => g.deps }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { constructor() { g.sdk++; } } }));
// Claude paused: every render comes from the fixed templates, and the renderer still runs (spec 4.5).
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "paused" as const }));

import { db } from "@/lib/db";
import { getUser, saveUser, type User } from "@/lib/auth";
import { getTask, listLite, saveBrand, saveTask, type Brand, type Task } from "@/lib/brand";
import { runTool } from "@/lib/chat";
import { availableModels, offModels } from "@/lib/media/config";
import { mk } from "@/lib/media/keys";
import { BUSY_RETRY_S, QUEUED_LOST_MS, advance, getJob } from "@/lib/media/jobs";
import { fixedVideoPrompt } from "@/lib/media/prompts";
import { mediaResponse } from "@/lib/media/start";
import { kpis } from "@/lib/stats";
import { overview } from "@/lib/admin-stats";
import { fakeAdapter, fakeDeps, ipHeaders, mediaEnv, noNetwork, resetMediaCounters, type FakeScript } from "./helpers/media";
import { json, newUser, params, settle, signIn, signOut } from "./helpers/session";

import * as imageRoute from "@/app/api/tasks/[id]/image/route";
import * as videoRoute from "@/app/api/tasks/[id]/video/route";
import * as mediaRoute from "@/app/api/media/[jobId]/route";
import * as hookRoute from "@/app/api/media/hook/[provider]/route";
import * as cronRoute from "@/app/api/cron/media/route";

const net = noNetwork();
afterAll(() => {
  net.restore();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  resetMediaCounters();
  signOut();
  g.sdk = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Work a previous test scheduled with after() must not run inside this one.
  await settle();
});
afterEach(async () => {
  await settle();
  vi.restoreAllMocks();
  expect(net.hosts, "a media route test reached the network").toEqual([]);
  expect(g.sdk, "Claude is paused: no prompt call").toBe(0);
});

type Body = { ok: boolean; error?: string; credits?: number; need?: number; have?: number; provider?: string; job?: PublicJob; task?: Task };
const brand: Brand = { name: "Rose Coffee", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "coffee", audience: "Riyadh", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "Riyadh", updatedAt: new Date().toISOString() };
const RESULT = "https://tempfile.kie.example/result.png";
const EVIL = "https://evil.example/x.jpg";

/** A new account with a brand: a trial by default (50 credits), `pro` for tests that are not about trials. */
async function owner(over: Partial<User> = {}): Promise<User> {
  const u = await newUser("mr");
  if (Object.keys(over).length) {
    Object.assign(u, over);
    await saveUser(u);
  }
  await saveBrand(u.email, brand);
  return u;
}
const paid = () => owner({ plan: "pro" });
let taskN = 0;
async function taskFor(u: User, over: Partial<Task> = {}): Promise<Task> {
  const t: Task = { id: `mr${++taskN}${randomBytes(3).toString("hex")}`, type: "social", channel: "instagram", title: "Weekend offer", body: "Two for one this weekend.", status: "pending", createdAt: new Date().toISOString(), lang: "ar", ...over };
  await saveTask(u.email, t, true);
  return t;
}
/** A real generated image on our Blob store: the only reference image a provider may receive (spec A9). */
const ourImage = () => ({ imageUrl: `https://s1.public.blob.vercel-storage.com/media/${randomBytes(16).toString("hex")}.jpg`, imageProvider: "kie" as const });
const balance = async (u: User) => (await getUser(u.email))!.credits;

/** kie with a fresh task id per submit, so no pointer left by an earlier test can match. */
const kieFake = (status?: FakeScript["status"]) => fakeAdapter("kie", { submit: () => ({ state: "pending", providerTaskId: `kie${randomBytes(6).toString("hex")}` }), status });
const done = () => ({ state: "done" as const, urls: [RESULT] });
function useDeps(...a: Parameters<typeof fakeDeps>) {
  const deps = fakeDeps(...a);
  g.deps = deps;
  return deps;
}

async function start(kind: "image" | "video", u: User, t: Task, body: unknown = {}): Promise<{ status: number; body: Body }> {
  await signIn(u.email);
  const route = kind === "image" ? imageRoute : videoRoute;
  const res = await route.POST(json(`/api/tasks/${t.id}/${kind}`, "POST", body), params({ id: t.id }));
  return { status: res.status, body: (await res.json()) as Body };
}
async function poll(u: User | null, jobId: string): Promise<{ status: number; body: Body }> {
  if (u) await signIn(u.email);
  else signOut();
  const res = await mediaRoute.GET(json(`/api/media/${jobId}`, "GET"), params({ jobId }));
  return { status: res.status, body: (await res.json()) as Body };
}
async function hook(provider: string, body: unknown, ip: number, headers: Record<string, string> = {}): Promise<number> {
  const res = await hookRoute.POST(json(`/api/media/hook/${provider}`, "POST", body, { ...ipHeaders(ip), ...headers }), params({ provider }));
  return res.status;
}
/** Push a job's start time back, as if it had been running that long. */
async function age(scope: string, id: string, ms: number) {
  const j = (await getJob(scope, id))!;
  await db.set(mk.job(scope, id), { ...j, createdAt: new Date(Date.now() - ms).toISOString() });
}
const jobOf = (r: { body: Body }) => {
  if (!r.body.job) throw new Error(`no job in ${JSON.stringify(r.body)}`);
  return r.body.job;
};

describe("starting a render", () => {
  it("1. the image route with no media service configured answers the placeholder and charges nothing", async () => {
    mediaEnv({});
    const fal = fakeAdapter("fal"), kie = kieFake();
    useDeps({ fal, kie });
    const u = await owner();
    const t = await taskFor(u);
    expect(await balance(u)).toBe(50);
    const { creditsUsed: used, images } = await kpis(u.email, 7);
    const month = (await overview()).revenue.creditsUsedMonth;
    const r = await start("image", u, t);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, provider: "placeholder", credits: 50 });
    expect(await balance(u)).toBe(50);
    expect(fal.submits.length + kie.submits.length, "no adapter call").toBe(0);
    expect((await getTask(u.email, t.id))!).toMatchObject({ imageProvider: "placeholder", mediaCredits: 0 });
    expect((await kpis(u.email, 7)).creditsUsed, "the reports count no credit for a card that cost none").toBe(used);
    expect((await kpis(u.email, 7)).images, "nor count a placeholder card as an image generated").toBe(images);
    expect((await overview()).revenue.creditsUsedMonth, "nor does the founder console").toBe(month);
    // A placeholder saved before placeholders wrote mediaCredits (none on it): once re-saved, its row is no image, so the
    // readers' `image ? IMAGE_COST : 0` fallback counts no credit either.
    const legacy = await taskFor(u, { imageUrl: "https://placehold.co/1024x1024/x.png?text=Rose", imageProvider: "placeholder" });
    const row = (await listLite(u.email)).find((l) => l.id === legacy.id)!;
    expect([row.image, row.mediaCredits]).toEqual([false, undefined]);
    expect((await kpis(u.email, 7)).images).toBe(images);
  });

  it("1c. a placeholder asked for while another image style finishes on the item lands under that image, never over it", async () => {
    // img-fast switched off by the breaker, so a model-less request is the placeholder; a kie image runs on the same item.
    mediaEnv({ fal: true, kie: true, blob: true, models: "all" });
    await db.set(mk.off(), { "img-fast": { until: Date.now() + 3600_000, reason: "store_failed" } });
    const deps = useDeps({ kie: kieFake(done) });
    const u = await paid();
    const t = await taskFor(u);
    const first = await start("image", u, t, { model: "img-balanced" });
    expect(first.status).toBe(202);
    const running = (await getJob(u.email, jobOf(first).id))!;
    // The kie image finishes inside the placeholder's read of the item: the route's own read is the first, this the second.
    const key = `task:${u.email}:${t.id}`;
    const get = db.get.bind(db);
    let reads = 0;
    let finishing: Promise<unknown> | undefined;
    vi.spyOn(db, "get").mockImplementation(async (k: string) => {
      const v = await get(k);
      if (k === key && ++reads === 2) {
        finishing = advance(running, deps, { force: true, deadline: Date.now() + 100_000, via: "sweep" });
        // Waiting for it would deadlock under the task lock; the old read-then-save let it land in full before saving.
        await Promise.race([finishing, new Promise((r) => setTimeout(r, 300))]);
      }
      return v as never;
    });
    const r = await start("image", u, t);
    expect(r.status).toBe(200);
    expect(finishing, "the finish ran inside the placeholder's window").toBeDefined();
    expect(await finishing).toMatchObject({ state: "done" });
    vi.mocked(db.get).mockRestore();
    const after = (await getTask(u.email, t.id))!;
    expect(after, "the paid kie image is on the item, not the placeholder card").toMatchObject({ imageProvider: "kie", imageModel: "img-balanced", mediaCredits: running.credits });
    expect(after.mediaJob?.image).toBeUndefined();
  });

  it("1b. a placeholder never replaces artwork: with no image model the item keeps its image and nothing is charged", async () => {
    const fal = fakeAdapter("fal");
    useDeps({ fal });
    const u = await owner();
    const cases: [what: string, env: () => Promise<void>, image: Partial<Task>][] = [
      ["nothing configured", async () => mediaEnv({}), ourImage()],
      ["the default model switched off by the breaker", async () => {
        mediaEnv({ fal: true });
        await db.set(mk.off(), { "img-fast": { until: Date.now() + 3600_000, reason: "store_failed" } });
      }, { imageUrl: "https://v3.fal.media/files/paid.jpg", imageProvider: "fal" }],
    ];
    for (const [what, env, image] of cases) {
      await env();
      const t = await taskFor(u, image);
      for (const body of [{}, { model: "img-fast" }]) {
        const r = await start("image", u, t, body);
        expect([r.status, r.body.error], `${what} ${JSON.stringify(body)}`).toEqual([409, "model_unavailable"]);
      }
      expect((await getTask(u.email, t.id))!, what).toMatchObject(image);
    }
    expect(await balance(u)).toBe(50);
    expect(fal.submits).toHaveLength(0);
  });

  it("2. an unknown or wrong-kind model, and an item that takes no media, are 400 and charge nothing", async () => {
    mediaEnv({ fal: true, kie: true, higgsfield: true, blob: true, models: "all" });
    const fal = fakeAdapter("fal"), kie = kieFake();
    useDeps({ fal, kie, higgsfield: fakeAdapter("higgsfield") });
    const u = await paid();
    const social = await taskFor(u), plan = await taskFor(u, { type: "weekly_plan", channel: "internal" }), article = await taskFor(u, { type: "article", channel: "blog" });
    const cases: [kind: "image" | "video", t: Task, body: unknown, error: string][] = [
      ["image", social, { model: "constructor" }, "bad_model"],
      ["image", social, { model: "toString" }, "bad_model"],
      ["image", social, { model: "vid-quick" }, "bad_model"],
      ["video", social, { model: "img-fast" }, "bad_model"],
      ["video", social, {}, "bad_model"],
      ["image", plan, {}, "wrong_type"],
      ["video", plan, { model: "vid-quick" }, "wrong_type"],
      ["video", article, { model: "vid-quick" }, "wrong_type"],
    ];
    for (const [kind, t, body, error] of cases) {
      const r = await start(kind, u, t, body);
      expect([r.status, r.body.error], `${kind} ${JSON.stringify(body)} on ${t.type}`).toEqual([400, error]);
    }
    expect(await balance(u)).toBe(50);
    expect(fal.submits.length + kie.submits.length).toBe(0);
  });

  it("3. a kie model needs its key, the Blob store and the founder's switch; then 202, polled to 200 with our copy", async () => {
    const kie = kieFake((n) => (n === 1 ? { state: "pending" } : done()));
    const deps = useDeps({ kie });
    const u = await paid();
    const t = await taskFor(u);

    mediaEnv({ kie: true, blob: true });
    expect((await start("image", u, t, { model: "img-balanced" })).body.error, "not in MEDIA_MODELS_ON").toBe("model_unavailable");
    mediaEnv({ kie: true, models: "all" });
    const noBlob = await start("image", u, t, { model: "img-balanced" });
    expect([noBlob.status, noBlob.body.error], "no Blob store").toEqual([409, "model_unavailable"]);
    expect(await balance(u)).toBe(50);

    mediaEnv({ kie: true, blob: true, models: "all" });
    const r = await start("image", u, t, { model: "img-balanced" });
    expect(r.status).toBe(202);
    const job = jobOf(r);
    expect(job).toMatchObject({ state: "running", model: "img-balanced", credits: 1, kind: "image" });
    expect(r.body.credits).toBe(49);
    expect(r.body.task!.mediaJob?.image, "the task points at the job, so a reload resumes polling").toBe(job.id);

    const first = await poll(u, job.id);
    expect([first.status, first.body.job!.state]).toEqual([200, "running"]);
    await db.unlock(mk.poll(job.id));
    const second = await poll(u, job.id);
    expect(second.status).toBe(200);
    expect(second.body.job!.state).toBe("done");
    expect(deps.stored.map((s) => s.source)).toEqual([RESULT]);
    expect(second.body.task).toMatchObject({ imageUrl: deps.stored[0].url, imageProvider: "kie", imageModel: "img-balanced" });
    expect(second.body.task!.mediaJob?.image).toBeUndefined();
    expect(await balance(u)).toBe(49);
  });

  it("the image route with fal answers 200 with the finished job and our copy", async () => {
    mediaEnv({ fal: true, blob: true });
    const fal = fakeAdapter("fal");
    const deps = useDeps({ fal });
    const u = await owner();
    const t = await taskFor(u, { channel: "tiktok" });
    const r = await start("image", u, t);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, provider: "fal", credits: 49 });
    expect(r.body.job).toMatchObject({ state: "done", model: "img-fast" });
    expect(r.body.task).toMatchObject({ imageUrl: deps.stored[0].url, imageProvider: "fal", imageModel: "img-fast" });
    expect(fal.submits[0]).toMatchObject({ model: "img-fast", aspect: "portrait" });
  });

  it("4. two clicks at once start one render and charge once; a later click gets the running job", async () => {
    mediaEnv({ kie: true, blob: true, models: "all" });
    const kie = kieFake();
    useDeps({ kie });
    const u = await paid();
    const t = await taskFor(u);
    await signIn(u.email);
    const post = () => imageRoute.POST(json(`/api/tasks/${t.id}/image`, "POST", { model: "img-balanced" }), params({ id: t.id }));
    const res = await Promise.all([post(), post()]);
    const bodies = (await Promise.all(res.map((r) => r.json()))) as Body[];
    expect(res.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(bodies.find((b) => !b.ok)!.error).toBe("in_progress");
    expect(kie.submits).toHaveLength(1);
    expect(await balance(u)).toBe(49);
    const running = bodies.find((b) => b.ok)!.job!;
    const again = await start("image", u, t, { model: "img-balanced" });
    expect([again.status, again.body.error, again.body.job?.id, again.body.job?.state]).toEqual([409, "in_progress", running.id, "running"]);
  });

  it("7. video: a first frame only from a portrait image of ours, Photo to motion needs one, and the paused prompt still renders", async () => {
    mediaEnv({ kie: true, higgsfield: true, blob: true, models: "all" });
    const kie = kieFake(), hf = fakeAdapter("higgsfield");
    useDeps({ kie, higgsfield: hf });
    const u = await paid();
    u.credits = 200;
    await saveUser(u);

    const bare = await taskFor(u);
    const r0 = await start("video", u, bare, { model: "vid-motion" });
    expect([r0.status, r0.body.error]).toEqual([409, "needs_image"]);
    expect(await balance(u)).toBe(200);

    const tiktok = await taskFor(u, { channel: "tiktok", ...ourImage() });
    expect((await start("video", u, tiktok, { model: "vid-quick" })).status).toBe(202);
    expect(kie.submits[0].imageUrl, "a portrait image is the first frame").toBe(tiktok.imageUrl);
    expect(kie.submits[0].aspect).toBe("portrait");

    const square = await taskFor(u, { channel: "instagram", ...ourImage() });
    expect((await start("video", u, square, { model: "vid-quick" })).status).toBe(202);
    expect(kie.submits[1].imageUrl, "a square first frame would give a square clip").toBeUndefined();
    const prompt = kie.submits[1].prompt;
    expect(prompt).toBe(fixedVideoPrompt(brand, square, "vid-quick", false));
    expect(prompt).toContain("no speech");

    const square2 = await taskFor(u, { channel: "instagram", ...ourImage() });
    expect((await start("video", u, square2, { model: "vid-motion" })).status).toBe(202);
    expect(hf.submits[0].imageUrl, "Photo to motion takes the image whatever its shape").toBe(square2.imageUrl);
    expect(await balance(u)).toBe(200 - 36);
  });

  it("a start that throws after the charge answers with its durable job, which a poll later settles and refunds", async () => {
    mediaEnv({ kie: true, blob: true, models: "all" });
    const kie = kieFake();
    useDeps({ kie });
    const u = await paid();
    const t = await taskFor(u);
    // The job lock after Round A is outside every try in startMedia: a store error there reaches the route's catch.
    const lock = db.lock.bind(db);
    const spy = vi.spyOn(db, "lock").mockImplementation(async (key: string, ttl: number) => {
      if (key.startsWith("mjoblock:")) throw new Error("store_down");
      return lock(key, ttl);
    });
    const r = await start("image", u, t, { model: "img-balanced" });
    spy.mockRestore();
    await settle();
    expect(r.status, "not 502 media_failed: no refund has happened").toBe(202);
    const job = jobOf(r);
    expect(job).toMatchObject({ state: "running", model: "img-balanced", credits: 1 });
    expect((await getTask(u.email, t.id))!.mediaJob?.image, "the inbox follows the job the task points at").toBe(job.id);
    expect(await balance(u), "charged, and not yet refunded").toBe(49);
    expect(kie.submits).toHaveLength(0);

    await age(u.email, job.id, QUEUED_LOST_MS + 60_000);
    const p = await poll(u, job.id);
    expect(p.body.job).toMatchObject({ id: job.id, state: "failed", error: "submit_lost" });
    expect(p.body.credits).toBe(50);
    expect(await balance(u)).toBe(50);
  });

  it("a start that throws before the charge answers media_pending, never that credits were returned", async () => {
    mediaEnv({ kie: true, blob: true, models: "all" });
    const kie = kieFake();
    useDeps({ kie });
    const u = await paid();
    const t = await taskFor(u);
    const lock = db.lock.bind(db);
    const spy = vi.spyOn(db, "lock").mockImplementation(async (key: string, ttl: number) => {
      if (key.startsWith("mflight:")) throw new Error("store_down");
      return lock(key, ttl);
    });
    const image = await start("image", u, t, { model: "img-balanced" });
    const video = await start("video", u, t, { model: "vid-quick" });
    spy.mockRestore();
    expect([image.status, image.body.error]).toEqual([502, "media_pending"]);
    expect([video.status, video.body.error]).toEqual([502, "media_pending"]);
    expect(await balance(u)).toBe(50);
    expect(kie.submits).toHaveLength(0);
  });

  it("media_failed goes out only with the balance its refund left; without one it is media_pending", () => {
    expect(mediaResponse({ ok: false, status: 502, error: "media_failed", credits: 50 }).body).toEqual({ ok: false, error: "media_failed", credits: 50 });
    expect(mediaResponse({ ok: false, status: 502, error: "media_failed" })).toEqual({ status: 502, body: { ok: false, error: "media_pending" } });
    expect(mediaResponse({ ok: false, status: 422, error: "nsfw" }).body.error, "other codes pass through").toBe("nsfw");
    // Rule 672: a 429 says when to try again, the refusing window when the engine named one, else BUSY_RETRY_S.
    expect(mediaResponse({ ok: false, status: 429, error: "too_many", retryAfter: 86400 })).toEqual({ status: 429, headers: { "Retry-After": "86400" }, body: { ok: false, error: "too_many" } });
    expect(mediaResponse({ ok: false, status: 429, error: "busy" }).headers).toEqual({ "Retry-After": String(BUSY_RETRY_S) });
    expect(mediaResponse({ ok: false, status: 402, error: "no_credits", need: 50, have: 0 }).headers, "only a 429 carries it").toBeUndefined();
  });

  it("12. a model the breaker switched off is refused before any charge and left out of the inbox list", async () => {
    mediaEnv({ kie: true, blob: true, models: "all" });
    const kie = kieFake();
    useDeps({ kie });
    await db.set(mk.off(), { "img-balanced": { until: Date.now() + 3600_000, reason: "store_failed" } });
    const u = await paid();
    const r = await start("image", u, await taskFor(u), { model: "img-balanced" });
    expect([r.status, r.body.error]).toEqual([409, "model_unavailable"]);
    expect(await balance(u)).toBe(50);
    expect(kie.submits).toHaveLength(0);
    const list = availableModels(undefined, await offModels());
    expect(list).not.toContain("img-balanced");
    expect(list).toContain("img-premium");
  });

  it("13. a trial keeps one 12-credit video", async () => {
    mediaEnv({ kie: true, blob: true, models: "all" });
    const kie = kieFake();
    useDeps({ kie });
    const u = await owner();
    expect(u.plan).toBe("trial");
    const premium = await start("video", u, await taskFor(u), { model: "vid-premium" });
    expect([premium.status, premium.body.error]).toEqual([402, "plan_required"]);
    expect(await balance(u)).toBe(50);
    expect((await start("video", u, await taskFor(u), { model: "vid-quick" })).status).toBe(202);
    expect(await balance(u)).toBe(38);
    const second = await start("video", u, await taskFor(u), { model: "vid-quick" });
    expect([second.status, second.body.error]).toEqual([402, "trial_video_used"]);
    expect(await balance(u)).toBe(38);
    expect(kie.submits).toHaveLength(1);
  });
});

describe("polling a render", () => {
  it("5. another account's job is a 404 with no provider call; a malformed id is a 404; no session is a 401", async () => {
    mediaEnv({ kie: true, blob: true, models: "all" });
    const kie = kieFake();
    useDeps({ kie });
    const A = await paid(), B = await paid();
    const job = jobOf(await start("image", A, await taskFor(A), { model: "img-balanced" }));
    const r = await poll(B, job.id);
    expect([r.status, r.body.job]).toEqual([404, undefined]);
    expect(kie.statusCalls).toBe(0);
    expect((await poll(A, "../x")).status).toBe(404);
    expect((await poll(A, job.id.toUpperCase())).status).toBe(404);
    expect((await poll(null, job.id)).status).toBe(401);
    expect(kie.statusCalls).toBe(0);
  });

  it("6. a poll that sees the render fail answers the restored balance", async () => {
    mediaEnv({ kie: true, blob: true, models: "all" });
    useDeps({ kie: kieFake(() => ({ state: "failed", reason: "provider_failed" })) });
    const u = await paid();
    const t = await taskFor(u);
    const job = jobOf(await start("image", u, t, { model: "img-balanced" }));
    expect(await balance(u)).toBe(49);
    const r = await poll(u, job.id);
    expect(r.status).toBe(200);
    expect(r.body.job).toMatchObject({ id: job.id, state: "failed", error: "provider_failed" });
    expect(r.body.credits).toBe(50);
    expect(await balance(u)).toBe(50);
    expect((await getTask(u.email, t.id))!.mediaLast?.image).toMatchObject({ error: "provider_failed", refunded: true });
  });

  it("14. a poll runs the opportunistic sweep behind its lock: a stale job of another account is refunded, once per 5 minutes", async () => {
    mediaEnv({ fal: true, kie: true, blob: true, models: "all" });
    const kie = kieFake();
    useDeps({ fal: fakeAdapter("fal"), kie });
    const A = await paid(), B = await paid();
    const a1 = jobOf(await start("image", A, await taskFor(A), { model: "img-balanced" }));
    const b = jobOf(await start("image", B, await taskFor(B)));
    expect(b.state).toBe("done");
    // The starts' own sweeps found nothing due and took the lock: free it, as five minutes would.
    await settle();
    await db.unlock(mk.sweepLock());

    await age(A.email, a1.id, 11 * 60_000);
    expect((await poll(B, b.id)).status).toBe(200);
    await settle();
    expect(await getJob(A.email, a1.id)).toMatchObject({ state: "failed", error: "timeout", refunded: true });
    expect(await balance(A)).toBe(50);
    expect(kie.statusCalls).toBe(1);

    const a2 = jobOf(await start("image", A, await taskFor(A), { model: "img-balanced" }));
    await settle();
    await age(A.email, a2.id, 11 * 60_000);
    await poll(B, b.id);
    await settle();
    expect(kie.statusCalls, "no second sweep within 5 minutes").toBe(1);
    expect((await getJob(A.email, a2.id))!.state).toBe("running");
  });
});

describe("provider callbacks", () => {
  it("8. a hint is checked, throttled and capped, and moves only the job it names, from the provider's own answer", async () => {
    mediaEnv({ kie: true, blob: true, models: "all" });
    const kie = kieFake(() => done());
    const deps = useDeps({ kie });
    expect(await hook("evil", { taskId: "kie123456" }, 1)).toBe(404);
    expect(await hook("fal", { taskId: "kie123456" }, 2)).toBe(404);
    mediaEnv({ blob: true, models: "all" });
    expect(await hook("kie", { taskId: "kie123456" }, 3), "kie not configured").toBe(404);
    mediaEnv({ kie: true, blob: true, models: "all" });

    expect(await hook("kie", { taskId: "kieunknown999" }, 4), "no oracle for an unknown id").toBe(200);
    await settle();
    expect(kie.statusCalls).toBe(0);
    expect(await hook("kie", { taskId: "../../x" }, 5)).toBe(400);
    expect(await hook("kie", { nothing: true }, 6)).toBe(400);
    const notJson = await hookRoute.POST(new Request("https://nashr.test/api/media/hook/kie", { method: "POST", headers: ipHeaders(7), body: "{nope" }), params({ provider: "kie" }));
    expect(notJson.status).toBe(400);

    const A = await paid(), B = await paid();
    const ta = await taskFor(A), tb = await taskFor(B);
    const ja = jobOf(await start("image", A, ta, { model: "img-balanced" }));
    const jb = jobOf(await start("image", B, tb, { model: "img-balanced" }));
    await settle();
    const aId = (await getJob(A.email, ja.id))!.providerTaskId!;
    // The body offers its own result URL; only the provider's answer to our status call is ever copied.
    expect(await hook("kie", { taskId: aId, resultUrls: [EVIL], data: { resultJson: JSON.stringify({ resultUrls: [EVIL] }) } }, 8)).toBe(200);
    await settle();
    expect(await getJob(A.email, ja.id)).toMatchObject({ state: "done", url: deps.stored[0].url });
    expect(deps.stored.map((s) => s.source)).toEqual([RESULT]);
    expect((await getTask(A.email, ta.id))!.imageUrl).toBe(deps.stored[0].url);
    expect((await getJob(B.email, jb.id))!.state, "B's job is untouched").toBe("running");
    expect((await getTask(B.email, tb.id))!.imageUrl).toBeUndefined();
    expect(kie.statusCalls).toBe(1);

    expect(await hook("kie", { taskId: "kie123456", pad: "x".repeat(64 * 1024) }, 9)).toBe(413);
  });

  it("8b. the per-IP limit refuses the 241st hint in a minute from one address, not from another", async () => {
    mediaEnv({ kie: true, blob: true, models: "all" });
    useDeps({ kie: kieFake() });
    // One after another: allow() is a fixed window whose first hit sets the expiry.
    for (let i = 0; i < 240; i++) expect(await hook("kie", { taskId: "kieunknown999" }, 10)).toBe(200);
    expect(await hook("kie", { taskId: "kieunknown999" }, 10)).toBe(429);
    expect(await hook("kie", { taskId: "kieunknown999" }, 11)).toBe(200);
  });

  it("8c. five hints for one job in a row cost one status call", async () => {
    mediaEnv({ kie: true, blob: true, models: "all" });
    const kie = kieFake();
    useDeps({ kie });
    const u = await paid();
    const job = jobOf(await start("image", u, await taskFor(u), { model: "img-balanced" }));
    await settle();
    const id = (await getJob(u.email, job.id))!.providerTaskId!;
    for (let i = 0; i < 5; i++) expect(await hook("kie", { data: { taskId: id } }, 20 + i)).toBe(200);
    await settle();
    expect(kie.statusCalls).toBe(1);
  });

  it("9. with the HMAC key set, kie hints must be signed and fresh", async () => {
    mediaEnv({ kie: true, blob: true, hmac: true, models: "all" });
    const kie = kieFake(() => done());
    useDeps({ kie });
    const u = await paid();
    const job = jobOf(await start("image", u, await taskFor(u), { model: "img-balanced" }));
    await settle();
    const id = (await getJob(u.email, job.id))!.providerTaskId!;
    const sign = (ts: number, key = "test-kie_webhook_hmac_key") => ({ "x-webhook-timestamp": String(ts), "x-webhook-signature": createHmac("sha256", key).update(`${id}.${ts}`).digest("base64") });
    const now = Math.floor(Date.now() / 1000);

    expect(await hook("kie", { taskId: id }, 30), "unsigned").toBe(401);
    expect(await hook("kie", { taskId: id }, 31, sign(now, "another-key")), "wrong key").toBe(401);
    expect(await hook("kie", { taskId: id }, 32, sign(now - 301)), "stale").toBe(401);
    await settle();
    expect(kie.statusCalls).toBe(0);
    expect(await hook("kie", { taskId: id }, 33, sign(now))).toBe(200);
    await settle();
    expect((await getJob(u.email, job.id))!.state).toBe("done");

    mediaEnv({ kie: true, blob: true, models: "all" });
    expect(await hook("kie", { taskId: "kieunknown999" }, 34), "without the key an unsigned hint is a hint").toBe(200);
  });

  it("a Higgsfield hint finds its job by request_id", async () => {
    mediaEnv({ higgsfield: true, blob: true, models: "all" });
    const hf = fakeAdapter("higgsfield", { status: () => ({ state: "done", urls: ["https://cdn.higgsfield.example/out.jpg"] }) });
    useDeps({ higgsfield: hf });
    const u = await paid();
    const job = jobOf(await start("image", u, await taskFor(u), { model: "img-lifestyle" }));
    await settle();
    const id = (await getJob(u.email, job.id))!.providerTaskId!;
    expect(await hook("higgsfield", { request_id: "not-a-uuid" }, 40)).toBe(400);
    expect(await hook("higgsfield", { request_id: id, status: "completed" }, 41)).toBe(200);
    await settle();
    expect((await getJob(u.email, job.id))!.state).toBe("done");
  });
});

describe("the cron sweep", () => {
  it("10. needs the bearer, then fails and refunds a render past its max age", async () => {
    mediaEnv({ kie: true, blob: true, models: "all" });
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const kie = kieFake();
    useDeps({ kie });
    const u = await paid();
    const job = jobOf(await start("image", u, await taskFor(u), { model: "img-balanced" }));
    await settle();
    await age(u.email, job.id, 11 * 60_000);

    const get = (auth?: string) => cronRoute.GET(new Request("https://nashr.test/api/cron/media", { headers: auth ? { authorization: auth } : {} }));
    expect((await get()).status).toBe(401);
    expect((await get("Bearer wrong-secret")).status).toBe(401);
    expect(await balance(u)).toBe(49);
    const res = await get("Bearer test-cron-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, open: 1, failed: 1 });
    expect(await getJob(u.email, job.id)).toMatchObject({ state: "failed", error: "timeout", refunded: true });
    expect(await balance(u)).toBe(50);
  });
});

describe("the chat tool", () => {
  it("11. generate_image renders the default model, or the placeholder with nothing charged", async () => {
    mediaEnv({ fal: true, blob: true });
    const fal = fakeAdapter("fal");
    useDeps({ fal });
    const u = await owner();
    const t = await taskFor(u);
    const actions: string[] = [];
    const fresh = (await getUser(u.email))!;
    expect(await runTool(fresh, "generate_image", { task_id: t.id }, actions)).toMatch(/^Image generated for "Weekend offer" \(fal\).*Credits left: 49\.$/);
    expect(actions).toContain(`image:${t.id}`);
    expect(fal.submits[0].model, "the chat never picks a dearer model (spec A2)").toBe("img-fast");
    const plan = await taskFor(u, { type: "weekly_plan", channel: "internal" });
    expect(await runTool((await getUser(u.email))!, "generate_image", { task_id: plan.id }, [])).toMatch(/^Images are only for these item types: social, ads/);

    mediaEnv({});
    const t2 = await taskFor(u);
    const out = await runTool((await getUser(u.email))!, "generate_image", { task_id: t2.id }, []);
    expect(out).toMatch(/placeholder rather than artwork\. No credit was used\./);
    expect(await balance(u)).toBe(49);
    expect(fal.submits).toHaveLength(1);
  });
});

describe("route ceilings (spec A23)", () => {
  it("15. image, video, poll and hook have 120 s; the cron 300 s", () => {
    expect([imageRoute.maxDuration, videoRoute.maxDuration, mediaRoute.maxDuration, hookRoute.maxDuration, cronRoute.maxDuration]).toEqual([120, 120, 120, 120, 300]);
  });
});
