import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { appOrigin } from "./origin";

/**
 * Minimal OAuth 2.1 authorization server for the Nashr MCP (PKCE S256, dynamic client
 * registration, refresh tokens). Access tokens reuse the `mcptoken:` lookup so /api/mcp
 * accepts both personal tokens and OAuth tokens.
 */
export const SCOPES = ["noor"];
const ACCESS_TTL = 60 * 60 * 24 * 30; // 30d
const REFRESH_TTL = 60 * 60 * 24 * 90;

export type Client = { client_id: string; client_secret?: string; client_name?: string; redirect_uris: string[]; created_at: number };

export function metadata() {
  const o = appOrigin();
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/api/oauth/token`,
    registration_endpoint: `${o}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: SCOPES,
  };
}
export function resourceMetadata() {
  const o = appOrigin();
  return { resource: `${o}/api/mcp`, authorization_servers: [o], bearer_methods_supported: ["header"], scopes_supported: SCOPES, resource_name: "Thakeen — Noor" };
}

/**
 * Hosts that may be reached over plain http. OAuth 2.1 (§4.1.3) requires https for every redirect URI, with one
 * exception: a native client listening on the loopback interface, which cannot obtain a certificate. Anything else
 * over http means the authorization code — and with it the account — crosses the network in the clear.
 *
 * RFC 8252 §7.3 prefers the IP literals because "localhost" depends on a resolver. It is accepted anyway: the MCP
 * clients that register here use it, it still resolves to the loopback interface on every system this runs on, and
 * refusing it would push those clients to register a real http host, which is the outcome this guards against.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function validRedirectUri(u: unknown): u is string {
  if (typeof u !== "string") return false;
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  // RFC 6749 §3.1.2: a redirect URI is absolute and carries no fragment.
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export async function registerClient(body: { redirect_uris?: string[]; client_name?: string; token_endpoint_auth_method?: string }): Promise<Client> {
  // Was /^https?:\/\//, which accepted http://anywhere. A client could register a plaintext redirect on a host it
  // controlled and receive an authorization code for someone else's account over the open network.
  const uris = (body.redirect_uris ?? []).filter(validRedirectUri).slice(0, 10);
  if (!uris.length) throw new Error("invalid_redirect_uri");
  const c: Client = { client_id: "nc_" + randomBytes(12).toString("hex"), client_name: (body.client_name ?? "").slice(0, 100), redirect_uris: uris, created_at: Math.floor(Date.now() / 1000) };
  if (body.token_endpoint_auth_method === "client_secret_post") c.client_secret = randomBytes(24).toString("base64url");
  await db.set(`oauthclient:${c.client_id}`, c);
  return c;
}
export async function getClient(id: string) {
  return db.get<Client>(`oauthclient:${id}`);
}

/**
 * Tokens and codes are stored under the SHA-256 (hex) of their value, never the value itself: a read of the database (a
 * leaked dump, a support query, a log of keys) yields nothing that authenticates. Keys keep their prefixes
 * (`mcptoken:<hash>`, `oauthrefresh:<hash>`, `oauthcode:<hash>`); a raw token always starts with `nashr_`, so the two
 * forms never collide. Values minted before this change live under the raw key: they are found there once and moved.
 */
export const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");
const isRaw = (t: string) => t.startsWith("nashr_");

type CodeRec = { client_id: string; redirect_uri: string; challenge: string; email: string; scope: string };
export async function issueCode(p: CodeRec) {
  const code = randomBytes(24).toString("base64url");
  await db.set(`oauthcode:${tokenHash(code)}`, p, 600);
  return code;
}
export async function redeemCode(code: string, client_id: string, redirect_uri: string, verifier: string) {
  // GETDEL: of two exchanges of the same code exactly one gets it (a GET then a DEL let both through, two grants).
  // The raw key is a code issued before hashing, within its 10 minutes.
  const p = (await db.getdel<CodeRec>(`oauthcode:${tokenHash(code)}`)) ?? (await db.getdel<CodeRec>(`oauthcode:${code}`));
  if (!p) return null;
  if (p.client_id !== client_id || p.redirect_uri !== redirect_uri) return null;
  const expected = createHash("sha256").update(verifier).digest("base64url");
  if (expected !== p.challenge) return null;
  return p;
}
/**
 * One grant per connected client per account: the record the owner sees under "Connected apps" and can revoke. It holds
 * the hashes of the live token pair, and is the authority for both: an access token names its grant and is accepted only
 * while that grant exists and still lists it (src/lib/mcp.ts `userFromBearer`), a refresh token likewise. Revoking the
 * grant therefore ends every token ever issued under it, including one minted by a refresh that lost a race.
 * `access`/`refresh` are the raw pair of a grant written before hashing; they are only read to delete those tokens.
 */
export type Grant = { id: string; client_id: string; client_name: string; scope: string; createdAt: string; lastIssuedAt: string; accessHash?: string; refreshHash?: string; access?: string; refresh?: string };
export type AccessRec = { email: string; grant: string };
type RefreshRec = { email: string; client_id: string; scope: string; grant?: string };
export const grantKey = (email: string, id: string) => `mcpgrant:${email}:${id}`;

