import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { json, jar, newMember, newUser, markVerified, PERSONS, signIn, signOut } from "./helpers/session";
import { softAuthenticator, type SoftAuthenticator } from "./helpers/soft-authenticator";
import { acct, createUser, getLogin, sessionKey, type User } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/cookie-names";
import { db } from "@/lib/db";
import { globalKey, personKey, storedPersonId, type PersonId } from "@/lib/keys";
import { ownerOf } from "@/lib/membership";
import { newPersonId } from "@/lib/multi-org";
import { addPasskey, credHash, ensureUid } from "@/lib/passkeys";
import { getPerson } from "@/lib/person";
import { createMember, forceRemoveMember } from "@/lib/team";
import { wipeAccount } from "@/lib/account";
import { deletePerson as deleteOwnLogin } from "@/lib/person-delete";
import type { PasskeySetValue } from "@/lib/stored";
import * as manageRoute from "@/app/api/account/passkeys/route";
import * as optionsRoute from "@/app/api/auth/passkey/options/route";
import * as verifyRoute from "@/app/api/auth/passkey/verify/route";

/**
 * Rule 2428, the passkey isolation property (docs/specs/2026-10-20-passkeys.md, threat "one person's credential signs
 * in another person"; pre-flight ruling 17). Over random rounds of persons and credentials, one person's passkey never
 * signs in another person, and a credential id a second person registers is refused.
 *
 * Each of the 40 rounds makes two accounts (two owners) and 0-2 members spread over them, gives every person 0-3
 * soft-authenticator credentials (one person's first credential through the real settings routes with the password as
 * re-authentication, the rest through the Task 3 store, ruling 17), runs one control sign-in, and then one cross case:
 *
 *  - `handle`: person B's credential presented with person A's user handle (A's `uid`);
 *  - `address`: B's credential with A's address typed in the field, sent as the user handle (the address, or A's pid,
 *    in base64url), then B's genuine assertion with A's address and pid forged into the body and headers, which may
 *    only ever sign in B;
 *  - `reborn`: A deleted (an owner's account wiped, or a member removed), sometimes with A's old set and reverse entries
 *    planted back as a rollback build's deletion would leave them, then a new person B registered at A's address (the
 *    same legacy pid in legacy mode), and A's credential presented with A's handle.
 *
 * The three cross presentations always answer 401 `passkey_failed` with no session cookie. Every 200 carries a session
 * whose `pid` is the credential's own person. Every `db` call during a verify is recorded (as tests/multi-org-isolation
 * does): the passkey families (`passkeys:`, `pkreg:`, `lock:person:`) only ever name the credential's own pid, the only
 * `pkcred:` key touched is the presented credential's own hash, and a refused sign-in writes nothing but rate counters
 * and the single-use challenge it took. Every request carries its own `x-forwarded-for`, so the per-IP buckets never
 * fill. The seed is printed on failure; `ISOLATION_SEED` replays one. Nothing is mode-specific beyond the pid shape.
 */

const SEED = Number(process.env.ISOLATION_SEED ?? 2428);
const ROUNDS = 40;
const LIVE = "https://thakeen.com";
const RP = "thakeen.com";
const PASSWORD = "abc12345";
const FAILED = { ok: false, error: "passkey_failed" };

/** mulberry32: a small deterministic PRNG, so a failing run is replayed from its seed. */
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
const chance = (p: number) => rng() < p;
const between = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

let ipN = 0;
/** A fresh client address per request (ruling 17), so no per-IP bucket fills across the file. */
const ip = () => ({ "x-forwarded-for": `100.${64 + (Math.floor(++ipN / 62500) % 64)}.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}` });
const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");

type Cred = { soft: SoftAuthenticator; counter: number };
type Person = { label: string; email: string; pid: PersonId; kind: "owner" | "member"; owner: User; alive: boolean; uid: string | null; creds: Cred[] };

// ---------------------------------------------------------------------------------------------------------------------
// The key recorder: every db call while a verify runs.
// ---------------------------------------------------------------------------------------------------------------------

