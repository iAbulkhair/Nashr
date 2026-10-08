// Post-release checks (spec 2026-10-08-staging-smooth-releases, sections 5.8 and 7).
// Usage: node scripts/smoke.mjs <origin>. One PASS or FAIL line per check, exit 0 when all pass, else 1. Node 22, no dependencies.
//
// On https://thakeen.com only the anonymous checks run. On any other origin (staging) the checks that sign in, chat and
// call a cron run too. Their values come from `.smoke.local` at the repository root (gitignored, one KEY=value per
// line, no quotes; an environment variable of the same name wins): STAGING_ACCESS_CODE (the value of the staging host's
// STAGING_ACCESS_KEY), SMOKE_EMAIL, SMOKE_PASSWORD and SMOKE_CRON_SECRET (the staging CRON_SECRET). Nothing from that
// file is ever printed. All four are listed in docs/system/variables.md section 7.
//
// Not before the client-address check: do not run this, or scripts/probe.mjs, against staging until the plan's Task 13,
// step 4 has passed (docs/system/flows.md section 49, item 7). Until then a host that forwards no client address puts
// every caller of /api/health into one bucket. Nothing in this file can tell whether it has passed.
//
// /api/health allows 60 a minute per client address. A 429 there is the app answering, not an outage, so that one check
// waits for Retry-After and asks once more (fetchRetryOnce), and a 429 that survives says the bucket is shared or full.
//
// The test account (spec 4.3, made by Claude, never a customer's):
// - It needs no brand. Signup creates none, and a signed-in account without one is sent from /ar/app to /ar/app/start
//   (src/app/[lang]/app/page.tsx), which appHomeProblem accepts when /ar/app/start answers 200.
// - It must be able to chat. A trial ends after 3 days (src/lib/auth.ts createUser) and has 30 chat messages for the
//   whole trial (CHAT_ALLOWANCE in src/lib/pricing.ts), so a trial account fails the chat check with 402 trial_over or
//   chat_allowance soon after it is made. Put it on a paid plan in the founder console (POST /api/admin/plan).
// - Every staging run sends ONE real chat message to the model on the staging Anthropic key. A message costs at most
//   CHAT_TURN_MAX_USD (0.14 USD today, src/lib/pricing.ts) and counts against the account's chat allowance, so N runs
//   cost at most N x 0.14 USD. That spend is intended (spec section 7).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stagingCookie } from "./staging-cookie.mjs";

const LIVE = "https://thakeen.com";
const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 65_000;

const defaultSleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One fetch. On a 429 only, waits for Retry-After in whole seconds (a minute when the header is missing or not a whole
 * number, never more than 65 s) and fetches once more. Returns that second response whatever it is; no third try, and
 * no wait or retry for any other status.
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchRetryOnce(url, init, { fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const first = await fetchImpl(url, init);
  if (first.status !== 429) return first;
  const header = (first.headers.get("retry-after") ?? "").trim();
  const wait = /^\d+$/.test(header) ? Number(header) * 1000 : DEFAULT_WAIT_MS;
  await sleep(Math.min(wait, MAX_WAIT_MS));
  return fetchImpl(url, init);
}

/**
 * The signed-in check of `/ar/app`. The page sends an account without a brand to `/ar/app/start`, and signup creates no
 * brand, so a fresh test account gets a 307 there. That is the app answering for this session, so it follows the
 * redirect once and wants 200 from `/ar/app/start`; a 307 anywhere else (the login page: the session was not accepted)
 * or any other status fails. Returns the reason it failed, nothing when it passed.
 * @param {(path: string) => Promise<Response>} get  a GET that carries the test account's session
 * @returns {Promise<string | void>}
 */
export async function appHomeProblem(get) {
  const home = "/ar/app", onboarding = "/ar/app/start";
  let res = await get(home);
  if (res.status === 307) {
    const to = new URL(res.headers.get("location") ?? "", "http://localhost").pathname;
    if (to !== onboarding) return `got 307 to ${to}`;
    res = await get(onboarding);
    if (res.status !== 200) return `got 307 to ${onboarding}, then ${res.status} there`;
    return;
  }
  if (res.status !== 200) return `got ${res.status}`;
}

/** Why `POST /api/chat` refused, for the two refusals that follow from how old or how used the test account is. */
const CHAT_REFUSED = /** @type {Record<string, string>} */ ({
  trial_over: "the test account's 3-day trial has ended: put it on a paid plan (POST /api/admin/plan), see docs/system/variables.md section 7",
  chat_allowance: "the test account has no chat messages left for the period (a trial has 30 for the whole trial): see docs/system/variables.md section 7",
});

/**
 * The reply of `POST /api/chat` to the smoke message. Returns the reason it failed, nothing when it answered `ok: true`.
 * @param {number} status
 * @param {{ ok?: unknown; error?: unknown } | null} body  the parsed JSON, null when it did not parse
 * @returns {string | void}
 */
export function chatProblem(status, body) {
  if (status === 200 && body?.ok === true) return;
  const error = typeof body?.error === "string" ? body.error : "";
  const why = Object.hasOwn(CHAT_REFUSED, error) ? `: ${CHAT_REFUSED[error]}` : "";
  return `got ${status}${error ? ` ${error}` : ""}${why}`;
}

/** `.smoke.local` as a map: KEY=value lines, blank lines and # comments skipped, a missing file is an empty map. */
function readLocal() {
  /** @type {Record<string, string>} */
  const out = {};
  let text = "";
  try { text = readFileSync(new URL("../.smoke.local", import.meta.url), "utf8"); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const at = line.indexOf("=");
    if (!line || line.startsWith("#") || at < 1) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/** The `name=value` pair of one cookie in a response's Set-Cookie headers, or null. */
function cookiePair(/** @type {Response} */ res, /** @type {string} */ name) {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`)) ?? null;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node scripts/smoke.mjs <origin>");
    process.exit(2);
  }
  const origin = arg.replace(/\/+$/, "");
  const staging = new URL(origin).origin !== LIVE;
  const local = readLocal();
  const val = (/** @type {string} */ key) => process.env[key] || local[key];

  let stagingPair = /** @type {string | null} */ (null);
  let session = /** @type {string | null} */ (null);
  /** Request options with the Cookie header: the staging cookie, plus the session only for `signedIn` requests. */
  const init = (/** @type {RequestInit} */ extra = {}, /** @type {boolean} */ signedIn = false) => {
    const cookie = [stagingPair, signedIn ? session : null].filter(Boolean).join("; ");
    return { redirect: /** @type {const} */ ("manual"), ...extra, headers: { ...(cookie ? { Cookie: cookie } : {}), ...extra.headers } };
  };
  const call = (/** @type {string} */ path, /** @type {RequestInit} */ extra = {}, /** @type {boolean} */ signedIn = false) =>
    fetch(origin + path, init(extra, signedIn));

  let failed = 0;
  /** A check passes when `run` returns nothing; a string it returns is the reason it failed. */
  const check = async (/** @type {string} */ name, /** @type {() => Promise<string | void>} */ run) => {
    let problem;
    try { problem = await run(); } catch (e) { problem = `error: ${e instanceof Error ? e.message : String(e)}`; }
    if (problem) { failed++; console.log(`FAIL ${name}: ${problem}`); } else console.log(`PASS ${name}`);
  };
  const expectStatus = (/** @type {string} */ name, /** @type {string} */ path, /** @type {number} */ want) =>
    check(name, async () => { const r = await call(path); if (r.status !== want) return `got ${r.status}`; });

  // The lock first: on staging every other path is a bare 404 without the cookie.
  if (staging) {
    await check("staging access cookie", async () => {
      stagingPair = await stagingCookie(origin, val("STAGING_ACCESS_CODE"));
      if (!stagingPair) return "no cookie: STAGING_ACCESS_CODE missing or wrong, or the access route's 5 tries per 15 minutes are used up";
    });
  }

  await check("GET / is 307 to /ar", async () => {
    const r = await call("/");
    const to = r.headers.get("location");
    if (r.status !== 307 || !to || new URL(to, origin).pathname !== "/ar") return `got ${r.status}${to ? ` to ${to}` : ""}`;
  });
  await expectStatus("GET /ar is 200", "/ar", 200);
  await expectStatus("GET /en is 200", "/en", 200);
  await expectStatus("GET /api/tasks without a session is 401", "/api/tasks", 401);
  await expectStatus("GET /api/cron/weekly without a bearer is 401", "/api/cron/weekly", 401);
  await check("GET /api/health is 200", async () => {
    const r = await fetchRetryOnce(`${origin}/api/health`, init());
    if (r.status === 429) return "429 after one retry: the health bucket is shared or full (docs/system/permissions.md row 150), not an outage";
    if (r.status !== 200) return `got ${r.status}`;
  });

  if (staging) {
    await check("GET /robots.txt disallows everything", async () => {
      const r = await call("/robots.txt");
      // A whole line: the live file's "Disallow: /api/" also contains "Disallow: /".
      if (r.status !== 200 || !/^Disallow: \/\s*$/m.test(await r.text())) return `got ${r.status} without a "Disallow: /" line`;
    });
    await check("POST /api/auth/login signs in the test account", async () => {
      const email = val("SMOKE_EMAIL"), password = val("SMOKE_PASSWORD");
      if (!email || !password) return "SMOKE_EMAIL or SMOKE_PASSWORD missing";
      const r = await call("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      if (r.status !== 200) return `got ${r.status}`;
      session = cookiePair(r, "nashr_session");
      if (!session) return "200 but no session cookie";
    });
    await check("GET /ar/app is 200 with that session (or /ar/app/start while it has no brand)", async () => {
      if (!session) return "not signed in";
      return appHomeProblem((path) => call(path, {}, true));
    });
    await check("POST /api/chat answers ok", async () => {
      if (!session) return "not signed in";
      const r = await call("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "مرحبا" }) }, true);
      return chatProblem(r.status, await r.json().catch(() => null));
    });
    // `evening` because it makes no model call and spends no credits (src/lib/secretary-evening.ts: "Free: no credits, no
    // model call"): on an empty database it has nobody to wrap. Any other cron would run Reem's or a plan's model turn.
    await check("GET /api/cron/evening with the bearer is 200", async () => {
      const secret = val("SMOKE_CRON_SECRET");
      if (!secret) return "SMOKE_CRON_SECRET missing";
      const r = await call("/api/cron/evening", { headers: { Authorization: `Bearer ${secret}` } });
      if (r.status !== 200) return `got ${r.status}`;
    });
  }

  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