/** Every key a grant's tokens may live under: hashed, and the raw ones of a pre-hashing grant. */
function grantTokenKeys(g: Grant): string[] {
  const keys: string[] = [];
  if (g.accessHash) keys.push(`mcptoken:${g.accessHash}`);
  if (g.refreshHash) keys.push(`oauthrefresh:${g.refreshHash}`);
  if (g.access) keys.push(`mcptoken:${g.access}`, `mcptoken:${tokenHash(g.access)}`);
  if (g.refresh) keys.push(`oauthrefresh:${g.refresh}`, `oauthrefresh:${tokenHash(g.refresh)}`);
  return keys;
}

/** Is this access token (by hash, or raw for a pre-hashing grant) the one its grant lists now? */
export async function grantHoldsAccess(email: string, grant: string, hash: string, raw?: string): Promise<boolean> {
  const g = await db.get<Grant>(grantKey(email, grant));
  return !!g && (g.accessHash === hash || (!!raw && g.access === raw));
}

/**
 * Mint a pair under a new grant (`prev` absent) or rotate an existing one. A rotation writes the grant with SET XX, so a
 * grant revoked meanwhile is never brought back; it then answers null and the tokens it wrote are unusable, because no
 * grant lists them.
 */
async function mint(email: string, client_id: string, scope: string, prev: Grant | null) {
  const access = "nashr_" + randomBytes(24).toString("base64url");
  const refresh = "nashr_r_" + randomBytes(24).toString("base64url");
  const id = prev?.id ?? randomBytes(8).toString("hex");
  const client = await getClient(client_id);
  const now = new Date().toISOString();
  const accessHash = tokenHash(access), refreshHash = tokenHash(refresh);
  const grant: Grant = { id, client_id, client_name: client?.client_name || client_id, scope, createdAt: prev?.createdAt ?? now, lastIssuedAt: now, accessHash, refreshHash };
  if (prev) {
    if (!(await db.setXx(grantKey(email, id), grant, REFRESH_TTL))) return null;
  } else await db.set(grantKey(email, id), grant, REFRESH_TTL);
  await Promise.all([
    db.set(`mcptoken:${accessHash}`, { email, grant: id } satisfies AccessRec, ACCESS_TTL),
    db.set(`oauthrefresh:${refreshHash}`, { email, client_id, scope, grant: id } satisfies RefreshRec, REFRESH_TTL),
    db.sadd(`mcpgrants:${email}`, id),
    // Rotation: the previous access token must not stay valid for the rest of its 30 days.
    ...(prev ? grantTokenKeys(prev).map((k) => db.del(k)) : []),
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope };
}

export async function issueTokens(email: string, client_id: string, scope: string) {
  return (await mint(email, client_id, scope, null))!;
}
export async function rotateRefresh(refresh: string, client_id: string) {
  const hash = tokenHash(refresh);
  // GETDEL: of two refreshes with the same token exactly one gets the record. With GET then DEL both passed, each minted
  // a pair, and the grant kept only the last one: the other pair was tracked nowhere and survived every revocation.
  const p = (await db.getdel<RefreshRec>(`oauthrefresh:${hash}`)) ?? (isRaw(refresh) ? await db.getdel<RefreshRec>(`oauthrefresh:${refresh}`) : null);
  // A refresh token with no grant (issued before grants existed) could never be revoked by its owner: refused.
  if (!p || p.client_id !== client_id || !p.grant) return null;
  // The grant must still exist (not revoked) and still list this token (not one a lost race left behind).
  const g = await db.get<Grant>(grantKey(p.email, p.grant));
  if (!g || (g.refreshHash !== hash && g.refresh !== refresh)) return null;
  return mint(p.email, client_id, p.scope, g);
}

/** Connected apps of an account, newest first, without the tokens. Expired grants drop out of the index here. */
export async function listGrants(email: string): Promise<Omit<Grant, "access" | "refresh" | "accessHash" | "refreshHash">[]> {
  const ids = await db.smembers(`mcpgrants:${email}`);
  const rows = await Promise.all(ids.map((id) => db.get<Grant>(grantKey(email, id))));
  await Promise.all(ids.filter((_, i) => !rows[i]).map((id) => db.srem(`mcpgrants:${email}`, id)));
  return rows
    .filter((g): g is Grant => !!g)
    .map(({ id, client_id, client_name, scope, createdAt, lastIssuedAt }) => ({ id, client_id, client_name, scope, createdAt, lastIssuedAt }))
    .sort((a, b) => (a.lastIssuedAt < b.lastIssuedAt ? 1 : -1));
}
/** Revoke one connected app: both tokens stop working at once. The grant is looked up under the caller's own email only. */
export async function revokeGrant(email: string, id: string): Promise<boolean> {
  const g = await db.get<Grant>(grantKey(email, id));
  if (!g) return false;
  // The grant record goes first in the same round: once it is gone no token of this grant is accepted, whatever survives.
  await Promise.all([db.del(grantKey(email, id)), ...grantTokenKeys(g).map((k) => db.del(k)), db.srem(`mcpgrants:${email}`, id)]);
  return true;
}
export async function revokeAllGrants(email: string): Promise<number> {
  const ids = await db.smembers(`mcpgrants:${email}`);
  return (await Promise.all(ids.map((id) => revokeGrant(email, id)))).filter(Boolean).length;
}
