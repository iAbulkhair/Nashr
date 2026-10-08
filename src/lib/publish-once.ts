import { db } from "./db";
import { getTask, updateTask, type Task } from "./brand";
import { publishTask, type PublishResult } from "./connectors/publish";
import { ReconnectRequired } from "./connectors/fresh";
import { SOCIAL_PUB_KEY } from "./social-stats";

/**
 * One publish per item and platform, and an honest answer when a publish may or may not have landed.
 *
 * Before this, a publish that timed out inside the route's 60 seconds came back as a 502 and the card looked
 * unpublished, so pressing Publish again posted the same text twice to X, Telegram or Facebook; two quick presses did
 * the same. Now:
 * - a lock per (scope, item, platform) lets one publish run at a time, held longer than any caller may run;
 * - the caller's gates run again on the copy that is actually sent, read under that lock;
 * - a marker is written before the platform is called and removed once the answer is known. A kill at the time limit
 *   leaves it behind, and so does any error that does not prove nothing went out. The next attempt is then refused as
 *   "result unknown" until the owner has checked the platform and confirms. Only a clear refusal (a 4xx answer, a
 *   refused token, a check made before sending) removes it;
 * - a platform the item already went to is refused unless the owner confirms "publish again".
 *
 * The callers keep their own gates (role, approval, brand rules, target) and pass the ones that read the task as
 * `check`; this is only the send and its record.
 */
export type Refusal = { error: string; [k: string]: unknown };
export type PublishOnce =
  | { ok: true; result: PublishResult; task: Task; approving: boolean }
  | { ok: false; error: "not_found" | "publish_busy" | "already_published" | "publish_unknown"; at?: string; url?: string }
  /** Nothing new was posted, but the attempt whose answer nobody saw went live: recorded on `task`, as a success is. */
  | { ok: false; error: "earlier_live"; at: string; task: Task; approving: boolean }
  | { ok: false; error: "refused"; refusal: Refusal }
  | { ok: false; error: "publish_failed"; cause: unknown };

/** Above the longest caller by default: the chat and MCP routes run up to 300 s. The publish route (60 s) passes its own. */
const LOCK_S = 330;
const MARK_S = 3 * 86400;
const lockKey = (scope: string, id: string, provider: string) => `publock:${scope}:${id}:${provider}`;
export const attemptKey = (scope: string, id: string, provider: string) => `pubtry:${scope}:${id}:${provider}`;

