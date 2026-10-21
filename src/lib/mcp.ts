import { randomBytes } from "crypto";
import { isPersonSuspended, isSuspended } from "./suspension";
import { db } from "./db";
import { BEARER, TOKEN_PREFIX, grantHoldsAccess, revokeAllGrants, tokenHash } from "./oauth";
import { emailVerified, getUser, normalizeEmail, readLoginIndex, type User } from "./auth";
import type { Action } from "./roles";
import { accountKey, globalKey, personKey, storedAccountId, storedPersonId } from "./keys";
import { acct } from "./account-id";

/**
 * The role each /api/mcp tool needs, the same action the web route for that work checks (src/lib/roles.ts). A bearer
 * resolves only to an owner today (userFromBearer below), so these all pass for a valid token; they are here so that a
 * token ever issued to a lower role, or a user resolved with no actor, is held to the same table and never to less. A
 * tool missing from this map is refused. ask_noor's own tools (update_brand, publish_item) are gated inside runTool.
 * `handoff_note` (a chat tool) is deliberately absent: it is not offered over MCP, and runTool refuses it there.
 * It lives here rather than in the route file because a Next.js route module may export only handlers and route config.
 */
export const MCP_TOOL_ACTION: Readonly<Record<string, Action>> = { ask_noor: "chat", generate_content: "generate", list_inbox: "read", read_file: "read", list_files: "read", get_brand_rules: "read", check_brand: "read", save_draft: "drafts", agenda_get: "read", agenda_next: "read", free_slots: "read", todo_create: "todo.write", todo_update: "todo.write", todo_propose_done: "todo.write" };

/**
 * Personal MCP tokens: `Authorization: Bearer thakeen_...` (or an older `nashr_...`) → user. Stored only as a hash (src/lib/oauth.ts `tokenHash`):
 * `mcptoken:<hash>` → email, and `mcptoken-of:<email>` → that hash. The token itself is returned once, at creation, and
 * can never be read back. A token minted before hashing lives under `mcptoken:<raw>` and `mcptoken-of:<email>` → raw
 * until its first use moves it (`userFromBearer`).
 */
export async function createMcpToken(email: string) {
  const token = TOKEN_PREFIX + randomBytes(24).toString("base64url");
  const h = tokenHash(token);
  await Promise.all([db.set(globalKey.mcpToken(h), email), db.set(accountKey.mcpTokenOf(email), h)]);
  return token;
}
/** The stored hash of the account's personal token (or, before migration, the raw value), for "is there one" only. */
export async function getMcpToken(email: string) {
  return db.get<string>(accountKey.mcpTokenOf(email));
}
export async function revokeMcpToken(email: string) {
  const t = await getMcpToken(email);
  // A pre-hashing value may have been moved to its hashed key by a use since: both forms go.
  const keys = t ? (t.startsWith("nashr_") ? [globalKey.mcpToken(t), globalKey.mcpToken(tokenHash(t))] : [globalKey.mcpToken(t)]) : [];
  await Promise.all([...keys.map((k) => db.del(k)), db.del(accountKey.mcpTokenOf(email))]);
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
  const v = await db.get<string | { email: string; grant: string }>(globalKey.mcpToken(hash));
  if (v) return typeof v === "string" ? { email: v, hash } : { email: v.email, grant: v.grant, hash };
  if (!(await db.rename(globalKey.mcpToken(raw), globalKey.mcpToken(hash)))) return null;
  const moved = await db.get<string>(globalKey.mcpToken(hash));
  if (!moved || typeof moved !== "string") return null;
  await db.replaceIf(accountKey.mcpTokenOf(moved), raw, hash);
  return { email: moved, hash };
}

/**
 * The account behind a bearer (rules 2120, 2131). A token names its ACCOUNT (the record's `email` is `acct(u)` when
 * minted, rule 1985), never a browser session's `acct`, so a token never follows the person to another account. The
 * actor is the account's owner (`ownerOf`), whose person is read in the same round: for a legacy account the owner's
 * person id is the account id, known before the read; an account with `ownerPid` pays one more round. A suspended
 * person is refused like a suspended account.
 */
export async function userFromBearer(req: Request): Promise<User | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(BEARER);
  if (!m) return null;
  const rec = await bearerRecord(m[1]);
  if (!rec) return null;
  const email = rec.email;
  // Tokens (personal and OAuth) are minted by owners only, so a bearer resolves only to an owner account. A token whose
  // email is another person's login is refused: the login index at the address must name the account's owner. From M4
  // (rule 2138) no legacy member record is read; the index is the one answer to "who signs in at this address".
  const [{ activeBrandFrom, activeBrandIn, scopeFor }, { getPerson, personFromRaw }, { aidOf, ownerOf }] = await Promise.all([import("./brands"), import("./person"), import("./membership")]);
  // A legacy account's owner is the person whose id is the account id (the token record's value, which this app wrote).
  // The account must also be on the owner's `orgs:{pid}`, as sign-in requires (`listOrgs`): a record at a legacy member's
  // address (whose person id is that address) is otherwise "owned" by the member, and the index names that member too.
  const id = normalizeEmail(email);
  const legacyPid = storedPersonId(id);
  const legacyAid = storedAccountId(id);
  // An OAuth access token is accepted only while its grant exists and lists it (revoked, or rotated past, is refused).
  // Read alongside the account, with the owner's person and active brand, so none of them costs an extra round trip.
  const [u, idx, rawPerson, rawActive, legacyListed, granted] = await Promise.all([
    getUser(email),
    readLoginIndex(id),
    db.get<unknown>(personKey.person(legacyPid)),
    db.get<unknown>(personKey.activeBrand(legacyPid, legacyAid)),
    db.sismember(personKey.orgs(legacyPid), legacyAid),
    rec.grant ? grantHoldsAccess(email, rec.grant, rec.hash) : true,
  ]);
  // A suspended account is blocked everywhere, including tokens issued before the suspension; so is an owner who has
  // not proved the address yet (rule 753), which covers a token minted before the gate or by a not-yet-verified owner.
  if (!u || isSuspended(u) || !emailVerified(u) || !granted) return null;
  const pid = ownerOf(u);
  if (idx && idx.pid !== pid) return null;
  const aid = aidOf(u);
  const inRound = pid === legacyPid && aid === legacyAid && normalizeEmail(u.email) === id;
  const [person, chosen, listed] = inRound
    ? [personFromRaw(pid, rawPerson), activeBrandFrom(rawActive), legacyListed]
    : await Promise.all([getPerson(pid), activeBrandIn(pid, aid), db.sismember(personKey.orgs(pid), aid)]);
  if (!listed) return null;
  // Person suspension blocks the person in every account and every resolver, tokens included (rule 2131).
  if (!person || isPersonSuspended(person)) return null;
  // Same scope resolution as a browser session (src/lib/auth.ts `currentUser`): without it every MCP call read and
  // wrote the default brand even while the owner had another brand active. The owner's choice in THIS account.
  u.brandId = chosen;
  u.scope = scopeFor(acct(u), u.brandId);
  u.actor = { kind: "token", pid, email: u.email, name: u.name, lang: u.lang, role: "owner" };
  return u;
}
