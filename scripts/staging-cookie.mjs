// What the release scripts (probe.mjs, smoke.mjs) share: the origins they may talk to, the values they read from the
// environment or `.smoke.local`, and the staging access cookie (rule 675). Node 22, no dependencies.
import { readFileSync } from "node:fs";

const LIVE = "https://thakeen.com";
const STAGING = "https://staging.thakeen.com";

/**
 * The only origins the release scripts talk to. Exactly https://thakeen.com is live (anonymous checks only, nothing
 * secret is ever sent there), exactly https://staging.thakeen.com is staging, and http://localhost:<port> or
 * http://127.0.0.1:<port> is a local server. Anything else (a typo, www, plain http, a look-alike host, a path, a port, a
 * user part) is null, so a caller can refuse it before the access code, the test password or the cron secret leave the
 * machine. One trailing slash is dropped; nothing else is normalised.
 * @param {string | undefined} arg
 * @returns {{ origin: string; kind: "live" | "staging" | "local" } | null}
 */
export function classifyOrigin(arg) {
  const origin = (arg ?? "").replace(/\/+$/, "");
  if (origin === LIVE) return { origin, kind: "live" };
  if (origin === STAGING) return { origin, kind: "staging" };
  const port = /^http:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})$/.exec(origin)?.[1];
  if (port && Number(port) >= 1 && Number(port) <= 65535) return { origin, kind: "local" };
  return null;
}

/** The refusal both scripts print for an origin `classifyOrigin` returned null for. */
export function originRefusal(/** @type {string} */ arg) {
  return `Refused origin "${arg}". The release scripts talk only to ${LIVE}, ${STAGING}, http://localhost:<port> and http://127.0.0.1:<port>; nothing was sent.`;
}

/** `.smoke.local` text as a map: KEY=value lines, blank lines, # comments and lines without a key skipped. */
export function parseLocal(/** @type {string} */ text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const at = line.indexOf("=");
    if (!line || line.startsWith("#") || at < 1) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/**
 * `.smoke.local` at the repository root (gitignored) as a map; a missing file is an empty map.
 * @param {string | URL} [file]
 * @returns {Record<string, string>}
 */
export function readLocal(file = new URL("../.smoke.local", import.meta.url)) {
  try { return parseLocal(readFileSync(file, "utf8")); } catch { return {}; }
}

/**
 * One value for a script: the environment variable of that name when it is not empty, else the same key in `.smoke.local`.
 * @param {string} key
 * @param {Record<string, string>} local  the map `readLocal` returned
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function valueOf(key, local, env = process.env) {
  return env[key] || local[key];
}

/**
 * POSTs the access form and returns the `thakeen_staging=<token>` pair to send as a Cookie header, or null when the
 * route gave none (no code, a wrong code, the route's 5 tries per 15 minutes used up, or an origin that is not
 * staging). `redirect: "manual"` keeps the 303 itself, whose Set-Cookie is the answer. The code travels only in the
 * form body and is never printed.
 * @param {string} origin e.g. https://staging.thakeen.com
 * @param {string | undefined} code
 * @returns {Promise<string | null>}
 */
export async function stagingCookie(origin, code) {
  if (!code) return null;
  const res = await fetch(`${origin}/api/staging-access`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ code, lang: "en" }),
  });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("thakeen_staging=")) ?? null;
}