const READS = new Set(["get", "mget", "lrange", "hgetall", "hget", "smembers", "sismember", "scard", "scardMany", "exists", "zcard", "zscore", "zrangeWithScores", "zrangeByScore", "ttl"]);
type Touch = { op: string; key: string };
let recording = false;
const touched: Touch[] = [];
const spies: { mockRestore(): void }[] = [];

function recordDb() {
  const target = db as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of Object.keys(target)) {
    if (typeof target[name] !== "function") continue;
    const real = target[name].bind(db);
    spies.push(
      vi.spyOn(target, name).mockImplementation(((...args: unknown[]) => {
        if (recording) {
          const keys = Array.isArray(args[0]) ? (args[0] as string[]) : typeof args[0] === "string" ? [args[0]] : [];
          if (name === "rename" && typeof args[1] === "string") keys.push(args[1]);
          for (const key of keys) touched.push({ op: name, key });
        }
        return real(...args);
      }) as never),
    );
  }
}

const PASSKEY_FAMILIES: [string, (pid: string) => string][] = [
  ["passkeys", (p) => personKey.passkeys(p as PersonId)],
  ["pkreg", (p) => personKey.passkeyReg(p as PersonId)],
  ["lock:person", (p) => personKey.lock(p as PersonId)],
];
const PK_CRED = globalKey.passkeyCred("");
const PK_AUTH = globalKey.passkeyAuth("");

/**
 * What a verify touched that it must not: a passkey-family key of any pid but `own` (the credential's own person), a
 * `pkcred:` key other than the presented credential's, and, when the answer refused, any write but a rate counter and
 * the single-use challenge.
 */
