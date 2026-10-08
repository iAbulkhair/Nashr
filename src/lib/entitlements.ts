import { AGENT_IDS, type AgentId } from "./agents";
import type { Grant, User } from "./auth";
import { billingLocked } from "./billing-state";
import { MEDIA_MODELS, TRIAL_VIDEO_MODELS, type VideoModelId } from "./media-catalog";
import { allowanceOf, chatAllowanceOf, seatLimit } from "./pricing";
import { chatCaps } from "./rate";

/**
 * What an account's plan includes, in one pure function (spec docs/superpowers/specs/2026-10-08-entitlements-agent-scope-design.md
 * section 3.1, rule 780). It reads only the user record and constants, so it costs nothing and can be called anywhere;
 * it does not replace `allowanceOf`, `seatLimit`, `chatAllowanceOf` or `chatCaps`, it asks them, so there is still one
 * source for each number. It imports `chatCaps` from src/lib/rate.ts, which imports the db client: a server module.
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
};

/** The part of the user record `entitlements` reads, so a caller may pass a full `User` or a hand-built fixture. */
export type EntUser = Pick<User, "plan" | "trialEnds" | "suspended" | "billing" | "seats" | "deal" | "chatAllowance" | "grants">;

/** Every video model, in catalogue order: what a paid plan includes. */
export const ALL_VIDEO_MODELS: readonly VideoModelId[] = MEDIA_MODELS.filter((m) => m.kind === "video").map((m) => m.id as VideoModelId);

/**
 * Whether a founder grant is in force at `now`: it names who set it and when (`by`, `at`), `until` is a YYYY-MM-DD day,
 * and `now` is not past the end of that UTC day. Anything else, a grant that is missing, malformed or past, reads as
 * absent; nothing deletes it (`User.grants`).
 */
export function grantActive(g: Grant<unknown> | undefined, now: number = Date.now()): boolean {
  if (!g || !g.by || !g.at) return false;
  if (typeof g.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(g.until)) return false;
  return now <= Date.parse(`${g.until}T23:59:59.999Z`);
}

/** The first reason the account is not active, or undefined. Suspension first, then a locked subscription, then an ended trial. */
function inactiveOf(u: EntUser, now: number): Inactive | undefined {
  if (u.suspended) return "suspended";
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
  };
}
