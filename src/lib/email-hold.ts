import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { db } from "./db";
import { OPAQUE_IDS } from "./account-id";
import { normalizeEmail } from "./auth";
import { accountKey, addressRecordKeys, globalKey, personKey, storedPersonId, type PersonId } from "./keys";
import { getPerson } from "./person";
import { parseStored } from "./stored";

/**
 * The old address after a move in place (account-id spec, decision D1; release R2, rules 2740, 2743, 2744).
 *
 * A proved move writes a HOLD on the address the person left (`emailhold:{old}`, 30 days) and a single-use REVERT link
 * mailed to that address (`emailrevert:{sha256(token)}`, 7 days). While the person exists, nobody else may take the held
 * address: not a sign-up, not a Google sign-up, not an invite acceptance and not another login's address change. The
 * person itself may (moving back is a normal change, or the revert). The typo fix of an unverified owner writes neither:
 * nothing was proved at the old address.
 *
 * L3 (rule 2740): an account that moved in place keeps its key. A legacy owner's account and person stay at
 * `user:{old}` and `person:{old}` holding the NEW address, so the old address must never get a record at that key again
 * (an address-derived id): a legacy invite acceptance and a member's address move refuse it for as long as those
 * records hold another address, hold or no hold. New accounts are opaque while `OPAQUE_IDS` is on (`createUser`).
 *
 * Holds and revert tokens are written only by a move in place, which runs only while `OPAQUE_IDS` is on; a revert is
 * taken only while it is on. `addressBlocked` reads whatever the constant says (see there).
 * Addresses are normalized by the callers (and `addressBlocked` normalizes both sides of its compare); the tokens are
 * only ever stored as their SHA-256.
 */
export const HOLD_DAYS = 30;
export const REVERT_DAYS = 7;

const EmailHold = z.looseObject({ pid: z.string().min(1), to: z.string().min(3), at: z.string().min(1), until: z.string().min(1) });
export type EmailHoldValue = z.output<typeof EmailHold>;
const EmailRevert = z.looseObject({ old: z.string().min(3), pid: z.string().min(1), to: z.string().min(3), at: z.string().min(1) });
export type EmailRevertValue = z.output<typeof EmailRevert>;
const Reverted = z.looseObject({ move: z.string().min(1), at: z.string().min(1) });

/** The token's storage name: SHA-256 hex. */
export const revertHash = (token: string) => createHash("sha256").update(token).digest("hex");
/** A revert token as it is mailed: 32 random bytes, hex (the fragment form the reset and invite links use). */
export const REVERT_TOKEN = /^[a-f0-9]{64}$/;

/** The hold on `address`, when one is stored and still in its window. */
export async function holdOn(address: string, now: number = Date.now()): Promise<EmailHoldValue | null> {
  if (!OPAQUE_IDS) return null;
  const h = parseStored("emailhold", EmailHold, await db.get(accountKey.emailHold(address)), null);
  return h && Date.parse(h.until) > now ? h : null;
}

/**
 * Whether `address` may NOT become a login of anyone but `pid` (rules 2740, 2743): `held` while another person who still
 * exists holds it (D1), `moved` while the account or person record stored under the address as its id holds another
 * address (L3; never for the person whose id IS the address, a legacy owner moving back). Null when it is free of both.
 * One round for the records and the hold, one more for the holder only when a hold is there. Read whatever `OPAQUE_IDS`
 * says: with it off no hold and no moved record exist, so it answers null at the cost of reads the callers already make
 * side by side; and if the constant is ever turned off again after accounts moved, the old keys stay protected (an
 * address-derived id at `user:{old}` would overwrite the moved account).
 */
