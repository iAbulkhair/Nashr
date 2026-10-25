import { db } from "./db";
import { newAccountId } from "./account-id";
import { getAccount, PLAN_CREDITS, saveUser, setSessionAccount, type Role, type User } from "./auth";
import { getBrand } from "./brand";
import { personKey, type AccountId } from "./keys";
import { heldAccounts } from "./membership";
import { pmap } from "./parallel";
import { getPerson, updatePerson, withPersonLock, type Person } from "./person";
import { workspaceCreateAllowed } from "./rate";
import { joinInviteAsPerson, withLoginLock, type TeamFail, type TeamRole } from "./team";
import { matchHandle, wsHandle } from "./ws-handle";
import { asHandle } from "./ws-path";
import { claimSlug, releaseSlug } from "./ws-slug";
import { logoUrls } from "./workspace-logo";

/**
 * A person's workspaces (multi-workspace M2, docs/specs/2026-10-18-multi-org.md sections 7 "Switching", 10 and 16;
 * rules 2112, 2123). Every function takes the person `currentPerson()` resolved from the session, never an id from the
 * request: the only request value is a handle, and it only selects among the accounts the person holds now.
 */

/** Accounts one person may own unless the founder set `ownedCap` on the person (decision 3). */
export const OWNED_CAP = 3;
/** A trial workspace's days, as at sign-up (`createUser`). */
const TRIAL_DAYS = 3;

/**
 * `slug` (rule 3504): the readable slug, shown beside the name; absent for a workspace made before slugs. `logo` (rule
 * 3610): the workspace logo's signed URL, absent when it has none (an optional field added, expand-only).
 */
export type WorkspaceRow = { handle: string; name: string; role: Role; current: boolean; slug?: string; logo?: string };

/**
 * The person's workspaces for the switcher and `/{lang}/app/workspaces`: the held accounts (`heldAccounts`, which
 * re-checks every one on the forward records), then ONE `pmap` round of each account and its default brand for the
 * name: the brand's name, else the name given at create, else the owner's name. `current` is the session's account.
 */
export async function listWorkspaces(p: Person, current: AccountId | null): Promise<WorkspaceRow[]> {
  const held = await heldAccounts(p);
  // The logos in ONE `mget` beside the same round (rule 3610), never a read per row.
  const [rows, logos] = await Promise.all([
    pmap(held, async ({ aid, role }): Promise<WorkspaceRow> => {
      const [u, brand] = await Promise.all([getAccount(aid), getBrand(aid)]);
      const name = brand?.name?.trim() || u?.workspaceName?.trim() || u?.name || "";
      return { handle: wsHandle(aid), name, role, current: aid === current, ...(u?.workspaceSlug ? { slug: u.workspaceSlug } : {}) };
    }),
    logoUrls(held.map((h) => h.aid)),
  ]);
  return rows.map((r, i) => {
    const logo = logos.get(held[i].aid);
    return logo ? { ...r, logo } : r;
  });
}

export type CreateResult = { ok: true; aid: AccountId; handle: string } | { ok: false; error: "email_unverified" | "rate_limited" | "workspace_cap" | "not_found" };

/**
 * Create a workspace (spec section 10, rule 2123): the person's address is verified; `wscreate` allows 3 per person per
 * day; the person owns fewer than their cap. Under `lock:login:{email}` → `lock:person:{pid}` (rule 2139) the person
 * and the held accounts are read again, then a new `a_` account with `ownerPid` is saved (into `users:all`), added to
 * `orgs:{pid}` and made the person's last choice (`lastorg:`). The trial is given once per person: only when
 * `trialUsedAt` is unset and the person owns nothing yet (an owner from before M2 used theirs on their first account),
 * and `trialUsedAt` is set in the same locked write. Otherwise the account starts on plan `trial` with no credits and a
 * trial that has already ended, so the shell shows "choose a plan". Then this device's session opens it (`setSessionAccount`).
 */
