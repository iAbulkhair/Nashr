// Account-id release R1's one-time fill (docs/specs/2026-10-17-account-id.md "Releases", rule 1994; docs/system/flows.md
// section 87): every stored account and member gets its frozen id and every sign-in address its login index. Run from
// `scripts/account-ids.ts` (a terminal) or from the founder console (POST /api/admin/conversions/account-ids, rule 4100),
// never at build time. R1 already writes both for every new signup, invite and move; this fills in the records from
// before it. Nothing reads them as required yet, so a run that stops halfway is harmless and the next run finishes it.
//
// For every id in `users:all` (in parallel, 50 at a time; no `await db.*` inside a loop):
//   - the owner record gets `id` = the key it is stored under, if it has none (under the account lock, `withUserLock`);
//   - `login:{address}` gets `{ kind: "person", pid: id }` if absent (under `lock:login:{address}`, read again first);
//   - every member on its roster gets `id` = its address and its own `login:{address}`, the same way; a member whose
//     stored `id` is not its address is a conflict, left as it is.
// It never overwrites: an index that names someone else, an owner record whose address differs from its key, and a
// roster entry with no member record (or one of another team) are counted as conflicts or orphans and left as they are.
// A second run writes nothing (idempotent). The report is counts only: no email, id or key.
import { db, mgetChunked } from "../db";
import { pmap } from "../parallel";
import { accountKey, globalKey } from "../keys";
import { LoginIndex, loginIndexOf } from "../account-id";
import { normalizeEmail, saveUser, type User } from "../auth";
import { withUserLock } from "../credits";
import { saveMember, withLoginLock, withMemberLock, type Member } from "../team";

export type IdsReport = {
  apply: boolean;
  accounts: number;
  /** In `users:all` with no record (a deletion that stopped halfway): left alone. */
  missing: number;
  members: number;
  /** Owner and member records that had no `id`: set (or, in a dry run, that would be). */
  idsSet: number;
  /** Sign-in addresses with no `login:` index: written (or would be). */
  indexesSet: number;
  /** An index naming another person, or an owner record stored under a key that is not its address. Never overwritten. */
  conflicts: number;
  /** A roster entry with no member record, or a member record of another team. */
  orphans: number;
};

const CHUNK = 50;
const readIndex = (raw: unknown) => {
  if (raw === null || raw === undefined) return null;
  const r = LoginIndex.safeParse(raw);
  return r.success ? r.data : ("invalid" as const);
};

/**
 * The index of `login`, written only while it is still absent under the login lock, and only while the record it is
 * written for still holds the address (L2, rule 2747: `holds` re-reads it under the lock, so a record that moved or was
 * deleted since the first read is never indexed).
 */
async function claimIfAbsent(login: string, pid: string, holds: () => Promise<boolean>): Promise<"set" | "same" | "conflict"> {
  return withLoginLock(login, async () => {
    const [raw, still] = await Promise.all([db.get(accountKey.login(login)), holds()]);
    const cur = readIndex(raw);
    if (cur === null) {
      if (!still) return "conflict" as const;
      await db.set(accountKey.login(login), loginIndexOf(pid));
      return "set" as const;
    }
    return cur !== "invalid" && cur.pid === pid ? ("same" as const) : ("conflict" as const);
  });
}

/**
 * `index`: whether the script may write the login index. A legacy owner (its key is its address) and a member may. An
 * account whose key is not its address (an opaque `a_` account, or one that moved in place under R2, rule 2747) had its
 * index written by the signup or the move itself: the script only checks it names the owner, and never writes one.
 */
type Plan = { kind: "owner"; id: string; login: string; pid: string; needsId: boolean; index: boolean } | { kind: "member"; owner: string; login: string; pid: string; needsId: boolean; index: true };

