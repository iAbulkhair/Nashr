import { randomBytes } from "crypto";
import { db } from "./db";
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

/** Personal MCP tokens: `Authorization: Bearer nashr_...` → user. */
export async function createMcpToken(email: string) {
  const token = "nashr_" + randomBytes(24).toString("base64url");
  await db.set(`mcptoken:${token}`, email);
  await db.set(`mcptoken-of:${email}`, token);
  return token;
}
export async function getMcpToken(email: string) {
  return db.get<string>(`mcptoken-of:${email}`);
}
export async function revokeMcpToken(email: string) {
  const t = await getMcpToken(email);
  if (t) await db.del(`mcptoken:${t}`);
  await db.del(`mcptoken-of:${email}`);
}
/** Personal token and every OAuth grant of the account (password reset, founder reset, account deletion). */
export async function revokeAllMcp(email: string) {
  const { revokeAllGrants } = await import("./oauth");
  await Promise.all([revokeMcpToken(email), revokeAllGrants(email)]);
}
export async function userFromBearer(req: Request): Promise<User | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(nashr_[A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  const email = await db.get<string>(`mcptoken:${m[1]}`);
  if (!email) return null;
  // Tokens (personal and OAuth) are minted by owners only, so a bearer resolves only to an owner account. A token whose
  // email is a member login is refused, even should an owner record exist at the same address.
  const [{ getMember }, { activeBrandId, scopeFor }] = await Promise.all([import("./team"), import("./brands")]);
  const [u, member, brandId] = await Promise.all([getUser(email), getMember(email), activeBrandId(email)]);
  // A suspended account is blocked everywhere, including tokens issued before the suspension.
  if (!u || u.suspended || member) return null;
  // Same scope resolution as a browser session (src/lib/auth.ts `currentUser`): without it every MCP call read and
  // wrote the default brand even while the owner had another brand active.
  u.brandId = brandId;
  u.scope = scopeFor(u.email, brandId);
  u.actor = { kind: "token", email: u.email, name: u.name, lang: u.lang, role: "owner" };
  return u;
}
