import { createHash, randomBytes } from "crypto";
import { providerTimeout } from "../fetch-timeout";
import { PROVIDER_REPLY_BYTES, responseJson, responseText } from "../read-capped";
import type { Provider } from "./registry";
import { appOrigin } from "../origin";

export const REDIRECT = (id: string) => `${appOrigin()}/api/connect/${id}/callback`;

/** Above this an `expires` value is a Unix time in seconds (2001-09-09), below it a lifetime: no token lives 31 years. */
const UNIX_SECONDS = 1e9;

/**
 * When a token answer's access token lapses (rule 2176), or undefined when the answer does not say. `expires_in` is
 * the OAuth field (RFC 6749 §5.1, seconds from now). Salla's documented answer carries `expires` instead, written once
 * as a Unix time and once as seconds, so both readings are taken. Without this a Salla connection kept no expiry, was
 * never refreshed early, and was lost when its 14-day token lapsed although its refresh token was still good.
 */
export function tokenExpiry(data: Record<string, string>, now = Date.now()): string | undefined {
  const lifetime = Number(data.expires_in);
  if (Number.isFinite(lifetime) && lifetime > 0) return new Date(now + lifetime * 1000).toISOString();
  const expires = Number(data.expires);
  if (!Number.isFinite(expires) || expires <= 0) return undefined;
  return new Date(expires > UNIX_SECONDS ? expires * 1000 : now + expires * 1000).toISOString();
}

export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(p: Provider, state: string, opts: { shop?: string; challenge?: string }) {
  const o = p.oauth!;
  const base = o.authorizeUrl.replace("{shop}", opts.shop ?? "");
  const u = new URL(base);
  u.searchParams.set("client_id", process.env[o.clientIdEnv]!);
  u.searchParams.set("redirect_uri", REDIRECT(p.id));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  if (o.scopes.length) u.searchParams.set("scope", o.scopes.join(o.scopeSeparator ?? " "));
  if (o.pkce && opts.challenge) {
    u.searchParams.set("code_challenge", opts.challenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  if (p.id === "tiktok") { u.searchParams.set("client_key", process.env[o.clientIdEnv]!); u.searchParams.delete("client_id"); }
  for (const [k, v] of Object.entries(o.extraAuthParams ?? {})) u.searchParams.set(k, v);
  // A Business-type Meta app using Facebook Login for Business names its permissions in a configuration, not in scope.
  if (p.id === "meta" && process.env.META_CONFIG_ID) { u.searchParams.set("config_id", process.env.META_CONFIG_ID); u.searchParams.delete("scope"); }
  return u.toString();
}

/** " invalid_grant" when the body is an RFC 6749 error answer with a plain code, else "" (never the description). */
export function oauthErrorCode(text: string): string {
  try {
    const code = (JSON.parse(text) as { error?: unknown }).error;
    return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? ` ${code}` : "";
  } catch {
    return "";
  }
}

/** POST to the provider's token URL with the client authentication each provider expects, and flatten the answer. */
async function tokenRequest(p: Provider, body: URLSearchParams, shop?: string): Promise<Record<string, string>> {
  const o = p.oauth!;
  const url = o.tokenUrl.replace("{shop}", shop ?? "");
  const id = process.env[o.clientIdEnv]!;
  const secret = process.env[o.clientSecretEnv]!;
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (o.tokenAuth === "basic") headers.Authorization = "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
  else if (p.id === "tiktok") { body.set("client_key", id); body.set("client_secret", secret); }
  else { body.set("client_id", id); body.set("client_secret", secret); }
  const res = await fetch(url, { method: "POST", headers, body, signal: providerTimeout() });
  // The provider, the status and the OAuth error code only (rule 1354): the rest of a refused exchange's body is the
  // provider's own text, which reaches the logs and can echo what was sent. The code (RFC 6749 §5.2, such as
  // `invalid_grant`) is a fixed word, and the calendar sync reads it to tell a lost link from a passing failure. A
  // refusal too large to read keeps its status (rule 2250).
  if (!res.ok) {
    const text = await responseText(res, PROVIDER_REPLY_BYTES).catch(() => "");
    throw new Error(`${p.id} token ${res.status}${oauthErrorCode(text)}`);
  }
  const j = await responseJson<Record<string, unknown>>(res, PROVIDER_REPLY_BYTES);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(j)) if (v != null && typeof v !== "object") out[k] = String(v);
  if (typeof j.data === "object" && j.data) for (const [k, v] of Object.entries(j.data as Record<string, unknown>)) if (v != null && typeof v !== "object") out[k] = String(v); // TikTok wraps
  return out;
}

/**
 * Trade a refresh token for a new access token. Providers that rotate it (X) return a new refresh token too. Zid's docs
 * (Authorization, read 2026-10-18) list `redirect_uri` in the refresh body as well, so it goes with Zid's (rule 2213).
 */
export async function refreshTokens(p: Provider, refreshToken: string, shop?: string): Promise<Record<string, string>> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (p.id === "zid") body.set("redirect_uri", REDIRECT(p.id));
  return tokenRequest(p, body, shop);
}

export async function exchangeCode(p: Provider, code: string, opts: { shop?: string; verifier?: string }): Promise<Record<string, string>> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT(p.id) });
  if (opts.verifier) body.set("code_verifier", opts.verifier);
  if (p.id === "shopify") { body.delete("grant_type"); body.delete("redirect_uri"); }
  return tokenRequest(p, body, opts.shop);
}
