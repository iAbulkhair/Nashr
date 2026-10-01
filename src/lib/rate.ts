import { timingSafeEqual } from "crypto";
import { db } from "./db";

/** Fixed-window rate limit. True when the caller is still inside the allowance. */
export async function allow(bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  const key = `rate:${bucket}`;
  const n = await db.incrby(key, 1);
  // Every hit, not only the first: EXPIRE NX starts the window when the counter has none and never touches the count.
  // Setting the expiry on the first hit alone, with a SET, reset hits that landed in between, and when that one call
  // failed the counter kept no expiry and refused every caller for good (rate:kie:create is every tenant's). A failure
  // here is repaired by the next hit, so it does not fail the request.
  try {
    await db.expireNx(key, windowSeconds);
  } catch (e) {
    console.error("rate expiry failed", e instanceof Error ? e.name : "error");
    // A store that refused the NX form must not leave every counter without an expiry: the first hit falls back to the
    // old SET, which can only reset hits that landed in the same instant.
    if (n === 1) await db.set(key, 1, windowSeconds).catch(() => {});
  }
  return n <= max;
}

/** Client IP for throttling. Platform-set headers first; the caller-suppliable x-forwarded-for is the last resort and its LAST hop is used. */
export const clientIp = (req: Request) =>
  (req.headers.get("x-vercel-forwarded-for") ?? req.headers.get("x-real-ip") ?? "").split(",")[0].trim() ||
  (req.headers.get("x-forwarded-for") ?? "").split(",").pop()!.trim() || "unknown";

/**
 * Chat turns per account. A turn is free in credits but is the most expensive call in the product (up to five model
 * calls with the full workspace in the prompt), so the spend of a single account is bounded here. Generous enough that
 * no real conversation hits it: the ceiling is roughly a day of continuous use.
 */
export const CHAT_PER_HOUR = 40;
export const CHAT_PER_DAY = 200;
export async function chatAllowed(email: string): Promise<boolean> {
  const [hour, day] = await Promise.all([allow(`chat:h:${email}`, CHAT_PER_HOUR, 3600), allow(`chat:d:${email}`, CHAT_PER_DAY, 86400)]);
  return hour && day;
}

/**
 * Drafts saved into the inbox by the owner's own assistant (MCP `save_draft`). Free in credits and without a model
 * call, so nothing else bounds it: without this a looping client could fill the approvals inbox. Per account, across
 * its brands. Well above what an owner reviews in an hour.
 */
export const DRAFTS_PER_HOUR = 30;
export const DRAFTS_PER_DAY = 150;
export async function draftAllowed(email: string): Promise<boolean> {
  const [hour, day] = await Promise.all([allow(`draft:h:${email}`, DRAFTS_PER_HOUR, 3600), allow(`draft:d:${email}`, DRAFTS_PER_DAY, 86400)]);
  return hour && day;
}

/**
 * Brands added per account (POST /api/brands add). Brands are unlimited on every plan (src/lib/pricing.ts), so nothing
 * else bounds how many an account creates, and every active brand fans out into each cron (the daily brief, the
 * routines, and the Sunday plan once the owner switches it on). These buckets are the only bound, and they are a rate,
 * never a cap: an agency can keep adding brands every hour. Well above a real agency's onboarding pace, and the
 * onboarding itself stays at three a day per account (src/app/api/onboard/route.ts). Rule 245, tests/brand-guardrails.test.ts.
 */
export const BRANDS_PER_HOUR = 10;
export const BRANDS_PER_DAY = 30;
/**
 * Null when the add may go ahead, else which window refused it, so the owner is told "in an hour" or "tomorrow" rather
 * than "shortly" (a full day window can last up to 24 hours). The hour is checked first and the day only when the hour
 * allowed it: an add refused by the hour does not use one of the day's 30. One refused by the day uses an hourly slot,
 * which only matters within the hour and never outlasts the day's refusal.
 */
export async function brandAddRefusal(email: string): Promise<"hour" | "day" | null> {
  if (!(await allow(`brandadd:h:${email}`, BRANDS_PER_HOUR, 3600))) return "hour";
  if (!(await allow(`brandadd:d:${email}`, BRANDS_PER_DAY, 86400))) return "day";
  return null;
}

/**
 * The public OAuth endpoints, per IP. Hosted MCP clients (claude.ai, ChatGPT) register and exchange tokens from shared
 * egress addresses on behalf of many accounts, and a token pair lives 30 days, so real traffic stays far below these.
 * Registration is the tighter one: it is open (RFC 7591) and every client is stored with no expiry.
 */
export const OAUTH_TOKEN_PER_IP = 60, OAUTH_TOKEN_WINDOW = 900;
export const OAUTH_REGISTER_PER_IP = 30, OAUTH_REGISTER_WINDOW = 3600;

/**
 * Governance restores per account (`POST /api/governance/rollback`). Each one rewrites every setting and adds a history
 * record, so a script must not be able to churn them; an owner undoing a few changes stays far below this.
 */
export const GOV_ROLLBACKS_PER_HOUR = 20;

/**
 * The owner's activity log, per account: pages and filters (`GET /api/activity`) and CSV downloads
 * (`GET /api/activity/export`). Every read loads the brand's whole capped log (CAPS.activity rows), so a script paging
 * in a loop is bounded here; an owner filtering and pressing "Load more" stays far below it.
 */
export const ACTIVITY_READS_PER_HOUR = 300;
export const ACTIVITY_EXPORTS_PER_HOUR = 10;

/**
 * Majed's handoffs, per account (src/lib/handoffs.ts). Reads: the chat's handoff cards fetch their record on show and
 * after every action. Runs: each is a paid batch (the credits and the agent caps bound it too), and a run holds the
 * handoff's lock for its whole length, so a script cannot stack them; "Run all" on a three-item card is three. Declines
 * write the record and a log row, so they are bounded like any other write.
 */
export const HANDOFF_READS_PER_HOUR = 600;
export const HANDOFF_RUNS_PER_HOUR = 60;
export const HANDOFF_DECLINES_PER_HOUR = 120;

/**
 * Thumbs on agent replies, per account (`POST /api/chat/feedback`). Each one is a write to the brand's capped feedback
 * log, which the agents' prompts read back, so a script must not churn it; an owner rating replies stays far below this
 * (chat itself is CHAT_PER_HOUR turns).
 */
export const FEEDBACK_PER_HOUR = 120;

/** Constant-time string comparison for secrets. */
export function sameSecret(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = Buffer.from(a ?? ""), y = Buffer.from(b ?? "");
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
