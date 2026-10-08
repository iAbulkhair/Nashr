// Watches GET /api/health while the site rebuilds (spec 2026-10-08-staging-smooth-releases, section 5.8).
// Usage: node scripts/probe.mjs <origin> <seconds>. On staging, STAGING_ACCESS_CODE in the environment (the value of the
// staging host's STAGING_ACCESS_KEY; listed in docs/system/variables.md section 7). Node 22, no dependencies.
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
import { stagingCookie } from "./staging-cookie.mjs";

export const PROBE_INTERVAL_MS = 1200;
// A request that hangs during the switch is recorded as a failure after this long, instead of stalling the loop.
const PROBE_TIMEOUT_MS = 10_000;

/** How long to sleep after a request that took `elapsedMs`, so two requests start at least PROBE_INTERVAL_MS apart. */
export function paceDelay(/** @type {number} */ elapsedMs) {
  return Math.max(0, PROBE_INTERVAL_MS - elapsedMs);
}

/**
 * A failure is any status but 200 and 429 (0 is a network error or a timeout). A 429 ends a failure run and is counted
 * in `throttled`. The commit change is the `t` of the first sample whose commit differs from the first commit seen;
 * samples without a commit (failures, 429s) are skipped.
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
    else if (s.status === 200) run = 0;
    else longestFailRun = Math.max(longestFailRun, ++run);
    if (s.commit === null) continue;
    if (firstCommit === null) firstCommit = s.commit;
    else if (commitChangedAt === null && s.commit !== firstCommit) commitChangedAt = s.t;
  }
  return { longestFailRun, slowestMs, commitChangedAt, throttled };
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const [arg, secondsArg] = process.argv.slice(2);
  const seconds = Number(secondsArg);
  if (!arg || !(seconds > 0)) {
    console.error("usage: node scripts/probe.mjs <origin> <seconds>   (staging: STAGING_ACCESS_CODE in the environment)");
    process.exit(2);
  }
  const origin = arg.replace(/\/+$/, "");
  const code = process.env.STAGING_ACCESS_CODE;
  const cookie = await stagingCookie(origin, code);
  if (code && !cookie) {
    console.error("STAGING_ACCESS_CODE is set but the access route gave no cookie: a wrong code, its 5 tries per 15 minutes used up, or an origin that is not staging.");
    process.exit(1);
  }
  const headers = cookie ? { Cookie: cookie } : undefined;

  /** @type {{ t: number; status: number; ms: number; commit: string | null }[]} */
  const samples = [];
  /** @type {number | null} */ let lastStatus = null;
  /** @type {string | null} */ let lastCommit = null;
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    const sent = Date.now();
    let status = 0;
    /** @type {string | null} */ let commit = null;
    try {
      const res = await fetch(`${origin}/api/health`, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      status = res.status;
      if (status === 200) {
        const body = await res.json();
        commit = typeof body?.commit === "string" ? body.commit : null;
      }
    } catch {
      // No answer (or a body that did not parse): the status already holds what was seen, 0 when there was none.
    }
    const sample = { t: (sent - started) / 1000, status, ms: Date.now() - sent, commit };
    samples.push(sample);
    const commitChanged = commit !== null && lastCommit !== null && commit !== lastCommit;
    if (status !== lastStatus || commitChanged) {
      console.log(`${sample.t.toFixed(1).padStart(7)} s  ${status || "no answer"}${commit ? `  commit ${commit.slice(0, 7)}` : ""}${commitChanged ? "  (commit changed)" : ""}  ${sample.ms} ms`);
    }
    lastStatus = status;
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
