import { CAPS, db, mgetChunked, pushCapped } from "./db";
import { pmap } from "./parallel";
import { editPctOf } from "./similarity";
import { hasAdCode, newAdCode } from "./ad-codes";
import { agentForTask, type AgentId } from "./agents";

export type Brand = {
  name: string;
  website: string;
  industry: string;
  dialect: "msa" | "saudi" | "emirati" | "kuwaiti" | "english";
  languages: ("ar" | "en")[];
  tone: string;
  products: string;
  audience: string;
  offers: string;
  competitors: string;
  banned: string;
  preferred: string;
  channels: string[];
  city: string;
  updatedAt: string;
  /** Why customers choose you (profile page). */
  valueProp?: string;
  /** Sitemap URL for internal links and product import. */
  sitemap?: string;
  /** Social handles by platform (instagram, snapchat, tiktok, x, linkedin). */
  social?: Record<string, string>;
  /**
   * The time zone Reem keeps this brand's to-dos in: one of `ZONE_IDS` (src/lib/zones.ts), checked on write and again on
   * read (`zoneOf`, which falls back to the city, then the dialect, then Riyadh). Absent on brands saved before
   * 2026-09-29.
   */
  timeZone?: string;
  /**
   * The model every content batch of this brand runs on and is priced for, when it passes `route("generate")` for the
   * batch's type (src/lib/models/overrides.ts); absent: automatic. Set and cleared only by PUT /api/models (admin or
   * owner); every other brand writer keeps it as it is, and PUT /api/brand never takes it from the request. A catalog id
   * as stored: validated again at every batch, never trusted. Absent on brands saved before 2026-10-08.
   */
  model?: string;
};

// The task catalogue lives in ./tasks, which imports nothing: client components read the costs from there instead of
// from this module, which would drag the Redis client into their bundle. Re-exported so server callers are unaffected.
export type { TaskType } from "./tasks";
export { TASK_COST, TASK_COUNT, IMAGE_TYPES, VIDEO_TYPES, IMAGE_COST } from "./tasks";
import { isTaskType, type TaskType } from "./tasks";
import type { ImageModelId, MediaFailure, MediaProviderId, VideoModelId } from "./media-catalog";
import { log } from "./log";
import { scopeParam, wsKey } from "./keys";

/** The last render of one kind that ended without a result, kept on the card until the next render of that kind. */
export type MediaLast = { error: MediaFailure; credits: number; refunded: boolean; at: string };

