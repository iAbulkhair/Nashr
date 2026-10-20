import { createHash, createPublicKey, randomBytes, verify as verifySig, type JsonWebKey } from "crypto";
import { cookies } from "next/headers";
import { db } from "./db";
import { createUser, getLogin, normalizeEmail, validEmail, type Login } from "./auth";
import { appOrigin } from "./origin";
import { sameSecret } from "./rate";
import { safeNext } from "./safe-next";
import { withLoginLock } from "./team";
import { accountKey, globalKey } from "./keys";

/**
 * Sign in with Google (rules 1946-1953, docs/specs/2026-10-13-google-sign-in.md), OFF until both
 * `GOOGLE_SIGNIN_CLIENT_ID` and `GOOGLE_SIGNIN_CLIENT_SECRET` are set (docs/system/variables.md). Without them the
 * routes answer 404 and the buttons are not drawn. Its own OAuth client, separate from the connectors' `GOOGLE_CLIENT_*`:
 * sign-in asks for `openid email profile` only.
 *
 * The flow is the authorization code flow with PKCE (S256), a random `state` bound to this browser by an httpOnly
 * cookie, and a `nonce` checked inside the ID token. Every URL is fixed: Google's endpoints are constants and the
 * redirect is `appOrigin()` + a fixed path, never anything from the request. The ID token comes straight from Google's
 * token endpoint over TLS and is still verified: RS256 against Google's published keys, issuer, audience, expiry,
 * nonce, and `email_verified`.
 *
 * Stored (rule 679 expand: new keys only):
 *   gsi:state:{sha256(state)}  {nonce, verifier, mode, next, lang, ref, at, login?}, 10 minutes, taken once (GETDEL)
 *   google:{sub}               the login email this Google account signs in to
 *   googlesub:{login}          the Google `sub` linked to this login (one per login)
 * A link is made only to an owner whose address is already proved, or by the signed-in login itself from settings
 * (mode "link"); never to an unproved owner or a member by address alone, so a password account somebody opened in
 * another person's name is never handed to them, nor theirs to it.
 */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
export const GSI_COOKIE = "thakeen_gsi";
export const GSI_STATE_TTL = 600;
export const CALLBACK_PATH = "/api/auth/google/callback";
const SUB = /^[A-Za-z0-9_-]{1,255}$/;

export type GoogleMode = "login" | "signup" | "link";
type State = { nonce: string; verifier: string; mode: GoogleMode; next: string; lang: "ar" | "en"; ref: string; at: number; /** Mode "link": the login that started it; the callback must run in the same login. */ login?: string };

/** Both names set, or null: the switch for the whole feature. */
export function googleConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = (process.env.GOOGLE_SIGNIN_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_SIGNIN_CLIENT_SECRET ?? "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
export const googleSignInOn = () => googleConfig() !== null;
export const redirectUri = () => `${appOrigin()}${CALLBACK_PATH}`;

const b64url = (b: Buffer) => b.toString("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const stateKey = (state: string) => `gsi:state:${sha(state)}`;
export const linkKey = (sub: string) => globalKey.googleAccount(sub);
export const subKey = (login: string) => accountKey.googleSub(normalizeEmail(login));

/** Begin: store the flow's secrets, bind it to this browser, and return Google's consent address. */
export async function startGoogle(input: { mode: GoogleMode; next?: unknown; lang?: unknown; ref?: unknown; login?: string }): Promise<string | null> {
  const cfg = googleConfig();
  if (!cfg) return null;
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const rec: State = {
    nonce, verifier, mode: input.mode,
    next: safeNext(input.next),
    lang: input.lang === "en" ? "en" : "ar",
    ref: typeof input.ref === "string" && /^[A-Za-z0-9]{6,10}$/.test(input.ref) ? input.ref : "",
    at: Date.now(),
    ...(input.mode === "link" && input.login ? { login: normalizeEmail(input.login) } : {}),
  };
  await db.set(stateKey(state), rec, GSI_STATE_TTL);
  (await cookies()).set(GSI_COOKIE, state, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: CALLBACK_PATH, maxAge: GSI_STATE_TTL });
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: redirectUri(), response_type: "code", scope: "openid email profile",
    state, nonce, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
  });
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

