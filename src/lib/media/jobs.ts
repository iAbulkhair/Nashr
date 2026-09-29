/**
 * The media job engine: charge, submit, poll, copy, refund, for every provider (spec 4.3 and 4.4).
 *
 * Providers and storage arrive as `MediaDeps` (spec A6), so this module imports no adapter and no Blob code: tests drive
 * every transition with scripted fakes, and ./registry wires the real ones. What every change here must keep:
 * - nothing is charged before the balance pre-check, the flight lock, the limits and the provider throttle have passed,
 *   and every refusal before the job is durable releases the flight lock (spec A24);
 * - a job becomes terminal only under `mjoblock:{id}`, after a re-read, and never changes again;
 * - a refund happens only after winning `mrefund:{id}`, and only to the account that paid (spec A32);
 * - a job reads and writes only under its own `scope`, which the server set when it created the job;
 * - the task is changed only through `updateTask` (src/lib/brand.ts), never by saving a copy read earlier.
 */
import { randomBytes } from "crypto";
import { db, pushCapped } from "../db";
import { charge, monthKey, refund } from "../credits";
import { getUser } from "../auth";
import { IMAGE_COST, getTask, updateTask, type MediaLast, type Task } from "../brand";
import { allow } from "../rate";
import { pmap } from "../parallel";
import { track } from "../track";
import { pushNotif } from "../notifications";
import {
  MEDIA_MAX_AGE_MS, MEDIA_MODELS, hasArtwork, isMediaModelId, mediaModel,
  type ImageModelId, type MediaFailure, type MediaKind, type MediaModelId, type MediaProviderId, type VideoModelId,
} from "../media-catalog";
import { JOB_ID, JOB_TTL_S, PROVIDER_TASK_ID, abortAfter, budget, mk, parseOpenMember } from "./keys";
import { COST_USD, EXPECTED_KIE_CREDITS, KIE_USD_PER_CREDIT, type OffMap } from "./config";
import {
  ProviderError, StoreError,
  type AdvanceOpts, type MediaDeps, type MediaJob, type ProviderErrorCode, type PublicJob, type StartError, type StartInput,
  type StartResult, type StatusResult, type SubmitResult, type SweepReport,
} from "./types";

/** One render per task and kind at a time, a little longer than that kind's max age. */
export const FLIGHT_TTL_S: Record<MediaKind, number> = { image: 15 * 60, video: 35 * 60 };
/** Longer than any route deadline (105 s), so a start request still working is never declared lost. */
export const QUEUED_LOST_MS = 3 * 60_000;
/** Sweeps and Higgsfield admission force-advance open jobs older than this. */
export const STALE_MS = 2 * 60_000;
/** At most one provider status call per job in this many seconds, whoever asks (spec A20, A30). */
export const POLL_GAP_S = 4;
/** A result that could not be copied yet is tried this many times in all, at least this far apart (spec A25). */
export const STORE_TRIES = 3, STORE_RETRY_S = 30;
/** kie allows 20 creates per 10 s for the whole account, which every tenant shares. */
export const KIE_CREATES = { max: 18, windowS: 10 };
export const HF_MAX_OPEN = 2; // Higgsfield's floor for a new account; raise to what the console shows
export const RENDER_LIMITS: Record<MediaKind, { hour: number; day: number }> = { image: { hour: 30, day: 150 }, video: { hour: 6, day: 20 } };
export const TRIAL_VIDEO_TTL_S = 14 * 86400;
/** Spec A22: `failures` defect-class failures of one model within `windowS` switch it off for `offMs`. */
export const BREAKER = { failures: 3, windowS: 3600, offMs: 6 * 3600_000, noBalanceOffMs: 3600_000, overbill: 1.1 };
const SUBMIT_MAX_MS: Record<MediaProviderId, number> = { fal: 45_000, kie: 20_000, higgsfield: 20_000 };
const SUBMIT_MIN_MS = 5_000;
const PROMPT_MAX_MS = 20_000;
const STATUS_MAX_MS = 15_000, STATUS_MIN_MS = 15_000;
/** Do not start a copy with less time than this left; the job keeps resultUrls for the next poll or sweep. */
export const FINALIZE_MIN_MS: Record<MediaKind, number> = { image: 25_000, video: 60_000 };
const JOB_LOCK_S = 120, SWEEP_LOCK_S = 300, HF_CLEAN_LOCK_S = 60;
/** A sweep starts no advance with less than a status call's worth of time left; the opportunistic one needs more to start at all. */
const SWEEP_MIN_MS = 20_000, MAYBE_SWEEP_MIN_MS = 30_000;
const PROVIDERS: readonly MediaProviderId[] = ["fal", "kie", "higgsfield"];

/** What a transition leaves behind: the job, the task as written (null when it is gone), the balance after a refund. */
type Outcome = { job: MediaJob; task?: Task | null; credits?: number };
/** `cause` is the adapter's error code on a failed submit and `providerCredits` what kie billed: both feed the breaker and the spend. */
type Ctx = AdvanceOpts & { cause?: ProviderErrorCode; providerCredits?: number };