export type Task = {
  id: string;
  type: TaskType;
  channel: string;
  title: string;
  body: string;
  editedBody?: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  lang: "ar" | "en";
  /**
   * `external`: written by the owner's own assistant and saved through MCP `save_draft` (src/lib/external-drafts.ts).
   * `handoff`: an item of Majed's handoff, run by a login pressing Run on its card (src/lib/handoffs.ts); see `parent`.
   */
  source?: "manual" | "chat" | "scheduled" | "external" | "handoff";
  /**
   * The handoff item this task was made for (`source: "handoff"`): the handoff's id, the item's position in it (0-based)
   * and the conversation it was proposed in. Set in code by the run (`runHandoffItem`), never from a request or the model.
   */
  parent?: TaskParent;
  /**
   * The plan step this task was made for (v2 C3, rule 4632): the plan's id and the step's position in it (0-based). Set in
   * code by the step's run (src/lib/plan-run.ts), never from a request or the model. Expand: old code ignores it.
   */
  plan?: TaskPlan;
  /**
   * The agent who owns the request this task was made for in a team thread (v2 C12, rule 4743): the thread's owner, set in
   * code from the turn (`scopeOf`, src/lib/chat-gates.ts), never from a request or the model. Expand: old code ignores it.
   */
  owner?: AgentId;
  scheduledFor?: string; // YYYY-MM-DD, set by owner in inbox/calendar
  imageUrl?: string;
  imagePrompt?: string;
  /**
   * Which service produced imageUrl: "fal", "kie" or "higgsfield" for a generated image (src/lib/media/), absent on
   * images saved before providers were recorded. When the default image model is unavailable, the owner gets a
   * placehold.co card carrying the brand name instead, marked "placeholder". That is not artwork, and presenting it as
   * the generated image the owner just paid for is a lie the interface was telling on our behalf. Test for artwork with
   * hasArtwork (src/lib/media-catalog.ts), never by comparing with one provider.
   */
  imageProvider?: MediaProviderId | "placeholder";
  /** Catalogue model that made imageUrl. Absent on placeholder cards and on images made before 2026-09-29 (all fal's default model). */
  imageModel?: ImageModelId;
  /** Our Blob copy of the generated clip (video/mp4). Downloaded by the owner; never a publish target in this round. */
  videoUrl?: string;
  /** The prompt the clip was rendered from, shown under the video as imagePrompt is under the image. */
  videoPrompt?: string;
  /** Which service rendered videoUrl. fal has no video model. */
  videoProvider?: Exclude<MediaProviderId, "fal">;
  /** Catalogue model that made videoUrl. */
  videoModel?: VideoModelId;
  /** Credits kept for renders of this task, after refunds. Absent before 2026-09-29: start from `hasArtwork(t) ? IMAGE_COST : 0` (spec A14). */
  mediaCredits?: number;
  /** The media job of each kind still in progress, set when the job is saved queued and cleared when it ends. */
  mediaJob?: { image?: string; video?: string };
  /**
   * The latest finished render jobs whose result or credits this task already took (at most 8, oldest first). A finalize
   * retried after a failed write finds its job here and changes nothing, so no render is counted twice.
   */
  mediaApplied?: string[];
  /** The last failed render of each kind, until the next render of that kind starts (spec A28). */
  mediaLast?: { image?: MediaLast; video?: MediaLast };
  /** `id`: the platform's own post id, kept for WordPress only, so "publish again" updates that post instead of making a second one. */
  published?: { provider: string; url: string; status: "draft" | "published"; at: string; id?: string }[];
  /** When the owner approved or rejected (for time-to-decision). */
  decidedAt?: string;
  /**
   * Who approved it (rule 3761, expand): the person id of the approver and when. Set by PATCH /api/tasks/{id} when the
   * item ends approved by a person's decision, cleared whenever it leaves "approved". With the account's approval policy
   * on (`User.approvalRequired`) nothing publishes unless this names a person still allowed to approve (publish-once.ts).
   * Older code ignores it.
   */
  approvedBy?: { pid: string; at: string };
  /** Who should decide it (rule 3764, expand): an approver of the brand, picked when an agent's draft arrives. Older code ignores it. */
  assignee?: { pid: string; at: string };
  /** Comments on the draft (rule 3758, expand): any role, the draft itself unchanged. Newest last, at most 50. */
  comments?: { pid: string; name: string; text: string; at: string }[];
  /**
   * Set aside under "Not now" (rule 2340): still `pending`, out of the badge, the pending chip, the nudges and Reem's
   * walk until someone brings it back. `by: "auto"` when the daily job moved it after `NOT_NOW_DAYS` untouched
   * (src/lib/not-now.ts). Rule 679 expand: new and optional; older code ignores it and shows the item as pending.
   */
  notNow?: { at: string; by: "owner" | "auto" };
  /** The last time a person acted on this item without deciding it (edit, date, reopen, bring back): the auto-move's clock. */
  touchedAt?: string;
  /**
   * The founder let this exact text through the publish check (rule 1411, `POST /api/admin/agent-scope/release`): `hash` is
   * `itemHash` of the item when released, so any later edit is checked again. Set only by that route. Rule 679 expand: new
   * and optional; older code ignores it.
   */
  agentScopeRelease?: { hash: string; by: string; at: string };
  /** Put in the ad's name so its results can be matched back to this item (src/lib/ad-codes.ts). */
  adCode?: string;
  /** What the agent was asked for this batch: the owner's notes or brief, first 500 characters (`briefOf`). */
  brief?: string;
  /**
   * Which prompts made this item (src/lib/prompt-stamp.ts): 12-hex hashes of the owning agent's playbook, review.md, the
   * industry playbook (`id:hash`) and the prompts written in code; "none" for a playbook that did not load. `plat` and
   * `ins` are the hashes of the platform instruction block and of the owner's instruction block the batch carried
   * (src/lib/agent-instructions.ts, `none` when empty); tasks from before the instruction layers lack them. Set on every
   * generated batch (`taskFromItem`); absent on older tasks and on MCP `save_draft` drafts, which no Nashr prompt wrote.
   */
  pb?: {
    skills: string;
    review: string;
    industry?: string;
    code: string;
    plat?: string;
    ins?: string;
  };
  /** Automated judge score (src/lib/judge.ts). `autofail` is the judge's automatic-fail code, when one was set. */
  quality?: { score: number; dims: { completeness: number; brand: number; honesty: number; language: number; format: number }; notes: string; model: string; at: string; autofail?: string };
  /** The self-check before the save (v2 C6, rule 4672, src/lib/self-check.ts): the first score, and whether the item was rewritten with the judge's note. Expand-only (rule 679): absent on older tasks and while `SELF_CHECK` is off. */
  selfCheck?: SelfCheckMark;
  /**
   * Another agent's second opinion on this item, one verdict per reviewing agent (`crossReview` in noor.ts; Razan checks
   * the arithmetic of growth, deck and strategy work, Majed the strategy of pricing and GTM work). Notes only: the item's
   * text is never changed by it. A "flag" holds the item pending even when its type is auto-approved. Absent on types
   * nobody cross-reviews, when the owner switched it off, when the review failed, and on MCP `save_draft` drafts.
   */
  crossReview?: CrossVerdict[];
};

