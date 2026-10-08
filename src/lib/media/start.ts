/**
 * What a render request must pass before the engine may charge for it (spec 4.4 A step 2), shared by the image and
 * video routes and the chat tool, so the three can never disagree on who may spend what. The engine (./jobs) owns the
 * charge, the refund and every state change; this module only validates and maps the outcome to HTTP.
 */
import { sc, trialOver, type User } from "../auth";
import { getTask, updateTask, type Brand, type Task } from "../brand";
import { agentForTask, type AgentId } from "../agents";
import { agentSpendFor } from "../credits";
import { getGov } from "../governance";
import { IMAGE_TYPES, VIDEO_TYPES } from "../tasks";
import {
  DEFAULT_IMAGE_MODEL, TRIAL_VIDEO_MODELS, aspectFor, hasArtwork, isMediaModelId, mediaImageFor, mediaModel,
  type ImageModelId, type MediaKind, type MediaModelId, type VideoModelId,
} from "../media-catalog";
import { modelAvailable, offModels } from "./config";
import { fixedImagePrompt, imagePrompt, videoPrompt } from "./prompts";
import { BUSY_RETRY_S, getJob, publicJob, startMedia } from "./jobs";
import { retryAfter } from "../rate";
import { mediaDeps } from "./registry";
import type { MediaDeps, StartError, StartResult } from "./types";
import { byOf, type By } from "../actor";

/** The default image model with no provider behind it: the old placeholder card, and nothing charged (spec A1, 4.4 G). */
export type ImageOutcome = StartResult | { ok: true; placeholder: true; task: Task; credits: number };
/** `by` and `from`: who started the render and where, for the activity log; without them, the session's login and the app. */
type Opts = { deadline: number; deps?: MediaDeps; by?: By; from?: "app" | "chat" };

const refuse = (status: 400 | 402 | 409, error: StartError): StartResult => ({ ok: false, status, error });
/** A catalogue id of this kind, from request input. `isMediaModelId` is a list test, so "constructor" is refused. */
const ofKind = (v: unknown, kind: MediaKind): v is MediaModelId => isMediaModelId(v) && mediaModel(v).kind === kind;

/**
 * Who a render of `t` is charged to: the agent that owns the item (computed in code, never from the request), the owner's
 * monthly cap for that agent in this brand scope, and what it spent this month as the session read it (a pre-check; the
 * ledger decides under its lock). Read here, so the image and video routes and the chat tool cannot disagree.
 */
async function spendFor(u: User, t: Task): Promise<{ agent: AgentId; cap?: number; spent: number }> {
  const agent = agentForTask(t.type).id;
  const gov = await getGov(sc(u));
  return { agent, cap: gov.agentCaps[agent], spent: agentSpendFor(u, sc(u))[agent] ?? 0 };
}

/**
 * The card shown when the default image model is unavailable: brand name on a coloured card, marked so it never passes
 * for artwork. It never replaces artwork: the owner paid for that image, and Instagram publishes only with it.
 */
async function placeholder(u: User, t: Task, brand: Brand): Promise<ImageOutcome> {
  const card = (base: Task): Task => {
    const next: Task = {
      ...base,
      imageUrl: `https://placehold.co/1024x1024/0f3d3a/f2b33d.png?text=${encodeURIComponent(brand.name.slice(0, 24))}`,
      imagePrompt: fixedImagePrompt(brand, base, DEFAULT_IMAGE_MODEL, aspectFor("image", t.channel)),
      imageProvider: "placeholder",
      // Written, not left to the readers' fallback: that counts any image as one credit, and a placeholder cost nothing.
      mediaCredits: base.mediaCredits ?? 0,
    };
    delete next.imageModel;
    return next;
  };
  // Under the task lock, on the task as stored now: a render of another image style can finish between a plain read and
  // a write, and the artwork it delivered must never end up under a placeholder. A deleted task is not recreated.
  let kept = false;
  const saved = await updateTask(sc(u), t.id, (cur) => {
    if (!hasArtwork(cur)) return card(cur);
    kept = true;
    return null;
  });
  if (kept || (!saved && hasArtwork(t))) return refuse(409, "model_unavailable");
  return { ok: true, placeholder: true, task: saved ?? card(t), credits: u.credits };
}