const clockOf = (deps: MediaDeps) => () => deps.now?.() ?? Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const ageOf = (j: MediaJob, now: number) => now - Date.parse(j.createdAt);
const terminal = (j: MediaJob) => j.state === "done" || j.state === "failed";
const oldestFirst = (a: MediaJob, b: MediaJob) => Date.parse(a.createdAt) - Date.parse(b.createdAt);
/** Only a webhook or a sweep ends a job without the owner watching, so only those tell them (spec A28). */
const unattended = (ctx: AdvanceOpts) => ctx.via === "hook" || ctx.via === "sweep";
/** What a log line may say about an error: our fixed codes (provider_busy:429, store_put_failed, user_lock_timeout), else its name. */
const codeOf = (e: unknown) => (e instanceof Error ? (/^[a-z_]+(:\d+)?$/.test(e.message) ? e.message : e.name) : "error");
/** Side effects of a transition (set members, flight lock, counters, notices) never undo the transition that was saved. */
const quiet = (p: Promise<unknown> | null, what: string) => p && p.catch((e) => console.error(what, codeOf(e)));
/** What a render cost us: kie's creditsConsumed when it reported one, else the list price. */
const costOf = (model: MediaModelId, providerCredits?: number) => (providerCredits != null ? providerCredits * KIE_USD_PER_CREDIT : COST_USD[model]);
const https = (urls: string[]) => urls.filter((u) => typeof u === "string" && u.startsWith("https://"));
/**
 * A copy that failed waits STORE_RETRY_S before the next try, whoever asks (spec A25). The `mpoll` lock holds polls back
 * for that long, but a sweep's `force` skips it, so the engine checks the gap itself.
 */
const copyWaits = (j: MediaJob, now: number) => (j.storeTries ?? 0) > 0 && now - Date.parse(j.updatedAt) < STORE_RETRY_S * 1000;

/** A copy of a per-kind task field without `kind`, or undefined when nothing is left. */
function without<V>(o: Partial<Record<MediaKind, V>> | undefined, kind: MediaKind): Partial<Record<MediaKind, V>> | undefined {
  const rest = { ...o };
  delete rest[kind];
  return Object.keys(rest).length ? rest : undefined;
}

export async function getJob(scope: string, jobId: string): Promise<MediaJob | null> {
  return typeof jobId === "string" && JOB_ID.test(jobId) ? db.get<MediaJob>(mk.job(scope, jobId)) : null;
}
const saveJob = (j: MediaJob) => db.set(mk.job(j.scope, j.id), j, JOB_TTL_S);
/** The stored job, keeping the prompt that a start request holds in memory until its first save after the submit. */
async function reread(job: MediaJob): Promise<MediaJob | null> {
  const cur = await getJob(job.scope, job.id);
  return cur && { ...cur, prompt: cur.prompt || job.prompt };
}

export const publicJob = (j: MediaJob): PublicJob => ({
  id: j.id, kind: j.kind, model: j.model, credits: j.credits, createdAt: j.createdAt,
  state: j.state === "queued" ? "running" : j.state,
  ...(j.error ? { error: j.error } : {}),
});

/**
 * Start one render (spec A24, 4.4 A). Nothing is charged before step 8; every refusal before the job is durable releases
 * the flight lock (and the trial marker this request took) in the `finally`. After the charge, the only answers are a
 * durable job or an immediate refund, and when that refund fails, a job written again for the next poll or sweep to refund.
 */