/**
 * Where a handoff item's task came from: `Task.parent`. `auto` marks a task Majed's auto-run made (the cron started the
 * item, not a login pressing Run; src/lib/handoff-auto.ts). Set in code by the run, never from a request or the model.
 */
export type TaskParent = { handoff: string; item: number; conv?: string; auto?: true };
/** Where a plan step's task came from: `Task.plan` (src/lib/plans.ts). */
export type TaskPlan = { id: string; step: number };
/** `Task.selfCheck` (rule 4672): `first` is the in-line score; `skipped` says why an item below the bar kept its text. */
export type SelfCheckMark = { first?: number; autofail?: string; rewritten: boolean; skipped?: "time" | "judge" | "cap" | "error" };

/**
 * Work the product made on its own, with no login asking for it at that moment: the Sunday plan and the routines
 * (`source: "scheduled"`), and the items Majed's auto-run made from a handoff (`parent.auto`). The one test for it: the
 * weekly cap (`Governance.weeklyCap`) counts these in the routines' `holdBatch`, the auto-run and `runWeekly`, and
 * Dana's routine does not take them as the owner's own activity.
 *
 * `external` (MCP `save_draft`) is NOT autonomous: the owner's own assistant wrote it at the owner's request, through a
 * token the owner created; it costs nothing and always waits for the owner. Counting it would let the owner's own tool
 * use up the cap and silently stop the Sunday plan, the routines and the auto-run, which are what the cap bounds.
 * A handoff item a login ran from its card is not autonomous either: a person pressed Run.
 */
export const isAutonomous = (t: Pick<Task, "source" | "parent">): boolean => t.source === "scheduled" || (t.source === "handoff" && t.parent?.auto === true);

/** One reviewing agent's verdict on one item: "ok", or "flag" with up to 300 characters of notes in the item's language. */
export type CrossVerdict = { by: AgentId; verdict: "ok" | "flag"; notes: string; at: string; model: string };
/** Whether any reviewing agent flagged the item. */
export const crossFlagged = (t: Pick<Task, "crossReview">): boolean => !!t.crossReview?.some((v) => v.verdict === "flag");

/** The notes or brief of one batch as each of its tasks keeps it: first 500 characters, or nothing when there were none. */
export const briefOf = (notes: unknown): string | undefined => (typeof notes === "string" && notes.trim() ? notes.trim().slice(0, 500) : undefined);

