// Readiness check for the better-auth engine (rule 3426; docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md
// section 10; docs/system/flows.md section "Sign-in engine behind AUTH_ENGINE"). READ ONLY: better-auth reads Thakeen's own
// records through the projection adapter (src/lib/better-auth/adapter.ts), so there is nothing to copy or convert and
// `--apply` is refused. Run by hand before the founder sets AUTH_ENGINE=better-auth on staging, and again before
// production; never at build time and not as part of `npm run check`.
//
// Usage:  npx --no-install jiti scripts/better-auth-check.ts      (read-only, prints counts)
// with the app's own KV_REST_API_URL / KV_REST_API_TOKEN already in the environment (set privately, never typed on a
// command line that is saved).
//
// What it reads (in parallel, 50 at a time; no `await db.*` inside a loop):
//   - every account in `users:all` and its roster `members:{aid}`. The sign-in addresses are each owner record's
//     address and each roster person's address (`getPerson`), each once;
//   - each address as the sign-in route reads it (`getLogin`), projected through the adapter's own pure functions
//     (`projectUser`, `projectAccounts`, `twoWayGoogle`): a password (`credential`), a two-way Google link, or neither.
//     Neither means that once the switch is on the login signs in only with a magic link or a passkey (better-auth's
//     Google stays off, rule 3425; the legacy Google routes keep working);
//   - the way back better-auth takes from a session's `userId` (`loginOfPerson(pid)`): a login whose person does not
//     lead back to it would read as signed out under the new engine (`idMismatch`), and a projection whose address is
//     not the address it was read from would not be found by address (`addressMismatch`);
//   - each login's device index (`devs:{login}`) and the session records it names. A record written before R1 (no
//     `pid`) still resolves (`resolveSession` reads both shapes); an impersonation reads as signed out to better-auth
//     (server code keeps `currentUser` for it); an index entry whose record has expired is only counted.
//
// Output is counts only: no address, id, hash, token or key is printed.
// Exit codes: 0 ready (no mismatch); 1 at least one mismatch (look before switching on); 2 could not run, or `--apply`.
import { pathToFileURL } from "node:url";
import { db, mgetChunked } from "../src/lib/db";
import { pmap } from "../src/lib/parallel";
import { accountKey, globalKey, storedPersonId } from "../src/lib/keys";
import { getLogin, normalizeEmail, type Login } from "../src/lib/auth";
import { getPerson } from "../src/lib/person";
import { devicesKey } from "../src/lib/devices";
import { linkKey, subKey } from "../src/lib/google-signin";
import { loginOfPerson, projectAccounts, projectUser, twoWayGoogle } from "../src/lib/better-auth/adapter";

const CHUNK = 50;