export async function startMedia(input: StartInput, deps: MediaDeps): Promise<StartResult> {
  const now = clockOf(deps);
  if (!isMediaModelId(input.model)) return { ok: false, status: 400, error: "bad_model" };
  const m = mediaModel(input.model);
  const { scope, email, taskId } = input;
  // 1-2. Refusals that cost nothing and move no counter.
  if (m.provider !== "fal" && !deps.blobReady()) return { ok: false, status: 409, error: "model_unavailable" };
  if (input.balance < m.credits) return { ok: false, status: 402, error: "no_credits", need: m.credits, have: input.balance };
  // 3. One render per task and kind.
  const flight = mk.flight(scope, taskId, m.kind);
  if (!(await db.lock(flight, FLIGHT_TTL_S[m.kind]))) return inProgress(scope, taskId, m.kind);

  let keepFlight = false, trialVideo = false;
  let job: MediaJob, task: Task | null = null, credits: number;
  try {
    // 5. Account limits, counted only for requests that got this far.
    const lim = RENDER_LIMITS[m.kind];
    const [hour, day] = await Promise.all([allow(`media:${m.kind}:h:${email}`, lim.hour, 3600), allow(`media:${m.kind}:d:${email}`, lim.day, 86400)]);
    if (!hour || !day) return { ok: false, status: 429, error: "too_many" };
    // 6. A trial keeps one video (spec A29); a refund of that video releases the marker again.
    if (input.plan === "trial" && m.kind === "video") {
      if (!(await db.lock(mk.trialVideo(email), TRIAL_VIDEO_TTL_S))) return { ok: false, status: 402, error: "trial_video_used" };
      trialVideo = true;
    }
    // 7. Provider throttles, shared by every tenant.
    if (m.provider === "kie" && !(await allow("kie:create", KIE_CREATES.max, KIE_CREATES.windowS))) return { ok: false, status: 429, error: "busy" };
    if (m.provider === "higgsfield") {
      const refused = await hfAdmission(email, m.kind, deps, input.deadline);
      if (refused) return { ok: false, status: 429, error: refused };
    }
    // 8. The charge. A throw (the ledger lock timed out) charged nothing.
    let paid: Awaited<ReturnType<typeof charge>>;
    try {
      paid = await charge(email, m.credits);
    } catch (e) {
      console.error("media charge failed", codeOf(e));
      return { ok: false, status: 429, error: "busy" };
    }
    if (!paid.ok) return { ok: false, status: 402, error: "no_credits", need: m.credits, have: paid.credits };
    credits = paid.credits;

    // 9. Round A: the job, its open-set member and task.mediaJob together. From here a start request killed by the
    // platform is recovered as submit_lost by the next poll or sweep, because the task points at the job. The task write
    // re-reads under the task lock, so a render of the other kind or an approval landing now keeps its fields.
    const at = iso(now());
    job = {
      id: randomBytes(16).toString("hex"), scope, email, accountSince: input.accountSince, lang: input.lang, taskId,
      kind: m.kind, model: m.id, provider: m.provider, credits: m.credits, prompt: "",
      ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
      state: "queued", createdAt: at, updatedAt: at,
      ...(trialVideo ? { trialVideo: true } : {}),
    };
    const kind = m.kind, prior: { last?: MediaLast } = {};
    // All three settle before anything is decided, so a cleanup never races a task write still in flight.
    const round = await Promise.allSettled([
      saveJob(job),
      db.sadd(mk.open(m.provider), mk.openMember(scope, job.id)),
      updateTask(scope, taskId, (t) => {
        prior.last = t.mediaLast?.[kind];
        return { ...t, mediaJob: { ...t.mediaJob, [kind]: job.id }, mediaLast: without(t.mediaLast, kind) };
      }),
    ]);
    const lost = round.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (lost) {
      console.error("media job save failed", codeOf(lost.reason));
      const back = await refundUnsaved(job, prior.last);
      // Not refunded: the job is still owed a refund and stays this task's render until the next poll or sweep ends it.
      if (back.open) keepFlight = true;
      return { ok: false, status: 502, error: "media_failed", ...(back.credits != null ? { credits: back.credits } : {}) };
    }
    task = round[2].status === "fulfilled" ? round[2].value : null;
    keepFlight = true;
  } finally {
    if (!keepFlight) await Promise.all([db.unlock(flight), trialVideo ? db.del(mk.trialVideo(email)) : null]);
  }

  // 11. A fresh id, so always won. Held until this request returns: polls and sweeps leave the job to it meanwhile.
  await db.lock(mk.jobLock(job.id), JOB_LOCK_S);
  try {
    return await submitLocked(job, task, credits, input, deps);
  } finally {
    await db.unlock(mk.jobLock(job.id)).catch(() => {});
  }
}

/** 409 for a second render of one kind on one task, with the job still running when the task points at one. */
async function inProgress(scope: string, taskId: string, kind: MediaKind): Promise<StartResult> {
  const id = (await getTask(scope, taskId))?.mediaJob?.[kind];
  const running = id ? await getJob(scope, id) : null;
  return { ok: false, status: 409, error: "in_progress", ...(running && !terminal(running) ? { job: publicJob(running) } : {}) };
}

/**
 * The charge went through but the job never became durable. Refund at once under the same exactly-once marker a fail
 * uses, so a queued record that was written after all ends submit_lost without a second refund; then the open-set member
 * and the task pointer are removed, best effort, so nothing points at a job that may not exist.
 *
 * When the refund itself fails the charge stands, and only the job can still return it: the queued record, its member
 * and the task pointer are written again (best effort) and `open` tells the start to keep the flight, so the next poll
 * or sweep ends the job submit_lost with the refund, QUEUED_LOST_MS on.
 */
async function refundUnsaved(job: MediaJob, last: MediaLast | undefined): Promise<{ credits?: number; open: boolean }> {
  const { scope, taskId, kind } = job;
  try {
    const { credits } = await refundOnce(job);
    await Promise.all([
      quiet(db.srem(mk.open(job.provider), mk.openMember(scope, job.id)), "media cleanup failed"),
      quiet(updateTask(scope, taskId, (t) => (t.mediaJob?.[kind] === job.id
        ? { ...t, mediaJob: without(t.mediaJob, kind), mediaLast: last ? { ...t.mediaLast, [kind]: last } : t.mediaLast }
        : null)), "media cleanup failed"),
    ]);
    return { credits, open: false };
  } catch (e) {
    console.error("media refund failed", codeOf(e));
    await Promise.all([
      quiet(saveJob(job), "media job save failed"),
      quiet(db.sadd(mk.open(job.provider), mk.openMember(scope, job.id)), "media job save failed"),
      quiet(updateTask(scope, taskId, (t) => ({ ...t, mediaJob: { ...t.mediaJob, [kind]: job.id }, mediaLast: without(t.mediaLast, kind) })), "media job save failed"),
    ]);
    return { open: true };
  }
}