export async function getBrand(email: string) {
  return db.get<Brand>(wsKey.brand(scopeParam(email)));
}
export async function saveBrand(email: string, b: Brand) {
  await db.set(wsKey.brand(scopeParam(email)), b);
}
/**
 * Ids waiting for the owner's decision, seeding the set on first use exactly as the badge does. The badge and the
 * inbox both read THIS, so they cannot drift apart: one read used twice, not two that happen to agree. Also read by
 * Reem's "walk me through" (src/lib/secretary-walk.ts), so its approval cards are the badge's items.
 */
export async function pendingIds(email: string): Promise<string[]> {
  if (!(await db.get(wsKey.pendingIndex(scopeParam(email))))) await rebuildPending(email);
  return db.smembers(wsKey.pending(scopeParam(email)));
}

/**
 * What the approvals inbox holds: the newest 200 tasks, plus every task still waiting for a decision.
 *
 * The second half is the point. The inbox is the surface that approves or rejects, it used to read the newest 200 ids
 * alone, and the sidebar badge counts the whole `pending:{scope}` set — so past 200 tasks an owner saw "Approvals 50"
 * above an inbox showing none of them, and the backlog was unreachable for good. The pending chip is therefore
 * exhaustive while the approved and rejected chips stay a recency window, and a buried item leaves the list once it is
 * decided. Nothing is lost: listLite and the reports still see every task.
 *
 * Cost is bounded by 200 + the backlog the owner still has to clear, never by the size of the workspace.
 */
export async function listTasks(email: string): Promise<Task[]> {
  const [head, pending] = await Promise.all([db.lrange(wsKey.tasks(scopeParam(email)), 0, 199), pendingIds(email)]);
  // Dedupe BEFORE fetching. A pending task inside the newest 200 must appear once: twice would give React duplicate
  // keys and make the optimistic overlay in Inbox.tsx apply to both copies of the same card.
  const seen = new Set(head);
  const tail = pending.filter((id) => !seen.has(id));
  // Chunked MGET (rule 1430): two requests for the newest 200, where one GET per task cost 200 billed commands a page view.
  const rows = await mgetChunked<Task>([...head, ...tail].map((id) => wsKey.task(scopeParam(email), id)));
  const tailRows = rows.slice(head.length);

  // A pending id whose task record is gone is counted by the badge and dropped here — the same disagreement in
  // miniature. This read already knows which ones they are, so it clears them; the badge is fetched after the render.
  const ghosts = tail.filter((_, i) => !tailRows[i]);
  if (ghosts.length) void Promise.all(ghosts.map((id) => db.srem(wsKey.pending(scopeParam(email)), id))).catch(() => {});

  // The head keeps the list's own order. The tail is newest-first too, ordered by (createdAt, id) so a batch written
  // inside one millisecond does not reshuffle under an owner working through it.
  const older = tailRows
    .filter((t): t is Task => !!t)
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
  return [...rows.slice(0, head.length).filter((t): t is Task => !!t), ...older];
}

/**
 * Light row of a task: everything the dashboards, calendar, briefs and metrics need, without the body. Rows live in one
 * Redis hash per workspace per creation month (`tidx:{scope}:{YYYY-MM}`), so a page costs one command per month it looks
 * at instead of one per task, and nothing falls off after the 200 newest tasks.
 */
