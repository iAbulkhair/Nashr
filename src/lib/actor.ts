import { cookies } from "next/headers";
import { isFounder, type User } from "./auth";
import { db } from "./db";
import { sameSecret } from "./rate";

/**
 * Who acted: the login (or the system job) behind a governance change, a decision on an item or an activity row.
 *
 * Small on purpose: the kind, and an email only where it names a person. Never the whole actor object (names and
 * languages change), and never taken from a request body: it is worked out here from the session.
 *
 * The account (`u.email`) is always the owner's. A member (teams, PR #223) acts inside the owner's account, so the
 * member's own login email is recorded next to their role; a founder acting on the owner's account through support
 * access is recorded as the founder, with the owner's email and `imp` saying who impersonated (the founder's email once
 * the session carries it, else "founder"); a connected app (MCP bearer) is `token`; scheduled work is `system`.
 */
export type ByRole = "owner" | "admin" | "member";
export type ByJob = "auto_handoff" | "cron" | "routine";
export type By = { kind: "owner" | "member" | "founder" | "token" | "system"; email?: string; role?: ByRole; imp?: string; job?: ByJob };

const ROLES: readonly ByRole[] = ["owner", "admin", "member"];
const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 200) : undefined);

/** A session token as `createSession` makes it: 64 hex characters. Anything else is never looked up. */
const SESSION_TOKEN = /^[a-f0-9]{64}$/;

/**
 * Whether this request is the founder's support access to `u`'s account. The `nashr_impersonate` cookie names the
 * account (2 hours), but it is a plain value any browser can set: on its own, an owner could have their own saves,
 * decisions and publishes recorded as Nashr support's. So something the owner cannot forge must stand behind it: the
 * founder's own session, saved in `nashr_return` when support access started, still live and a founder account's
 * (`isFounder`, as `isAdmin` checks it), or the admin key cookie. Reads nothing unless the cookie names this account.
 */
async function supportAccess(u: User): Promise<boolean> {
  let jar: Awaited<ReturnType<typeof cookies>>;
  try {
    jar = await cookies();
  } catch {
    // Outside a request (a cron or a script) there are no cookies: nobody is impersonating.
    return false;
  }
  if (jar.get("nashr_impersonate")?.value !== u.email) return false;
  const key = process.env.WAITLIST_ADMIN_KEY;
  if (key && sameSecret(jar.get("nashr_admin")?.value, key)) return true;
  const back = jar.get("nashr_return")?.value;
  if (!back || !SESSION_TOKEN.test(back)) return false;
  // A session record is `{email, at}`, or a bare email for sessions written before 2026-09-18 (auth.ts).
  const rec = await db.get<string | { email?: unknown }>(`session:${back}`);
  return isFounder(typeof rec === "string" ? rec : typeof rec?.email === "string" ? rec.email : null);
}

/**
 * `u.actor` does not exist on main: it is read structurally, so this file compiles today and is the only file to change
 * once PR #223 lands (import its `Actor` type, drop the cookie fallback). Until then the founder's support access is
 * told apart by `supportAccess`: the impersonation cookie, backed by the founder's own session or the admin key.
 */
export async function byOf(u: User): Promise<By> {
  const a = (u as { actor?: { kind?: unknown; email?: unknown; role?: unknown; impersonating?: unknown } }).actor;
  if (a && typeof a === "object") {
    if (a.kind === "member") {
      const role = ROLES.find((r) => r === a.role);
      return { kind: "member", ...(str(a.email) ? { email: str(a.email) } : {}), ...(role ? { role } : {}) };
    }
    // The founder's own email is in `impersonating`; `actor.email` is the owner's there, so it is never recorded as who.
    if (a.kind === "founder") return { kind: "founder", email: u.email, imp: str(a.impersonating) ?? "founder" };
    if (a.kind === "token") return { kind: "token", email: u.email };
    return { kind: "owner", email: u.email };
  }
  return (await supportAccess(u)) ? { kind: "founder", email: u.email, imp: "founder" } : { kind: "owner", email: u.email };
}

/** Work the product started on its own, never on behalf of a login. */
export const systemBy = (job: ByJob): By => ({ kind: "system", job });

/**
 * A connected app acting with the account's MCP bearer token. On main the bearer's user carries no actor and no cookie,
 * so `byOf` would say "owner"; the MCP route says `token` here instead. After PR #223 `byOf` gives the same from `u.actor`.
 */
export const tokenBy = (u: Pick<User, "email">): By => ({ kind: "token", email: u.email });

/** A stored `by` read back: only the fields and kinds above, so a malformed row is dropped rather than shown. */
export function isBy(v: unknown): v is By {
  if (!v || typeof v !== "object") return false;
  const k = (v as { kind?: unknown }).kind;
  return k === "owner" || k === "member" || k === "founder" || k === "token" || k === "system";
}
