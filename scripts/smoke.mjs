// Post-release checks (spec 2026-10-08-staging-smooth-releases, sections 5.8 and 7).
// Usage: node scripts/smoke.mjs <origin>. One PASS or FAIL line per check, exit 0 when all pass, else 1. Node 22, no dependencies.
//
// On https://thakeen.com only the anonymous checks run. On any other origin (staging) the checks that sign in, chat and
// call a cron run too. Their values come from `.smoke.local` at the repository root (gitignored, one KEY=value per
// line, no quotes; an environment variable of the same name wins): STAGING_ACCESS_CODE, SMOKE_EMAIL, SMOKE_PASSWORD
// and SMOKE_CRON_SECRET (the staging CRON_SECRET). Nothing from that file is ever printed.
//
// /api/health allows 60 a minute per client address. A 429 there is the app answering, not an outage, so that one check
// waits for Retry-After and asks once more (fetchRetryOnce), and a 429 that survives says the bucket is shared or full.
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
    await check("GET /ar/app is 200 with that session", async () => {
      if (!session) return "not signed in";
      const r = await call("/ar/app", {}, true);
      if (r.status !== 200) return `got ${r.status}`;
    });
    await check("POST /api/chat answers ok", async () => {
      if (!session) return "not signed in";
      const r = await call("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "مرحبا" }) }, true);
      const body = await r.json().catch(() => null);
      if (r.status !== 200 || body?.ok !== true) return `got ${r.status}${typeof body?.error === "string" ? ` ${body.error}` : ""}`;
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