/** Steps 12-16 of a start, under the job lock: prompt, one submit, then finish (fal) or hand over to polling. */
async function submitLocked(job: MediaJob, task: Task | null, credits: number, input: StartInput, deps: MediaDeps): Promise<StartResult> {
  const now = clockOf(deps);
  const ctx: Ctx = { deadline: input.deadline, via: "start" };
  const refuse = async (reason: MediaFailure, status: 422 | 429 | 502, error: StartError, cause?: ProviderErrorCode): Promise<StartResult> => {
    const r = await failLocked(job, reason, deps, { ...ctx, cause });
    return { ok: false, status, error, ...(r.credits != null ? { credits: r.credits } : {}) };
  };

  try {
    job.prompt = await input.prompt(budget(PROMPT_MAX_MS, input.deadline - SUBMIT_MIN_MS, now()));
  } catch (e) {
    console.error("media prompt failed", codeOf(e));
    return refuse("submit_failed", 502, "media_failed");
  }
  // fal answers with the image in the same request, so its submit leaves room for the copy (spec A23).
  const ms = budget(SUBMIT_MAX_MS[job.provider], input.deadline - (job.provider === "fal" ? FINALIZE_MIN_MS.image : 0), now());
  if (ms < SUBMIT_MIN_MS) return refuse("submit_failed", 502, "media_failed");
  let res: SubmitResult;
  try {
    // Never retried: no provider takes an idempotency key, so a second POST could render and bill twice.
    res = await deps.adapter(job.provider).submit({ model: job.model, prompt: job.prompt, aspect: input.aspect, ...(job.imageUrl ? { imageUrl: job.imageUrl } : {}) }, abortAfter(ms));
  } catch (e) {
    const cause = e instanceof ProviderError ? e.code : undefined;
    console.error("media submit failed", job.provider, codeOf(e));
    return cause === "busy" ? refuse("submit_failed", 429, "busy", cause) : refuse("submit_failed", 502, "media_failed", cause);
  }

  if (res.state === "failed") return refuse("nsfw", 422, "nsfw");
  if (res.state === "done") {
    const r = await finalizeLocked(job, res.urls, undefined, deps, ctx);
    if (r.job.state === "failed") return { ok: false, status: 502, error: "media_failed", ...(r.credits != null ? { credits: r.credits } : {}) };
    return { ok: true, job: r.job, task: r.task !== undefined ? r.task : task, credits };
  }
  const id = res.providerTaskId;
  if (typeof id !== "string" || !PROVIDER_TASK_ID[job.provider].test(id)) return refuse("submit_failed", 502, "media_failed", "bad_response");
  const running: MediaJob = { ...job, state: "running", providerTaskId: id, updatedAt: iso(now()) };
  // Round C. If it throws, the job stays queued and ends submit_lost, refunded, three minutes later. The member is added
  // again because a sweep that read the set between Round A's two writes would have dropped it as gone.
  await Promise.all([
    saveJob(running),
    db.set(mk.ref(job.provider, id), { scope: job.scope, jobId: job.id }, JOB_TTL_S),
    db.sadd(mk.open(job.provider), mk.openMember(job.scope, job.id)),
  ]);
  return { ok: true, job: running, task, credits };
}

/**
 * Higgsfield admission (spec A10). Every tenant shares one Higgsfield account, so only live jobs count: not terminal,
 * inside their max age, no result waiting to be copied. At the cap, jobs that are probably over are advanced first
 * (status calls only, behind `mhfclean`). Not atomic (spec R13): Higgsfield's own concurrency refusal is the backstop.
 */
async function hfAdmission(email: string, kind: MediaKind, deps: MediaDeps, deadline: number): Promise<"one_open" | "busy" | null> {
  const now = clockOf(deps);
  const members = await db.smembers(mk.open("higgsfield"));
  if (!members.length) return null;
  let { jobs } = await loadOpen(members.map((member) => ({ provider: "higgsfield" as const, member })), 4);
  const live = (j: MediaJob) => !terminal(j) && ageOf(j, now()) <= MEDIA_MAX_AGE_MS[j.kind] && !j.resultUrls?.length;
  // At the cap counting every open job, not only live ones: jobs past their max age must be failed and refunded, and
  // the member removed, or they would sit in the set until the daily cron.
  if (jobs.length >= HF_MAX_OPEN && (await db.lock(mk.hfClean(), HF_CLEAN_LOCK_S))) {
    const stale = jobs.filter((j) => !live(j) || ageOf(j, now()) > STALE_MS).sort(oldestFirst).slice(0, 4);
    // A 20 s deadline leaves no room for a copy: a result waiting for one stays in resultUrls.
    const moved = await pmap(stale, (j) => advance(j, deps, { force: true, deadline: Math.min(deadline, now() + 20_000), via: "sweep" }).catch((e) => {
      console.error("media admission advance failed", codeOf(e));
      return j;
    }), 2);
    const byId = new Map(moved.map((j) => [j.id, j]));
    jobs = jobs.map((j) => byId.get(j.id) ?? j);
  }
  const open = jobs.filter(live);
  if (open.some((j) => j.email === email)) return "one_open";
  if (open.length >= HF_MAX_OPEN) return "busy";
  // Keep a slot for images: videos take at most HF_MAX_OPEN - 1.
  if (kind === "video" && open.filter((j) => j.kind === "video").length >= HF_MAX_OPEN - 1) return "busy";
  return null;
}

type OpenRef = { provider: MediaProviderId; member: string };
/** The open jobs behind these set members. Unparseable, gone and terminal members are removed in one round. */
async function loadOpen(refs: OpenRef[], limit: number): Promise<{ jobs: MediaJob[]; dropped: number }> {
  const rows = await pmap(refs, (r) => {
    const p = parseOpenMember(r.member);
    return p ? getJob(p.scope, p.jobId) : Promise.resolve(null);
  }, limit);
  const gone = refs.filter((_, i) => !rows[i] || terminal(rows[i]!));
  await Promise.all(gone.map((r) => db.srem(mk.open(r.provider), r.member)));
  return { jobs: rows.filter((j): j is MediaJob => !!j && !terminal(j)), dropped: gone.length };
}

