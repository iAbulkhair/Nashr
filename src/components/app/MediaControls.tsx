"use client";
import Link from "next/link";
import { useEffect, useEffectEvent, useId, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Task } from "@/lib/brand";
import type { Lang } from "@/lib/i18n";
import { CONFIRM_FROM_CREDITS, DEFAULT_IMAGE_MODEL, MEDIA_MAX_AGE_MS, MEDIA_MODELS, TRIAL_VIDEO_MODELS, aspectFor, hasArtwork, mediaImageFor, mediaModel, plural, type MediaKind, type MediaModel, type MediaModelId } from "@/lib/media-catalog";
import type { PublicJob } from "@/lib/media/types";
import { IMAGE_TYPES, VIDEO_TYPES } from "@/lib/tasks";
import { limitFromError } from "./LimitModal";

/**
 * The image and video buttons of one inbox card: a model picker per kind with the price on every choice, a
 * confirmation before an expensive render or a replacement, and the polling that follows a render still in progress.
 *
 * Values come only from the import-free catalogues (tests/client-bundle.test.ts). Every rule shown here is checked again
 * by the routes (src/lib/media/start.ts): a disabled card or a stale balance only changes what the owner sees first.
 */

/** Poll gaps: quick while a render is young, slower after 2 minutes, doubled on 429 up to 30 s. */
const FIRST: Record<MediaKind, number> = { image: 3_000, video: 6_000 };
const LATER = 15_000;
const MAX_GAP = 30_000;
const QUICK_FOR = 2 * 60_000;
/** The server fails and refunds a job at its max age on the next poll; this is how long past that the inbox waits to hear so. */
const GRACE = 2 * 60_000;
/** Past GRACE the card says the render is late and keeps asking this far apart: it said the outcome would show here. */
const LATE_GAP = 60_000;
/** After a 409 that named no job (the other start has not saved it yet), the task is re-read after each of these gaps. */
export const RECHECK_GAPS = [4_000, 12_000, 30_000];

type StartBody = { ok?: boolean; error?: string; need?: number; have?: number; job?: PublicJob };
export type PollEvent = { job?: PublicJob; end?: "done" | "failed" | "gone"; late?: true };
/** `waiting`: the note says the card will pick up a render another start is saving, so it goes once the card does. */
type Note = { text: string; billing?: boolean; topup?: boolean; waiting?: boolean };

/**
 * One setTimeout chain for one job; returns the function that stops it. The job's age comes from its createdAt, clamped
 * to the kind's max age, so a client clock that runs ahead still polls for GRACE: long enough to see the server's verdict.
 * Past that it reports `late` once and slows to LATE_GAP; only a finished job, a 404 or a 401 ends it.
 */
export function pollJob(id: string, kind: MediaKind, report: (e: PollEvent) => void): () => void {
  const ctl = new AbortController();
  let born = Date.now();
  let gap = FIRST[kind];
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const age = () => Date.now() - born;
  const again = (ms: number) => { timer = setTimeout(tick, ms); };
  const backOff = () => { gap = late ? LATE_GAP : Math.min(gap * 2, MAX_GAP); again(gap); };
  async function tick() {
    if (!late && age() >= MEDIA_MAX_AGE_MS[kind] + GRACE) {
      late = true;
      report({ late: true });
    }
    let res: Response;
    try {
      res = await fetch(`/api/media/${id}`, { cache: "no-store", signal: ctl.signal });
    } catch {
      return ctl.signal.aborted ? undefined : backOff();
    }
    // 404: another brand's job after a switch, or a job past its 7-day record. 401: signed out. Neither gets better.
    if (res.status === 404 || res.status === 401) return report({ end: "gone" });
    const j = (await res.json().catch(() => ({}))) as { job?: PublicJob };
    if (ctl.signal.aborted) return;
    if (!res.ok || !j.job) return backOff();
    const since = Date.now() - Date.parse(j.job.createdAt);
    if (since > 0) born = Math.min(born, Date.now() - Math.min(since, MEDIA_MAX_AGE_MS[kind]));
    if (j.job.state !== "running") return report({ job: j.job, end: j.job.state });
    report({ job: j.job });
    gap = late ? LATE_GAP : age() < QUICK_FOR ? FIRST[kind] : LATER;
    again(gap);
  }
  again(gap);
  return () => { ctl.abort(); clearTimeout(timer); };
}

