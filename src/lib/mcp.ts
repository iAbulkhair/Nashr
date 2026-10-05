import { randomBytes } from "crypto";
import { db } from "./db";
import { grantHoldsAccess, revokeAllGrants, tokenHash } from "./oauth";
import { getUser, type User } from "./auth";
import type { Action } from "./roles";

/**
 * The role each /api/mcp tool needs, the same action the web route for that work checks (src/lib/roles.ts). A bearer
 * resolves only to an owner today (userFromBearer below), so these all pass for a valid token; they are here so that a
 * token ever issued to a lower role, or a user resolved with no actor, is held to the same table and never to less. A
 * tool missing from this map is refused. ask_noor's own tools (update_brand, publish_item) are gated inside runTool.
 * `handoff_note` (a chat tool) is deliberately absent: it is not offered over MCP, and runTool refuses it there.
 * It lives here rather than in the route file because a Next.js route module may export only handlers and route config.
 */
export const MCP_TOOL_ACTION: Readonly<Record<string, Action>> = { ask_noor: "chat", generate_content: "generate", list_inbox: "read", read_file: "read", list_files: "read", get_brand_rules: "read", check_brand: "read", save_draft: "drafts", agenda_get: "read", agenda_next: "read", todo_create: "todo.write", todo_update: "todo.write", todo_propose_done: "todo.write" };

/**
 * Personal MCP tokens: `Authorization: Bearer nashr_...` → user. Stored only as a hash (src/lib/oauth.ts `tokenHash`):
 * `mcptoken:<hash>` → email, and `mcptoken-of:<email>` → that hash. The token itself is returned once, at creation, and
 * can never be read back. A token minted before hashing lives under `mcptoken:<raw>` and `mcptoken-of:<email>` → raw
 * until its first use moves it (`userFromBearer`).
 */
export async function createMcpToken(email: string) {
  const token = "nashr_" + randomBytes(24).toString("base64url");
  const h = tokenHash(token);
  await Promise.all([db.set(`mcptoken:${h}`, email), db.set(`mcptoken-of:${email}`, h)]);
  return token;
}
/** The stored hash of the account's personal token (or, before migration, the raw value), for "is there one" only. */
export async function getMcpToken(email: string) {
  return db.get<string>(`mcptoken-of:${email}`);
}
export async function revokeMcpToken(email: string) {
  const t = await getMcpToken(email);
  // A pre-hashing value may have been moved to its hashed key by a use since: both forms go.
  const keys = t ? (t.startsWith("nashr_") ? [`mcptoken:${t}`, `mcptoken:${tokenHash(t)}`] : [`mcptoken:${t}`]) : [];
  await Promise.all([...keys.map((k) => db.del(k)), db.del(`mcptoken-of:${email}`)]);
}
/** Personal token and every OAuth grant of the account (password reset, founder reset, account deletion). */
export async function revokeAllMcp(email: string) {
  await Promise.all([revokeMcpToken(email), revokeAllGrants(email)]);
}

/**
 * The record behind a bearer: `mcptoken:<hash>` first, then a pre-hashing `mcptoken:<raw>`, which is moved to the hashed
 * key with RENAME (one command, TTL kept) so a revocation running at the same moment either deletes it under the old
 * name first (the rename fails, the token is refused) or after (it deletes the hashed key too). A personal token's
 * `mcptoken-of` pointer follows with a compare-and-set, so a token re-minted meanwhile is never overwritten.
 */
async function bearerRecord(raw: string): Promise<{ email: string; grant?: string; hash: string } | null> {
  const hash = tokenHash(raw);
  const v = await db.get<string | { email: string; grant: string }>(`mcptoken:${hash}`);
  if (v) return typeof v === "string" ? { email: v, hash } : { email: v.email, grant: v.grant, hash };
  if (!(await db.rename(`mcptoken:${raw}`, `mcptoken:${hash}`))) return null;
  const moved = await db.get<string>(`mcptoken:${hash}`);
  if (!moved || typeof moved !== "string") return null;
  await db.replaceIf(`mcptoken-of:${moved}`, raw, hash);
  return { email: moved, hash };
}

export async function userFromBearer(req: Request): Promise<User | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(nashr_[A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  const rec = await bearerRecord(m[1]);
  if (!rec) return null;
  const email = rec.email;
  // Tokens (personal and OAuth) are minted by owners only, so a bearer resolves only to an owner account. A token whose
  // email is a member login is refused, even should an owner record exist at the same address.
  const [{ getMember }, { activeBrandId, scopeFor }] = await Promise.all([import("./team"), import("./brands")]);
  // An OAuth access token is accepted only while its grant exists and lists it (revoked, or rotated past, is refused).
  // Read alongside the account, so it costs no extra round trip.
  const [u, member, brandId, granted] = await Promise.all([getUser(email), getMember(email), activeBrandId(email), rec.grant ? grantHoldsAccess(email, rec.grant, rec.hash) : true]);
  // A suspended account is blocked everywhere, including tokens issued before the suspension.
  if (!u || u.suspended || member || !granted) return null;
  // Same scope resolution as a browser session (src/lib/auth.ts `currentUser`): without it every MCP call read and
  // wrote the default brand even while the owner had another brand active.
  u.brandId = brandId;
  u.scope = scopeFor(u.email, brandId);
  u.actor = { kind: "token", email: u.email, name: u.name, lang: u.lang, role: "owner" };
  return u;
}