/**
 * Take the flow back: the `state` in the address must equal the one in this browser's cookie, and its record is taken
 * once. Null when either is missing, differs or has expired (a forged or replayed callback).
 */
export async function takeState(state: unknown): Promise<State | null> {
  const jar = await cookies();
  const own = jar.get(GSI_COOKIE)?.value ?? "";
  // Cleared on the same path it was set on, whatever happens next: a state is good for one try.
  jar.set(GSI_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: CALLBACK_PATH, maxAge: 0 });
  if (typeof state !== "string" || state.length < 20 || state.length > 100 || !own || !sameSecret(state, own)) return null;
  const rec = await db.getdel<State>(stateKey(state));
  if (!rec || Date.now() - Number(rec.at) > GSI_STATE_TTL * 1000) return null;
  return rec;
}

type Jwk = JsonWebKey & { kid?: string; alg?: string; kty?: string };
let certs: { at: number; keys: Jwk[] } | null = null;
async function googleKeys(fresh = false): Promise<Jwk[]> {
  if (!fresh && certs && Date.now() - certs.at < 3600_000) return certs.keys;
  const res = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!res.ok) throw new Error("google_certs");
  const j = (await res.json()) as { keys?: Jwk[] };
  certs = { at: Date.now(), keys: Array.isArray(j.keys) ? j.keys : [] };
  return certs.keys;
}

export type GoogleIdentity = { sub: string; email: string; name: string };

/** Check an ID token's signature and claims; the identity, or null. Exported for the tests. */
export async function verifyIdToken(idToken: string, expected: { clientId: string; nonce: string }, keys?: Jwk[]): Promise<GoogleIdentity | null> {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const find = (ks: Jwk[]) => ks.find((k) => k.kid === header.kid && k.kty === "RSA");
  let jwk = find(keys ?? (await googleKeys()));
  if (!jwk && !keys) jwk = find(await googleKeys(true));
  if (!jwk) return null;
  const ok = verifySig("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  const aud = claims.aud;
  if (!ISSUERS.has(String(claims.iss))) return null;
  if (!(aud === expected.clientId || (Array.isArray(aud) && aud.includes(expected.clientId)))) return null;
  if (typeof claims.exp !== "number" || claims.exp < now - 60) return null;
  if (typeof claims.iat === "number" && claims.iat > now + 300) return null;
  if (typeof claims.nonce !== "string" || !sameSecret(claims.nonce, expected.nonce)) return null;
  if (claims.email_verified !== true && claims.email_verified !== "true") return null;
  const sub = String(claims.sub ?? "");
  const email = normalizeEmail(String(claims.email ?? ""));
  if (!SUB.test(sub) || !validEmail(email)) return null;
  return { sub, email, name: typeof claims.name === "string" ? claims.name.slice(0, 80) : "" };
}

/** Trade the code for tokens at Google's fixed token address (with the PKCE verifier) and verify the ID token. */
export async function exchangeCode(code: unknown, st: State): Promise<GoogleIdentity | null> {
  const cfg = googleConfig();
  if (!cfg || typeof code !== "string" || !code || code.length > 2048) return null;
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri(), grant_type: "authorization_code", code_verifier: st.verifier }).toString(),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return null;
  const j = (await res.json().catch(() => ({}))) as { id_token?: unknown };
  if (typeof j.id_token !== "string") return null;
  return verifyIdToken(j.id_token, { clientId: cfg.clientId, nonce: st.nonce });
}

/** Link `sub` to `login`, both ways, replacing an older link of that login. Callers hold `lock:login:{login}`. */
async function writeLink(login: string, sub: string): Promise<void> {
  const prev = await db.get<string>(subKey(login));
  if (prev && prev !== sub) await db.del(linkKey(prev));
  await Promise.all([db.set(linkKey(sub), normalizeEmail(login)), db.set(subKey(login), sub)]);
}