export async function convertAccountIds(apply: boolean): Promise<IdsReport> {
  const r: IdsReport = { apply, accounts: 0, missing: 0, members: 0, idsSet: 0, indexesSet: 0, conflicts: 0, orphans: 0 };
  const ids = await db.smembers(globalKey.usersAll());
  r.accounts = ids.length;
  const users = await mgetChunked<User>(ids.map((id) => accountKey.user(id)));
  const rosters = await pmap(ids, (id) => db.smembers(accountKey.members(id)), CHUNK);
  const plans: Plan[] = [];
  ids.forEach((id, i) => {
    const u = users[i];
    if (!u) {
      r.missing++;
      return;
    }
    const login = normalizeEmail(u.email);
    // A stored id that is not its key (a rolled-back build's copy), or a record with no id whose address is not its key
    // (written by hand or by a bug): reported, never indexed (the guarded fallback already refuses it, rule 1981). A
    // record that carries its key as its id and another address is an opaque account or one that moved in place (R2):
    // not a conflict, its index is only checked below.
    if ((u.id !== undefined && u.id !== id) || (u.id === undefined && login !== id)) {
      r.conflicts++;
      return;
    }
    plans.push({ kind: "owner", id, login, pid: u.ownerPid ?? id, needsId: u.id === undefined, index: login === id });
  });
  const rosterPairs = ids.flatMap((id, i) => (users[i] ? rosters[i].map((m) => [id, normalizeEmail(m)] as const) : []));
  const members = await mgetChunked<Member>(rosterPairs.map(([, m]) => accountKey.member(m)));
  rosterPairs.forEach(([owner, login], i) => {
    const m = members[i];
    if (!m || m.memberOf !== owner || normalizeEmail(m.email) !== login) {
      r.orphans++;
      return;
    }
    // A stored id that is not the address (a rolled-back build's move copied the old one): reported, never indexed, so
    // no index ever names one person for two addresses (security review M1).
    if (m.id !== undefined && m.id !== login) {
      r.conflicts++;
      return;
    }
    r.members++;
    plans.push({ kind: "member", owner, login, pid: login, needsId: m.id === undefined, index: true });
  });
  const indexes = await mgetChunked<unknown>(plans.map((p) => accountKey.login(p.login)));
  const work: Plan[] = [];
  plans.forEach((p, i) => {
    const cur = readIndex(indexes[i]);
    if ((cur !== null && (cur === "invalid" || cur.pid !== p.pid)) || (cur === null && !p.index)) {
      r.conflicts++;
      return;
    }
    if (p.needsId) r.idsSet++;
    if (cur === null) r.indexesSet++;
    if (p.needsId || cur === null) work.push(p);
  });
  if (!apply) return r;
  // Counted again from what the writes find under their locks: a record changed since the read above is not overwritten.
  r.idsSet = 0;
  r.indexesSet = 0;
  const outcomes = await pmap(work, async (p) => {
    let idSet = false;
    if (p.kind === "owner" && p.needsId) {
      idSet = await withUserLock(p.id, async (x) => {
        if (x.id !== undefined || normalizeEmail(x.email) !== p.id) return false;
        await saveUser(x); // `saveUser` writes `id = acct(x)`, the key the record was read from
        return true;
      }).catch(() => false);
    }
    if (p.kind === "member" && p.needsId) {
      idSet = !!(await withMemberLock(p.login, async (m) => {
        if (m.id !== undefined || m.memberOf !== p.owner) return false;
        await saveMember({ ...m, id: p.login });
        return true;
      }).catch(() => false));
    }
    // L2: the record is read again under the login lock; only one that still holds this address gets its index.
    const holds = p.kind === "owner"
      ? async () => normalizeEmail((await db.get<User>(accountKey.user(p.id)))?.email ?? "") === p.login
      : async () => {
        const m = await db.get<Member>(accountKey.member(p.login));
        return !!m && m.memberOf === p.owner && normalizeEmail(m.email) === p.login;
      };
    const idx = await claimIfAbsent(p.login, p.pid, holds).catch(() => "conflict" as const);
    return { idSet, idx };
  }, CHUNK);
  for (const o of outcomes) {
    if (o.idSet) r.idsSet++;
    if (o.idx === "set") r.indexesSet++;
    if (o.idx === "conflict") r.conflicts++;
  }
  return r;
}

