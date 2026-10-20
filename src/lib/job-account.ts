import { emailVerified, getUser, sc, type User } from "./auth";
import { listBrands, scopeFor } from "./brands";
import { isSuspended } from "./suspension";
import { acct, accountOfScope } from "./account-id";

/**
 * Background jobs carry the workspace they act for (rules 2500-2519, docs/system/tests/2500-jobs-carry-account.md;
 * Fizzy's `Current.account` serialized into each job and restored when it runs).
 *
 * A per-user cron lists its roster once per hop, then starts items for up to four minutes (src/lib/cron-batch.ts). The
 * entry it started from was a snapshot: the owner could delete the account, be suspended or archive the brand in
 * between, and the run still charged, wrote and mailed on the old copy. So every entry carries a `JobRef`, taken with
 * `jobRef(u)` from the roster's own record when the item is listed (never from a request), and the run starts only
 * through `runAsAccount`, which reads the account and its brand list again and hands the work a fresh `User` for that
 * scope, or answers a `skip:` outcome before any write or charge.
 *
 * Nothing here is stored: a `JobRef` lives in the batch's memory for one hop, and the batch's markers keep their keys.
 */
export type JobRef = { account: string; scope: string };

/** Why a run was skipped at its start. Each is a final outcome for the period: the batch's done marker is set. */
export type JobSkip = "skip:account_gone" | "skip:account_changed" | "skip:suspended" | "skip:unverified" | "skip:brand_inactive" | "skip:scope_mismatch";

/** The account and scope an entry acts for (rule 2500): `acct(u)` and `sc(u)` of the roster's record, at listing time. */
export const jobRef = (u: User): JobRef => ({ account: acct(u), scope: sc(u) });

/**
 * Rule 2501: the account a job acts for, read again when it runs. In order, with no write anywhere:
 * - the scope must belong to the carried account (`accountOfScope`), checked before any read (rule 2502);
 * - the account must still exist and be keyed where the ref says (rule 2503);
 * - it must not be suspended, and its owner's address must be verified (rule 755; rule 2504);
 * - the scope must be one of its brands and that brand active (rule 2505).
 * The answer is a fresh `User` with `brandId` and `scope` set as `dailyRoster` sets them, or the skip.
 */
export async function resumeJob(ref: JobRef): Promise<{ ok: true; user: User } | { ok: false; skip: JobSkip }> {
  if (!ref.account || accountOfScope(ref.scope) !== ref.account) return { ok: false, skip: "skip:scope_mismatch" };
  const [u, brands] = await Promise.all([getUser(ref.account), listBrands(ref.account)]);
  if (!u) return { ok: false, skip: "skip:account_gone" };
  if (acct(u) !== ref.account) return { ok: false, skip: "skip:account_changed" };
  if (isSuspended(u)) return { ok: false, skip: "skip:suspended" };
  if (!emailVerified(u)) return { ok: false, skip: "skip:unverified" };
  const brand = brands.find((b) => scopeFor(ref.account, b.id) === ref.scope);
  if (!brand || brand.status !== "active") return { ok: false, skip: "skip:brand_inactive" };
  return { ok: true, user: { ...u, brandId: brand.id, scope: ref.scope } };
}

/**
 * Rule 2506: the only way a per-user cron starts an item's work. `run` gets the fresh `User`, never the roster's copy;
 * a skip is answered as the item's outcome without calling it, so nothing is written, charged or sent.
 */
export async function runAsAccount(ref: JobRef, run: (u: User) => Promise<string>): Promise<string> {
  const r = await resumeJob(ref);
  return r.ok ? run(r.user) : r.skip;
}
