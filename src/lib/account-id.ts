import { randomBytes } from "crypto";
import { z } from "zod";

/**
 * The account id (docs/specs/2026-10-17-account-id.md, release R1 "expand", rules 1980-1999; amended by
 * docs/specs/2026-10-18-multi-org.md "Changes forced on the account-id spec").
 *
 * An account's storage key is its id, never its sign-in address. In R1 every id equals an email: a legacy account's id
 * is its address as stored today, and a new signup writes `id = email` (`OPAQUE_IDS` is off). So every key keeps its
 * bytes and nothing on production behaves differently. What R1 changes is who names the key: code reaches an account
 * key only through `acct(u)` (a `User`) or `accountOfScope(scope)` (a scope from our own records), and a login only
 * through the login index (`login:{email}`, `LoginIndex`), so R2 can give new accounts opaque ids and move an owner's
 * address without touching data.
 *
 * Import-free apart from `crypto` and `zod`, so every module can use it without a cycle through src/lib/auth.ts.
 */

/**
 * Release R2's switch, a code constant and not an environment variable (spec section "Releases": a variable change
 * needs a rebuild anyway). Off in R1: signup writes `id = email` and an owner with data may not move (rule 1996).
 */
export const OPAQUE_IDS = false;

/** What `acct` reads: the stored id when the record has one, else the address it was stored under (a legacy account). */
type AccountLike = { id?: string; email: string };

/**
 * The account's storage key (rule 1980). The only way code turns a `User` into an account key prefix or a scope prefix.
 * Release R3 drops the fallback once every record carries `id`.
 */
export const acct = (u: AccountLike): string => u.id ?? u.email;

/**
 * The account a scope belongs to (rule 1986): the part before `#` (an added brand is `{account}#{brandId}`, the default
 * brand is the account id itself). The only scope parser: `validEmail` bans `#` and an opaque id has none, so the split is
 * exact. Pass only a scope from our own records or from `sc(u)`.
 */
export function accountOfScope(scope: string): string {
  const i = scope.indexOf("#");
  return i < 0 ? scope : scope.slice(0, i);
}

/** The brand id of a scope: "default" for the account's own scope, else the part after `#`. */
export function brandOfScope(scope: string): string {
  const i = scope.indexOf("#");
  return i < 0 ? "default" : scope.slice(i + 1);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** RFC 4648 base32, lower case, no padding. Exported for `newPersonId` (src/lib/multi-org.ts). */
export function base32lower(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The shape of an opaque account id (rule 1980): `a_` and 24 base32 characters. No `@`, `:` or `#`. */
export const OPAQUE_ACCOUNT_ID = /^a_[a-z2-7]{24}$/;

/** A new opaque account id from `crypto` (120 bits), never `Math.random`. Used only once `OPAQUE_IDS` is on (R2). */
export const newAccountId = (): string => "a_" + base32lower(randomBytes(15));

/**
 * The id a new account is created with (rule 1996): its address while `OPAQUE_IDS` is off (R1), an opaque id after.
 * `opaque` lets tests build an account with id ≠ email (rule 1985) without turning the release switch on.
 */
export const idForNewAccount = (email: string, opaque: boolean = OPAQUE_IDS): string => (opaque ? newAccountId() : email);

/**
 * `login:{email}`: the person a sign-in address belongs to. Multi-org forced change 1: it names a PERSON (`pid`), not an
 * account. In R1 a person's id is its own address (an owner's person id is its account id, which equals the address; a
 * member's is its address, frozen at the first index write, forced change 2). The account-id spec's original shape
 * `{ kind: "owner", id }` is read too (a legacy owner's person id IS its account id), so nothing ever needs rewriting.
 * A value of any other shape reads as no index (logged by `parseStored`), so the guarded legacy lookup decides.
 */
export const LoginIndex = z.union([
  z.looseObject({ kind: z.literal("person"), pid: z.string().min(1) }).transform((v) => ({ kind: "person" as const, pid: v.pid })),
  z.looseObject({ kind: z.literal("owner"), id: z.string().min(1) }).transform((v) => ({ kind: "person" as const, pid: v.id })),
]);
export type LoginIndexValue = { kind: "person"; pid: string };

/** The value R1 writes for a person: always the multi-org shape. */
export const loginIndexOf = (pid: string): LoginIndexValue => ({ kind: "person", pid });
