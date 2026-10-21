import { normalizeEmail } from "./auth";
import { pmap } from "./parallel";
import { getPerson, withPersonLock, type Person } from "./person";
import { forgetPerson, heldAnywhere, leaveForDeletion, withLoginLock } from "./team";
import { splitPerson } from "./transfer";

export type DeletePersonFail = "delete_unavailable" | "owns_workspace" | "busy";

/**
 * Delete one's own login (multi-workspace M3, rules 2127 and 2754; plan reconciliation 7). Only a `p_` person read from
 * its own `person:` row (`splitPerson`): a legacy-shaped one (an owner or member record that is also the credential)
 * goes with M4/S2. Refused `owns_workspace` while the person owns any account (the account is deleted or handed over
 * first, never here). Otherwise each membership, paused ones included (`heldAnywhere`), goes under its own team lock,
 * one at a time (`pmap` with one worker: every one of them takes the same person's `lock:login` → `lock:person` inside
 * the team lock, rule 2139), with one "left" row each. Then, under `lock:login` → `lock:person`, the person is read
 * again: anything held now (a membership or a transfer accepted in between) answers `busy` (or `owns_workspace`) and
 * keeps the person; nothing held deletes the person's keys in one round (`forgetPerson`). The caller has checked the
 * fresh proof and signs this device out.
 */
export async function deletePerson(p: Person): Promise<{ ok: true } | { ok: false; error: DeletePersonFail; left?: number }> {
  if (!splitPerson(p)) return { ok: false, error: "delete_unavailable" };
  const email = normalizeEmail(p.email);
  const held = await heldAnywhere(p.pid);
  if (held.some((h) => h.owner)) return { ok: false, error: "owns_workspace" };
  await pmap(held, ({ aid }) => leaveForDeletion(aid, p.pid, email), 1);
  // Review B finding 5: a refusal after the memberships went says how many were left, so the answer is never silent about
  // a partial delete. A retry finishes it: it leaves whatever was joined in between and deletes the person.
  const r = await withLoginLock(email, () =>
    withPersonLock(p.pid, async () => {
      const fresh = await getPerson(p.pid);
      if (!fresh) return { ok: true } as const;
      if (!splitPerson(fresh) || normalizeEmail(fresh.email) !== email) return { ok: false, error: "busy" } as const;
      const now = await heldAnywhere(p.pid);
      if (now.length) return { ok: false, error: now.some((h) => h.owner) ? "owns_workspace" : "busy" } as const;
      await forgetPerson(p.pid, email, { loginLocked: true, personLocked: true });
      return { ok: true } as const;
    }),
  );
  return !r.ok && held.length ? { ...r, left: held.length } : r;
}