/**
 * Move one job forward (spec 4.4 E): a poll, a webhook hint or a sweep. A provider status call needs the 4 s `mpoll`
 * throttle (skipped only with `force`) and the job lock, which is held through finalize or fail, so two tabs, webhooks
 * and sweeps cannot multiply provider calls and a job being copied gets none (spec A20).
 */
export async function advance(job: MediaJob, deps: MediaDeps, opts: AdvanceOpts): Promise<MediaJob> {
  if (terminal(job)) return job;
  const now = clockOf(deps);
  const queued = job.state === "queued";
  // A queued job belongs to its start request until QUEUED_LOST_MS. After that, with the job lock free, it was lost.
  if (queued && ageOf(job, now()) <= QUEUED_LOST_MS) return job;
  if (!queued && !opts.force && !(await db.lock(mk.poll(job.id), POLL_GAP_S))) return job;
  if (!(await db.lock(mk.jobLock(job.id), JOB_LOCK_S))) return job;
  try {
    const cur = await getJob(job.scope, job.id);
    if (!cur || terminal(cur)) return cur ?? job;
    if (cur.state === "queued") return ageOf(cur, now()) > QUEUED_LOST_MS ? (await failLocked(cur, "submit_lost", deps, opts)).job : cur;
    // The caller saw it queued and so took no poll slot: a status call waits for a caller that did.
    if (queued && !opts.force) return cur;
    if (cur.resultUrls?.length) return copyWaits(cur, now()) ? cur : (await finalizeLocked(cur, cur.resultUrls, cur.providerCredits, deps, opts)).job;
    return await checkStatus(cur, deps, opts);
  } finally {
    await db.unlock(mk.jobLock(job.id)).catch(() => {});
  }
}

/** The one status call of an advance, under the job lock. */
async function checkStatus(cur: MediaJob, deps: MediaDeps, ctx: AdvanceOpts): Promise<MediaJob> {
  const now = clockOf(deps);
  const late = () => ageOf(cur, now()) > MEDIA_MAX_AGE_MS[cur.kind];
  const ref = cur.providerTaskId ? { providerTaskId: cur.providerTaskId, model: cur.model } : null;
  const timeout = async () => {
    try {
      if (ref) await deps.adapter(cur.provider).cancel?.(ref);
    } catch {
      // Best effort: Higgsfield cancels only while queued, and kie has no cancel.
    }
    return (await failLocked(cur, "timeout", deps, ctx)).job;
  };
  if (!ref) return late() ? timeout() : cur;
  const ms = budget(STATUS_MAX_MS, ctx.deadline, now());
  if (ms < STATUS_MIN_MS) return cur;
  let st: StatusResult;
  try {
    st = await deps.adapter(cur.provider).status(ref, abortAfter(ms));
  } catch (e) {
    console.error("media status failed", cur.provider, codeOf(e));
    return late() ? timeout() : cur;
  }
  if (st.state === "done") return (await finalizeLocked(cur, st.urls, st.providerCredits, deps, ctx)).job;
  if (st.state === "failed") return (await failLocked(cur, st.reason, deps, ctx)).job;
  return late() ? timeout() : cur;
}

/** How many finished jobs a task remembers in `mediaApplied`: more than can finish for one task between two tries of one finalize. */
const APPLIED_KEEP = 8;
/**
 * The task after a render of `j` finished: the credits always (they were kept), the media only while the task still
 * waits for this job. Null when the task already took this job: a finalize retried after a failed write counts it once.
 */
function withResult(t: Task, j: MediaJob, url: string): Task | null {
  if (t.mediaApplied?.includes(j.id)) return null;
  const next: Task = { ...t, mediaCredits: (t.mediaCredits ?? (hasArtwork(t) ? IMAGE_COST : 0)) + j.credits, mediaApplied: [...(t.mediaApplied ?? []), j.id].slice(-APPLIED_KEEP) };
  if (t.mediaJob?.[j.kind] !== j.id) return next;
  next.mediaJob = without(t.mediaJob, j.kind);
  if (j.kind === "image") return { ...next, imageUrl: url, imagePrompt: j.prompt, imageProvider: j.provider, imageModel: j.model as ImageModelId };
  return { ...next, videoUrl: url, videoPrompt: j.prompt, ...(j.provider !== "fal" ? { videoProvider: j.provider } : {}), videoModel: j.model as VideoModelId };
}

