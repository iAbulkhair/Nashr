import { createHash, randomBytes } from "crypto";
import { db } from "./db";

/**
 * Minimal OAuth 2.1 authorization server for the Nashr MCP (PKCE S256, dynamic client
 * registration, refresh tokens). Access tokens reuse the `mcptoken:` lookup so /api/mcp
 * accepts both personal tokens and OAuth tokens.
 */
export const ORIGIN = () => process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app";
export const SCOPES = ["noor"];
const ACCESS_TTL = 60 * 60 * 24 * 30; // 30d
const REFRESH_TTL = 60 * 60 * 24 * 90;

export type Client = { client_id: string; client_secret?: string; client_name?: string; redirect_uris: string[]; created_at: number };

export function metadata() {
  const o = ORIGIN();
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
  const o = ORIGIN();
  return { resource: `${o}/api/mcp`, authorization_servers: [o], bearer_methods_supported: ["header"], scopes_supported: SCOPES, resource_name: "Nashr — Noor" };
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

export async function issueCode(p: { client_id: string; redirect_uri: string; challenge: string; email: string; scope: string }) {
  const code = randomBytes(24).toString("base64url");
  await db.set(`oauthcode:${code}`, p, 600);
  return code;
}
export async function redeemCode(code: string, client_id: string, redirect_uri: string, verifier: string) {
  const p = await db.get<{ client_id: string; redirect_uri: string; challenge: string; email: string; scope: string }>(`oauthcode:${code}`);
  if (!p) return null;
  await db.del(`oauthcode:${code}`);
  if (p.client_id !== client_id || p.redirect_uri !== redirect_uri) return null;
  const expected = createHash("sha256").update(verifier).digest("base64url");
  if (expected !== p.challenge) return null;
  return p;
}
/**
 * One grant per connected client per account: the record the owner sees under "Connected apps" and can revoke. It holds the
 * live token pair so revoking deletes both at once, with no extra read on the MCP request path.
 */
export type Grant = { id: string; client_id: string; client_name: string; scope: string; createdAt: string; lastIssuedAt: string; access: string; refresh: string };
const grantKey = (email: string, id: string) => `mcpgrant:${email}:${id}`;

export async function issueTokens(email: string, client_id: string, scope: string, grantId?: string) {
  const access = "nashr_" + randomBytes(24).toString("base64url");
  const refresh = "nashr_r_" + randomBytes(24).toString("base64url");
  const id = grantId ?? randomBytes(8).toString("hex");
  const [prev, client] = await Promise.all([grantId ? db.get<Grant>(grantKey(email, id)) : null, getClient(client_id)]);
  const now = new Date().toISOString();
  const grant: Grant = { id, client_id, client_name: client?.client_name || client_id, scope, createdAt: prev?.createdAt ?? now, lastIssuedAt: now, access, refresh };
  await Promise.all([
    db.set(`mcptoken:${access}`, email, ACCESS_TTL),
    db.set(`oauthrefresh:${refresh}`, { email, client_id, scope, grant: id }, REFRESH_TTL),
    db.set(grantKey(email, id), grant, REFRESH_TTL),
    db.sadd(`mcpgrants:${email}`, id),
    // Rotation: the previous access token must not stay valid for the rest of its 30 days.
    prev?.access ? db.del(`mcptoken:${prev.access}`) : null,
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope };
}
export async function rotateRefresh(refresh: string, client_id: string) {
  const p = await db.get<{ email: string; client_id: string; scope: string; grant?: string }>(`oauthrefresh:${refresh}`);
  if (!p || p.client_id !== client_id) return null;
  await db.del(`oauthrefresh:${refresh}`);
  return issueTokens(p.email, client_id, p.scope, p.grant);
}

/** Connected apps of an account, newest first, without the tokens. Expired grants drop out of the index here. */
export async function listGrants(email: string): Promise<Omit<Grant, "access" | "refresh">[]> {
  const ids = await db.smembers(`mcpgrants:${email}`);
  const rows = await Promise.all(ids.map((id) => db.get<Grant>(grantKey(email, id))));
  await Promise.all(ids.filter((_, i) => !rows[i]).map((id) => db.srem(`mcpgrants:${email}`, id)));
  return rows.filter((g): g is Grant => !!g).map(({ access: _a, refresh: _r, ...g }) => { void _a; void _r; return g; }).sort((a, b) => (a.lastIssuedAt < b.lastIssuedAt ? 1 : -1));
}
/** Revoke one connected app: both tokens stop working at once. The grant is looked up under the caller's own email only. */
export async function revokeGrant(email: string, id: string): Promise<boolean> {
  const g = await db.get<Grant>(grantKey(email, id));
  if (!g) return false;
  await Promise.all([db.del(`mcptoken:${g.access}`), db.del(`oauthrefresh:${g.refresh}`), db.del(grantKey(email, id)), db.srem(`mcpgrants:${email}`, id)]);
  return true;
}
export async function revokeAllGrants(email: string): Promise<number> {
  const ids = await db.smembers(`mcpgrants:${email}`);
  return (await Promise.all(ids.map((id) => revokeGrant(email, id)))).filter(Boolean).length;
}
