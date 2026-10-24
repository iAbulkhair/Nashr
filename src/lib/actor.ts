import type { Actor, Role, User } from "./auth";

/**
 * Who acted: the login (or the system job) behind a governance change, a decision on an item or an activity row.
 *
 * Small on purpose: the kind, and an email only where it names a person. Never the whole actor object (names and
 * languages change), and never taken from a request body: it is worked out here from the session's `u.actor`, which
 * `currentUser` (src/lib/auth.ts `resolveSession`) and `userFromBearer` (src/lib/mcp.ts) set and `saveUser` strips.
 *
 * The account (`u.email`) is always the owner's. A member acts inside the owner's account, so the member's own login
 * email is recorded next to their role; a founder acting on the owner's account through support access (a session
 * carrying `imp`) is recorded as the founder, with the owner's email and `imp` saying who impersonated (the founder's
 * email, or "key" for the console key); a connected app (MCP bearer) is `token`; scheduled work is `system`.
 */
export type ByRole = Role;
export type ByJob = "auto_handoff" | "cron" | "routine";
export type By = { kind: Actor["kind"] | "system"; email?: string; role?: ByRole; imp?: string; job?: ByJob };

const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 200) : undefined);

/** Work the product started on its own, never on behalf of a login. */
export const systemBy = (job: ByJob): By => ({ kind: "system", job });

/**
 * Who is acting on this request, from `u.actor` alone. Cookies are never read: the impersonation cookies are values any
 * browser can set, while `actor.kind === "founder"` comes from a session record only the founder console writes.
 *
 * For a founder, `actor.email` is the OWNER's (the account being acted on), so who acted is `actor.impersonating`, never
 * `actor.email`. A member's role is kept only when it is a member role; a malformed one is dropped, not recorded.
 *
 * A user with no actor never comes from a request (every session and bearer user carries one): it is a cron, a routine
 * or a script working on an account it loaded with `getUser`. That work is the system's, not the owner's, so it is never
 * recorded as a person. The scheduled paths pass their own `systemBy(job)`; this is the fallback for any other.
 */
export function byOf(u: User): By {
  const a = u.actor;
  if (!a) return systemBy("cron");
  switch (a.kind) {
    case "member": {
      const role = a.role === "admin" || a.role === "member" || a.role === "viewer" ? a.role : undefined;
      const email = str(a.email);
      return { kind: "member", ...(email ? { email } : {}), ...(role ? { role } : {}) };
    }
    case "founder":
      return { kind: "founder", email: u.email, imp: str(a.impersonating) ?? "founder" };
    case "token":
      return { kind: "token", email: u.email };
    case "owner":
      return { kind: "owner", email: u.email };
    default:
      // An actor of a kind this file does not know is nobody's: fail safe, like `can` in src/lib/roles.ts.
      return systemBy("cron");
  }
}

/**
 * A connected app acting with the account's MCP bearer token. `userFromBearer` sets `actor.kind = "token"`, so
 * `byOf(user)` gives the same; the MCP route and `external-drafts` name it explicitly, so the row says `token` even for a
 * user resolved some other way.
 */
export const tokenBy = (u: Pick<User, "email">): By => ({ kind: "token", email: u.email });

/**
 * A `by` as the account's own logins receive it: the kind, email, role and job, never `imp`. Who impersonated is the
 * founder console's own login (or "key") and stays in storage for the founder console (GET /api/admin/users/{email}):
 * GET /api/activity, the Activity page, the Governance page and the governance save and restore responses (`historyView`)
 * send this instead, so a support-access row names only "Thakeen support", as `/api/profile` gives support access only as
 * a boolean.
 */
export const publicBy = ({ kind, email, role, job }: By): By => ({ kind, ...(email ? { email } : {}), ...(role ? { role } : {}), ...(job ? { job } : {}) });

/** A stored `by` read back: only the fields and kinds above, so a malformed row is dropped rather than shown. */
export function isBy(v: unknown): v is By {
  if (!v || typeof v !== "object") return false;
  const k = (v as { kind?: unknown }).kind;
  return k === "owner" || k === "member" || k === "founder" || k === "token" || k === "system";
}
