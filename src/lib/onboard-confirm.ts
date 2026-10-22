import { db } from "./db";
import type { User } from "./auth";
import { acct } from "./account-id";
import { getBrand } from "./brand";
import { ONBOARD_HOLD_MS, resolveOnboardHolds } from "./credits";
import { recordActivity } from "./activity";
import { systemBy } from "./actor";
import { parseAnswers, type GameAnswers } from "./dictionary";
import { scopeParam, wsKey } from "./keys";

/**
 * Which site a workspace is built from is the owner's choice, made on the start page and checked here in code.
 *
 * A link (`/app/signup?url=`, `/app/chat?onboard=`) only pre-fills the start page: it never starts a crawl or a model
 * call. The owner presses the button, `POST /api/onboard/confirm` records the URL under their own scope, and
 * `POST /api/onboard` refuses any other URL and clears the record once the brand is saved: one confirmation, one build.
 */
const key = (scope: string) => wsKey.onboardOk(scopeParam(scope));
/** A day, the window of the three-runs allowance, so "refresh to try again" after a failed or paused run still works. */
const TTL = 86400;

/** The one form of a site URL that the start page, the chat page and both onboarding routes compare. */
export const onboardUrl = (raw: unknown) => (typeof raw === "string" ? raw.trim().slice(0, 300) : "");
export const confirmOnboard = (scope: string, url: string) => db.set(key(scope), url, TTL);
export const confirmedOnboard = async (scope: string) => (await db.get<string>(key(scope))) ?? "";
export const clearOnboard = (scope: string) => Promise.all([db.del(key(scope)), db.del(gameKey(scope))]);

/**
 * The owner's answers from the first-login game (src/lib/dictionary.ts `GameAnswers`), stored with the confirmation,
 * under the same scope and for the same day, and cleared with it. A confirm without answers deletes any left by an
 * earlier one, so a stale game never names a later build. The build reads them here, never from its request, and
 * validates them again: a stored value is data too. Rules 522-523.
 */
const gameKey = (scope: string) => wsKey.onboardGame(scopeParam(scope));
export const confirmAnswers = (scope: string, a: GameAnswers | null) => (a ? db.set(gameKey(scope), a, TTL) : db.del(gameKey(scope)));
export const confirmedAnswers = async (scope: string) => parseAnswers(await db.get<unknown>(gameKey(scope)));

/**
 * An added brand's onboarding charge (src/lib/pricing.ts ONBOARD_EXTRA_BRAND_COST) is held on the account record, not
 * here: `User.onboardPaid[scope]`, written and dropped in the same locked save as the charge and its refund
 * (src/lib/credits.ts `chargeOnboard`, `refundOnboard`, `settleOnboard`). A separate key could not be kept in step with
 * the balance: a refund whose marker delete failed left a marker that made the next build free, or refunded twice.
 *
 * The hold has no TTL, so it cannot expire between a killed run and the owner's retry (the confirmation, a day long, is
 * written first and always expired first). While it exists a retry, and the start page, treat the setup as paid. The
 * daily cron resolves any hold that no run charged or reused for a day: refunded when its brand was never built (a run
 * the platform killed before saving the brand), dropped when it was. Rule 246, tests/brand-guardrails.test.ts.
 */
export const heldOnboard = (u: Pick<User, "onboardPaid">, scope: string) => u.onboardPaid?.[scope] ?? null;

/**
 * The daily sweep of one account's stale holds: reads the brand of each stale scope side by side, then resolves them in
 * one save. Each refund is one `onboard_refunded` row in that brand's activity log, by the cron, with the credits the
 * ledger gave back (rule 232): the setup's charge was a row there, so its refund is too. A dropped hold adds none (its
 * charge stands).
 */
export async function sweepOnboardHolds(u: Pick<User, "id" | "email" | "onboardPaid">, now = Date.now()) {
  const stale = Object.entries(u.onboardPaid ?? {}).filter(([, h]) => !(now - new Date(h.at).getTime() < ONBOARD_HOLD_MS)).map(([scope]) => scope);
  if (!stale.length) return null;
  const brands = await Promise.all(stale.map((scope) => getBrand(scope)));
  const done = await resolveOnboardHolds(acct(u), Object.fromEntries(stale.map((scope, i) => [scope, !!brands[i]])), now);
  const at = new Date().toISOString();
  await Promise.all(done.refunded.map((r) => recordActivity(r.scope, [{ at, kind: "onboard_refunded", agent: r.agent, by: systemBy("cron"), via: "cron", credits: r.credits, refunded: true }])));
  return done;
}
