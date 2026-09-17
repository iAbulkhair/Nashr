import { createHash, randomBytes } from "crypto";
import type { Provider } from "./registry";

export const REDIRECT = (id: string) => `${process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app"}/api/connect/${id}/callback`;

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
  return u.toString();
}

export async function exchangeCode(p: Provider, code: string, opts: { shop?: string; verifier?: string }): Promise<Record<string, string>> {
  const o = p.oauth!;
  const url = o.tokenUrl.replace("{shop}", opts.shop ?? "");
  const id = process.env[o.clientIdEnv]!;
  const secret = process.env[o.clientSecretEnv]!;
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT(p.id) });
  if (opts.verifier) body.set("code_verifier", opts.verifier);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (o.tokenAuth === "basic") headers.Authorization = "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
  else if (p.id === "tiktok") { body.set("client_key", id); body.set("client_secret", secret); }
  else { body.set("client_id", id); body.set("client_secret", secret); }
  if (p.id === "shopify") { body.delete("grant_type"); body.delete("redirect_uri"); }
  const res = await fetch(url, { method: "POST", headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${p.id} token ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(j)) if (v != null && typeof v !== "object") out[k] = String(v);
  if (typeof j.data === "object" && j.data) for (const [k, v] of Object.entries(j.data as Record<string, unknown>)) if (v != null && typeof v !== "object") out[k] = String(v); // TikTok wraps
  return out;
}