/** A result is known: copy it to our store and deliver it, or keep it for a later try. The caller holds the job lock. */
async function finalizeLocked(job: MediaJob, urls: string[], providerCredits: number | undefined, deps: MediaDeps, ctx: AdvanceOpts): Promise<Outcome> {
  const now = clockOf(deps);
  const cur = await reread(job);
  if (!cur || terminal(cur)) return { job: cur ?? job };
  // A fail refunded this job (or is refunding it, or found nothing owed) and then could not save: a refunded render is
  // never delivered (spec 4.3). failLocked finishes that fail, or throws while its claim stands.
  if (await db.get(mk.refundOnce(cur.id))) return failLocked(cur, cur.error ?? "provider_failed", deps, ctx);
  const results = https(urls);
  if (!results.length) return failLocked(cur, "provider_failed", deps, ctx);
  const pc = typeof providerCredits === "number" && Number.isFinite(providerCredits) ? providerCredits : undefined;
  const credited = pc != null ? { providerCredits: pc } : {};

  if (budget(Infinity, ctx.deadline, now()) < FINALIZE_MIN_MS[cur.kind]) {
    const next: MediaJob = { ...cur, state: "running", resultUrls: results, ...credited, updatedAt: iso(now()) };
    if (!cur.resultUrls?.length) await Promise.all([saveJob(next), db.sadd(mk.open(cur.provider), mk.openMember(cur.scope, cur.id))]);
    return { job: next };
  }

  let url = results[0];
  try {
    if (deps.blobReady()) url = (await deps.store(results[0], cur.kind, ctx.deadline)).url;
    else if (cur.provider !== "fal") throw new StoreError("no_blob");
  } catch (e) {
    console.error("media store failed", cur.model, codeOf(e));
    // fal keeps its own URL, exactly as before the Blob store existed (spec A25). kie and Higgsfield delete results
    // after 1 to 14 days, so theirs must be copied: retry from resultUrls without another status call.
    if (cur.provider !== "fal") {
      const tries = (cur.storeTries ?? 0) + 1;
      if (tries >= STORE_TRIES || ageOf(cur, now()) > MEDIA_MAX_AGE_MS[cur.kind]) return failLocked(cur, "store_failed", deps, { ...ctx, providerCredits: pc });
      const next: MediaJob = { ...cur, state: "running", resultUrls: results, storeTries: tries, ...credited, updatedAt: iso(now()) };
      await saveJob(next);
      // The next try waits STORE_RETRY_S. Unlock then lock, not a plain set: the memory store's lock keeps its own
      // expiry in the value (src/lib/db.ts), so a set would not hold it there.
      await db.unlock(mk.poll(cur.id));
      await db.lock(mk.poll(cur.id), STORE_RETRY_S);
      return { job: next };
    }
  }

  const costUsd = costOf(cur.model, pc);
  const expected = EXPECTED_KIE_CREDITS[cur.model];
  const overbilled = pc != null && expected != null && pc > expected * BREAKER.overbill;
  // The task first, then the job: once a job is done nothing advances it again, so a result the task never received
  // would be paid for and never shown. A failed task write leaves the job running with its result for the next poll or
  // sweep, and withResult skips a job the task already took, so that retry never counts the render twice.
  let task: Task | null;
  try {
    task = await updateTask(cur.scope, cur.taskId, (t) => withResult(t, cur, url));
  } catch (e) {
    await quiet(saveJob({ ...cur, state: "running", resultUrls: results, ...credited, updatedAt: iso(now()) }), "media job save failed");
    throw e;
  }
  const at = iso(now());
  const done: MediaJob = { ...cur, state: "done", url, costUsd, ...credited, resultUrls: undefined, finishedAt: at, updatedAt: at };
  // One account check for the analytics and the notice: a render that finishes after its account was deleted rebuilds
  // none of the per-account records wipeAccount removed, and tells nobody (spec A32).
  const own = cur.kind === "image" || unattended(ctx) ? sameAccount(cur) : null;
  await Promise.all([
    saveJob(done),
    quiet(db.srem(mk.open(cur.provider), mk.openMember(cur.scope, cur.id)), "media open-set remove failed"),
    quiet(releaseFlight(done, now()), "media flight release failed"),
    recordOutcome(done, ctx),
    own && cur.kind === "image" ? quiet(own.then((ok) => (ok ? track(cur.email, "image") : undefined)), "media track failed") : null,
    overbilled ? quiet(setOff(cur.model, "overbilled", BREAKER.offMs), "media breaker failed") : null,
    own && unattended(ctx) ? quiet(notifyOwner(done, task, own), "media notice failed") : null,
  ]);
  return { job: done, task };
}

/** How long a refund claim stands before a later pass may take it over: far past the ledger lock's worst wait (3 s, then its 10 s TTL). */
const REFUND_CLAIM_S = 60;

/** Whether the account that paid for `j` still exists as that account: never after a wipe, never an address registered again since (spec A32). */
async function sameAccount(j: MediaJob): Promise<boolean> {
  const acct = await getUser(j.email);
  return !!acct && acct.createdAt === j.accountSince;
}

/**
 * Refund `j` exactly once (spec 4.3, A32). `mrefund:{id}` records how far that got: a claim (the lock value) taken
 * before the ledger call and standing for REFUND_CLAIM_S, then "done" once refund() has returned, or "none" when the
 * account that paid is gone. So `refunded` is true only after a refund that happened: a pass that died holding the claim
 * delays the refund until the claim expires instead of losing it, and a later pass then takes the claim and refunds.
 * Throws `refund_pending` while another pass's claim stands, and rethrows a ledger error after releasing the claim;
 * either way the caller leaves the job open for the next poll or sweep.
 */