export type TaskLite = Pick<Task, "id" | "type" | "channel" | "title" | "status" | "createdAt" | "lang" | "source" | "scheduledFor" | "decidedAt" | "parent" | "notNow" | "touchedAt"> & {
  /** First 200 characters of the current text (edited text when the owner edited it). */
  preview: string;
  edited: boolean;
  /** How much the owner changed the text before approving, 0..100. Only set when edited. */
  editPct?: number;
  /** Has an image that is not a placeholder card. Rows written before 2026-09-29 count a placeholder too, until re-saved. */
  image: boolean;
  /** Absent, so false, on rows written before 2026-09-29. */
  video: boolean;
  /**
   * Credits spent on renders of this task. Optional: rows written before 2026-09-29 lack it; readers use
   * `t.mediaCredits ?? (t.image ? IMAGE_COST : 0)`.
   */
  mediaCredits?: number;
  published: number;
  score?: number;
  notes?: string;
  /** The judge's automatic-fail code, when it set one (the notes then start with "[code]"). */
  autofail?: string;
  /** Another agent flagged it in the cross-agent review (`Task.crossReview`). Absent, so false, when none did. */
  xflag?: boolean;
};
export function liteOf(t: Task): TaskLite {
  const edited = !!t.editedBody && t.editedBody !== t.body;
  return {
    id: t.id, type: t.type, channel: t.channel, title: t.title, status: t.status, createdAt: t.createdAt, lang: t.lang, source: t.source, scheduledFor: t.scheduledFor, decidedAt: t.decidedAt,
    // The handoff item a task was made for, so the lists can say so without loading the task.
    ...(t.parent ? { parent: t.parent } : {}),
    // "Not now" and the auto-move's clock (rule 2340), so the counts, nudges and the daily move need no task bodies.
    ...(t.notNow ? { notNow: t.notNow } : {}),
    ...(t.touchedAt ? { touchedAt: t.touchedAt } : {}),
    preview: (t.editedBody ?? t.body ?? "").slice(0, 200),
    edited,
    editPct: edited ? editPctOf(t.body, t.editedBody!) : undefined,
    // A placeholder card is not an image anyone made or paid for: it counts in neither "images generated" nor, through
    // the readers' `image ? IMAGE_COST : 0` fallback, credits used. Not hasArtwork: images saved before providers were
    // recorded have no provider and are real.
    image: !!t.imageUrl && t.imageProvider !== "placeholder",
    video: !!t.videoUrl,
    mediaCredits: t.mediaCredits,
    // Only what actually went live. WordPress and Shopify connectors create DRAFTS by default, and counting those made
    // the "Published via integrations" tile — and Dana's weekly report, which quotes it — claim posts were live that
    // were sitting unpublished in the owner's CMS.
    published: t.published?.filter((p) => p.status === "published").length ?? 0,
    score: t.quality?.score,
    notes: t.quality?.notes?.slice(0, 200),
    autofail: t.quality?.autofail,
    // Built here, so saveTask, updateTask and rebuildIndex all keep it: every path that writes a row goes through liteOf.
    xflag: crossFlagged(t) || undefined,
  };
}
const monthOf = (iso: string) => (/^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : "0000-00");
const asLite = (v: unknown): TaskLite | null => {
  if (typeof v !== "string") return (v as TaskLite) ?? null;
  try { return JSON.parse(v) as TaskLite; } catch { return null; }
};

export async function saveTask(email: string, t: Task, isNew = false) {
  const month = monthOf(t.createdAt);
  // Every creation path passes here, so every new ad or social item gets its code in one place.
  if (isNew && !t.adCode && hasAdCode(t.type)) t.adCode = newAdCode();
  const s = scopeParam(email);
  // A fresh draft gets an approver of its brand, in turn (rule 3764). Imported here, not at the top: assign.ts reads the
  // roster and the bell, which import this file.
  if (isNew && t.status === "pending" && !t.assignee) await (await import("./assign")).autoAssign(s, t);
  // Every path that changes a task goes through here, and each write below is idempotent, so the pending set and the
  // light index cannot drift the way a +1/-1 counter would. One round of parallel commands instead of a chain.
  await Promise.all([
    db.set(wsKey.task(s, t.id), t),
    isNew ? db.lpush(wsKey.tasks(s), t.id) : null,
    t.status === "pending" ? db.sadd(wsKey.pending(s), t.id) : db.srem(wsKey.pending(s), t.id),
    // The "Not now" subset (rule 2341): a pending task set aside, and nothing else.
    t.status === "pending" && t.notNow ? db.sadd(wsKey.notNow(s), t.id) : db.srem(wsKey.notNow(s), t.id),
    db.hset(wsKey.taskMonth(s, month), t.id, liteOf(t)),
    db.sadd(wsKey.taskMonths(s), month),
    isNew && t.adCode ? db.hset(wsKey.adCodes(s), t.adCode, t.id) : null,
  ]);
}

/**
 * Remove tasks a batch saved and then refunded (src/lib/generate-batch.ts, rule 334): the record, its place in the list,
 * the pending set, the light index and its ad code, every write of `saveTask` undone, in one round of parallel commands.
 * Each is idempotent, so a task whose save never landed, or landed in part, is removed all the same.
 */