export type CheckReport = {
  /** Ids in `users:all`. */
  accounts: number;
  /** In `users:all` with no readable record (a deletion that stopped halfway). */
  missing: number;
  /** Distinct sign-in addresses read: owners and roster persons. */
  addresses: number;
  /** Addresses that sign in (`getLogin`). */
  logins: number;
  /** Addresses that sign in as nobody under either engine (a removed member, an account that moved): counted only. */
  noLogin: number;
  /** Logins with a password (better-auth's `credential` account). */
  password: number;
  /** Logins whose Google link holds both ways (a login can count here and under `password`). */
  google: number;
  /** Logins with neither: a magic link or a passkey only, once the switch is on. */
  neither: number;
  /** The projected address is not the address the login was read from: better-auth would not find it by address. */
  addressMismatch: number;
  /** The login's person does not lead back to this login: its sessions would read as signed out to better-auth. */
  idMismatch: number;
  /** Live session records named by the logins' device indexes. */
  sessions: number;
  /** Of those, written before R1 (no person id): they still resolve. */
  sessionsNoPid: number;
  /** Of those, founder impersonations: signed out to better-auth, `currentUser` keeps them. */
  sessionsImp: number;
  /** Device index entries whose session record has expired. */
  sessionsGone: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Pure: what better-auth sees of one login read from `address`, its person's way back, and its Google link. */
export type LoginVerdict = { password: boolean; google: boolean; addressMismatch: boolean; idMismatch: boolean };
export function judgeLogin(address: string, l: Login, back: Login | null, googleSub: string | null): LoginVerdict {
  const kinds = projectAccounts(l, googleSub).map((a) => a.providerId);
  return {
    password: kinds.includes("credential"),
    google: kinds.includes("google"),
    addressMismatch: projectUser(l).email !== normalizeEmail(address),
    idMismatch: !back || back.pid !== l.pid,
  };
}

/** Pure: one session record as the new engine reads it. */
export type SessionKind = "gone" | "imp" | "noPid" | "ok";
export function sessionKind(rec: unknown): SessionKind {
  if (typeof rec === "string") return rec ? "noPid" : "gone";
  if (!isRecord(rec)) return "gone";
  if (rec.imp) return "imp";
  return typeof rec.pid === "string" && rec.pid ? "ok" : "noPid";
}

export async function run(): Promise<CheckReport> {
  const r: CheckReport = { accounts: 0, missing: 0, addresses: 0, logins: 0, noLogin: 0, password: 0, google: 0, neither: 0, addressMismatch: 0, idMismatch: 0, sessions: 0, sessionsNoPid: 0, sessionsImp: 0, sessionsGone: 0 };

  // Round 1: the accounts. Round 2: their records and rosters.
  const ids = await db.smembers(globalKey.usersAll());
  r.accounts = ids.length;
  const [users, rosters] = await Promise.all([mgetChunked<unknown>(ids.map((id) => accountKey.user(id))), pmap(ids, (id) => db.smembers(accountKey.members(id)), CHUNK)]);
  const addresses = new Set<string>();
  for (const u of users) {
    if (isRecord(u) && typeof u.email === "string" && u.email) addresses.add(normalizeEmail(u.email));
    else r.missing++;
  }
  // Round 3: each roster person once, as `getPerson` reads it (a legacy member record or a `person:` row).
  const pids = [...new Set(rosters.flat())].map((p) => storedPersonId(p));
  const persons = await pmap(pids, (pid) => getPerson(pid), CHUNK);
  for (const p of persons) if (p && typeof p.email === "string" && p.email) addresses.add(normalizeEmail(p.email));
  const list = [...addresses];
  r.addresses = list.length;

  // Round 4: each address as the sign-in route reads it, its Google link, its device index.
  const [logins, subs, indexes] = await Promise.all([
    pmap(list, (e) => getLogin(e), CHUNK),
    mgetChunked<unknown>(list.map((e) => subKey(e))),
    pmap(list, (e) => db.hgetall<unknown>(devicesKey(e)), CHUNK),
  ]);
  // Round 5: the other end of each Google link, each person's way back, the session records.
  const linked = subs.flatMap((s, i) => (typeof s === "string" && s ? [{ i, sub: s }] : []));
  const keys = indexes.flatMap((h) => Object.values(h).flatMap((e) => (isRecord(e) && typeof e.k === "string" && e.k.startsWith("session:h:") ? [e.k] : [])));
  const [backs, ways, records] = await Promise.all([
    mgetChunked<unknown>(linked.map((x) => linkKey(x.sub))),
    pmap(logins, (l) => (l ? loginOfPerson(l.pid) : Promise.resolve(null)), CHUNK),
    mgetChunked<unknown>(keys),
  ]);
  const google = new Map(linked.map((x, j) => [x.i, twoWayGoogle(list[x.i], x.sub, backs[j])]));

  logins.forEach((l, i) => {
    if (!l) {
      r.noLogin++;
      return;
    }
    r.logins++;
    const v = judgeLogin(list[i], l, ways[i], google.get(i) ?? null);
    if (v.password) r.password++;
    if (v.google) r.google++;
    if (!v.password && !v.google) r.neither++;
    if (v.addressMismatch) r.addressMismatch++;
    if (v.idMismatch) r.idMismatch++;
  });
  for (const rec of records) {
    const k = sessionKind(rec);
    if (k === "gone") {
      r.sessionsGone++;
      continue;
    }
    r.sessions++;
    if (k === "noPid") r.sessionsNoPid++;
    if (k === "imp") r.sessionsImp++;
  }
  return r;
}

/** 1 while any login would not survive the switch (a mismatch), else 0. The other counts are for reading, not blocking. */
export function exitCodeOf(r: CheckReport): 0 | 1 {
  return r.addressMismatch + r.idMismatch > 0 ? 1 : 0;
}

/** The report as printed: counts only. */
export function reportLines(r: CheckReport): string[] {
  return [
    `Read: accounts ${r.accounts} (missing records ${r.missing}), sign-in addresses ${r.addresses}, logins ${r.logins} (addresses that sign in as nobody ${r.noLogin}).`,
    `Ways in under better-auth: password ${r.password}, Google link ${r.google} (legacy Google sign-in, rule 3425), neither (magic link or passkey only) ${r.neither}.`,
    `Mismatches, must be 0 before switching on: address ${r.addressMismatch}, person ${r.idMismatch}.`,
    `Sessions: live ${r.sessions} (before R1, no person id ${r.sessionsNoPid}; impersonations, signed out to better-auth ${r.sessionsImp}); expired index entries ${r.sessionsGone}.`,
  ];
}

export const NOTHING_TO_APPLY = "Nothing to apply: better-auth reads the stored records through the adapter, so this check only reads. Run it without --apply.";

/** The command line, without printing: `--apply` is refused before the store is touched or the variables are read. */
export async function cli(argv: readonly string[]): Promise<{ code: 0 | 1 | 2; lines: string[] }> {
  if (argv.includes("--apply")) return { code: 2, lines: [NOTHING_TO_APPLY] };
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return { code: 2, lines: ["KV_REST_API_URL and KV_REST_API_TOKEN must be set (the app's own store)."] };
  const r = await run();
  return { code: exitCodeOf(r), lines: reportLines(r) };
}

async function main(): Promise<void> {
  const { code, lines } = await cli(process.argv.slice(2));
  for (const line of lines) (code === 2 ? console.error : console.log)(line);
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("The better-auth check stopped: the store could not be read. It writes nothing, so run it again.");
    process.exitCode = 2;
  });
}
