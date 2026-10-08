// Watches GET /api/health while the site rebuilds (spec 2026-10-08-staging-smooth-releases, section 5.8).
// Usage: node scripts/probe.mjs <origin> <seconds>. The origin is exactly https://thakeen.com, https://staging.thakeen.com
// or a local server (http://localhost:<port>, http://127.0.0.1:<port>); anything else is refused before a request is sent.
// On staging the access code is STAGING_ACCESS_CODE (the value of the staging host's STAGING_ACCESS_KEY; listed in
// docs/system/variables.md section 7), read from the environment and, when that is empty, from `.smoke.local` at the
// repository root, the way scripts/smoke.mjs reads it. With no code the probe stops at once: every answer would be the
// lock's 404 and it would measure nothing. The code is sent only to staging (and to a local server when one is set).
// Node 22, no dependencies.
//
// Not before the client-address check: do not run this, or scripts/smoke.mjs, against staging until the plan's Task 13,
// step 4 has passed (docs/system/flows.md section 51, item 7). Until then a host that forwards no client address puts
// every caller of /api/health into one bucket, and this probe alone fills most of it. Nothing in this file can tell
// whether the check has passed.
//
// The health route allows 60 a minute per client address (a fixed window that starts at its first hit), so one request
// a second would sit exactly on the cap. The probe starts requests at least 1.2 s apart: at most 51 in any 60 seconds,
// which leaves room for a smoke run or a manual check. A 429 is the route's limiter answering, so the process is up: it
// is counted apart (`throttled`) and is not a failure. The probe does not wait or stop on a 429; the measurement needs
// every request.
import { pathToFileURL } from "node:url";
import { classifyOrigin, originRefusal, readLocal, stagingCookie, valueOf } from "./staging-cookie.mjs";

export const PROBE_INTERVAL_MS = 1200;
// A request that hangs during the switch is recorded as a failure after this long, instead of stalling the loop.
const PROBE_TIMEOUT_MS = 10_000;

/** How long to sleep after a request that took `elapsedMs`, so two requests start at least PROBE_INTERVAL_MS apart. */
export function paceDelay(/** @type {number} */ elapsedMs) {
  return Math.max(0, PROBE_INTERVAL_MS - elapsedMs);
}

/**
 * The commit of a health answer, or null when `body` is not one: exactly the route's shape `{ ok: true, commit, built }`
 * with a commit and a build time that are strings (the route says "unknown" for a build that was not stamped). A holding
 * page or an error page that answers 200 with some other body is not the app answering.
 * @param {unknown} body  the parsed JSON of a 200 answer
 * @returns {string | null}
 */
export function healthCommit(body) {
  if (typeof body !== "object" || body === null) return null;
  const { ok, commit, built } = /** @type {Record<string, unknown>} */ (body);
  return ok === true && typeof commit === "string" && commit !== "" && typeof built === "string" ? commit : null;
}

/**
 * A failure is any status but 200 and 429 (0 is a network error or a timeout), and a 200 without a commit, which is a
 * 200 whose body was not the health answer (`healthCommit`). A 429 ends a failure run and is counted in `throttled`. The
 * commit change is the `t` of the first sample whose commit differs from the first commit seen; samples without a commit
 * are skipped there.
 * @param {{ t: number; status: number; ms: number; commit: string | null }[]} samples
 * @returns {{ longestFailRun: number; slowestMs: number; commitChangedAt: number | null; throttled: number }}
 */