function strayTouches(own: PersonId, presentedId: string, refused: boolean): string[] {
  const out: string[] = [];
  const ownKeys = new Set(PASSKEY_FAMILIES.map(([, k]) => k(own)));
  const familyPrefixes = PASSKEY_FAMILIES.map(([, k]) => k(""));
  const hashKey = globalKey.passkeyCred(credHash(presentedId));
  for (const t of touched) {
    if (t.key !== globalKey.passkeysOff() && familyPrefixes.some((p) => t.key.startsWith(p)) && !ownKeys.has(t.key)) out.push(`${t.op} ${t.key}`);
    if (t.key.startsWith(PK_CRED) && t.key !== hashKey) out.push(`${t.op} ${t.key}`);
    if (refused && !READS.has(t.op) && !t.key.startsWith("rate:") && !(t.op === "getdel" && t.key.startsWith(PK_AUTH))) out.push(`write on refusal: ${t.op} ${t.key}`);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------------------------------
// Persons and credentials
// ---------------------------------------------------------------------------------------------------------------------

const bornOf = async (pid: PersonId) => (await getPerson(pid))!.createdAt;

async function ownerPerson(label: string): Promise<Person> {
  const u = await newUser("pkiso", { shadow: false });
  return { label, email: u.email, pid: ownerOf(u), kind: "owner", owner: u, alive: true, uid: null, creds: [] };
}
async function memberPerson(label: string, owner: Person): Promise<Person> {
  const m = await newMember(owner.owner, chance(0.5) ? "admin" : "member", "pkisom", { shadow: false });
  return { label, email: m.email, pid: m.pid, kind: "member", owner: owner.owner, alive: true, uid: null, creds: [] };
}

/** One credential through the Task 3 store, as the settings route writes it. */
async function storeCredential(p: Person): Promise<void> {
  const born = await bornOf(p.pid);
  const u = await ensureUid(p.pid, born);
  if (u === "invalid") throw new Error("ensureUid answered invalid");
  const soft = softAuthenticator();
  const r = await addPasskey(p.pid, born, { id: soft.credId, pk: soft.cosePublicKey, counter: 0, transports: ["internal"], aaguid: "00000000-0000-0000-0000-000000000000", backedUp: true }, `Key ${p.creds.length + 1}`);
  expect(r, `seed ${SEED}: store add for ${p.label}`).toMatchObject({ ok: true });
  p.uid = u.uid;
  p.creds.push({ soft, counter: 0 });
}

const manage = (body: unknown) => manageRoute.POST(json("/api/account/passkeys", "POST", body, ip()));

/** One credential through the real settings routes: signed in as `p`, the password as the proof, real crypto. */
async function routeCredential(p: Person, soft = softAuthenticator()): Promise<{ status: number; body: { ok: boolean; error?: string } }> {
  await signIn(p.email);
  try {
    const o = await manage({ action: "register-options", password: PASSWORD });
    expect(o.status, `seed ${SEED}: register-options for ${p.label}`).toBe(200);
    const options = (await o.json()).options as { challenge: string; user: { id: string } };
    const response = soft.makeAttestation({ challenge: options.challenge, origin: LIVE, rpId: RP, userHandle: options.user.id });
    const v = await manage({ action: "register-verify", response, name: `Route key ${p.creds.length + 1}` });
    const body = await v.json();
    if (v.status === 200) {
      p.uid = options.user.id;
      p.creds.push({ soft, counter: 0 });
    }
    return { status: v.status, body };
  } finally {
    signOut();
  }
}

/**
 * Options then verify through the public routes, recorded. `assertion` builds the response from the challenge;
 * `extra` adds forged fields beside `response` in the body, `headers` forged request headers.
 */
async function signInWith(
  assertion: (challenge: string) => unknown,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; pid: string | null }> {
  signOut();
  const h = ip();
  const o = await optionsRoute.POST(json("/api/auth/passkey/options", "POST", {}, h));
  expect(o.status).toBe(200);
  const challenge = (await o.json()).options.challenge as string;
  const response = assertion(challenge);
  touched.length = 0;
  recording = true;
  let status = 0;
  let body: unknown = null;
  try {
    const r = await verifyRoute.POST(json("/api/auth/passkey/verify", "POST", { response, ...extra }, { ...headers, ...h }));
    status = r.status;
    body = await r.json();
  } finally {
    recording = false;
  }
  const token = jar().get(SESSION_COOKIE);
  const pid = token ? ((await db.get<{ pid?: string }>(sessionKey(token)))?.pid ?? null) : null;
  return { status, body, pid };
}

/** A good assertion from `c` (its counter moves on every use), with `userHandle` as given. */
const assertFrom = (c: Cred, userHandle: string | null) => (challenge: string) => {
  c.counter += 1;
  return c.soft.makeAssertion({ challenge, origin: LIVE, rpId: RP, userHandle, counter: c.counter });
};

/** The pid shape of the fixture mode: `p_` persons by default, legacy ids (the account id or the address) otherwise. */
function expectPidShape(p: Person) {
  if (PERSONS === "p") expect(p.pid, `seed ${SEED}: ${p.label}`).toMatch(/^p_/);
  else expect(p.pid, `seed ${SEED}: ${p.label}`).toBe(storedPersonId(p.kind === "owner" ? acct(p.owner) : p.email.toLowerCase()));
}

/** Delete `a` for good: an owner's account wiped (its members go with it), or a member removed. */
async function deletePerson(a: Person, round: Person[]) {
  if (a.kind === "owner") {
    await wipeAccount(acct(a.owner));
    for (const p of round) if (p.owner === a.owner) p.alive = false;
  } else {
    expect(await forceRemoveMember(a.email)).toBe(true);
    // With MULTI_ORG on a removal keeps the person (they may hold other workspaces): the person goes through the delete-own-login flow (rule 2754).
    const left = await getPerson(a.pid);
    if (left) expect(await deleteOwnLogin(left), `seed ${SEED}: ${a.label} deletes its login`).toMatchObject({ ok: true });
    a.alive = false;
  }
  expect(await getPerson(a.pid), `seed ${SEED}: ${a.label} is still a person`).toBeNull();
}

/** A new person registered at `a`'s address: an owner signs up there again, or a member joins a living account. */
async function rebornAt(a: Person, round: Person[]): Promise<Person> {
  await new Promise((r) => setTimeout(r, 3)); // another `createdAt` than the deleted person's
  if (a.kind === "owner") {
    const u = await createUser({ email: a.email, name: "Again", phone: "", password: PASSWORD, lang: "ar" }, PERSONS === "p" ? { person: "p" } : {});
    const v = await markVerified(u.email);
    return { label: `${a.label}'`, email: a.email, pid: ownerOf(v), kind: "owner", owner: v, alive: true, uid: null, creds: [] };
  }
  const host = round.find((p) => p.alive && p.kind === "owner")!;
  const input = { email: a.email, name: "Again", password: PASSWORD, lang: "ar" as const, role: "member" as const, invitedBy: host.owner.email };
  if (PERSONS === "p") {
    const pid = storedPersonId(newPersonId());
    await createMember(acct(host.owner), { ...input, invitedByPid: ownerOf(host.owner) }, { pid });
    return { label: `${a.label}'`, email: a.email, pid, kind: "member", owner: host.owner, alive: true, uid: null, creds: [] };
  }
  await createMember(acct(host.owner), input);
  return { label: `${a.label}'`, email: a.email, pid: (await getLogin(a.email))!.pid, kind: "member", owner: host.owner, alive: true, uid: null, creds: [] };
}

beforeAll(() => {
  recordDb();
});
afterAll(() => {
  for (const s of spies) s.mockRestore();
});
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", LIVE);
});