export async function addressBlocked(address: string, pid?: string): Promise<"held" | "moved" | null> {
  const [userKey, personRowKey] = addressRecordKeys(address);
  const [rawHold, rawUser, rawPerson] = await Promise.all([db.get(accountKey.emailHold(address)), db.get<{ email?: unknown }>(userKey), db.get<{ email?: unknown }>(personRowKey)]);
  const hold = parseStored("emailhold", EmailHold, rawHold, null);
  if (hold && hold.pid !== pid && Date.parse(hold.until) > Date.now() && (await getPerson(storedPersonId(hold.pid)))) return "held";
  // Both sides normalized: a record written before the address rules tightened may hold another case or spacing.
  const here = normalizeEmail(address);
  const holds = (r: { email?: unknown } | null) => !!r && typeof r === "object" && normalizeEmail(typeof r.email === "string" ? r.email : "") !== here;
  if (here !== normalizeEmail(pid ?? "") && [rawUser, rawPerson].some(holds)) return "moved";
  return null;
}

/**
 * After a proved move from `old` to `to` by `pid`: the hold on `old` and a revert token for it, written before the old
 * address is released (the caller holds both login locks and the person lock). Returns the token for the notice mail.
 */
export async function holdOldAddress(pid: PersonId, old: string, to: string, at: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const until = new Date(Date.parse(at) + HOLD_DAYS * 864e5).toISOString();
  await Promise.all([
    db.set(accountKey.emailHold(old), { pid, to, at, until } satisfies EmailHoldValue, HOLD_DAYS * 86400),
    db.set(globalKey.emailRevert(revertHash(token)), { old, pid, to, at } satisfies EmailRevertValue, REVERT_DAYS * 86400),
  ]);
  return token;
}

/** The hold on `address` goes when the person it names takes the address back (a revert, or a move back). */
export async function dropOwnHold(address: string, pid: string): Promise<void> {
  const h = parseStored("emailhold", EmailHold, await db.get(accountKey.emailHold(address)), null);
  if (h && h.pid === pid) await db.del(accountKey.emailHold(address));
}

/**
 * The record still counts: not dead because an earlier revert of the same person undid a move made before this one
 * (a later move made by whoever held the account then: `emailreverted:{pid}`).
 */
async function revertAlive(rec: EmailRevertValue | null): Promise<EmailRevertValue | null> {
  if (!rec) return null;
  const last = parseStored("emailreverted", Reverted, await db.get(personKey.emailReverted(storedPersonId(rec.pid))), null);
  const t = Date.parse(rec.at);
  if (last && t > Date.parse(last.move) && t <= Date.parse(last.at)) return null;
  return rec;
}

const revertable = (token: unknown): token is string => OPAQUE_IDS && typeof token === "string" && REVERT_TOKEN.test(token);

/**
 * Read a revert token WITHOUT using it up (rule 2744, fix round 1): the revert reads it first to learn the person and
 * the address, takes its locks, re-checks, and only then claims it (`claimRevert`). A busy lock or a refused check
 * leaves the link usable. Null when it is unknown, used, expired, malformed or dead (`revertAlive`).
 */
export async function peekRevert(token: unknown): Promise<EmailRevertValue | null> {
  if (!revertable(token)) return null;
  return revertAlive(parseStored("emailrevert", EmailRevert, await db.get(globalKey.emailRevert(revertHash(token))), null));
}

/**
 * Use a revert token up (single use: `getdel`, so two clicks never both pass), called under the revert's locks once
 * every check passed. Null when another click took it first, or it is dead.
 */
export async function claimRevert(token: unknown): Promise<EmailRevertValue | null> {
  if (!revertable(token)) return null;
  return revertAlive(parseStored("emailrevert", EmailRevert, await db.getdel(globalKey.emailRevert(revertHash(token))), null));
}

/** Put a claimed token back for the rest of its 7 days, when the revert that claimed it did not finish. */
export async function restoreRevert(token: string, rec: EmailRevertValue, now: number = Date.now()): Promise<void> {
  const left = Math.floor((Date.parse(rec.at) + REVERT_DAYS * 864e5 - now) / 1000);
  if (left > 0) await db.set(globalKey.emailRevert(revertHash(token)), rec, left);
}

/** Stamp a revert: tokens of moves made after `move` and before now are dead (`takeRevert`). */
export async function stampRevert(pid: PersonId, move: string, at: string): Promise<void> {
  await db.set(personKey.emailReverted(pid), { move, at }, HOLD_DAYS * 86400);
}