export async function renderImage(u: User, t: Task, brand: Brand, requested: unknown, opts: Opts): Promise<ImageOutcome> {
  if (trialOver(u)) return refuse(402, "trial_over");
  const asked = requested == null || requested === "" ? DEFAULT_IMAGE_MODEL : requested;
  if (!ofKind(asked, "image")) return refuse(400, "bad_model");
  const model = asked as ImageModelId;
  if (!IMAGE_TYPES.includes(t.type)) return refuse(400, "wrong_type");
  const [off, spend, by] = await Promise.all([offModels(), spendFor(u, t), opts.by ?? byOf(u)]);
  // The placeholder costs nothing, so neither the balance nor the agent's cap stands in its way.
  if (!modelAvailable(model, off)) return model === DEFAULT_IMAGE_MODEL ? placeholder(u, t, brand) : refuse(409, "model_unavailable");
  const m = mediaModel(model);
  const aspect = aspectFor("image", t.channel);
  return startMedia({
    scope: sc(u), email: u.email, lang: u.lang, accountSince: u.createdAt, plan: u.plan, balance: u.credits, ...spend,
    taskId: t.id, model, aspect, imageUrl: mediaImageFor(m, t), deadline: opts.deadline,
    prompt: (ms) => imagePrompt(brand, t, model, aspect, u.email, ms),
    by, from: opts.from ?? "app",
  }, opts.deps ?? mediaDeps());
}

export async function renderVideo(u: User, t: Task, brand: Brand, requested: unknown, opts: Opts): Promise<StartResult> {
  if (trialOver(u)) return refuse(402, "trial_over");
  // No default: a video costs 12 or 24 credits, so the owner names the model every time.
  if (!ofKind(requested, "video")) return refuse(400, "bad_model");
  const model = requested as VideoModelId;
  if (!VIDEO_TYPES.includes(t.type)) return refuse(400, "wrong_type");
  if (u.plan === "trial" && !TRIAL_VIDEO_MODELS.includes(model)) return refuse(402, "plan_required");
  const [off, spend, by] = await Promise.all([offModels(), spendFor(u, t), opts.by ?? byOf(u)]);
  if (!modelAvailable(model, off)) return refuse(409, "model_unavailable");
  const m = mediaModel(model);
  const imageUrl = mediaImageFor(m, t);
  if (m.needsImage && !imageUrl) return refuse(409, "needs_image");
  return startMedia({
    scope: sc(u), email: u.email, lang: u.lang, accountSince: u.createdAt, plan: u.plan, balance: u.credits, ...spend,
    taskId: t.id, model, aspect: "portrait", imageUrl, deadline: opts.deadline,
    prompt: (ms) => videoPrompt(brand, t, model, !!imageUrl, u.email, ms),
    by, from: opts.from ?? "app",
  }, opts.deps ?? mediaDeps());
}

/** What a route's log line may say about an error: a fixed code (store_put_failed, user_lock_timeout), else its name, never a message that could carry a provider body. */
export const errCode = (e: unknown) => (e instanceof Error ? (/^[a-z_]+(:\d+)?$/.test(e.message) ? e.message : e.name) : "error");

type MediaHttp = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

/**
 * The HTTP contract the inbox reads (plan P7): 200 finished, 202 rendering, else the refusal with what it carries. The
 * inbox tells the owner "all credits were returned" for media_failed, so that code goes out only with the balance the
 * refund left; a failure whose refund this request did not make is media_pending ("any credits used come back").
 */
export function mediaResponse(r: ImageOutcome): MediaHttp {
  if ("placeholder" in r) return { status: 200, body: { ok: true, task: r.task, credits: r.credits, provider: "placeholder" } };
  if (r.ok && r.job.state === "done") return { status: 200, body: { ok: true, task: r.task, credits: r.credits, provider: r.job.provider, job: publicJob(r.job) } };
  if (r.ok) return { status: 202, body: { ok: true, job: publicJob(r.job), task: r.task, credits: r.credits } };
  const { status, need, have, credits, job, agent, spent, cap } = r;
  const error = r.error === "media_failed" && credits == null ? "media_pending" : r.error;
  return {
    status,
    // A 429 says when to try again: the refusing bucket's window, else a minute (rule 680).
    ...(status === 429 ? { headers: retryAfter(r.retryAfter ?? BUSY_RETRY_S) } : {}),
    body: {
      ok: false, error, ...(need != null ? { need } : {}), ...(have != null ? { have } : {}), ...(credits != null ? { credits } : {}), ...(job ? { job } : {}),
      // The same body /api/generate answers at an agent's cap, so the app raises the same dialog.
      ...(agent ? { agent, spent, cap } : {}),
    },
  };
}

/**
 * The answer when a start threw. Before the charge that is a store error and nothing was charged. After it the engine
 * throws only once the job is durable and before any refund, which the next poll or a sweep makes. So the inbox follows
 * the job the task points at, like any render in progress; without one it hears media_pending, never that credits
 * were returned.
 */
export async function startThrew(u: User, taskId: string, kind: MediaKind): Promise<MediaHttp> {
  try {
    const id = (await getTask(sc(u), taskId))?.mediaJob?.[kind];
    const job = id ? await getJob(sc(u), id) : null;
    if (job && job.state !== "done" && job.state !== "failed") return { status: 202, body: { ok: true, job: publicJob(job) } };
  } catch {
    // The store is still failing: the inbox refreshes, and the task it reads then points at the job.
  }
  return { status: 502, body: { ok: false, error: "media_pending" } };
}
