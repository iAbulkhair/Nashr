import { emailVerified, getUser, normalizeEmail, type User } from "./auth";
import { listBrands } from "./brands";
import { lastSignIn } from "./devices";
import { pmap } from "./parallel";
import { brandCapFor, seatLimit } from "./pricing";
import { isSuspended, suspensionEnd } from "./suspension";
import { getMember, listMembers, peekInvites } from "./team";
import { lastActive } from "./track";

/**
 * The founder console's read-only view of one customer workspace (rules 2077-2083, docs/system/flows.md section 84),
 * after supastarter's admin organization page: the owner, the members with their roles and last sign-in, the pending
 * invites, the brands and the plan with its seat and brand limits.
 *
 * Tenant isolation: staff choose an address, and the account is found with the console's existing lookups, `getUser`
 * and, for a member's address, `getMember` then the owner named on that stored member record. Every key after that is
 * built from the stored owner record and the stored roster, never from the request. Nothing here writes: invites are
 * read with `peekInvites`, last sign-ins with `lastSignIn`, and every list is read in one `Promise.all` or `pmap` round.
 *
 * What is left out on purpose: password hashes, session and device details (browser, address), invite ids and tokens,
 * the brand files, tasks and conversations (the account's sheet already shows those to staff with the same gate).
 */

export type WorkspaceMember = { email: string; name: string; role: "admin" | "member"; invitedBy: string; acceptedAt: string; paused: boolean; lastSignInAt: string | null };
export type WorkspaceInvite = { email: string; role: "admin" | "member"; invitedBy: string; createdAt: string; expiresAt: string };
export type WorkspaceBrand = { id: string; name: string; status: "active" | "archived"; createdAt: string };
export type WorkspaceView = {
  owner: { email: string; name: string; lang: "ar" | "en"; createdAt: string; verified: boolean; suspended: boolean; suspendedUntil: string | null; lastSignInAt: string | null; lastActiveAt: string | null };
  plan: { plan: User["plan"]; trialEnds: string; credits: number; seats: { used: number; limit: number }; brands: { active: number; cap: number } };
  members: WorkspaceMember[];
  invites: WorkspaceInvite[];
  brands: WorkspaceBrand[];
  /** Set when staff opened the workspace from a member's address: that address. */
  openedFrom: string | null;
};

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** The account a chosen address belongs to: the owner record itself, or the owner named on a member record. */
async function ownerOf(chosen: string): Promise<{ owner: User; openedFrom: string | null } | null> {
  const email = normalizeEmail(chosen);
  if (!email) return null;
  const [u, m] = await Promise.all([getUser(email), getMember(email)]);
  if (u) return { owner: u, openedFrom: null };
  if (!m || typeof m.memberOf !== "string" || !m.memberOf) return null;
  const owner = await getUser(m.memberOf);
  return owner ? { owner, openedFrom: m.email } : null;
}

/** The workspace of the account `chosen` belongs to, or null when no account holds that address. */
export async function workspaceView(chosen: string): Promise<WorkspaceView | null> {
  const found = await ownerOf(chosen);
  if (!found) return null;
  const { owner, openedFrom } = found;
  const key = owner.email;
  const [members, invites, brands, ownerSignIn, active] = await Promise.all([listMembers(key), peekInvites(key), listBrands(key), lastSignIn(key), lastActive(key)]);
  const memberSignIns = await pmap(members, (m) => lastSignIn(m.email));
  const suspended = isSuspended(owner);
  return {
    owner: {
      email: owner.email, name: owner.name, lang: owner.lang, createdAt: owner.createdAt, verified: emailVerified(owner),
      suspended, suspendedUntil: suspended ? suspensionEnd(owner) : null, lastSignInAt: iso(ownerSignIn), lastActiveAt: active ?? null,
    },
    plan: {
      plan: owner.plan, trialEnds: owner.trialEnds, credits: owner.credits,
      seats: { used: 1 + members.filter((m) => !m.disabled).length + invites.length, limit: seatLimit(owner) },
      brands: { active: brands.filter((b) => b.status === "active").length, cap: brandCapFor(owner) },
    },
    members: members.map((m, i) => ({ email: m.email, name: m.name, role: m.role, invitedBy: m.invitedBy, acceptedAt: m.acceptedAt, paused: !!m.disabled, lastSignInAt: iso(memberSignIns[i]) })),
    invites: invites.map((v) => ({ email: v.email, role: v.role, invitedBy: v.invitedBy, createdAt: v.createdAt, expiresAt: v.expiresAt })),
    brands: brands.map((b) => ({ id: b.id, name: b.name, status: b.status, createdAt: b.createdAt })),
    openedFrom,
  };
}