export function summarize(samples) {
  let longestFailRun = 0, run = 0, slowestMs = 0, throttled = 0;
  /** @type {string | null} */ let firstCommit = null;
  /** @type {number | null} */ let commitChangedAt = null;
  for (const s of samples) {
    slowestMs = Math.max(slowestMs, s.ms);
    if (s.status === 429) { throttled++; run = 0; }
    else if (s.status === 200 && s.commit !== null) run = 0;
    else longestFailRun = Math.max(longestFailRun, ++run);
    if (s.commit === null) continue;
    if (firstCommit === null) firstCommit = s.commit;
    else if (commitChangedAt === null && s.commit !== firstCommit) commitChangedAt = s.t;
  }
  return { longestFailRun, slowestMs, commitChangedAt, throttled };
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything the probe settles before its first request to the health route: the arguments, the origin allowlist, and
 * on staging the access code (environment, then `.smoke.local`) and the cookie the access route gives for it. Returns
 * `stop` (an exit code and a message for stderr) when the probe must not start: 2 for a bad usage, a refused origin or
 * a staging origin with no code, all before any request; 1 for a code the access route did not accept. The code goes
 * to `cookieFn` only for staging, and for a local server when one is set; never to live.
 * @param {string[]} args  process.argv.slice(2)
 * @param {{ env?: Record<string, string | undefined>; local?: Record<string, string>; cookieFn?: typeof stagingCookie }} [deps]
 * @returns {Promise<{ stop: { exit: number; message: string } | null; origin: string; seconds: number; headers: { Cookie: string } | undefined }>}
 */
export async function probeStart(args, { env = process.env, local = readLocal(), cookieFn = stagingCookie } = {}) {
  const [arg, secondsArg] = args;
  const seconds = Number(secondsArg);
  const stop = (/** @type {number} */ exit, /** @type {string} */ message) => ({ stop: { exit, message }, origin: "", seconds, headers: undefined });
  if (!arg || !(seconds > 0)) return stop(2, "usage: node scripts/probe.mjs <origin> <seconds>   (staging: STAGING_ACCESS_CODE in the environment or in .smoke.local)");
  const target = classifyOrigin(arg);
  if (!target) return stop(2, originRefusal(arg));
  const { origin, kind } = target;
  const code = kind === "live" ? undefined : valueOf("STAGING_ACCESS_CODE", local, env);
  if (kind === "staging" && !code) {
    return stop(2, "No staging access code: set STAGING_ACCESS_CODE in the environment or in .smoke.local at the repository root (the value of the staging host's STAGING_ACCESS_KEY, docs/system/variables.md section 7). Without it every answer is the lock's 404 and the probe would measure nothing.");
  }
  if (!code) return { stop: null, origin, seconds, headers: undefined };
  const cookie = await cookieFn(origin, code);
  if (!cookie) return stop(1, "STAGING_ACCESS_CODE is set but the access route gave no cookie: a wrong code, its 5 tries per 15 minutes used up, or an origin that is not staging.");
  return { stop: null, origin, seconds, headers: { Cookie: cookie } };
}

async function main() {
  const { stop, origin, seconds, headers } = await probeStart(process.argv.slice(2));
  if (stop) {
    console.error(stop.message);
    process.exit(stop.exit);
  }

  /** @type {{ t: number; status: number; ms: number; commit: string | null }[]} */
  const samples = [];
  /** @type {string | null} */ let lastAnswer = null;
  /** @type {string | null} */ let lastCommit = null;
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    const sent = Date.now();
    let status = 0;
    /** @type {string | null} */ let commit = null;
    try {
      const res = await fetch(`${origin}/api/health`, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      status = res.status;
      if (status === 200) commit = healthCommit(await res.json());
    } catch {
      // No answer, or a 200 whose body did not parse: the status holds what was seen (0 when there was none) and the
      // commit stays null, which `summarize` counts as a failure for a 200.
    }
    const sample = { t: (sent - started) / 1000, status, ms: Date.now() - sent, commit };
    samples.push(sample);
    const commitChanged = commit !== null && lastCommit !== null && commit !== lastCommit;
    const answer = status === 200 && commit === null ? "200 (not the health answer)" : String(status || "no answer");
    if (answer !== lastAnswer || commitChanged) {
      console.log(`${sample.t.toFixed(1).padStart(7)} s  ${answer}${commit ? `  commit ${commit.slice(0, 7)}` : ""}${commitChanged ? "  (commit changed)" : ""}  ${sample.ms} ms`);
    }
    lastAnswer = answer;
    if (commit !== null) lastCommit = commit;
    await sleep(paceDelay(Date.now() - sent));
  }

  const s = summarize(samples);
  console.log(`requests: ${samples.length}`);
  console.log(`longest run of failed requests: ${s.longestFailRun}`);
  console.log(`slowest answer: ${s.slowestMs} ms`);
  console.log(`commit changed at: ${s.commitChangedAt === null ? "never" : `${s.commitChangedAt.toFixed(1)} s`}`);
  console.log(`throttled (429): ${s.throttled}`);
  if (s.throttled > 0) {
    console.log("throttled above 0 means something else shares the health bucket, or the host forwards no client address (docs/system/permissions.md row 153).");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