/** Calls `refresh` after each gap of RECHECK_GAPS in turn; returns the function that stops it. */
export function recheckTask(refresh: () => void): () => void {
  let n = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => { timer = setTimeout(() => { refresh(); if (++n < RECHECK_GAPS.length) next(); }, RECHECK_GAPS[n]); };
  next();
  return () => clearTimeout(timer);
}

export default function MediaControls({ task, lang, t, available, credits, plan, paused, onChanged }: {
  task: Task; lang: Lang; t: AppDict; available: MediaModelId[];
  credits: number; plan: string; paused: boolean;
  /**
   * Called after any 200 or 202, after a 5xx, while waiting for the job another start is saving, and when a poll ends
   * done or failed: the parent drops its local copy and refreshes.
   */
  onChanged(): void;
}) {
  const i = t.inbox;
  const uid = useId();
  const [pick, setPick] = useState<Partial<Record<MediaKind, MediaModelId>>>({});
  const [asking, setAsking] = useState<Partial<Record<MediaKind, boolean>>>({});
  const [posting, setPosting] = useState<Partial<Record<MediaKind, boolean>>>({});
  const [note, setNote] = useState<Partial<Record<MediaKind, Note | null>>>({});
  // Jobs this card started or was told about (409), the last state seen per job id, and the ids no longer followed.
  const [started, setStarted] = useState<Partial<Record<MediaKind, string>>>({});
  const [jobs, setJobs] = useState<Record<string, PublicJob>>({});
  const [ended, setEnded] = useState<Record<string, true>>({});

  const say = (kind: MediaKind, n: Note | null) => setNote((p) => ({ ...p, [kind]: n }));
  const fail = (kind: MediaKind) => (kind === "image" ? i.imageFail : i.videoFail);
  // Own keys only: a code such as "constructor" must not reach Object.prototype (the same trap as isTaskType).
  const errText = (code?: string) => (code && Object.hasOwn(i.mediaErr, code) ? (i.mediaErr as Record<string, string>)[code] : undefined);

  /**
   * The job a kind is following: the one this card started, else the one the server recorded on the task, so a reload
   * resumes a running render. A job that ended here is never followed again, even while a refresh still names it.
   */
  const activeId = (kind: MediaKind) => [started[kind], task.mediaJob?.[kind]].find((id): id is string => !!id && !ended[id]);
  const imageJob = activeId("image");
  const videoJob = activeId("video");

  const report = useEffectEvent((kind: MediaKind, id: string, e: PollEvent) => {
    if (e.job) {
      setJobs((p) => ({ ...p, [id]: e.job! }));
      setNote((p) => (p[kind]?.waiting ? { ...p, [kind]: null } : p));
    }
    if (e.late) say(kind, { text: i.stillRendering });
    if (!e.end) return;
    setEnded((p) => ({ ...p, [id]: true }));
    if (e.end === "failed") say(kind, { text: errText(e.job?.error) ?? fail(kind) });
    if (e.end === "done") say(kind, null);
    // A failure refreshes too: the balance shows the refund and the card its mediaLast.
    if (e.end === "done" || e.end === "failed") onChanged();
  });
  // Keyed by job id: a refresh that brings the same id back does not start a second loop, and unmount stops it.
  useEffect(() => (imageJob ? pollJob(imageJob, "image", (e) => report("image", imageJob, e)) : undefined), [imageJob]);
  useEffect(() => (videoJob ? pollJob(videoJob, "video", (e) => report("video", videoJob, e)) : undefined), [videoJob]);
  // A 409 named no job yet: re-read the task until it points at one. Following it, or any new note, stops the re-reads.
  const refresh = useEffectEvent(() => onChanged());
  const waitImage = !imageJob && note.image?.waiting ? note.image : undefined;
  const waitVideo = !videoJob && note.video?.waiting ? note.video : undefined;
  useEffect(() => (waitImage ? recheckTask(() => refresh()) : undefined), [waitImage]);
  useEffect(() => (waitVideo ? recheckTask(() => refresh()) : undefined), [waitVideo]);

  const follow = (kind: MediaKind, job: PublicJob) => {
    setJobs((p) => ({ ...p, [job.id]: job }));
    setEnded((p) => { const n = { ...p }; delete n[job.id]; return n; });
    setStarted((p) => ({ ...p, [kind]: job.id }));
  };

  /**
   * Why a card cannot be picked, shown on the card itself: phones never show a title, nor does any browser on a disabled
   * option. An image the post shows but that is not our own copy (made before the copy existed, or a copy that failed)
   * is never sent to a provider (spec A9), so the owner is told to make it again rather than that there is none.
   */
  const why = (m: MediaModel): string | undefined =>
    plan === "trial" && m.kind === "video" && !(TRIAL_VIDEO_MODELS as readonly string[]).includes(m.id) ? i.afterSubscribe
    : m.needsImage && !mediaImageFor(m, task) ? (hasArtwork(task) ? i.redoImageNote : i.needsImageNote)
    : m.credits > credits ? i.notEnough
    : undefined;

  /**
   * The owner's pick while it can still be used; else images take the default model and video the cheapest open card.
   * When every card is closed the button still posts, so the server answers with the modal or the reason.
   */
  function chosen(kind: MediaKind, models: MediaModel[]): MediaModel | undefined {
    const open = models.filter((m) => !why(m));
    const mine = open.find((m) => m.id === pick[kind]);
    if (mine) return mine;
    if (kind === "image") return models.find((m) => m.id === DEFAULT_IMAGE_MODEL) ?? open[0] ?? models[0];
    return [...(open.length ? open : models)].sort((a, b) => a.credits - b.credits)[0];
  }

  const replacing = (kind: MediaKind) => (kind === "image" ? hasArtwork(task) : !!task.videoUrl);

  function ask(kind: MediaKind, m: MediaModel | undefined) {
    say(kind, null);
    // Every replacement asks, with a model or without: a POST without one renders the default model once it is back.
    // Without a model and nothing to replace it is the free placeholder (or that 1-credit render), posted at once.
    if (replacing(kind) || (m && m.credits >= CONFIRM_FROM_CREDITS)) setAsking((p) => ({ ...p, [kind]: true }));
    else void go(kind, m);
  }

  async function go(kind: MediaKind, m: MediaModel | undefined) {
    setAsking((p) => ({ ...p, [kind]: false }));
    setPosting((p) => ({ ...p, [kind]: true }));
    say(kind, null);
    let res: Response | null = null;
    let j: StartBody = {};
    try {
      res = await fetch(`/api/tasks/${task.id}/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m ? { model: m.id } : {}) });
      j = (await res.json().catch(() => ({}))) as StartBody;
    } catch {
      /* offline: reported below as a failure */
    }
    setPosting((p) => ({ ...p, [kind]: false }));
    if (res?.ok && j.ok) {
      if (j.job?.state === "running") follow(kind, j.job);
      onChanged();
      return;
    }
    // A server error can leave a charged render behind, which the task then points at: the refresh follows it.
    if (res && res.status >= 500) onChanged();
    const e = j.error;
    if (e === "in_progress") return j.job ? follow(kind, j.job) : say(kind, { text: i.mediaErr.in_progress, waiting: true });
    // Sent without a model, and the item has artwork the server would not draw a placeholder over.
    if (e === "model_unavailable" && !m) return say(kind, { text: i.keepsImage });
    // The modal's text ("you've used this month's credits") is true only at a zero balance. An agent at the monthly cap
    // the owner set in Governance gets the same dialog /api/generate raises, which points to Governance, not billing.
    if (e === "trial_over" || e === "agent_cap" || (e === "no_credits" && !(typeof j.have === "number" && j.have > 0))) { limitFromError(e); return; }
    if (e === "no_credits") {
      const need = j.need ?? m?.credits;
      // Short of credits, the link names the top-up and lands on its section (rule 450); the billing page tells a trial
      // that packs come after subscribing and a member that the owner buys them.
      return say(kind, { text: plural(i.needCredits, need ?? 0, { need: need ?? "", have: String(j.have) }), billing: true, topup: true });
    }
    say(kind, { text: errText(e) ?? fail(kind), billing: e === "plan_required" || e === "trial_video_used" });
  }

  function section(kind: MediaKind) {
    const models = MEDIA_MODELS.filter((m) => m.kind === kind && available.includes(m.id));
    const sel = chosen(kind, models);
    const jobId = kind === "image" ? imageJob : videoJob;
    const job = jobId ? jobs[jobId] : undefined;
    const rendering = !!posting[kind] || !!jobId;
    const has = kind === "image" ? !!task.imageUrl : !!task.videoUrl;
    const n = note[kind];
    const last = task.mediaLast?.[kind];
    const hintId = `${uid}-${kind}-hint`;
    const askId = `${uid}-${kind}-ask`;
    // What a POST without a model costs if the default model is back: the price a replacement then confirms.
    const price = sel?.credits ?? (kind === "image" ? mediaModel(DEFAULT_IMAGE_MODEL).credits : 0);
    // No image model to offer and artwork to lose: the server keeps artwork rather than draw a placeholder over it.
    const keeps = kind === "image" && !models.length && hasArtwork(task);
    return (
      <div key={kind} className="grid gap-2">
        {models.length > 0 && sel && (
          <fieldset role="radiogroup" aria-describedby={hintId} className="grid gap-1.5">
            <legend className="mb-1 text-xs font-semibold text-ink/70">{kind === "image" ? i.imageModel : i.videoModel}</legend>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {models.map((m) => {
                const off = why(m);
                return (
                  <label key={m.id} className={`flex items-start gap-2 rounded-lg border border-ink/15 bg-white p-2 text-xs has-checked:border-oasis has-checked:bg-oasis/5 ${off ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
                    <input type="radio" name={`${uid}-${kind}`} value={m.id} checked={sel.id === m.id} disabled={!!off} onChange={() => setPick((p) => ({ ...p, [kind]: m.id }))} className="mt-0.5 accent-oasis" />
                    <span className="grid gap-0.5">
                      <span className="font-semibold">{m.label[lang]}</span>
                      <span className="tnum text-ink/60">{m.credits} {plural(i.credits, m.credits)}</span>
                      {off && <span className="text-sadu-deep">{off}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            <p id={hintId} className="text-xs text-ink/60">
              {sel.hint[lang]}
              {mediaImageFor(sel, task) && <span className="ms-1.5 inline-block rounded-full bg-oasis/10 px-2 text-oasis">{i.buildsOnImage}</span>}
              {sel.id === "vid-motion" && aspectFor("image", task.channel) === "square" && ` ${i.squareClip}`}
            </p>
          </fieldset>
        )}
        {asking[kind] ? (
          <div role="group" aria-labelledby={askId} className="flex flex-wrap items-center gap-2 rounded-lg border border-saffron/50 bg-saffron/10 p-2 text-xs">
            <p id={askId} className="w-full sm:w-auto">{plural(replacing(kind) ? i.confirmReplace : i.confirmCost, price)}</p>
            {/* autoFocus: the button that asked was just replaced by this question, so focus would otherwise be lost. */}
            <button autoFocus onClick={() => go(kind, sel)} className="btn btn-primary btn-xs">{i.continue}</button>
            <button onClick={() => setAsking((p) => ({ ...p, [kind]: false }))} className="btn btn-secondary btn-xs">{i.cancel}</button>
          </div>
        ) : (
          <button disabled={rendering || keeps} onClick={() => ask(kind, sel)} className="w-fit rounded-full border border-saffron px-4 py-1.5 disabled:opacity-50">
            {rendering ? (kind === "image" ? i.imaging : i.videoing) : (has ? "↻ " : "") + (kind === "image" ? i.image : i.video)}
          </button>
        )}
        {keeps && !rendering && !n && <p className="text-xs text-ink/60">{i.keepsImage}</p>}
        {rendering && job && <p className="text-xs text-ink/60">{plural(i.charged, job.credits)}</p>}
        {kind === "video" && jobId && <p className="text-xs text-ink/60">{i.videoSlow}</p>}
        {n && (
          <p role="alert" className="text-xs text-sadu-deep">
            {n.text}
            {n.billing && <> <Link href={`/${lang}/app/billing${n.topup ? "#topup" : ""}`} className="font-semibold underline">{n.topup ? i.topupLink : i.billingLink}</Link></>}
          </p>
        )}
        {!rendering && !n && last && <p className="text-xs text-sadu-deep">{plural(i.mediaLastFailed, last.credits)} {errText(last.error)}</p>}
      </div>
    );
  }

  const kinds: MediaKind[] = [];
  if (IMAGE_TYPES.includes(task.type)) kinds.push("image");
  if (VIDEO_TYPES.includes(task.type) && available.some((id) => MEDIA_MODELS.some((m) => m.id === id && m.kind === "video"))) kinds.push("video");
  if (!kinds.length) return null;
  // The note says how renders are made, so it names only the kinds a model renders here: a placeholder is made from nothing.
  const made = kinds.filter((k) => MEDIA_MODELS.some((m) => m.kind === k && available.includes(m.id)));
  const pausedText = made.length === 2 ? i.pausedNote : made[0] === "image" ? i.pausedNoteImage : made[0] === "video" ? i.pausedNoteVideo : null;
  return (
    <div className="grid w-full gap-4">
      {paused && pausedText && <p className="text-xs text-ink/60">{pausedText}</p>}
      {kinds.map(section)}
    </div>
  );
}
