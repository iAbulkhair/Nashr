// Gives every stored account and member its frozen id and every sign-in address its login index (account-id release R1,
// docs/specs/2026-10-17-account-id.md "Releases", rule 1994; docs/system/flows.md section 87). Run by hand ONCE, after
// the R1 release is live and only on the founder's yes (it writes production data), never at build time and not as part
// of `npm run check`. R1 already writes both for every new signup, invite and move; this fills in the records from
// before it. Nothing reads them as required yet, so a run that stops halfway is harmless and the next run finishes it.
//
// Usage:  npx --no-install jiti scripts/account-ids.ts            (dry run: read-only, prints counts)
//         npx --no-install jiti scripts/account-ids.ts --apply    (write the missing ids and indexes)
// with the app's own KV_REST_API_URL / KV_REST_API_TOKEN already in the environment (set privately, never typed on a
// command line that is saved).
//
// For every id in `users:all` (in parallel, 50 at a time; no `await db.*` inside a loop):
//   - the owner record gets `id` = the key it is stored under, if it has none (under the account lock, `withUserLock`);
//   - `login:{address}` gets `{ kind: "person", pid: id }` if absent (under `lock:login:{address}`, read again first);
//   - every member on its roster gets `id` = its address and its own `login:{address}`, the same way; a member whose
//     stored `id` is not its address is a conflict, left as it is.
// It never overwrites: an index that names someone else, an owner record whose address differs from its key, and a
// roster entry with no member record (or one of another team) are counted as conflicts or orphans and left as they are.
// A second run writes nothing (idempotent).
//
// Output is counts only: no email, id or key is printed.
// Exit codes: 0 done with no conflict; 1 finished with at least one conflict or orphan; 2 could not run.
import { pathToFileURL } from "node:url";
import { db, mgetChunked } from "../src/lib/db";
import { pmap } from "../src/lib/parallel";
import { accountKey, globalKey } from "../src/lib/keys";
import { LoginIndex, loginIndexOf } from "../src/lib/account-id";
import { normalizeEmail, saveUser, type User } from "../src/lib/auth";
import { withUserLock } from "../src/lib/credits";
import { saveMember, withLoginLock, withMemberLock, type Member } from "../src/lib/team";

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

/** The index of `login`, written only while it is still absent under the login lock. True when written. */
async function claimIfAbsent(login: string, pid: string): Promise<"set" | "same" | "conflict"> {
  return withLoginLock(login, async () => {
    const cur = readIndex(await db.get(accountKey.login(login)));
    if (cur === null) {
      await db.set(accountKey.login(login), loginIndexOf(pid));
      return "set" as const;
    }
    return cur !== "invalid" && cur.pid === pid ? ("same" as const) : ("conflict" as const);
  });
}

type Plan = { kind: "owner"; id: string; login: string; needsId: boolean } | { kind: "member"; owner: string; login: string; pid: string; needsId: boolean };

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
    // R1 stores every account under its first address and moves copy the record, so a record whose address is not its key
    // was written by hand or by a bug: reported, never indexed (the guarded fallback already refuses it, rule 1981).
    if (login !== id || (u.id !== undefined && u.id !== id)) {
      r.conflicts++;
      return;
    }
    plans.push({ kind: "owner", id, login, needsId: u.id === undefined });
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
    plans.push({ kind: "member", owner, login, pid: login, needsId: m.id === undefined });
  });
  const indexes = await mgetChunked<unknown>(plans.map((p) => accountKey.login(p.login)));
  const work: Plan[] = [];
  plans.forEach((p, i) => {
    const cur = readIndex(indexes[i]);
    const pid = p.kind === "owner" ? p.id : p.pid;
    if (cur !== null && (cur === "invalid" || cur.pid !== pid)) {
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
    const idx = await claimIfAbsent(p.login, p.kind === "owner" ? p.id : p.pid).catch(() => "conflict" as const);
    return { idSet, idx };
  }, CHUNK);
  for (const o of outcomes) {
    if (o.idSet) r.idsSet++;
    if (o.idx === "set") r.indexesSet++;
    if (o.idx === "conflict") r.conflicts++;
  }
  return r;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("KV_REST_API_URL and KV_REST_API_TOKEN must be set (the app's own store).");
    process.exitCode = 2;
    return;
  }
  const r = await convertAccountIds(apply);
  const verb = apply ? "set" : "to set";
  console.log(`${apply ? "Applied" : "Dry run"}: accounts ${r.accounts} (missing records ${r.missing}), members ${r.members}; ids ${verb} ${r.idsSet}, login indexes ${verb} ${r.indexesSet}; conflicts ${r.conflicts}, orphans ${r.orphans}.`);
  process.exitCode = r.conflicts || r.orphans ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
