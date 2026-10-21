import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import { acct, OPAQUE_ACCOUNT_ID } from "./account-id";
import { getAccount, normalizeEmail, saveUser, validEmail, type User } from "./auth";
import { cardKey } from "./billing";
import { withUserLock } from "./credits";
import { accountKey, type AccountId, type PersonId } from "./keys";
import { log } from "./log";
import { revokeAllMcp } from "./mcp";
import { aidOf, getMembership, heldAccounts, membershipHolds, ownerOf } from "./membership";
import { PERSON_ID } from "./multi-org";
import { getPartner } from "./partners";
import { getPerson, withPersonLock, type Person } from "./person";
import { sameSecret } from "./secret";
import { revokeCalendarLinks } from "./secretary-gcal";
import { parseStored, TransferOfferRow, type TransferOfferValue } from "./stored";
import { isSuspended } from "./suspension";
import { listMembers, withAccountTeamLock, withLoginLock, writeMembership } from "./team";
import { logTeam } from "./teamlog";
import { OWNED_CAP } from "./workspaces";
import { matchHandle, wsHandle } from "./ws-handle";
import { asHandle } from "./ws-path";

/**
 * Ownership transfer (multi-workspace M3, docs/specs/2026-10-18-multi-org.md section 11; rules 2128, 2139, 2750-2752).
 *
 * The owner names an enabled admin of the account (`offerTransfer`, after the route has checked the owner's fresh
 * password and authenticator code). A 32-byte token is mailed to that admin's address in the link's fragment; only its
 * SHA-256 is stored, in `xfer:{aid}` for 7 days, one offer per account (a new offer replaces it). The admin accepts it
 * signed in as themselves (`acceptTransfer`): the token alone does nothing.
 *
 * Scope (ruling 1, fail-closed): only an `a_` account whose owner and receiving admin are both `p_` persons read from
 * `person:` rows. Until M4/S2 a legacy account record is also its owner's credential record and a legacy member record its
 * member's, so moving either would strand or delete credentials. An account that is a partner (commission, bank details
 * keyed by the account) never transfers: its payouts must not follow the account to a new owner.
 *
 * What the accept changes, under `lock:team:{aid}` → `lock:login:{new owner}` → `lock:person:{new owner}` →
 * `lock:user:{aid}` (rule 2139): the account's `ownerPid`, its contact `email`, `name` and `emailVerifiedAt` from the
 * new owner (`phone` cleared, it was the old owner's); the saved card dropped and renewals stopped, so the plan runs to
 * its paid-through day and nothing is charged on the old owner's card (decision 8); the MCP token and OAuth grants
 * ended, before the account write and once more after it; the old owner becomes an `admin` membership; the new owner's
 * membership row and roster entry go (an owner holds no membership); one `ownership_transferred` row. After the locks,
 * the Reem calendar links the old owner declared are dropped (their own calendar).
 */

const TTL_SECONDS = 7 * 24 * 3600;
const TOKEN = /^[a-f0-9]{64}$/;
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const offerKey = (aid: AccountId) => accountKey.xfer(aid);

/** A `p_` person read from its own `person:` row: the only shape a transfer moves (ruling 1) and a delete removes (ruling 7). */
export const splitPerson = (p: Person | null): p is Person => !!p && p.source === "person" && PERSON_ID.test(p.pid);

/** The account may change hands at all: an `a_` account owned through `ownerPid` by a `p_` person, not suspended. */
const transferable = (u: User | null): u is User => !!u && OPAQUE_ACCOUNT_ID.test(acct(u)) && !!u.ownerPid && PERSON_ID.test(ownerOf(u)) && !isSuspended(u);

async function readOffer(aid: AccountId): Promise<TransferOfferValue | null> {
  return parseStored("transfer", TransferOfferRow, await db.get<unknown>(offerKey(aid)), null);
}
const live = (o: TransferOfferValue, now = Date.now()) => new Date(o.expiresAt).getTime() > now;

export type TransferError = "transfer_unavailable" | "not_admin" | "invalid_email" | "forbidden";

