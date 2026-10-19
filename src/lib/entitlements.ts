import { AGENT_IDS, type AgentId } from "./agents";
import { isSuspended } from "./suspension";
import type { Grant, User } from "./auth";
import { billingLocked } from "./billing-state";
import { chatStatus, type ChatStatus } from "./chat-allowance";
import { MEDIA_MODELS, TRIAL_VIDEO_MODELS, type VideoModelId } from "./media-catalog";
import { allowanceOf, chatAllowanceOf, seatLimit } from "./pricing";
import { INSTRUCTION_CHARS, INSTRUCTION_PLAN, type InstructionLimits } from "./instructions-safety";
import { chatCaps } from "./rate";
import { route } from "./models/route";
import { seatsUsed } from "./team";
import { acct } from "./account-id";

/**
 * What an account's plan includes, in one pure function (spec docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md
 * section 3.1, rule 780). It reads only the user record and constants, so it costs nothing and can be called anywhere;
 * it does not replace `allowanceOf`, `seatLimit`, `chatAllowanceOf` or `chatCaps`, it asks them, so there is still one
 * source for each number. It imports `chatCaps` from src/lib/rate.ts, which imports the db client, and (for
 * `entitlementView`, rule 784) `seatsUsed` and `chatStatus`, which read the store: a server module, never imported by a
 * client component at runtime (a type import is erased).
 *
 * Deliberately outside the layer, because they are the owner's settings or Thakeen's protection rather than what the
 * plan includes (spec 3.1): whether a media model is switched on (`MEDIA_MODELS_ON` and the breaker in
 * src/lib/media/config.ts, so a model must be both included here and switched on there); the abuse rate limits in
 * src/lib/rate.ts (drafts, brands, OAuth, scope refusals); and the owner's own per-agent budgets (`agentCaps` in
 * src/lib/governance.ts).
 */

/** Why an account is not active, for display. The refusal codes of the gates (`trial_over`, ...) stay as they are. */
export type Inactive = "suspended" | "trial_over" | "billing_locked";

export type Entitlements = {
  /** false while the account is suspended, its trial is over or its Paymob subscription is locked. */
  active: boolean;
  /** Set when `active` is false, in the order the gates would refuse: suspended, then a locked subscription, then an ended trial. */
  inactive?: Inactive;
  /** The trial end (ISO) for a trial, else the Paymob paid-through day (YYYY-MM-DD), else null for an account activated by hand. */
  endsAt: string | null;
  credits: { monthly: number };
  seats: number;
  chat: { monthly: number; hour: number; day: number };
  /** The video models the plan includes. Whether each is switched on is a separate check (src/lib/media/config.ts). */
  media: { video: readonly VideoModelId[] };
  agents: readonly AgentId[];
  /** Customer instructions per brand workspace (agent skills portal, spec 9, rule 935). */
  instructions: InstructionLimits;
};

/** The part of the user record `entitlements` reads, so a caller may pass a full `User` or a hand-built fixture. */
export type EntUser = Pick<User, "plan" | "trialEnds" | "suspended" | "billing" | "seats" | "deal" | "chatAllowance" | "grants">;

/** Every video model, in catalogue order: what a paid plan includes. */
export const ALL_VIDEO_MODELS: readonly VideoModelId[] = MEDIA_MODELS.filter((m) => m.kind === "video").map((m) => m.id as VideoModelId);

/**
 * Whether `s` is a real UTC calendar day written `YYYY-MM-DD`. A regex alone is not enough: `Date.parse` rolls a day that
 * does not exist forward (`2026-02-31` becomes 3 March), so the day must also come back the same from a round trip
 * through `Date` (ruling R8). The one check for a grant's `until`, on the way in (`parseVideoGrant`) and when it is read
 * (`grantActive`).
 */
export function isUtcDay(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * Whether a founder grant is in force at `now`: it names who set it and when (`by`, `at`), `until` is a real
 * YYYY-MM-DD day (`isUtcDay`), and `now` is not past the end of that UTC day. Anything else, a grant that is missing,
 * malformed or past, reads as absent; nothing deletes it (`User.grants`).
 */
export function grantActive(g: Grant<unknown> | undefined, now: number = Date.now()): boolean {
  if (!g || !g.by || !g.at) return false;
  if (!isUtcDay(g.until)) return false;
  return now <= Date.parse(`${g.until}T23:59:59.999Z`);
}

/** Longest founder grant: it must end within this many days of today. */
const MAX_GRANT_DAYS = 366;
/** Longest grant note, in characters, after it is collapsed to one line. */
const MAX_GRANT_NOTE = 200;

/**
 * Checks a founder's video grant request body (`POST /api/admin/plan` `videoGrant`, rule 783) and returns only what is
 * read from it: `until` (a real UTC day after today and at most 366 days ahead, so the grant always ends) and an
 * optional note (a string of at most 200 characters, whitespace and control characters collapsed to one line, nothing
 * left of it means no note). Anything else, including a body that is not an object, is `{ ok: false }`. `by`, `at` and
 * the value are never read from the body: the route sets them. `now` is for tests.
 */
export function parseVideoGrant(v: unknown, now: number = Date.now()): { ok: true; until: string; note?: string } | { ok: false } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false };
  const { until, note } = v as { until?: unknown; note?: unknown };
  if (!isUtcDay(until)) return { ok: false };
  // Both are YYYY-MM-DD, so comparing the strings compares the days.
  const today = new Date(now).toISOString().slice(0, 10);
  const last = new Date(now + MAX_GRANT_DAYS * 86400_000).toISOString().slice(0, 10);
  if (until <= today || until > last) return { ok: false };
  if (note === undefined || note === null) return { ok: true, until };
  if (typeof note !== "string") return { ok: false };
  const line = note.replace(/[\s\p{Cc}]+/gu, " ").trim();
  if (line.length > MAX_GRANT_NOTE) return { ok: false };
  return line ? { ok: true, until, note: line } : { ok: true, until };
}