// ---------------------------------------------------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------------------------------------------------

describe("rule 2428: one person's passkey never signs in another person", () => {
  it(`${ROUNDS} random rounds: the three cross cases answer 401 and every session is the credential's own person (seed ${SEED})`, async () => {
    const problems: string[] = [];
    const kinds = new Map<string, number>();
    let controls = 0;
    let routeAdds = 0;
    let planted = 0;

    /** Check one sign-in: the status, the session's person, and the recorded keys. */
    const check = (at: string, r: { status: number; body: unknown; pid: string | null }, expect200: PersonId | null, own: PersonId, presentedId: string) => {
      if (expect200) {
        if (r.status !== 200) problems.push(`${at}: status ${r.status} ${JSON.stringify(r.body)}, expected 200`);
        if (r.pid !== expect200) problems.push(`${at}: session pid ${r.pid}, expected ${expect200}`);
      } else {
        if (r.status !== 401 || JSON.stringify(r.body) !== JSON.stringify(FAILED)) problems.push(`${at}: status ${r.status} ${JSON.stringify(r.body)}, expected 401 passkey_failed`);
        if (r.pid !== null) problems.push(`${at}: a session for ${r.pid}`);
      }
      for (const s of strayTouches(own, presentedId, !expect200)) problems.push(`${at}: ${s}`);
      // The recorder saw the verify: a sign-in reads and writes its own set under its own person lock.
      if (expect200 && !(["setXx", "lock"] as const).every((op) => touched.some((t) => t.op === op && (op === "lock" ? t.key === personKey.lock(own) : t.key === personKey.passkeys(own)))))
        problems.push(`${at}: the recorder missed the counter write under lock:person:${own}`);
    };

    for (let round = 0; round < ROUNDS && problems.length < 5; round++) {
      // Two accounts, 0-2 members spread over them.
      const owners = [await ownerPerson(`r${round}o0`), await ownerPerson(`r${round}o1`)];
      const members: Person[] = [];
      for (let j = between(0, 2); j > 0; j--) members.push(await memberPerson(`r${round}m${members.length}`, pick(owners)));
      const persons = [...owners, ...members];
      for (const p of persons) expectPidShape(p);

      // 0-3 credentials each; one person's first through the real routes, the rest through the store.
      const counts = persons.map(() => between(0, 3));
      // At least two holders, so a cross case always has a credential of another person to present.
      if (counts.filter((n) => n > 0).length < 2) {
        counts[0] = Math.max(counts[0], 1);
        counts[1] = Math.max(counts[1], 1);
      }
      const viaRoute = pick(persons.filter((_, i) => counts[i] > 0));
      for (const [i, p] of persons.entries()) {
        for (let n = 0; n < counts[i]; n++) {
          if (p === viaRoute && n === 0) {
            const r = await routeCredential(p);
            if (r.status !== 200) problems.push(`seed ${SEED}, round ${round}: route add for ${p.label} answered ${r.status} ${JSON.stringify(r.body)}`);
            else routeAdds++;
          } else await storeCredential(p);
        }
      }
      const holders = persons.filter((p) => p.creds.length > 0);

      // Control: a holder signs in with its own credential.
      {
        const c = pick(holders);
        const cred = pick(c.creds);
        const r = await signInWith(assertFrom(cred, c.uid));
        check(`seed ${SEED}, round ${round}, control ${c.label}`, r, c.pid, c.pid, cred.soft.credId);
        controls++;
      }

      const kind = pick(["handle", "address", "reborn"] as const);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      const at = `seed ${SEED}, round ${round}, ${kind}`;

      if (kind === "handle" || kind === "address") {
        const b = pick(holders);
        const a = pick(persons.filter((p) => p !== b));
        const cred = pick(b.creds);
        if (kind === "handle") {
          // A's user handle: A's own `uid` when A has a set, else a well-formed handle that is nobody's.
          const handle = a.uid ?? Buffer.alloc(32, round).toString("base64url");
          check(`${at}: ${b.label}'s credential, ${a.label}'s handle`, await signInWith(assertFrom(cred, handle)), null, b.pid, cred.soft.credId);
        } else {
          // A's address typed in the field, arriving as the user handle (the address, or A's pid).
          for (const handle of [b64u(a.email), b64u(a.pid)]) {
            check(`${at}: ${b.label}'s credential, ${a.label}'s address as handle`, await signInWith(assertFrom(cred, handle)), null, b.pid, cred.soft.credId);
          }
          // B's genuine assertion with A's address and pid forged beside it: only ever B.
          const forged = { email: a.email, login: a.email, address: a.email, pid: a.pid, userHandle: a.uid ?? b64u(a.email) };
          const r = await signInWith(assertFrom(cred, b.uid), forged, { "x-thakeen-login": a.email, "x-thakeen-pid": a.pid });
          check(`${at}: ${b.label}'s credential with ${a.label}'s address forged beside it`, r, b.pid, b.pid, cred.soft.credId);
        }
      } else {
        // A deleted, maybe planted back by a rollback build, then a new person at A's address. With MULTI_ORG on a
        // legacy-shaped member (its id is its address) keeps its person on removal and cannot delete it until M4
        // (rules 2124, 2754): its address is never given again, so only owners and `p_` persons are deleted here.
        const gone = holders.filter((p) => p.kind === "owner" || p.pid !== p.email.toLowerCase());
        if (!gone.length) {
          kinds.set(kind, (kinds.get(kind) ?? 1) - 1); // not a case: the count below asserts real ones
          continue;
        }
        const a = pick(gone);
        const oldSet = await db.get<PasskeySetValue>(personKey.passkeys(a.pid));
        const entries = a.creds.map((c) => globalKey.passkeyCred(credHash(c.soft.credId)));
        await deletePerson(a, persons);
        const rollback = chance(0.5);
        if (rollback) {
          await Promise.all([db.set(personKey.passkeys(a.pid), oldSet), ...entries.map((k) => db.set(k, a.pid))]);
          planted++;
        }
        const b = await rebornAt(a, persons);
        persons.push(b);
        // With OPAQUE_IDS on a new owner at the address gets a fresh account id, in either person shape.
        expect(b.pid, `${at}: the new person's id is not the deleted one's`).not.toBe(a.pid);
        for (let n = between(0, 2); n > 0; n--) await storeCredential(b);
        const cred = pick(a.creds);
        check(`${at}: deleted ${a.label}'s credential (rollback ${rollback}) after ${b.label} registered at the address`, await signInWith(assertFrom(cred, a.uid)), null, a.pid, cred.soft.credId);
        // The new person at the address still signs in with its own credential, as itself.
        if (b.creds.length) {
          const own = pick(b.creds);
          check(`${at}: ${b.label} at the reused address`, await signInWith(assertFrom(own, b.uid)), b.pid, b.pid, own.soft.credId);
        }
      }
    }

    expect(problems, `isolation property failed; replay with ISOLATION_SEED=${SEED}`).toEqual([]);
    // The run exercised every case, the real routes and a rollback planting.
    for (const k of ["handle", "address", "reborn"]) expect(kinds.get(k) ?? 0, `seed ${SEED} made no "${k}" case`).toBeGreaterThan(3);
    expect(controls).toBe(ROUNDS);
    expect(routeAdds).toBe(ROUNDS);
    expect(planted, `seed ${SEED} planted no rollback set`).toBeGreaterThan(0);
  }, 60_000);
});