/** The pending offer of the caller's own account, for the owner's Team page: the address and the expiry, never the hash. */
export async function pendingTransfer(u: User): Promise<{ email: string; expiresAt: string } | null> {
  const o = await readOffer(aidOf(u));
  return o && live(o) ? { email: o.toEmail, expiresAt: o.expiresAt } : null;
}

/**
 * Offer the account to one of its admins (ruling 6). `u` is the session's account and `byPid` the acting owner's person
 * (the route has checked `team.transfer`, the password and the code). The admin is found on the account's own roster by
 * address, never by an id from the request. Under `lock:team:{aid}` the account, both persons and the membership are
 * read again; the offer is written and `ownership_offered` logged in the same lock. The token is returned once for the
 * mail and never stored.
 */
export async function offerTransfer(u: User, byPid: PersonId, email: unknown): Promise<{ ok: true; token: string; to: { email: string; lang: "ar" | "en" }; expiresAt: string } | { ok: false; error: TransferError }> {
  const aid = aidOf(u);
  const e = normalizeEmail(typeof email === "string" ? email : "");
  if (!validEmail(e)) return { ok: false, error: "invalid_email" };
  if (!transferable(u) || ownerOf(u) !== byPid) return { ok: false, error: "transfer_unavailable" };
  if (await getPartner(aid)) return { ok: false, error: "transfer_unavailable" };
  const row = (await listMembers(aid)).find((m) => m.email === e);
  if (!row) return { ok: false, error: "not_admin" };
  return withAccountTeamLock(aid, async () => {
    const [account, owner, to, m] = await Promise.all([getAccount(aid), getPerson(byPid), getPerson(row.pid), getMembership(aid, row.pid)]);
    if (!transferable(account) || ownerOf(account) !== byPid || !splitPerson(owner)) return { ok: false as const, error: "transfer_unavailable" as const };
    if (!splitPerson(to) || !to.emailVerifiedAt || normalizeEmail(to.email) !== e) return { ok: false as const, error: "transfer_unavailable" as const };
    if (!m || m.role !== "admin" || !membershipHolds(account, m)) return { ok: false as const, error: "not_admin" as const };
    const token = randomBytes(32).toString("hex");
    const now = new Date();
    const offer: TransferOfferValue = { hash: hashOf(token), toPid: to.pid, toEmail: e, byPid, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL_SECONDS * 1000).toISOString() };
    await Promise.all([
      db.set(offerKey(aid), offer, TTL_SECONDS),
      logTeam(aid, { kind: "ownership_offered", actor: { pid: byPid, email: normalizeEmail(owner.email) }, target: { pid: to.pid, email: e }, role: "admin", via: "web" }, { teamLocked: true }),
    ]);
    return { ok: true as const, token, to: { email: e, lang: to.lang === "en" ? ("en" as const) : ("ar" as const) }, expiresAt: offer.expiresAt };
  });
}

/** Withdraw the pending offer, under the team lock (a mail that already left carries a token that no longer matches). */
export async function cancelTransfer(u: User): Promise<boolean> {
  const aid = aidOf(u);
  return withAccountTeamLock(aid, async () => (await db.getdel(offerKey(aid))) !== null);
}

/** Withdraw an offer whose mail could not be sent, only while it is still this one (`hash`). */
export async function withdrawOffer(u: User, token: string): Promise<void> {
  const aid = aidOf(u);
  await withAccountTeamLock(aid, async () => {
    const o = await readOffer(aid);
    if (o && sameSecret(o.hash, hashOf(token))) await db.del(offerKey(aid));
  });
}

export type AcceptError = "invalid" | "transfer_unavailable" | "workspace_cap";

/**
 * Accept an offer as the signed-in person `p` (ruling 3). `handle` names the workspace, matched only among the accounts
 * the person holds now (rule 2112); `token` is the mailed one. The offer must name this person (`toPid`) and the token's
 * hash must equal the stored one (`sameSecret`): a wrong token changes nothing and deletes nothing. Everything is read
 * again under the locks; a changed account voids the offer (deleted), a full owned-workspace cap keeps it (409
 * `workspace_cap`, nothing changed). Single use: the offer is deleted before the account is written.
 */