/** Errors the code throws before anything is sent, and platform answers without a status that say the post was not made. */
const REFUSED = /^(?:not_connected|unsupported_provider|instagram_needs_image|tiktok_needs_image|meta_no_page|meta_no_instagram|linkedin_no_author|reconnect_required|x_duplicate|wordpress_cannot_publish_live|no blog on store|composio_unavailable|composio_rate_limited|composio_tool_not_allowed|composio_argument_not_allowed|composio_file_not_allowed|composio_stage_failed|instagram_limit_reached|youtube_needs_video|whatsapp_empty|whatsapp_too_long|whatsapp_variable_at_edge|brevo_no_sender)$|^shopify (?:graphql|article):|^meta media (?:ERROR|EXPIRED|not ready)/;
/** The HTTP status a connector puts at the start of its error ("x 403: …", "telegram 400: …", "meta feed 400: …", "linkedin 502: …"). */
const LEADING_STATUS = /^(?:x|telegram|wordpress|shopify|prestashop|odoo|linkedin|tiktok|whatsapp|youtube|brevo|klaviyo|meta [\w-]+) (\d{3})\b/;
/** The platform refused the text because it was already posted there (X's duplicate, Facebook's #506). */
export const isDuplicate = (msg: string) => msg === "x_duplicate" || /\(#506\)|duplicate status/i.test(msg);

/**
 * Whether a failed publish may still have posted. Everything that is not a clear refusal counts: a timeout, a network
 * failure, a 5xx, a body that could not be read. Asking the owner to check once costs less than a double post.
 */
export function mayHavePosted(e: unknown): boolean {
  if (e instanceof ReconnectRequired) return false;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const name = e instanceof Error ? e.name : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  // Only the connector's own status counts, never a number inside the platform's message (Facebook's "(#506)").
  const status = LEADING_STATUS.exec(msg)?.[1];
  if (status) return status.startsWith("5");
  return !REFUSED.test(msg);
}

/**
 * Platforms whose post id is kept on the item: WordPress updates the same post on "publish again", Instagram and
 * LinkedIn ids join a post to its results (social-stats.ts).
 */
const KEEPS_ID: readonly string[] = ["wordpress", "instagram", "linkedin"];
const quietly = (p: Promise<unknown>, what: string) => p.catch((e) => console.error(`publish ${what} failed`, e instanceof Error ? e.name : "error"));

export async function publishOnce(scope: string, id: string, provider: string, opts: { again?: boolean; live?: boolean; check?: (t: Task) => Refusal | null; lockS?: number } = {}): Promise<PublishOnce> {
  const lk = lockKey(scope, id, provider);
  if (!(await db.lock(lk, opts.lockS ?? LOCK_S))) return { ok: false, error: "publish_busy" };
  try {
    const mk = attemptKey(scope, id, provider);
    const [t, tried] = await Promise.all([getTask(scope, id), db.get<{ at: string }>(mk)]);
    if (!t) return { ok: false, error: "not_found" };
    // The copy that goes out passes the caller's gates: an edit that landed after the caller read the item is judged too.
    const refusal = opts.check?.(t);
    if (refusal) return { ok: false, error: "refused", refusal };
    if (!opts.again) {
      // A marker is newer than any record: a successful publish removes it after writing its record.
      if (tried) return { ok: false, error: "publish_unknown", at: tried.at };
      const done = [...(t.published ?? [])].reverse().find((p) => p.provider === provider);
      if (done) return { ok: false, error: "already_published", at: done.at, url: done.url };
    }
    const tryAt = new Date().toISOString();
    await db.set(mk, { at: tryAt }, MARK_S);
    let r: PublishResult;
    try {
      r = await publishTask(scope, t, provider, { again: opts.again, live: opts.live });
    } catch (e) {
      if (mayHavePosted(e)) return { ok: false, error: "publish_unknown", at: tryAt };
      // "Already posted" after an attempt whose result nobody saw is the answer to that attempt: it went live. It is
      // recorded, so the item is protected from a third try and the owner is not told to reword and post again. It is
      // recorded as a success is: a pending item was approved by the owner's publish when that attempt went out, so it
      // gets `decidedAt` then, and the caller writes the decision and activity records the unknown attempt never wrote.
      if (tried && isDuplicate(e instanceof Error ? e.message : "")) {
        let approving = false;
        const saved = await updateTask(scope, id, (cur) => {
          cur.published = [...(cur.published ?? []), { provider, url: "", status: "published", at: tried.at }];
          approving = cur.status === "pending";
          if (approving) cur.decidedAt = tried.at;
          cur.status = "approved";
          return cur;
        });
        await quietly(db.del(mk), "marker clear");
        return { ok: false, error: "earlier_live", at: tried.at, task: saved ?? t, approving };
      }
      await quietly(db.del(mk), "marker clear");
      return { ok: false, error: "publish_failed", cause: e };
    }
    const at = new Date().toISOString();
    let approving = false;
    // Applied to the task as stored now, not to the copy read before the publish: a render that finished during the
    // seconds a publish takes keeps its image or clip and its credits.
    const saved = await updateTask(scope, id, (cur) => {
      cur.published = [...(cur.published ?? []), { provider: r.provider, url: r.url, status: r.status, at, ...(KEEPS_ID.includes(r.provider) && r.id ? { id: r.id } : {}) }];
      // Publishing a pending item is the owner approving it, so it records when that happened.
      approving = cur.status === "pending";
      if (approving) cur.decidedAt = at;
      cur.status = "approved";
      return cur;
    });
    // The post is recorded on the item, so the marker has done its job. A failed clear is only logged: the post went out
    // and is recorded, and a marker left behind makes the next attempt ask the owner, which errs on the safe side.
    // Instagram's media id joins the workspace's own list, so a result read later can say the post came from Thakeen
    // (social-stats.ts). Only logged on failure: the post went out and is recorded on the item.
    await Promise.all([quietly(db.del(mk), "marker clear"), r.provider === "instagram" && r.id ? quietly(db.sadd(SOCIAL_PUB_KEY(scope), r.id), "post id") : null]);
    return { ok: true, result: r, task: saved ?? t, approving };
  } finally {
    await quietly(db.unlock(lk), "lock release");
  }
}
