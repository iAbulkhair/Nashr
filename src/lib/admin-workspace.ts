import { acct, emailVerified, getAccount, getLogin, normalizeEmail, type User } from "./auth";
import { listBrands, scopeFor } from "./brands";
import { getGov } from "./governance";
import { TOOL_CAPS, authorityOf, type StoredMode, type ToolCap } from "./tool-authority";
import { AGENT_IDS, type AgentId } from "./agents";
import { lastSignIn } from "./devices";
import { listOrgs } from "./membership";
import { pmap } from "./parallel";
import { brandCapFor, includedSeats, paidExtraSeats, seatLimit } from "./pricing";
import { isSuspended, suspensionEnd } from "./suspension";
import { inviterAddress, listMembers, peekInvites, seatCount } from "./team";
import { lastActive } from "./track";

/**
 * The founder console's read-only view of one customer workspace (rules 2077-2083, docs/system/flows.md section 84),
 * after supastarter's admin organization page: the owner, the members with their roles and last sign-in, the pending
 * invites, the brands and the plan with its seat and brand limits.
 *
 * Tenant isolation: staff choose an address, and the account is found as a sign-in finds it (`getLogin`, the console's
 * lookup by address, rule 1982): the account the address owns, else the account its login stands for (`login.acct`: a
 * legacy member's stored `memberOf`, or a `p_` person's oldest live membership, multi-workspace M1), read back with
 * `getAccount`. Every key after that is built from the stored account record and the stored roster, never from the
 * request. Nothing here writes: invites are read with `peekInvites`, last sign-ins with `lastSignIn`, other workspaces
 * with `listOrgs`, and every list is read in one `Promise.all` or `pmap` round.
 *
 * `alsoIn` (multi-workspace M1, rule 2079): how many OTHER live workspaces a member belongs to or owns, a count only.
 * Their names, ids and owners are another tenant's and are never shown here.
 *
 * What is left out on purpose: password hashes, session and device details (browser, address), invite ids and tokens,
 * the brand files, tasks and conversations (the account's sheet already shows those to staff with the same gate).
 */

export type WorkspaceMember = { email: string; name: string; role: "admin" | "member" | "viewer"; invitedBy: string; acceptedAt: string; paused: boolean; lastSignInAt: string | null; alsoIn: number };
export type WorkspaceInvite = { email: string; role: "admin" | "member" | "viewer"; invitedBy: string; createdAt: string; expiresAt: string };
/**
 * `limits` (rule 2460): the brand's agent tool authority (src/lib/tool-authority.ts) as its restrictions only, each agent
 * and capability that is `ask` or `off`; empty means every agent may do everything. Read from the brand's own stored
 * scope, so support can answer "why won't Noor publish?" without impersonating.
 */
export type WorkspaceLimit = { agent: AgentId; cap: ToolCap; mode: StoredMode };
export type WorkspaceBrand = { id: string; name: string; status: "active" | "archived"; createdAt: string; limits: WorkspaceLimit[] };
export type WorkspaceView = {
  owner: { email: string; name: string; lang: "ar" | "en"; createdAt: string; verified: boolean; suspended: boolean; suspendedUntil: string | null; lastSignInAt: string | null; lastActiveAt: string | null };
  plan: { plan: User["plan"]; trialEnds: string; credits: number; seats: { used: number; limit: number; included: number; extra: number }; brands: { active: number; cap: number } };
  members: WorkspaceMember[];
  invites: WorkspaceInvite[];
  brands: WorkspaceBrand[];
  /** Set when staff opened the workspace from a member's address: that address. */
  openedFrom: string | null;
};

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * The account a chosen address belongs to: the account it owns, else the account its login stands for (`login.acct`),
 * read back with `getAccount`; `openedFrom` names the member's address. An address that signs in nowhere opens nothing.
 */
export async function accountForChosen(chosen: string): Promise<{ owner: User; openedFrom: string | null } | null> {
  const email = normalizeEmail(chosen);
  if (!email) return null;
  const login = await getLogin(email);
  if (!login) return null;
  if (login.kind === "owner") return { owner: login.user, openedFrom: null };
  if (!login.acct) return null;
  const owner = await getAccount(login.acct);
  return owner && acct(owner) === login.acct ? { owner, openedFrom: email } : null;
}

/** The workspace of the account `chosen` belongs to, or null when no account holds that address. */
export async function workspaceView(chosen: string): Promise<WorkspaceView | null> {
  const found = await accountForChosen(chosen);
  if (!found) return null;
  return viewOf(found.owner, found.openedFrom);
}

/**
 * The view of an account already found by `accountForChosen` (rules 3720-3749: the workspace page reads the same view and
 * adds its numbers, without finding the account twice). The key still comes from the stored record, never from a request.
 */
export async function viewOf(owner: User, openedFrom: string | null): Promise<WorkspaceView> {
  // The account id, from the stored record (an owner's address is its id while `OPAQUE_IDS` is off).
  const key = acct(owner);
  const [members, invites, brands, ownerSignIn, active] = await Promise.all([listMembers(key), peekInvites(key), listBrands(key), lastSignIn(owner.email), lastActive(owner.email)]);
  // Each member's last sign-in, other workspaces and inviter's address (`inviterAddress`: a membership row names its
  // inviter by person id since multi-workspace M1), and each brand's governance from its own stored scope (the account id
  // and the stored brand id), in one round.
  const [perMember, govs] = await Promise.all([pmap(members, (m) => Promise.all([lastSignIn(m.email), listOrgs(m.pid), inviterAddress(m.invitedBy)])), pmap(brands, (b) => getGov(scopeFor(key, b.id)))]);
  const suspended = isSuspended(owner);
  return {
    owner: {
      email: owner.email, name: owner.name, lang: owner.lang, createdAt: owner.createdAt, verified: emailVerified(owner),
      suspended, suspendedUntil: suspended ? suspensionEnd(owner) : null, lastSignInAt: iso(ownerSignIn), lastActiveAt: active ?? null,
    },
    plan: {
      plan: owner.plan, trialEnds: owner.trialEnds, credits: owner.credits,
      // `included` and `extra` (paid seats, rule 3375): read only; staff cannot add a paid seat from the console.
      seats: { used: seatCount(members, invites), limit: seatLimit(owner), included: includedSeats(owner), extra: paidExtraSeats(owner) },
      brands: { active: brands.filter((b) => b.status === "active").length, cap: brandCapFor(owner) },
    },
    members: members.map((m, i) => {
      const [signIn, orgs, invitedBy] = perMember[i];
      return { email: m.email, name: m.name, role: m.role, invitedBy, acceptedAt: m.acceptedAt, paused: !!m.disabled, lastSignInAt: iso(signIn), alsoIn: orgs.filter((o) => o.aid !== key).length };
    }),
    invites: invites.map((v) => ({ email: v.email, role: v.role, invitedBy: v.invitedBy, createdAt: v.createdAt, expiresAt: v.expiresAt })),
    brands: brands.map((b, i) => ({ id: b.id, name: b.name, status: b.status, createdAt: b.createdAt, limits: AGENT_IDS.flatMap((agent) => TOOL_CAPS.flatMap((cap): WorkspaceLimit[] => {
      const mode = authorityOf(govs[i].toolPolicy, agent, cap);
      return mode === "on" ? [] : [{ agent, cap, mode }];
    })) })),
    openedFrom,
  };
}