describe("rule 2428 (rule 2404): a credential id held by one person is refused to another", () => {
  it("a second person registering the same credential id through the routes gets 409 credential_taken; its set is unchanged and the first person still signs in", async () => {
    for (let pair = 0; pair < 3; pair++) {
      const o = await ownerPerson(`c${pair}o`);
      const a = chance(0.5) ? o : await memberPerson(`c${pair}a`, o);
      const other = await ownerPerson(`c${pair}x`);
      const b = chance(0.5) ? other : await memberPerson(`c${pair}b`, other);
      // B already holds 0-2 passkeys of its own.
      for (let n = between(0, 2); n > 0; n--) await storeCredential(b);
      expect((await routeCredential(a)).status).toBe(200);
      const taken = a.creds[0].soft.credId;

      // B opens a registration; its set (created now if B had none) is the snapshot.
      await signIn(b.email);
      const opened = await manage({ action: "register-options", password: PASSWORD });
      expect(opened.status).toBe(200);
      const options = (await opened.json()).options as { challenge: string; user: { id: string } };
      const before = JSON.stringify(await db.get(personKey.passkeys(b.pid)));
      const twin = softAuthenticator({ credId: taken });
      const response = twin.makeAttestation({ challenge: options.challenge, origin: LIVE, rpId: RP, userHandle: options.user.id });
      const v = await manage({ action: "register-verify", response, name: "Same id" });
      signOut();
      expect({ status: v.status, body: await v.json() }, `seed ${SEED}, pair ${pair}`).toEqual({ status: 409, body: { ok: false, error: "credential_taken" } });
      expect(JSON.stringify(await db.get(personKey.passkeys(b.pid)))).toBe(before);
      expect(String(await db.get(globalKey.passkeyCred(credHash(taken))))).toBe(a.pid);
      // The store refuses it too (rule 2404), whoever asks.
      const born = await bornOf(b.pid);
      expect(await addPasskey(b.pid, born, { id: taken, pk: twin.cosePublicKey, counter: 0, transports: ["internal"], aaguid: "00000000-0000-0000-0000-000000000000", backedUp: true }, "Again")).toBe("credential_taken");

      // A still signs in, as A; the twin key (same id, B's handle) does not, and never as B.
      const ra = await signInWith(assertFrom(a.creds[0], a.uid));
      expect({ status: ra.status, pid: ra.pid }).toEqual({ status: 200, pid: a.pid });
      const twinCred: Cred = { soft: twin, counter: 50 };
      const rb = await signInWith(assertFrom(twinCred, options.user.id));
      expect({ status: rb.status, body: rb.body, pid: rb.pid }).toEqual({ status: 401, body: FAILED, pid: null });
      expect(strayTouches(a.pid, taken, true)).toEqual([]);
    }
  }, 60_000);
});