/** The first reason the account is not active, or undefined. Suspension first, then a locked subscription, then an ended trial. */
function inactiveOf(u: EntUser, now: number): Inactive | undefined {
  if (isSuspended(u, now)) return "suspended";
  if (billingLocked(u.billing)) return "billing_locked";
  if (u.plan === "trial" && Date.parse(u.trialEnds) < now) return "trial_over";
  return undefined;
}

/**
 * What the account's plan includes at `now`. An inactive account still reports its plan's own numbers: `active` and
 * `inactive` say whether it may use them. A trial keeps `TRIAL_VIDEO_MODELS` unless its video grant is in force.
 */
export function entitlements(u: EntUser, now: number = Date.now()): Entitlements {
  const inactive = inactiveOf(u, now);
  const caps = chatCaps(u);
  return {
    active: !inactive,
    ...(inactive ? { inactive } : {}),
    endsAt: u.plan === "trial" ? u.trialEnds : u.billing?.paidThrough ?? null,
    credits: { monthly: allowanceOf(u) },
    seats: seatLimit(u),
    chat: { monthly: chatAllowanceOf(u), hour: caps.hour, day: caps.day },
    media: { video: u.plan === "trial" && !grantActive(u.grants?.video, now) ? TRIAL_VIDEO_MODELS : ALL_VIDEO_MODELS },
    agents: AGENT_IDS,
    instructions: { ...INSTRUCTION_PLAN[u.plan], chars: INSTRUCTION_CHARS },
  };
}

/**
 * What the founder's console shows for one account (rule 784): what the account gets now (`ent`), the plan's own values
 * without the founder's overrides (`base`, ruling R12), what the account has used, when the month's numbers start again,
 * and the video grant with whether it has run out. `grants.video` is the stored grant with `expired` set by
 * `grantActive`, so an old grant is shown as expired and never as in force.
 */
export type EntitlementView = {
  ent: Entitlements;
  /**
   * `entitlements()` of the same record with the four overrides of spec 3.2 removed (`deal`, `seats`, `chatAllowance`,
   * `grants`) and the same `now`: the plan's own values. The account's state (suspended, trial end, billing) is kept, so
   * `base` and `ent` differ only where an override is set.
   */
  base: Entitlements;
  used: { credits: number; seats: number; chat: ChatStatus };
  /** The next 1st of the month (a UTC day, YYYY-MM-DD) for a paid plan that renews; null for a trial and for a locked Paymob subscription. */
  resetsAt: string | null;
  grants: { video: (Grant<"all"> & { expired: boolean }) | null };
};

/**
 * The next 1st of the month after `now`, as a UTC day. Only a paid plan that is not billing-locked has one: that is the
 * account `renewalDue` (src/lib/credits.ts) renews at the start of the UTC month, and the one whose chat count restarts
 * with `monthKey` (rule 712: a locked subscription gets no new month until it pays; a trial's chat and credits do not reset).
 */
function resetsAtOf(u: EntUser, now: number): string | null {
  if (u.plan === "trial" || billingLocked(u.billing)) return null;
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/**
 * The entitlement view of one stored account for the founder's console (`GET /api/admin/users/{email}`, rule 784).
 * Reads only: the seats in use and the chat status, in one `Promise.all` (the chat status is also read by the route for
 * its own `chat`; reading it twice is accepted, ruling R11). `now` is for tests.
 */
export async function entitlementView(u: User, now: number = Date.now()): Promise<EntitlementView> {
  const [seats, chat] = await Promise.all([seatsUsed(acct(u)), chatStatus(u, route("chat").model)]);
  const g = u.grants?.video;
  const own: EntUser = { plan: u.plan, trialEnds: u.trialEnds, suspended: u.suspended, billing: u.billing };
  return {
    ent: entitlements(u, now),
    base: entitlements(own, now),
    used: { credits: u.credits, seats, chat },
    resetsAt: resetsAtOf(u, now),
    grants: { video: g ? { ...g, expired: !grantActive(g, now) } : null },
  };
}