export async function createWorkspace(p: Person, input: { name: string; lang: "ar" | "en" }): Promise<CreateResult> {
  if (!p.emailVerifiedAt) return { ok: false, error: "email_unverified" };
  if (!(await workspaceCreateAllowed(p.pid))) return { ok: false, error: "rate_limited" };
  const made = await withLoginLock(p.email, () =>
    withPersonLock(p.pid, async (): Promise<CreateResult> => {
      const [fresh, held] = await Promise.all([getPerson(p.pid), heldAccounts(p)]);
      if (!fresh || !fresh.emailVerifiedAt) return { ok: false, error: fresh ? "email_unverified" : "not_found" };
      const owned = held.filter((h) => h.role === "owner").length;
      if (owned >= (fresh.ownedCap ?? OWNED_CAP)) return { ok: false, error: "workspace_cap" };
      const now = new Date();
      const stamp = now.toISOString();
      const trial = !fresh.trialUsedAt && owned === 0;
      const aid = newAccountId() as AccountId;
      const u: User = {
        id: aid,
        ownerPid: fresh.pid,
        email: fresh.email,
        name: fresh.name,
        phone: "",
        plan: "trial",
        credits: trial ? PLAN_CREDITS.trial : 0,
        trialEnds: trial ? new Date(now.getTime() + TRIAL_DAYS * 864e5).toISOString() : stamp,
        createdAt: stamp,
        lang: input.lang,
        emailVerifiedAt: fresh.emailVerifiedAt,
        workspaceName: input.name.trim().slice(0, 80),
      };
      // Rule 3504: a readable slug from the name, claimed atomically (SET NX) for this new id; released if the save fails.
      const slug = await claimSlug(u.workspaceName ?? "", aid);
      if (slug) u.workspaceSlug = slug;
      try {
        await saveUser(u);
      } catch (e) {
        await releaseSlug(slug ?? undefined, aid).catch(() => {});
        throw e;
      }
      await Promise.all([
        db.sadd(personKey.orgs(fresh.pid), aid),
        db.set(personKey.lastOrg(fresh.pid), aid),
        trial ? updatePerson(fresh.pid, { trialUsedAt: stamp }, { personLocked: true }) : Promise.resolve(null),
      ]);
      return { ok: true, aid, handle: wsHandle(aid) };
    }),
  );
  // The new workspace is the one this device opens next (spec section 7: create writes the session's `acct`).
  if (made.ok) await setSessionAccount(p.pid, made.aid);
  return made;
}

/**
 * Switch the session to the workspace `handle` names (spec section 7 "Switching", rule 2112): the same selector check as
 * every request (the person's held accounts, re-checked now), then the session's `acct` (`SET XX`, TTL kept) and
 * `lastorg:{pid}`, never `activebrand`. Null with nothing written for a handle that is not one of them (foreign, stale,
 * made up or malformed) and for a session that cannot be moved.
 */
export async function switchWorkspace(p: Person, handle: unknown): Promise<AccountId | null> {
  const h = asHandle(typeof handle === "string" ? handle : null);
  if (!h) return null;
  const aid = matchHandle(h, (await heldAccounts(p)).map((x) => x.aid));
  if (!aid || !(await setSessionAccount(p.pid, aid))) return null;
  await db.set(personKey.lastOrg(p.pid), aid);
  return aid as AccountId;
}

/**
 * Accept an invite as the signed-in person (spec section 9, rule 2116): the locked join in src/lib/team.ts
 * (`joinInviteAsPerson`: the invite for the person's own verified address, never by address alone, no password), then
 * this device's session `acct` and `lastorg:{pid}` move to the account (spec section 7: accept writes `acct`). The answer
 * carries the account's handle, never its id.
 */
export async function acceptInviteAsPerson(token: string, p: Person): Promise<{ ok: true; handle: string; member: { name: string; email: string; role: TeamRole; memberOf: string } } | TeamFail> {
  const r = await joinInviteAsPerson(token, p);
  if (!r.ok) return r;
  const aid = r.member.memberOf;
  await Promise.all([setSessionAccount(p.pid, aid), db.set(personKey.lastOrg(p.pid), aid)]);
  return { ok: true, handle: wsHandle(aid), member: r.member };
}
