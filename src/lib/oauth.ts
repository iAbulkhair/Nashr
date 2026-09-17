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

export async function registerClient(body: { redirect_uris?: string[]; client_name?: string; token_endpoint_auth_method?: string }): Promise<Client> {
  const uris = (body.redirect_uris ?? []).filter((u) => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 10);
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
export async function issueTokens(email: string, client_id: string, scope: string) {
  const access = "nashr_" + randomBytes(24).toString("base64url");
  const refresh = "nashr_r_" + randomBytes(24).toString("base64url");
  await db.set(`mcptoken:${access}`, email, ACCESS_TTL);
  await db.set(`oauthrefresh:${refresh}`, { email, client_id, scope }, REFRESH_TTL);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope };
}
export async function rotateRefresh(refresh: string, client_id: string) {
  const p = await db.get<{ email: string; client_id: string; scope: string }>(`oauthrefresh:${refresh}`);
  if (!p || p.client_id !== client_id) return null;
  await db.del(`oauthrefresh:${refresh}`);
  return issueTokens(p.email, client_id, p.scope);
}