export type Resolution =
  | { kind: "login"; login: Login }
  | { kind: "created"; login: Login; email: string }
  | { kind: "refused"; error: "google_no_account" | "google_not_linked" | "google_taken" | "google_unverified_owner" };

/**
 * Which login this Google account opens. A linked `sub` opens its login (even if the Google address has changed since).
 * Unlinked: an owner whose address is proved, at the same address, is linked and opened; an unproved owner or a member
 * at that address is refused (they sign in with the password and link from settings); no login at all is refused in
 * "login" mode and created as a new owner, address already proved, in "signup" mode.
 */
export async function resolveGoogle(id: GoogleIdentity, mode: "login" | "signup", lang: "ar" | "en"): Promise<Resolution> {
  const linked = await db.get<string>(linkKey(id.sub));
  if (linked) {
    const l = await getLogin(linked);
    if (l) return { kind: "login", login: l };
    await db.del(linkKey(id.sub)); // the login is gone: a stale link opens nothing
  }
  return withLoginLock(id.email, async (): Promise<Resolution> => {
    const l = await getLogin(id.email);
    if (l?.kind === "owner") {
      // The address is proved on the PERSON (multi-workspace M1: `login.person`; for a legacy owner the account's own stamp).
      if (!l.person.emailVerifiedAt) return { kind: "refused", error: "google_unverified_owner" };
      const other = await db.get<string>(subKey(id.email));
      if (other && other !== id.sub) return { kind: "refused", error: "google_taken" };
      await writeLink(id.email, id.sub);
      return { kind: "login", login: l };
    }
    if (l) return { kind: "refused", error: "google_not_linked" };
    // A member record that is not on its roster still holds the address.
    const { getMember } = await import("./team");
    if (await getMember(id.email)) return { kind: "refused", error: "google_not_linked" };
    if (mode !== "signup") return { kind: "refused", error: "google_no_account" };
    // No password (multi-workspace M1, rule 2132): the person has no hash, so it signs in with Google, or sets a password
    // with "forgot password". Google proved the address: the person and the account it owns are stamped in the same
    // write, under `lock:person` (reconciliation 11); a held person lock throws `person_lock_timeout` with nothing
    // written, which the callback answers as it answers a failed sign-in.
    await createUser({ email: id.email, name: id.name, phone: "", lang, emailVerifiedAt: new Date().toISOString() });
    await writeLink(id.email, id.sub);
    // The new login as every sign-in reads it (its person included), still under the login lock.
    const login = await getLogin(id.email);
    if (login?.kind !== "owner") throw new Error("google signup: the new account does not resolve");
    return { kind: "created", login, email: id.email };
  });
}

/** Mode "link": the signed-in login links this Google account to itself. */
export async function linkGoogle(login: string, id: GoogleIdentity): Promise<"ok" | "google_taken"> {
  return withLoginLock(login, async () => {
    const holder = await db.get<string>(linkKey(id.sub));
    if (holder && holder !== normalizeEmail(login) && (await getLogin(holder))) return "google_taken";
    await writeLink(login, id.sub);
    return "ok";
  });
}

/** Whether this login has a Google account linked. */
export async function googleLinked(login: string): Promise<boolean> {
  return !!(await db.get<string>(subKey(login)));
}

/**
 * An address move (src/lib/email-change.ts): the link follows the login, both ways, and nothing names the old address.
 * The caller already holds both login locks (`withLoginLock` is not reentrant). A link whose `google:{sub}` names
 * another login is only dropped here, never moved.
 */
export async function moveGoogleLink(from: string, to: string): Promise<void> {
  const sub = await db.get<string>(subKey(from));
  if (!sub) return;
  const holder = await db.get<string>(linkKey(sub));
  await db.del(subKey(from));
  if (holder === normalizeEmail(from)) await writeLink(to, sub);
}

/** Drop this login's Google link, both ways. */
export async function unlinkGoogle(login: string): Promise<void> {
  await withLoginLock(login, async () => {
    const sub = await db.get<string>(subKey(login));
    await Promise.all([db.del(subKey(login)), sub ? db.del(linkKey(sub)) : Promise.resolve()]);
  });
}
