import type { Role, User } from "./auth";

/**
 * Who may do what inside an account: one table, used by every route, chat tool, MCP call and page
 * (docs/superpowers/specs/2026-09-29-teams-design.md §4). Enforced in code: hiding a control in the UI is display only.
 *
 * Type-only imports: this file is safe to import from client components (read-only rendering for lower roles).
 */
export const MIN_ROLE = {
  // ── Owner only ──
  /** Billing and plan: pay links, WhatsApp activation, checkout, seat changes. */
  billing: "owner",
  /** DELETE /api/account. */
  "account.delete": "owner",
  /** PUT /api/governance (agent caps, auto-approve, weekly cap, reviewer, learning). */
  "governance.write": "owner",
  /** MCP personal token: mint, rotate, revoke and status. */
  "mcp.token": "owner",
  /** OAuth consent approval (/oauth/authorize, /api/oauth/approve). */
  "oauth.approve": "owner",
  /** Connected apps: list and revoke OAuth grants (/api/mcp/grants). */
  "oauth.grants": "owner",
  /** Referral data (emails of referred people) and the refer page. */
  referral: "owner",
  /** Account-level profile fields: phone, WhatsApp, account language, email preferences. */
  "profile.account": "owner",
  /** Invite an admin, or promote a member to admin. */
  "team.invite.admin": "owner",
  /** Change any member's role. The owner role itself is never assignable. */
  "team.role": "owner",
  /** Remove an admin. */
  "team.remove.admin": "owner",

  // ── Admin and owner ──
  /** Brand file writes: PUT /api/brand, profile brand fields, chat `update_brand`. */
  "brand.write": "admin",
  /** Brands add, rename, archive. */
  "brands.manage": "admin",
  /** Onboarding: onboard, onboard/confirm, onboard plan. */
  onboard: "admin",
  /** Catalog import. */
  "catalog.import": "admin",
  /** Connectors: start, callback, key, disconnect, page and ad-account select. */
  connectors: "admin",
  /** Schedule and routines (PUT /api/schedule). */
  "schedule.write": "admin",
  /** Approve and publish: publish route, task approve, chat `publish_item`. */
  publish: "admin",
  /** Delete a core memory file. */
  "files.core.delete": "admin",
  /**
   * Write or overwrite a core memory file (PUT /api/files, chat `write_file`). Every agent reads these on every turn,
   * and writing one empty is deleting it, so it needs what deleting needs.
   */
  "files.core.write": "admin",
  /** Delete imported performance data. */
  "performance.delete": "admin",
  /** Import performance data from a CSV (POST /api/performance). An import replaces the last one: it needs what deleting needs. */
  "performance.import": "admin",
  /** Invite a plain member. */
  "team.invite.member": "admin",
  /** Remove a plain member. */
  "team.remove.member": "admin",
  /** See pending invites. */
  "team.invites.view": "admin",
  /** Cancel a pending invite (an admin only one for role "member"; see team.ts `cancelInvite`). */
  "team.invite.cancel": "admin",
  /**
   * Reem's list: close an item (complete with a result, confirm or send back an agent's claim), delete or restore it
   * (PATCH /api/secretary/{id}). Chat and MCP never close whatever the role (secretary.ts `OWNER_ONLY`).
   */
  "todo.close": "admin",

  // ── Every member ──
  chat: "member",
  generate: "member",
  images: "member",
  /** Drafts: edit, reject. */
  drafts: "member",
  conversations: "member",
  feedback: "member",
  notifications: "member",
  tools: "member",
  support: "member",
  "integrations.request": "member",
  /** Reem's list: add, update, snooze, reschedule, note, record a follow-up (POST /api/secretary, PATCH, the tools). */
  "todo.write": "member",
  /** Switch the active brand (per login). */
  "brands.switch": "member",
  /** Read anything in the workspace. */
  read: "member",
  /** See the roster and seats. */
  "team.view": "member",
  /** Leave the team: members only, never the owner (see `can`). */
  "team.leave": "member",
  /** Change one's OWN password (the member record for members, the owner record for the owner). */
  "password.change": "member",
  /** One's own display name and interface language. */
  "profile.self": "member",
} as const satisfies Record<string, Role>;

export type Action = keyof typeof MIN_ROLE;
export const ACTIONS = Object.keys(MIN_ROLE) as Action[];

/** Refused while a founder impersonates an account, whatever the role: nothing that outlives the two-hour session. */
export const IMPERSONATION_BLOCKED: ReadonlySet<Action> = new Set<Action>([
  "account.delete",
  "password.change",
  "team.invite.member",
  "team.invite.admin",
  "team.invite.cancel",
  "team.role",
  "team.remove.member",
  "team.remove.admin",
  "mcp.token",
  "oauth.approve",
]);

const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
const isAction = (a: unknown): a is Action => typeof a === "string" && Object.prototype.hasOwnProperty.call(MIN_ROLE, a);

/** The acting person's role, or null when the request carries no actor. */
export const roleOf = (u: User | null | undefined): Role | null => u?.actor?.role ?? null;

/**
 * May the actor on `u` do `action`? Fails closed: no user, no actor, an unknown action, or an actor whose kind and role
 * disagree (a member can never hold "owner"; an owner, token or founder is always "owner") all answer false.
 */
export function can(u: User | null | undefined, action: Action): boolean {
  const a = u?.actor;
  if (!a || !isAction(action)) return false;
  if (!Object.prototype.hasOwnProperty.call(RANK, a.role)) return false;
  if (a.kind === "member" ? a.role === "owner" : a.role !== "owner") return false;
  if (a.kind !== "owner" && a.kind !== "member" && a.kind !== "token" && a.kind !== "founder") return false;
  if (a.kind === "founder" && IMPERSONATION_BLOCKED.has(action)) return false;
  if (action === "team.leave") return a.kind === "member";
  return RANK[a.role] >= RANK[MIN_ROLE[action]];
}

/** For route handlers: `const no = forbid(u, "publish"); if (no) return no;` — a 403 `{error:"forbidden"}` or null. */
export function forbid(u: User | null | undefined, action: Action): Response | null {
  return can(u, action) ? null : Response.json({ error: "forbidden" }, { status: 403 });
}