export async function acceptTransfer(p: Person, handle: unknown, token: unknown): Promise<{ ok: true; aid: AccountId; handle: string } | { ok: false; error: AcceptError }> {
  const h = asHandle(typeof handle === "string" ? handle : null);
  if (!h || typeof token !== "string" || !TOKEN.test(token) || !splitPerson(p) || !p.emailVerifiedAt) return { ok: false, error: "invalid" };
  const found = matchHandle(h, (await heldAccounts(p)).map((x) => x.aid));
  if (!found) return { ok: false, error: "invalid" };
  const aid = found as AccountId;
  const first = await readOffer(aid);
  if (!first || !live(first) || first.toPid !== p.pid || !sameSecret(first.hash, hashOf(token))) return { ok: false, error: "invalid" };

  const done = await withAccountTeamLock(aid, () =>
    withLoginLock(p.email, () =>
      withPersonLock(p.pid, () =>
        withUserLock(aid, async (account): Promise<{ ok: true; oldPid: PersonId } | { ok: false; error: AcceptError }> => {
          const offer = await readOffer(aid);
          if (!offer || !live(offer) || offer.toPid !== p.pid || !sameSecret(offer.hash, hashOf(token))) return { ok: false, error: "invalid" };
          // The offering owner is the account's owner now (`ownerOf`), never an id read back from the offer.
          const oldPid = ownerOf(account);
          if (offer.byPid !== oldPid) {
            await db.del(offerKey(aid));
            return { ok: false, error: "transfer_unavailable" };
          }
          const [me, old, m, partner] = await Promise.all([getPerson(p.pid), getPerson(oldPid), getMembership(aid, p.pid), getPartner(aid)]);
          const stands =
            transferable(account) && splitPerson(old) && splitPerson(me) && !!me.emailVerifiedAt &&
            normalizeEmail(me.email) === offer.toEmail && !!m && m.role === "admin" && membershipHolds(account, m) && !partner;
          if (!stands) {
            await db.del(offerKey(aid));
            return { ok: false, error: "transfer_unavailable" };
          }
          const owned = (await heldAccounts(me)).filter((x) => x.role === "owner").length;
          if (owned >= (me.ownedCap ?? OWNED_CAP)) return { ok: false, error: "workspace_cap" };

          // Single use, then the old owner's AI access ends before the account changes hands.
          await Promise.all([db.del(offerKey(aid)), revokeAllMcp(aid)]);
          const next: User = { ...account, ownerPid: me.pid, email: normalizeEmail(me.email), name: me.name, phone: "", emailVerifiedAt: me.emailVerifiedAt };
          if (next.billing) {
            const billing = { ...next.billing, autoRenew: false };
            delete billing.card;
            next.billing = billing;
          }
          const stamp = new Date().toISOString();
          await Promise.all([saveUser(next), db.del(cardKey(aid))]);
          await Promise.all([
            writeMembership(aid, oldPid, { aid, pid: oldPid, role: "admin", acceptedAt: stamp, invitedBy: me.pid }, { home: false, teamLocked: true }),
            db.del(accountKey.membership(aid, me.pid)),
            db.srem(accountKey.members(aid), me.pid),
            // Once more: a token minted by the old owner between the first revoke and the owner write dies too.
            revokeAllMcp(aid),
            logTeam(aid, { kind: "ownership_transferred", actor: { pid: oldPid, email: normalizeEmail(old.email) }, target: { pid: me.pid, email: normalizeEmail(me.email) }, via: "web" }, { teamLocked: true }),
          ]);
          return { ok: true, oldPid };
        }),
      ),
    ),
  );
  if (!done.ok) return done;
  // The old owner's own calendar (Reem B3) is not the new owner's to read. Outside the locks: it takes the brands' calendar locks.
  await revokeCalendarLinks(aid).catch((e: unknown) => log.warn("transfer calendar revoke failed", { error: e instanceof Error ? e.name : "unknown" }));
  return { ok: true, aid, handle: wsHandle(aid) };
}