export async function dropTasks(email: string, tasks: readonly Task[]): Promise<void> {
  const s = scopeParam(email);
  await Promise.all(tasks.flatMap((t) => [
    db.del(wsKey.task(s, t.id)),
    db.lrem(wsKey.tasks(s), t.id),
    db.srem(wsKey.pending(s), t.id),
    db.srem(wsKey.notNow(s), t.id),
    db.hdel(wsKey.taskMonth(s, monthOf(t.createdAt)), t.id),
    t.adCode ? db.hdel(wsKey.adCodes(s), t.adCode) : null,
  ]));
}

/** This workspace's ad codes, code → task id: one read, used when results come in. */
export async function adCodeIndex(email: string): Promise<Record<string, string>> {
  return db.hgetall<string>(wsKey.adCodes(scopeParam(email)));
}

/** Rebuild the light index from the stored tasks (first use on an existing workspace, and the weekly reconcile). */
export async function rebuildIndex(email: string): Promise<TaskLite[]> {
  const ids = await db.lrange(wsKey.tasks(scopeParam(email)), 0, -1);
  const rows = (await mgetChunked<Task>(ids.map((id) => wsKey.task(scopeParam(email), id)))).filter((t): t is Task => !!t);
  const lite = rows.map(liteOf);
  await pmap(lite, (l) => db.hset(wsKey.taskMonth(scopeParam(email), monthOf(l.createdAt)), l.id, l));
  await Promise.all([...new Set(lite.map((l) => monthOf(l.createdAt)))].map((m) => db.sadd(wsKey.taskMonths(scopeParam(email)), m)));
  await db.set(wsKey.taskIndexVersion(scopeParam(email)), new Date().toISOString());
  return lite.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
/** When the light index was last rebuilt from the tasks themselves, or null when it never was. */
export async function indexedAt(email: string) {
  return db.get<string>(wsKey.taskIndexVersion(scopeParam(email)));
}

/** Light rows, newest first. `since` limits the read to the months that can hold tasks created on or after it. */
export async function listLite(email: string, since?: Date): Promise<TaskLite[]> {
  const [marker, months] = await Promise.all([db.get<string>(wsKey.taskIndexVersion(scopeParam(email))), db.smembers(wsKey.taskMonths(scopeParam(email)))]);
  if (!marker) {
    const all = await rebuildIndex(email);
    return since ? all.filter((l) => new Date(l.createdAt) >= since) : all;
  }
  const from = since ? since.toISOString().slice(0, 7) : "";
  const maps = await Promise.all(months.filter((m) => m >= from).map((m) => db.hgetall<unknown>(wsKey.taskMonth(scopeParam(email), m))));
  const out: TaskLite[] = [];
  for (const map of maps) for (const v of Object.values(map)) { const l = asLite(v); if (l && (!since || new Date(l.createdAt) >= since)) out.push(l); }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Light rows created in the last `days` days (server components may not read the clock themselves). */
export const listLiteDays = (email: string, days: number) => listLite(email, new Date(Date.now() - days * 864e5));

/**
 * Rebuild the pending set and its "Not now" subset from the task list (first use on an existing workspace, and the daily
 * reconcile). The subset is rebuilt with it (rule 2341), so an id older code left behind (it never writes `notnow:`) is
 * gone by the next morning. Returns the size of the pending set, set-aside items included.
 */
export async function rebuildPending(email: string, tasks?: Pick<Task, "id" | "status" | "notNow">[]): Promise<number> {
  const list = tasks ?? (await listLite(email));
  const s = scopeParam(email);
  const want = new Set(list.filter((t) => t.status === "pending").map((t) => t.id));
  const wantAside = new Set(list.filter((t) => t.status === "pending" && t.notNow).map((t) => t.id));
  const [have, haveAside] = await Promise.all([db.smembers(wsKey.pending(s)), db.smembers(wsKey.notNow(s))]);
  const sync = (key: string, want: Set<string>, have: string[]) => [...have.filter((id) => !want.has(id)).map((id) => db.srem(key, id)), ...[...want].filter((id) => !have.includes(id)).map((id) => db.sadd(key, id))];
  await Promise.all([...sync(wsKey.pending(s), want, have), ...sync(wsKey.notNow(s), wantAside, haveAside)]);
  await db.set(wsKey.pendingIndex(s), new Date().toISOString());
  return want.size;
}

/** Waiting for a decision now: pending and not set aside under "Not now" (rule 2340). Every count of the inbox uses this. */
export const isWaiting = (t: Pick<Task, "status" | "notNow">): boolean => t.status === "pending" && !t.notNow;

/**
 * Ids waiting for a decision now: the pending set without its "Not now" subset, read in one round (rule 2341). The badge,
 * Reem's walk and the agenda read this; the inbox reads `pendingIds`, so a set-aside item stays reachable under its chip.
 */
export async function waitingIds(email: string): Promise<string[]> {
  const [pending, aside] = await Promise.all([pendingIds(email), db.smembers(wsKey.notNow(scopeParam(email)))]);
  const skip = new Set(aside);
  return pending.filter((id) => !skip.has(id));
}

/** Number of items waiting for the owner's decision now ("Not now" left out): two reads in one round once indexed. */
export async function pendingCount(email: string): Promise<number> {
  return (await waitingIds(email)).length;
}
export async function getTask(email: string, id: string) {
  return db.get<Task>(wsKey.task(scopeParam(email), id));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Change one existing task under a short per-task lock: re-read, apply `mutate`, save. saveTask writes the whole task,
 * so a writer that read the task before slow work (a publish, the owner's approve or edit, a render finishing by poll,
 * webhook or sweep) and saved its copy afterwards erased whatever landed in between, a paid render included. Every such
 * writer goes through here instead, so each one applies only its own fields to the task as it is now.
 *
 * `mutate` gets the stored task and returns the task to save, or null to leave it as it is. It runs once, under the lock,
 * so it must not wait on anything slow. Returns the task as stored afterwards, or null when there is none: a task deleted
 * meanwhile is never recreated. `scope` is the caller's own (`sc(u)`, or the scope the server stored on a media job).
 */
export async function updateTask(scope: string, id: string, mutate: (t: Task) => Task | null): Promise<Task | null> {
  const key = wsKey.taskLock(scopeParam(scope), id);
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    got = await db.lock(key, 10);
    if (!got) await sleep(50);
  }
  if (!got) throw new Error("task_lock_timeout");
  try {
    const t = await getTask(scope, id);
    if (!t) return null;
    // A copy, so a mutate that edits in place and then declines leaves what this returns equal to what is stored.
    const next = mutate(structuredClone(t));
    if (!next) return t;
    await saveTask(scope, next);
    return next;
  } finally {
    // As in withUserLock: a failed release must not turn a saved change into a throw. The 10 s TTL frees the lock.
    await db.unlock(key).catch((e) => log.error("task lock release failed", e));
  }
}
export async function addPreference(email: string, note: string) {
  await pushCapped(wsKey.prefs(scopeParam(email)), note.slice(0, 500), CAPS.prefs);
}
export async function listPreferences(email: string) {
  return db.lrange(wsKey.prefs(scopeParam(email)), 0, 29);
}

/** The task type a learned note names ("Owner edited a social item (instagram). ..."), when it names one. */
const noteType = (note: string) => /^Owner (?:edited|rejected) an? ([a-z_]+) item\b/.exec(note)?.[1];

/**
 * The newest 30 preference notes for one agent's prompts. A note about another agent's work is left out, so the
 * owner's edits to Noor's posts do not steer Razan's pricing review; a note that names no task type is about the brand
 * and stays. The whole capped list is read in one command, so notes filtered out do not shrink the 30.
 */
export async function listPreferencesFor(email: string, agent: AgentId) {
  const notes = await db.lrange(wsKey.prefs(scopeParam(email)), 0, CAPS.prefs - 1);
  return notes.filter((n) => { const type = noteType(n); return !isTaskType(type) || agentForTask(type).id === agent; }).slice(0, 30);
}