async function refundOnce(j: MediaJob): Promise<{ refunded: boolean; credits?: number }> {
  const marker = mk.refundOnce(j.id);
  const state = await db.get<unknown>(marker);
  if (state === "done") return { refunded: true };
  if (state === "none") return { refunded: false };
  if (!(await db.lock(marker, REFUND_CLAIM_S))) throw new Error("refund_pending");
  let credits: number | undefined;
  try {
    if (await sameAccount(j)) credits = await refund(j.email, j.credits);
  } catch (e) {
    // The account was wiped between the check and the ledger call: nothing is owed.
    if (!(e instanceof Error && e.message === "user_not_found")) {
      await quiet(db.unlock(marker), "media refund release failed");
      throw e;
    }
  }
  const refunded = credits !== undefined;
  // If this write fails the claim expires and the job record, saved next with `refunded`, is what stops a second refund.
  await quiet(db.set(marker, refunded ? "done" : "none", JOB_TTL_S), "media refund marker failed");
  return { refunded, credits };
}

/**
 * End a job without a result and refund it exactly once (refundOnce). The caller holds the job lock. A refund that is
 * pending elsewhere or failed throws before anything is written, and a failed task write throws before the job is
 * saved: either way the job stays open, and the next poll or sweep finds any refund already made recorded in the marker.
 */
async function failLocked(job: MediaJob, reason: MediaFailure, deps: MediaDeps, ctx: Ctx): Promise<Outcome> {
  const now = clockOf(deps);
  const cur = await reread(job);
  if (!cur || terminal(cur)) return { job: cur ?? job };
  const { refunded, credits } = await refundOnce(cur);

  const pc = ctx.providerCredits ?? cur.providerCredits;
  const at = iso(now());
  const failed: MediaJob = {
    ...cur, state: "failed", error: reason, refunded,
    ...(pc != null ? { providerCredits: pc } : {}),
    // The provider billed us for a result we could not keep (spec 4.9).
    ...(reason === "store_failed" ? { costUsd: costOf(cur.model, pc) } : {}),
    resultUrls: undefined, finishedAt: at, updatedAt: at,
  };
  const last: MediaLast = { error: reason, credits: cur.credits, refunded, at };
  // Only while the task still points at this job, applied to the task as stored now.
  const task = await updateTask(cur.scope, cur.taskId, (t) => (t.mediaJob?.[cur.kind] === cur.id
    ? { ...t, mediaJob: without(t.mediaJob, cur.kind), mediaLast: { ...t.mediaLast, [cur.kind]: last } }
    : null));
  await Promise.all([
    saveJob(failed),
    quiet(db.srem(mk.open(cur.provider), mk.openMember(cur.scope, cur.id)), "media open-set remove failed"),
    quiet(releaseFlight(failed, now()), "media flight release failed"),
    recordOutcome(failed, ctx),
    cur.trialVideo && refunded ? quiet(db.del(mk.trialVideo(cur.email)), "media trial release failed") : null,
    unattended(ctx) && refunded ? quiet(notifyOwner(failed, task), "media notice failed") : null,
  ]);
  return { job: failed, task, credits };
}

/** The flight lock DEL is unconditional (docs/system/flows.md), so a job older than the lock must not free a newer job's hold. */
const releaseFlight = (j: MediaJob, now: number) =>
  ageOf(j, now) < FLIGHT_TTL_S[j.kind] * 1000 ? db.unlock(mk.flight(j.scope, j.taskId, j.kind)) : null;

/**
 * Count a terminal job for the founder console (spec 4.9) and feed the breaker. Every amount is an integer: Upstash
 * INCRBY refuses 175000.00000000003 while the memory store accepts it (spec A31). Never throws.
 */
async function recordOutcome(j: MediaJob, ctx: Ctx): Promise<void> {
  try {
    const month = mk.spend(monthKey()), p = `${month}:m:${j.model}`;
    const pc = j.providerCredits;
    await Promise.all([
      db.incrby(`${p}:${j.state === "done" ? "jobs" : "failed"}`, 1),
      j.state === "done" ? db.incrby(`${p}:credits`, Math.round(j.credits)) : null,
      // Set on done jobs and on store_failed ones: the provider billed us both times. A timeout is not counted, we cannot know.
      j.costUsd != null ? db.incrby(`${p}:usd_micro`, Math.round(j.costUsd * 1e6)) : null,
      pc != null ? db.incrby(`${month}:kie_centicredits`, Math.round(pc * 100)) : null,
      // No email, scope or prompt: the console shows these to the founder, and the list outlives any account.
      pushCapped(mk.recent(), JSON.stringify({ id: j.id, model: j.model, state: j.state, error: j.error, providerCredits: pc, costUsd: j.costUsd, at: j.finishedAt }), 50),
      trip(j, ctx.cause),
    ]);
  } catch (e) {
    console.error("media outcome failed", codeOf(e));
  }
}

/** Spec A22: switch a model, or a provider's models, off before every click becomes "provider bills us, owner refunded". */
async function trip(j: MediaJob, cause?: ProviderErrorCode): Promise<void> {
  if (j.state !== "failed" || !j.error) return;
  if (cause === "no_balance") return setOff(MEDIA_MODELS.filter((m) => m.provider === j.provider).map((m) => m.id), "no_balance", BREAKER.noBalanceOffMs);
  const defect = j.error === "store_failed" || j.error === "timeout" || (j.error === "submit_failed" && (cause === "rejected" || cause === "bad_response"));
  // allow() admits `max` hits per window, so the failure that makes it `failures` is the first one refused.
  if (defect && !(await allow(`mfail:${j.model}`, BREAKER.failures - 1, BREAKER.windowS))) await setOff(j.model, j.error, BREAKER.offMs);
}

/** Switch models off until now + ms (spec A22). A write that loses the lock is dropped: the next failure tries again. */
export async function setOff(models: MediaModelId | readonly MediaModelId[], reason: string, ms: number): Promise<void> {
  if (!(await db.lock(mk.offLock(), 5))) return;
  try {
    const now = Date.now(), until = now + ms;
    const all = (await db.get<OffMap>(mk.off())) ?? {};
    const next: OffMap = Object.fromEntries(Object.entries(all).filter(([, v]) => v && v.until > now));
    // A longer switch-off already in place is kept.
    for (const id of typeof models === "string" ? [models] : models) if (!((next[id]?.until ?? 0) > until)) next[id] = { until, reason };
    await db.set(mk.off(), next);
  } finally {
    await db.unlock(mk.offLock());
  }
}

/** Tell the owner a job ended while nobody was watching (spec A28), in the language stored on the job. */
async function notifyOwner(j: MediaJob, t: Task | null, own: Promise<boolean> = sameAccount(j)): Promise<void> {
  // Never after a wipe or to an address registered again: pushNotif would recreate notifs:{email} (spec A32).
  if (!(await own) || !t) return;
  const ar = j.lang === "ar", video = j.kind === "video", title = t.title.slice(0, 60);
  let n: { title: string; body: string };
  if (j.state === "done") {
    n = ar
      ? { title: video ? `الفيديو جاهز: ${title}` : `الصورة جاهزة: ${title}`, body: "يظهر في صندوق الموافقة." }
      : { title: `Your ${video ? "video" : "image"} is ready: ${title}`, body: "It's in your inbox." };
  } else if (j.refunded) {
    n = ar
      ? { title: video ? `لم يكتمل الفيديو لـ«${title}»` : `لم تكتمل الصورة لـ«${title}»`, body: `أُعيدت ${j.credits} كريدت.` }
      : { title: `The ${video ? "video" : "image"} for “${title}” did not finish`, body: j.credits === 1 ? "1 credit was returned." : `${j.credits} credits were returned.` };
  } else return;
  await pushNotif(j.email, { kind: "info", ...n, href: `/${j.lang}/app` });
}

/**
 * The job a webhook hint names, or null. The provider task id is format-checked before it becomes a key, and the
 * workspace comes from the stored pointer, never from the request; the job must agree on provider and task id.
 */
export async function jobForHook(provider: MediaProviderId, providerTaskId: string): Promise<MediaJob | null> {
  const format = PROVIDERS.includes(provider) ? PROVIDER_TASK_ID[provider] : null;
  if (!format || typeof providerTaskId !== "string" || !format.test(providerTaskId)) return null;
  const ref = await db.get<{ scope?: unknown; jobId?: unknown }>(mk.ref(provider, providerTaskId));
  if (!ref || typeof ref.scope !== "string" || typeof ref.jobId !== "string") return null;
  const job = await getJob(ref.scope, ref.jobId);
  return job && job.provider === provider && job.providerTaskId === providerTaskId ? job : null;
}

/**
 * Collect open jobs (spec 4.4 F): drop members that are gone or terminal, then force-advance jobs older than STALE_MS
 * or holding a result to copy, oldest first. Errors are per job: one bad job never stops the rest.
 */
export async function sweepMedia(deps: MediaDeps, opts: { deadline: number; limit?: number }): Promise<SweepReport> {
  const now = clockOf(deps);
  const sets = await Promise.all(PROVIDERS.map((p) => db.smembers(mk.open(p))));
  const { jobs, dropped } = await loadOpen(PROVIDERS.flatMap((provider, i) => sets[i].map((member) => ({ provider, member }))), 8);
  const due = jobs.filter((j) => (ageOf(j, now()) > STALE_MS || !!j.resultUrls?.length) && !copyWaits(j, now())).sort(oldestFirst).slice(0, opts.limit);
  const report: SweepReport = { open: jobs.length, advanced: 0, done: 0, failed: 0, dropped, skipped: 0 };
  await pmap(due, async (j) => {
    if (budget(Infinity, opts.deadline, now()) < SWEEP_MIN_MS) {
      report.skipped++;
      return;
    }
    try {
      const r = await advance(j, deps, { force: true, deadline: opts.deadline, via: "sweep" });
      report.advanced++;
      if (r.state === "done") report.done++;
      else if (r.state === "failed") report.failed++;
    } catch (e) {
      console.error("media sweep failed", j.provider, codeOf(e));
      report.skipped++;
    }
  }, 4);
  return report;
}

/** The opportunistic sweep (spec A3): at most one per SWEEP_LOCK_S, six jobs, and only with 30 s of the request left. */
export async function maybeSweep(deps: MediaDeps, deadline: number): Promise<SweepReport | null> {
  if (budget(Infinity, deadline, clockOf(deps)()) < MAYBE_SWEEP_MIN_MS) return null;
  try {
    if (!(await db.lock(mk.sweepLock(), SWEEP_LOCK_S))) return null;
    return await sweepMedia(deps, { deadline, limit: 6 });
  } catch (e) {
    console.error("media sweep failed", codeOf(e));
    return null;
  }
}
