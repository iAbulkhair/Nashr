import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { globalKey, personKey, storedPersonId, type PersonId } from "@/lib/keys";
import { ownerOf } from "@/lib/membership";
import { getLogin } from "@/lib/auth";
import { getPerson } from "@/lib/person";
import { PASSKEYS_MAX } from "@/lib/passkey-limits";
import {
  addPasskey,
  cleanName,
  counterOk,
  credHash,
  ensureUid,
  listPasskeys,
  movePasskeys,
  passkeyKeys,
  readSet,
  recordUse,
  refOf,
  removePasskey,
  renamePasskey,
  resolvePasskeyLogin,
  shortHash,
} from "@/lib/passkeys";
import type { PasskeySetValue } from "@/lib/stored";
import type { RegisteredCred } from "@/lib/webauthn";
import { newMember, newUser } from "./helpers/session";

/**
 * Customer passkeys, task 3 (docs/specs/2026-10-20-passkeys.md, docs/system/tests/2400-passkeys.md): the passkey store
 * `src/lib/passkeys.ts` on the memory store, with spies on `db`. Rules 2401-2404, 2413, 2414, 2416 and the store halves
 * of 2421, 2422, 2424 and 2425, with pre-flight rulings 1, 3, 10, 13, 21 and 22, and the Task 3 fix round 1 (the move's
 * births read inside it, its write order and retry, a live destination kept, a broken set never replaced, no orphaned
 * reverse entry on a failed write).
 */

afterEach(() => vi.restoreAllMocks());

let n = 0;
const BORN = "2026-10-01T00:00:00.000Z";
const pidOf = (kind: "legacy" | "p" = "legacy"): PersonId =>
  storedPersonId(kind === "p" ? `p_${randomBytes(12).toString("hex")}` : `pk${++n}-${randomBytes(3).toString("hex")}@test.example`);
const cred = (over: Partial<RegisteredCred> = {}): RegisteredCred => ({
  id: randomBytes(16).toString("base64url"),
  pk: randomBytes(77).toString("base64url"),
  counter: 0,
  transports: ["internal", "hybrid"],
  aaguid: "00000000-0000-0000-0000-000000000000",
  backedUp: true,
  ...over,
});
/** A person row for `pid` born at `createdAt` (what `getPerson` reads; the move reads both births itself). */
async function person(pid: PersonId, createdAt = BORN, email = `${pid.replace(/[^a-z0-9]/gi, "")}@row.test.example`): Promise<PersonId> {
  await db.set(personKey.person(pid), { pid, email, name: "", lang: "ar", createdAt });
  return pid;
}
/** Every reverse entry naming `pid` that its set does not list: must always be empty. */
async function orphans(pid: PersonId, ids: string[]): Promise<string[]> {
  const set = await rawSet(pid);
  const listed = new Set((set?.creds ?? []).map((c) => c.id));
  const vals = await Promise.all(ids.map(reverse));
  return ids.filter((id, i) => vals[i] === pid && !listed.has(id));
}
/** The uid of an `ensureUid` answer; the union makes the caller split off `invalid` (ruling N4). */
const uidOf = (r: { uid: string } | "invalid"): string => {
  if (r === "invalid") throw new Error("ensureUid answered invalid");
  return r.uid;
};
const rawSet = (pid: PersonId) => db.get<PasskeySetValue>(personKey.passkeys(pid));
const reverse = (id: string) => db.get<string>(globalKey.passkeyCred(credHash(id)));

/** Adds `count` passkeys to `pid` (sequential on purpose: each waits for the person lock anyway); returns their ids. */
async function fill(pid: PersonId, count: number, born = BORN): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const c = cred();
    const r = await addPasskey(pid, born, c, `Key ${i + 1}`);
    expect(r).toMatchObject({ ok: true });
    ids.push(c.id);
  }
  return ids;
}

/** Spies that record every store write, and whether the person lock of `pid` was held when it ran. */
function recordWrites(pid: PersonId) {
  const lockKey = personKey.lock(pid);
  let held = false;
  const writes: { op: string; key: string; held: boolean }[] = [];
  const locks: string[] = [];
  const lock = db.lock.bind(db);
  const unlock = db.unlock.bind(db);
  vi.spyOn(db, "lock").mockImplementation(async (key, ttl) => {
    const got = await lock(key, ttl);
    if (got) locks.push(key);
    if (got && key === lockKey) held = true;
    return got;
  });
  vi.spyOn(db, "unlock").mockImplementation(async (key) => {
    if (key === lockKey) held = false;
    return unlock(key);
  });
  for (const op of ["set", "setNx", "setXx", "del", "replaceIf"] as const) {
    const orig = (db[op] as (...a: unknown[]) => Promise<unknown>).bind(db);
    vi.spyOn(db, op).mockImplementation((async (...a: unknown[]) => {
      writes.push({ op, key: String(a[0]), held });
      return orig(...a);
    }) as never);
  }
  return { writes, locks };
}

describe("hashes and names", () => {
  it("credHash is the SHA-256 hex of the id; refOf and shortHash are its first 16 and 8 characters", () => {
    expect(credHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(refOf("abc")).toBe("ba7816bf8f01cfea");
    expect(shortHash("abc")).toBe("ba7816bf");
  });

  it("rule 2401: cleanName trims, drops control and bidi-override characters, refuses empty and 41 characters", () => {
    expect(cleanName("  My phone  ")).toBe("My phone");
    expect(cleanName("My\u0000 \u0007phone\n")).toBe("My phone");
    expect(cleanName("\u202Eenohp\u202C ym")).toBe("enohp ym");
    expect(cleanName("a\u2066b\u2067c\u2068d\u2069e\u202Af\u202Bg\u202Dh")).toBe("abcdefgh");
    expect(cleanName("هاتفي")).toBe("هاتفي");
    expect(cleanName("x".repeat(40))).toBe("x".repeat(40));
    expect(cleanName("x".repeat(41))).toBeNull();
    expect(cleanName("")).toBeNull();
    expect(cleanName("   ")).toBeNull();
    expect(cleanName("\u202E\u0000")).toBeNull();
    expect(cleanName(42)).toBeNull();
    expect(cleanName(null)).toBeNull();
    expect(cleanName(undefined)).toBeNull();
  });
});

describe("rule 2401: the cap of 10 and the stored shape", () => {
  it("the eleventh passkey answers limit and writes nothing", async () => {
    const pid = pidOf();
    await fill(pid, PASSKEYS_MAX);
    const before = await rawSet(pid);
    const extra = cred();
    const { writes } = recordWrites(pid);
    expect(await addPasskey(pid, BORN, extra, "One too many")).toBe("limit");
    expect(writes).toEqual([]);
    expect(await rawSet(pid)).toEqual(before);
    expect(await reverse(extra.id)).toBeNull();
  });

  it("a credential that does not fit PasskeyCred (a 2049-character key, nine transports, a 21-character transport, a bad name) is refused and nothing is written", async () => {
    const pid = pidOf();
    await ensureUid(pid, BORN);
    const before = await rawSet(pid);
    const bad: [RegisteredCred, string][] = [
      [cred({ pk: "A".repeat(2049) }), "Key"],
      [cred({ transports: Array.from({ length: 9 }, () => "usb") }), "Key"],
      [cred({ transports: ["x".repeat(21)] }), "Key"],
      [cred({ id: "short" }), "Key"],
      [cred({ id: "has+plus/slash_aaaaaaaaaa" }), "Key"],
      [cred({ counter: -1 }), "Key"],
      [cred(), "x".repeat(41)],
      [cred(), "\u202E"],
    ];
    const { writes, locks } = recordWrites(pid);
    for (const [c, name] of bad) {
      expect(await addPasskey(pid, BORN, c, name)).toBe("invalid");
      expect(await reverse(c.id)).toBeNull();
    }
    expect(writes).toEqual([]);
    expect(locks).toEqual([]);
    expect(await rawSet(pid)).toEqual(before);
  });

  it("a stored set that fails the shape reads as no passkeys, is never replaced (ensureUid and addPasskey answer invalid) and only a wipe lists it", async () => {
    const pid = pidOf();
    const id = cred().id;
    // A later build's shape, rolled back (rule 679): nothing here may delete it.
    const broken = { v: 2, uid: "short", born: BORN, creds: [{ id }] };
    await db.set(personKey.passkeys(pid), broken);
    await db.set(globalKey.passkeyCred(credHash(id)), pid);
    expect(await readSet(pid, BORN)).toBeNull();
    expect(await listPasskeys(pid, BORN)).toEqual([]);
    const { writes } = recordWrites(pid);
    const c = cred();
    expect(await ensureUid(pid, BORN)).toBe("invalid");
    expect(await ensureUid(pid, "2026-10-02T00:00:00.000Z")).toBe("invalid");
    expect(await addPasskey(pid, BORN, c, "Key")).toBe("invalid");
    expect(writes).toEqual([]);
    expect(await rawSet(pid)).toEqual(broken);
    expect(await reverse(id)).toBe(pid);
    expect(await reverse(c.id)).toBeNull();
    expect((await passkeyKeys(pid)).sort()).toEqual([personKey.passkeys(pid), personKey.passkeyReg(pid), globalKey.passkeyCred(credHash(id))].sort());
  });
});

describe("rule 2402: a set stamped with another birth", () => {
  it("reads as null and lists nothing, and a read never deletes it", async () => {
    const pid = pidOf();
    await fill(pid, 2);
    const before = await rawSet(pid);
    expect(await readSet(pid, "2026-10-02T00:00:00.000Z")).toBeNull();
    expect(await readSet(pid, undefined)).toBeNull();
    expect(await listPasskeys(pid, "2026-10-02T00:00:00.000Z")).toEqual([]);
    expect(await rawSet(pid)).toEqual(before);
    expect((await readSet(pid, BORN))?.creds).toHaveLength(2);
  });

  it("ensureUid replaces it with a new uid and deletes only the reverse entries that still name the pid", async () => {
    const pid = pidOf();
    const [mine, taken] = await fill(pid, 2);
    const old = (await rawSet(pid))!;
    const other = pidOf();
    await db.set(globalKey.passkeyCred(credHash(taken)), other); // since taken over by another person
    const uid = uidOf(await ensureUid(pid, "2026-10-02T00:00:00.000Z"));
    expect(uid).not.toBe(old.uid);
    expect(await rawSet(pid)).toEqual({ v: 1, uid, born: "2026-10-02T00:00:00.000Z", creds: [] });
    expect(await reverse(mine)).toBeNull();
    expect(await reverse(taken)).toBe(other);
  });

  it("addPasskey on a stale set replaces it inside the person lock, then adds", async () => {
    const pid = pidOf();
    const [old] = await fill(pid, 1);
    const oldUid = (await rawSet(pid))!.uid;
    const c = cred();
    const { writes } = recordWrites(pid);
    expect(await addPasskey(pid, "2026-10-02T00:00:00.000Z", c, "New")).toMatchObject({ ok: true });
    const set = (await rawSet(pid))!;
    expect(set.uid).not.toBe(oldUid);
    expect(set.born).toBe("2026-10-02T00:00:00.000Z");
    expect(set.creds.map((x) => x.id)).toEqual([c.id]);
    expect(await reverse(old)).toBeNull();
    expect(await reverse(c.id)).toBe(pid);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.held)).toBe(true);
  });
});

describe("rule 2403: the user handle", () => {
  it("is 43 base64url characters, differs per person and survives add and remove", async () => {
    const [a, b] = [pidOf(), pidOf("p")];
    const ua = uidOf(await ensureUid(a, BORN));
    const ub = uidOf(await ensureUid(b, BORN));
    expect(ua).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ub).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ua).not.toBe(ub);
    expect(ua).not.toContain(a);
    expect(await ensureUid(a, BORN)).toEqual({ uid: ua });
    const [id] = await fill(a, 1);
    expect((await rawSet(a))!.uid).toBe(ua);
    expect(await removePasskey(a, BORN, refOf(id))).toBe("ok");
    expect((await rawSet(a))!.uid).toBe(ua);
    expect(await ensureUid(a, BORN)).toEqual({ uid: ua });
  });

  it("addPasskey on a person with no set creates one with a fresh uid and the given birth", async () => {
    const pid = pidOf("p");
    const c = cred();
    const r = await addPasskey(pid, BORN, c, "First");
    expect(r).toMatchObject({ ok: true });
    const set = (await rawSet(pid))!;
    expect(set.uid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(set.born).toBe(BORN);
    expect(set.v).toBe(1);
  });
});

describe("rule 2404: a credential id is held by one pid only", () => {
  it("a second pid adding the same credential answers credential_taken and its set is unchanged", async () => {
    const [a, b] = [pidOf(), pidOf("p")];
    const c = cred();
    expect(await addPasskey(a, BORN, c, "Mine")).toMatchObject({ ok: true });
    await ensureUid(b, BORN);
    const before = await rawSet(b);
    expect(await addPasskey(b, BORN, { ...c }, "Stolen")).toBe("credential_taken");
    expect(await rawSet(b)).toEqual(before);
    expect(await reverse(c.id)).toBe(a);
  });

  it("the same pid adding the same credential twice is refused too", async () => {
    const pid = pidOf();
    const c = cred();
    expect(await addPasskey(pid, BORN, c, "Once")).toMatchObject({ ok: true });
    const before = await rawSet(pid);
    expect(await addPasskey(pid, BORN, { ...c }, "Twice")).toBe("credential_taken");
    expect(await rawSet(pid)).toEqual(before);
  });

  it("the reverse entry is written with SET NX and no expiry", async () => {
    const pid = pidOf();
    const setNx = vi.spyOn(db, "setNx");
    const c = cred();
    await addPasskey(pid, BORN, c, "Key");
    expect(setNx).toHaveBeenCalledTimes(1);
    expect(setNx.mock.calls[0]).toEqual([globalKey.passkeyCred(credHash(c.id)), pid]);
    expect(await db.ttl(globalKey.passkeyCred(credHash(c.id)))).toBe(-1);
    expect(await db.ttl(personKey.passkeys(pid))).toBe(-1);
  });
});

describe("rule 2413: the list and refs", () => {
  it("addPasskey answers the new item; the list carries only ref, name, dates, synced and transports", async () => {
    const pid = pidOf();
    const c = cred({ backedUp: false, transports: ["usb"] });
    const r = await addPasskey(pid, BORN, c, "  Security key  ");
    expect(r).not.toBe("limit");
    const item = (r as { ok: true; item: Record<string, unknown> }).item;
    expect(Object.keys(item).sort()).toEqual(["createdAt", "name", "ref", "synced", "transports"]);
    expect(item).toMatchObject({ ref: refOf(c.id), name: "Security key", synced: false, transports: ["usb"] });
    await recordUse(pid, BORN, c.id, 1);
    expect(await listPasskeys(pid, BORN)).toHaveLength(1);
    await fill(pid, 1);
    const second = await listPasskeys(pid, BORN);
    expect(second).toHaveLength(2);
    for (const it of second) {
      for (const k of Object.keys(it)) expect(["ref", "name", "createdAt", "lastUsedAt", "synced", "transports"]).toContain(k);
      expect(it).not.toHaveProperty("id");
      expect(it).not.toHaveProperty("pk");
      expect(it).not.toHaveProperty("aaguid");
      expect(it).not.toHaveProperty("counter");
      expect(JSON.stringify(it)).not.toContain(c.id);
      expect(JSON.stringify(it)).not.toContain(c.pk);
    }
    const used = second.find((x) => x.ref === refOf(c.id))!;
    expect(Object.keys(used).sort()).toEqual(["createdAt", "lastUsedAt", "name", "ref", "synced", "transports"]);
    expect(second.find((x) => x.ref !== refOf(c.id))).toMatchObject({ synced: true });
  });

  it("renamePasskey matches a ref only inside the caller's own set", async () => {
    const [a, b] = [pidOf(), pidOf()];
    const [ida] = await fill(a, 1);
    await fill(b, 1);
    const before = await rawSet(a);
    expect(await renamePasskey(b, BORN, refOf(ida), "Hijacked")).toBe("not_found");
    expect(await removePasskey(b, BORN, refOf(ida))).toBe("not_found");
    expect(await rawSet(a)).toEqual(before);
    expect(await reverse(ida)).toBe(a);
    expect(await renamePasskey(a, BORN, refOf(ida), " Laptop\u202E ")).toBe("ok");
    expect((await listPasskeys(a, BORN))[0].name).toBe("Laptop");
    expect(await renamePasskey(a, BORN, refOf(ida), "x".repeat(41))).toBe("invalid");
    expect(await renamePasskey(a, "2026-10-02T00:00:00.000Z", refOf(ida), "Stale")).toBe("not_found");
    expect((await listPasskeys(a, BORN))[0].name).toBe("Laptop");
  });
});

describe("rule 2414: every write under lock:person:{pid}", () => {
  it("add, rename, remove, recordUse and ensureUid write only while the person lock is held", async () => {
    const pid = pidOf();
    const { writes, locks } = recordWrites(pid);
    expect(uidOf(await ensureUid(pid, BORN))).toBeTruthy();
    const c = cred();
    await addPasskey(pid, BORN, c, "Key");
    await renamePasskey(pid, BORN, refOf(c.id), "Renamed");
    await recordUse(pid, BORN, c.id, 3);
    await removePasskey(pid, BORN, refOf(c.id));
    const ops = new Set(writes.map((w) => w.op));
    for (const op of ["set", "setNx", "setXx", "del"]) expect(ops.has(op)).toBe(true);
    expect(writes.filter((w) => !w.key.startsWith("lock:"))).toEqual(writes.filter((w) => !w.key.startsWith("lock:")).map((w) => ({ ...w, held: true })));
    expect(locks.length).toBeGreaterThanOrEqual(5);
    expect(locks.every((k) => k === `lock:person:${pid}`)).toBe(true);
  });

  it("personLocked: true takes no lock (the caller holds it)", async () => {
    const pid = pidOf();
    const lock = vi.spyOn(db, "lock");
    await ensureUid(pid, BORN, { personLocked: true });
    const c = cred();
    await addPasskey(pid, BORN, c, "Key", { personLocked: true });
    await renamePasskey(pid, BORN, refOf(c.id), "Renamed", { personLocked: true });
    await removePasskey(pid, BORN, refOf(c.id), { personLocked: true });
    expect(lock).not.toHaveBeenCalled();
  });

  it("two parallel adds with the cap at 9 leave exactly 10", async () => {
    const pid = pidOf();
    await fill(pid, PASSKEYS_MAX - 1);
    const answers = await Promise.all([addPasskey(pid, BORN, cred(), "A"), addPasskey(pid, BORN, cred(), "B")]);
    expect(answers.filter((a) => a === "limit")).toHaveLength(1);
    expect(answers.filter((a) => typeof a === "object" && a.ok)).toHaveLength(1);
    const set = (await rawSet(pid))!;
    expect(set.creds).toHaveLength(PASSKEYS_MAX);
    const owned = await Promise.all(set.creds.map((c) => reverse(c.id)));
    expect(owned.every((v) => v === pid)).toBe(true);
  });

  it("a lock that stays taken throws person_lock_timeout and writes nothing", async () => {
    const pid = pidOf();
    await ensureUid(pid, BORN);
    vi.useFakeTimers();
    try {
      vi.spyOn(db, "lock").mockResolvedValue(false);
      const set = vi.spyOn(db, "set");
      const p = addPasskey(pid, BORN, cred(), "Key");
      const settled = p.catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      expect(String(await settled)).toContain("person_lock_timeout");
      expect(set).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the reverse-entry writes of a ten-credential move and a stale replacement go out together, not one after another", async () => {
    const [from, to] = await Promise.all([person(pidOf()), person(pidOf("p"))]);
    await fill(from, PASSKEYS_MAX);
    const inFlight = (op: "replaceIf" | "del") => {
      const orig = (db[op] as (...a: unknown[]) => Promise<unknown>).bind(db);
      let done = 0;
      const seen: number[] = [];
      vi.spyOn(db, op).mockImplementation((async (...a: unknown[]) => {
        const key = String(a[0]);
        if (key.startsWith("pkcred:")) seen.push(done);
        const r = await orig(...a);
        await new Promise((res) => setTimeout(res, 1));
        if (key.startsWith("pkcred:")) done++;
        return r;
      }) as never);
      return seen;
    };
    const moved = inFlight("replaceIf");
    await movePasskeys(from, to, { personLocked: false });
    expect(moved).toHaveLength(PASSKEYS_MAX);
    expect(moved.every((d) => d === 0)).toBe(true);
    vi.restoreAllMocks();
    const dropped = inFlight("del");
    await ensureUid(to, "2026-10-02T00:00:00.000Z");
    expect(dropped).toHaveLength(PASSKEYS_MAX);
    expect(dropped.every((d) => d === 0)).toBe(true);
  });
});

describe("rule 2416: removing", () => {
  it("removing the last passkey leaves creds: [] with the uid and deletes its reverse entry", async () => {
    const pid = pidOf();
    const [id] = await fill(pid, 1);
    const uid = (await rawSet(pid))!.uid;
    expect(await removePasskey(pid, BORN, refOf(id))).toBe("ok");
    expect(await rawSet(pid)).toEqual({ v: 1, uid, born: BORN, creds: [] });
    expect(await reverse(id)).toBeNull();
    expect(await removePasskey(pid, BORN, refOf(id))).toBe("not_found");
  });

  it("a reverse entry that already names another pid is left alone", async () => {
    const pid = pidOf();
    const [id, kept] = await fill(pid, 2);
    const other = pidOf("p");
    await db.set(globalKey.passkeyCred(credHash(id)), other);
    expect(await removePasskey(pid, BORN, refOf(id))).toBe("ok");
    expect(await reverse(id)).toBe(other);
    expect((await rawSet(pid))!.creds.map((c) => c.id)).toEqual([kept]);
    expect(await reverse(kept)).toBe(pid);
  });

  it("a set deleted meanwhile is never re-created by rename or remove", async () => {
    const pid = pidOf();
    const [id] = await fill(pid, 1);
    const ref = refOf(id);
    const get = db.get.bind(db);
    // The wipe lands between the read inside the lock and the write.
    vi.spyOn(db, "get").mockImplementation((async (key: string) => {
      const v = await get(key);
      if (key === personKey.passkeys(pid)) await db.del(key);
      return v;
    }) as never);
    expect(await renamePasskey(pid, BORN, ref, "Late")).toBe("not_found");
    expect(await rawSet(pid)).toBeNull();
  });
});

describe("rule 2421 (store half): the signature counter", () => {
  it("counterOk", () => {
    const table: [number, number, boolean][] = [
      [0, 0, true],
      [0, 1, true],
      [5, 6, true],
      [5, 5, false],
      [5, 4, false],
      [5, 0, false],
    ];
    for (const [stored, next, ok] of table) expect(counterOk(stored, next), `${stored} -> ${next}`).toBe(ok);
  });

  it("recordUse with a regression answers counter with the stored value and writes nothing", async () => {
    const pid = pidOf();
    const c = cred({ counter: 5 });
    await addPasskey(pid, BORN, c, "Key");
    const before = await rawSet(pid);
    const { writes } = recordWrites(pid);
    expect(await recordUse(pid, BORN, c.id, 5)).toEqual({ result: "counter", stored: 5 });
    expect(await recordUse(pid, BORN, c.id, 4)).toEqual({ result: "counter", stored: 5 });
    expect(await recordUse(pid, BORN, c.id, 0)).toEqual({ result: "counter", stored: 5 });
    expect(writes).toEqual([]);
    expect(await rawSet(pid)).toEqual(before);
  });

  it("recordUse writes the new counter and lastUsedAt with SET XX under the lock", async () => {
    const pid = pidOf();
    const c = cred();
    await addPasskey(pid, BORN, c, "Key");
    const { writes } = recordWrites(pid);
    expect(await recordUse(pid, BORN, c.id, 0)).toEqual({ result: "ok", stored: 0 });
    expect(await recordUse(pid, BORN, c.id, 7)).toEqual({ result: "ok", stored: 0 });
    expect(writes.map((w) => [w.op, w.key, w.held])).toEqual([
      ["setXx", personKey.passkeys(pid), true],
      ["setXx", personKey.passkeys(pid), true],
    ]);
    const stored = (await rawSet(pid))!.creds[0];
    expect(stored.counter).toBe(7);
    expect(Date.parse(stored.lastUsedAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(await db.ttl(personKey.passkeys(pid))).toBe(-1);
  });
});

describe("rule 2422: recordUse never re-creates a deleted set", () => {
  it("answers gone after the set was deleted, after the credential was removed, or on another birth", async () => {
    const pid = pidOf();
    const [id, other] = await fill(pid, 2);
    expect(await recordUse(pid, "2026-10-02T00:00:00.000Z", id, 1)).toEqual({ result: "gone" });
    expect(await recordUse(pid, BORN, "unknownCredentialIdAAAA", 1)).toEqual({ result: "gone" });
    await removePasskey(pid, BORN, refOf(other));
    expect(await recordUse(pid, BORN, other, 1)).toEqual({ result: "gone" });
    await db.del(personKey.passkeys(pid));
    expect(await recordUse(pid, BORN, id, 1)).toEqual({ result: "gone" });
    expect(await rawSet(pid)).toBeNull();
  });

  it("a set deleted between the read and the write stays deleted", async () => {
    const pid = pidOf();
    const [id] = await fill(pid, 1);
    const get = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation((async (key: string) => {
      const v = await get(key);
      if (key === personKey.passkeys(pid)) await db.del(key);
      return v;
    }) as never);
    expect(await recordUse(pid, BORN, id, 1)).toEqual({ result: "gone", stored: 0 });
    expect(await rawSet(pid)).toBeNull();
  });
});

const TO_BORN = "2026-10-05T00:00:00.000Z";

describe("rules 2424, 2425 (store half): moves and wipes", () => {
  it("movePasskeys leaves no key under from, every reverse entry names to, the uid is kept and the birth is the destination's", async () => {
    const [from, to] = await Promise.all([person(pidOf()), person(pidOf(), TO_BORN)]);
    const ids = await fill(from, 3);
    await db.set(personKey.passkeyReg(from), { challenge: "c", sess: "s", at: Date.now() }, 300);
    const uid = (await rawSet(from))!.uid;
    expect(await movePasskeys(from, to, { personLocked: true })).toBe("moved");
    expect(await rawSet(from)).toBeNull();
    expect(await db.get(personKey.passkeyReg(from))).toBeNull();
    const set = (await rawSet(to))!;
    expect(set.uid).toBe(uid);
    expect(set.born).toBe(TO_BORN);
    expect((await readSet(to, (await getPerson(to))!.createdAt))?.creds).toHaveLength(3);
    expect(set.creds.map((c) => c.id)).toEqual(ids);
    expect(await Promise.all(ids.map(reverse))).toEqual(ids.map(() => to));
    expect(await passkeyKeys(from)).toEqual([personKey.passkeys(from), personKey.passkeyReg(from)]);
  });

  it("a retried move is a no-op, and so is a move to the same pid or of a person with no set", async () => {
    const [from, to] = await Promise.all([person(pidOf()), person(pidOf("p"))]);
    const ids = await fill(from, 2);
    await movePasskeys(from, to, { personLocked: true });
    const after = await rawSet(to);
    const empty = await person(pidOf());
    const { writes } = recordWrites(to);
    expect(await movePasskeys(from, to, { personLocked: true })).toBe("nothing");
    expect(await movePasskeys(to, to, { personLocked: true })).toBe("nothing");
    expect(await movePasskeys(empty, to, { personLocked: true })).toBe("nothing");
    expect(writes).toEqual([]);
    expect(await rawSet(to)).toEqual(after);
    expect(await Promise.all(ids.map(reverse))).toEqual([to, to]);
  });

  it("personLocked: false takes both person locks, the smaller pid first", async () => {
    const [x, y] = await Promise.all([person(pidOf("p")), person(pidOf())]);
    await fill(x, 1);
    const lock = vi.spyOn(db, "lock");
    await movePasskeys(x, y, { personLocked: false });
    const order = [x, y].sort();
    expect(lock.mock.calls.map((c) => c[0])).toEqual(order.map((p) => personKey.lock(p)));
  });

  it("a set stamped with another birth than getPerson(from) is not carried to the new pid: it is dropped with its own reverse entries", async () => {
    const [from, to] = await Promise.all([person(pidOf()), person(pidOf("p"))]);
    const [id, taken] = await fill(from, 2, "2020-01-01T00:00:00.000Z");
    const other = pidOf();
    await db.set(globalKey.passkeyCred(credHash(taken)), other);
    expect(await movePasskeys(from, to, { personLocked: true })).toBe("dropped");
    expect(await rawSet(from)).toBeNull();
    expect(await rawSet(to)).toBeNull();
    expect(await reverse(id)).toBeNull();
    expect(await reverse(taken)).toBe(other);
  });

  it("a reverse entry naming a third pid is not taken over by a move", async () => {
    const [from, to, third] = [await person(pidOf()), await person(pidOf("p")), pidOf()];
    const [id, kept] = await fill(from, 2);
    await db.set(globalKey.passkeyCred(credHash(id)), third);
    await movePasskeys(from, to, { personLocked: true });
    expect(await reverse(id)).toBe(third);
    expect(await reverse(kept)).toBe(to);
  });

  it("passkeyKeys lists exactly the set, its reverse entries that still name the pid, and pkreg:", async () => {
    const pid = pidOf();
    const ids = await fill(pid, 3);
    const other = pidOf("p");
    await db.set(globalKey.passkeyCred(credHash(ids[1])), other);
    const get = vi.spyOn(db, "get");
    const mget = vi.spyOn(db, "mget");
    const keys = await passkeyKeys(pid);
    expect(get).toHaveBeenCalledTimes(1);
    expect(mget).toHaveBeenCalledTimes(1);
    expect(keys.sort()).toEqual([personKey.passkeys(pid), personKey.passkeyReg(pid), globalKey.passkeyCred(credHash(ids[0])), globalKey.passkeyCred(credHash(ids[2]))].sort());
  });

  it("passkeyKeys of a person with no set is the set key and pkreg: only; of a stale set, still its own reverse entries", async () => {
    const none = pidOf();
    expect(await passkeyKeys(none)).toEqual([personKey.passkeys(none), personKey.passkeyReg(none)]);
    const stale = pidOf();
    const [id] = await fill(stale, 1, "2020-01-01T00:00:00.000Z");
    expect((await passkeyKeys(stale)).sort()).toEqual([personKey.passkeys(stale), personKey.passkeyReg(stale), globalKey.passkeyCred(credHash(id))].sort());
  });
});

describe("ruling 3: resolvePasskeyLogin (the sign-in lookup, forward-checked)", () => {
  it("an owner's and a member's credential resolve to their own login and set; the birth is the person's createdAt", async () => {
    const owner = await newUser("pko");
    const member = await newMember(owner, "member", "pkm");
    for (const pid of [ownerOf(owner), member.pid]) {
      const born = (await getPerson(pid))!.createdAt;
      const c = cred();
      expect(await addPasskey(pid, born, c, "Key")).toMatchObject({ ok: true });
      const r = await resolvePasskeyLogin(credHash(c.id));
      expect(r?.pid).toBe(pid);
      expect(r?.login.pid).toBe(pid);
      expect(r?.born).toBe(born);
      expect(r?.cred.id).toBe(c.id);
      expect(r?.set.uid).toBe((await rawSet(pid))!.uid);
    }
  });

  it("an unknown hash, an orphaned entry, another birth or a pid with no person resolves to nothing", async () => {
    const owner = await newUser("pko");
    const pid = ownerOf(owner);
    const born = (await getPerson(pid))!.createdAt;
    const c = cred();
    await addPasskey(pid, born, c, "Key");
    expect(await resolvePasskeyLogin("0".repeat(64))).toBeNull();
    expect(await resolvePasskeyLogin("not-a-hash")).toBeNull();
    // Orphan: the reverse entry names the pid, the set does not hold the credential.
    const orphan = cred();
    await db.set(globalKey.passkeyCred(credHash(orphan.id)), pid);
    expect(await resolvePasskeyLogin(credHash(orphan.id))).toBeNull();
    // A pid no record holds.
    const ghost = cred();
    await db.set(globalKey.passkeyCred(credHash(ghost.id)), "ghost@test.example");
    expect(await resolvePasskeyLogin(credHash(ghost.id))).toBeNull();
    // The set stamped with another birth.
    const set = (await rawSet(pid))!;
    await db.set(personKey.passkeys(pid), { ...set, born: "2020-01-01T00:00:00.000Z" });
    expect(await resolvePasskeyLogin(credHash(c.id))).toBeNull();
  });

  it("a person whose address signs in as another pid resolves to nothing (login.pid !== pid)", async () => {
    const owner = await newUser("pko");
    const login = await getLogin(owner.email);
    expect(login?.pid).toBe(ownerOf(owner));
    // A second person row holding the owner's address, with a set and a reverse entry of its own.
    const twin = await person(pidOf("p"), BORN, owner.email);
    const c = cred();
    expect(await addPasskey(twin, BORN, c, "Key")).toMatchObject({ ok: true });
    expect(await reverse(c.id)).toBe(twin);
    expect((await getPerson(twin))?.email).toBe(owner.email);
    expect(await resolvePasskeyLogin(credHash(c.id))).toBeNull();
    // Control: the owner's own credential resolves.
    const own = cred();
    await addPasskey(ownerOf(owner), (await getPerson(ownerOf(owner)))!.createdAt, own, "Mine");
    expect((await resolvePasskeyLogin(credHash(own.id)))?.pid).toBe(ownerOf(owner));
  });
});

describe("Task 3 fix round 1: the move's births, order, retry and destination", () => {
  const OLD = "2020-01-01T00:00:00.000Z";

  it("the move compares the from set with getPerson(from).createdAt and stamps getPerson(to).createdAt (a destination born otherwise still gets the set)", async () => {
    // A legacy record whose birth was re-stamped on the way (`updatePerson`): the two births differ.
    const [from, to] = await Promise.all([person(pidOf(), OLD), person(pidOf("p"), TO_BORN)]);
    const ids = await fill(from, 2, OLD);
    const uid = (await rawSet(from))!.uid;
    await movePasskeys(from, to, { personLocked: true });
    expect(await rawSet(from)).toBeNull();
    const set = (await rawSet(to))!;
    expect(set).toMatchObject({ uid, born: TO_BORN });
    expect(set.creds.map((c) => c.id)).toEqual(ids);
    expect(await listPasskeys(to, (await getPerson(to))!.createdAt)).toHaveLength(2);
    expect(await Promise.all(ids.map(reverse))).toEqual([to, to]);
  });

  it("a move whose from or to person cannot be read changes nothing", async () => {
    const from = await person(pidOf());
    const ids = await fill(from, 2);
    const before = await rawSet(from);
    const ghost = pidOf("p");
    const { writes } = recordWrites(from);
    expect(await movePasskeys(from, ghost, { personLocked: true })).toBe("skipped");
    const orphanFrom = pidOf();
    await db.set(personKey.passkeys(orphanFrom), before);
    expect(await movePasskeys(orphanFrom, await person(pidOf("p")), { personLocked: true })).toBe("skipped");
    expect(writes.filter((w) => w.key !== personKey.passkeys(orphanFrom) && !w.key.startsWith("person:"))).toEqual([]);
    expect(await rawSet(from)).toEqual(before);
    expect(await rawSet(ghost)).toBeNull();
    expect(await rawSet(orphanFrom)).toEqual(before);
    expect(await Promise.all(ids.map(reverse))).toEqual([from, from]);
  });

  it("writes to first, then the reverse entries, and deletes under from last", async () => {
    const [from, to] = await Promise.all([person(pidOf()), person(pidOf("p"))]);
    await fill(from, 2);
    const order: string[] = [];
    for (const op of ["set", "del", "replaceIf", "setNx"] as const) {
      const orig = (db[op] as (...a: unknown[]) => Promise<unknown>).bind(db);
      vi.spyOn(db, op).mockImplementation((async (...a: unknown[]) => {
        const r = await orig(...a);
        order.push(`${op} ${String(a[0]).split(":")[0]}${String(a[0]) === personKey.passkeys(to) ? ":to" : String(a[0]).endsWith(from) ? ":from" : ""}`);
        return r;
      }) as never);
    }
    await movePasskeys(from, to, { personLocked: true });
    expect(order).toEqual(["set passkeys:to", "replaceIf pkcred", "replaceIf pkcred", "del passkeys:from", "del pkreg:from"]);
  });

  it("a failed write of to deletes nothing; a move that fails after it leaves from in place, and the retry converges (`to` authoritative: a passkey added there in between stays)", async () => {
    const [from, to] = await Promise.all([person(pidOf()), person(pidOf("p"), TO_BORN)]);
    const ids = await fill(from, 3);
    await db.set(personKey.passkeyReg(from), { challenge: "c", sess: "s", at: Date.now() }, 300);
    const before = (await rawSet(from))!;
    const set = db.set.bind(db);
    const fail = vi.spyOn(db, "set").mockImplementation((async (key: string, ...rest: unknown[]) => {
      if (key === personKey.passkeys(to)) throw new Error("store down");
      return (set as (...a: unknown[]) => Promise<void>)(key, ...rest);
    }) as never);
    await expect(movePasskeys(from, to, { personLocked: true })).rejects.toThrow("store down");
    fail.mockRestore();
    expect(await rawSet(from)).toEqual(before);
    expect(await rawSet(to)).toBeNull();
    expect(await Promise.all(ids.map(reverse))).toEqual(ids.map(() => from));

    // Now the set write passes and the second reverse rewrite fails.
    const replaceIf = db.replaceIf.bind(db);
    let calls = 0;
    const flaky = vi.spyOn(db, "replaceIf").mockImplementation((async (...a: [string, string, string]) => {
      if (++calls === 2) throw new Error("store down");
      return replaceIf(...a);
    }) as never);
    await expect(movePasskeys(from, to, { personLocked: true })).rejects.toThrow("store down");
    flaky.mockRestore();
    expect(await rawSet(from)).toEqual(before);
    expect(await db.get(personKey.passkeyReg(from))).not.toBeNull();
    expect((await rawSet(to))!.uid).toBe(before.uid);
    // In between, the person signs in at the new address and adds a passkey there.
    const extra = cred();
    expect(await addPasskey(to, TO_BORN, extra, "New")).toMatchObject({ ok: true });

    await movePasskeys(from, to, { personLocked: true });
    expect(await rawSet(from)).toBeNull();
    expect(await db.get(personKey.passkeyReg(from))).toBeNull();
    const after = (await rawSet(to))!;
    expect(after).toMatchObject({ uid: before.uid, born: TO_BORN });
    expect(after.creds.map((c) => c.id).sort()).toEqual([...ids, extra.id].sort());
    expect(await Promise.all([...ids, extra.id].map(reverse))).toEqual([...ids, extra.id].map(() => to));
    expect(await orphans(from, ids)).toEqual([]);
    expect(await orphans(to, [...ids, extra.id])).toEqual([]);
  });

  it("a live destination set with another uid is kept: the from set is dropped with only the entries that still name from", async () => {
    const [from, to, third] = [await person(pidOf()), await person(pidOf("p"), TO_BORN), pidOf()];
    const [mine, taken] = await fill(from, 2);
    await db.set(globalKey.passkeyCred(credHash(taken)), third);
    const [theirs] = await fill(to, 1, TO_BORN);
    const kept = await rawSet(to);
    expect(await movePasskeys(from, to, { personLocked: true })).toBe("kept_to");
    expect(await rawSet(to)).toEqual(kept);
    expect(await rawSet(from)).toBeNull();
    expect(await reverse(mine)).toBeNull();
    expect(await reverse(taken)).toBe(third);
    expect(await reverse(theirs)).toBe(to);
  });

  it("a broken destination set is kept too; an empty one with another uid is replaced by the moved set", async () => {
    const [from, to] = await Promise.all([person(pidOf()), person(pidOf("p"), TO_BORN)]);
    const [id] = await fill(from, 1);
    const broken = { v: 2, uid: "short", creds: [] };
    await db.set(personKey.passkeys(to), broken);
    expect(await movePasskeys(from, to, { personLocked: true })).toBe("kept_to");
    expect(await rawSet(to)).toEqual(broken);
    expect(await rawSet(from)).toBeNull();
    expect(await reverse(id)).toBeNull();

    const [from2, to2] = await Promise.all([person(pidOf()), person(pidOf("p"), TO_BORN)]);
    const [id2] = await fill(from2, 1);
    const uid = (await rawSet(from2))!.uid;
    expect(uidOf(await ensureUid(to2, TO_BORN))).not.toBe(uid);
    expect(await movePasskeys(from2, to2, { personLocked: true })).toBe("moved");
    expect(await rawSet(to2)).toMatchObject({ uid, born: TO_BORN });
    expect(await reverse(id2)).toBe(to2);
  });
});

describe("Task 3 fix round 1: no orphaned reverse entry after a failed write", () => {
  const failOn = (op: "set" | "del" | "setXx", match: (key: string) => boolean) => {
    const orig = (db[op] as (...a: unknown[]) => Promise<unknown>).bind(db);
    return vi.spyOn(db, op).mockImplementation((async (...a: unknown[]) => {
      if (match(String(a[0]))) throw new Error("store down");
      return orig(...a);
    }) as never);
  };

  it("addPasskey: a set write that throws after SET NX won releases the reverse entry and rethrows", async () => {
    const pid = pidOf();
    const ids = await fill(pid, 1);
    const before = await rawSet(pid);
    const c = cred();
    failOn("set", (k) => k === personKey.passkeys(pid));
    await expect(addPasskey(pid, BORN, c, "Key")).rejects.toThrow("store down");
    vi.restoreAllMocks();
    expect(await reverse(c.id)).toBeNull();
    expect(await rawSet(pid)).toEqual(before);
    expect(await orphans(pid, [...ids, c.id])).toEqual([]);
    expect(await addPasskey(pid, BORN, c, "Key")).toMatchObject({ ok: true });
  });

  it("removePasskey: the reverse entry goes before the set is rewritten, so a failure leaves no entry the set does not list", async () => {
    const pid = pidOf();
    const ids = await fill(pid, 2);
    failOn("del", (k) => k.startsWith("pkcred:"));
    await expect(removePasskey(pid, BORN, refOf(ids[0]))).rejects.toThrow("store down");
    vi.restoreAllMocks();
    expect(await orphans(pid, ids)).toEqual([]);
    failOn("setXx", (k) => k === personKey.passkeys(pid));
    await expect(removePasskey(pid, BORN, refOf(ids[0]))).rejects.toThrow("store down");
    vi.restoreAllMocks();
    expect(await orphans(pid, ids)).toEqual([]);
    expect(await reverse(ids[0])).toBeNull();
    expect(await removePasskey(pid, BORN, refOf(ids[0]))).toBe("ok");
    expect((await rawSet(pid))!.creds.map((c) => c.id)).toEqual([ids[1]]);
  });

  it("a stale set's replacement drops its reverse entries before writing the new set", async () => {
    const pid = pidOf();
    const ids = await fill(pid, 2);
    const before = await rawSet(pid);
    failOn("del", (k) => k.startsWith("pkcred:"));
    await expect(ensureUid(pid, "2026-10-02T00:00:00.000Z")).rejects.toThrow("store down");
    vi.restoreAllMocks();
    expect(await rawSet(pid)).toEqual(before);
    expect(await orphans(pid, ids)).toEqual([]);
    failOn("set", (k) => k === personKey.passkeys(pid));
    await expect(addPasskey(pid, "2026-10-02T00:00:00.000Z", cred(), "Key")).rejects.toThrow("store down");
    vi.restoreAllMocks();
    expect(await orphans(pid, ids)).toEqual([]);
  });
});

describe("Task 3 fix round 2: resume, cut order, add failure, typed answers", () => {
  /** Makes `op` throw for keys `match` picks, the first `times` times; the rest pass through. */
  const failOn = (op: "del" | "replaceIf" | "set", match: (key: string) => boolean, times = Number.POSITIVE_INFINITY) => {
    const orig = (db[op] as (...a: unknown[]) => Promise<unknown>).bind(db);
    let left = times;
    return vi.spyOn(db, op).mockImplementation((async (...a: unknown[]) => {
      if (match(String(a[0])) && left-- > 0) throw new Error("store down");
      return orig(...a);
    }) as never);
  };

  it("N1: on a resumed move `to` is authoritative: a passkey removed at `to` between the runs never comes back", async () => {
    const [from, to] = await Promise.all([person(pidOf()), person(pidOf("p"), TO_BORN)]);
    const [x, y] = await fill(from, 2);
    // Run 1 writes `to` and both entries, then fails deleting the `from` set.
    failOn("del", (k) => k === personKey.passkeys(from));
    await expect(movePasskeys(from, to, { personLocked: true })).rejects.toThrow("store down");
    vi.restoreAllMocks();
    expect(await Promise.all([x, y].map(reverse))).toEqual([to, to]);
    // The person removes X at the new address (a lost device).
    expect(await removePasskey(to, TO_BORN, refOf(x))).toBe("ok");
    expect(await reverse(x)).toBeNull();
    expect(await movePasskeys(from, to, { personLocked: true })).toBe("moved");
    expect((await rawSet(to))!.creds.map((c) => c.id)).toEqual([y]);
    expect(await reverse(x)).toBeNull();
    expect(await resolvePasskeyLogin(credHash(x))).toBeNull();
    expect(await rawSet(from)).toBeNull();
    expect(await orphans(to, [x, y])).toEqual([]);
  });

  it("N1 + N2: an entry still naming `from` for a passkey removed at `to` is deleted, before the `from` set, and a failure there keeps `from` for the retry", async () => {
    const [from, to] = await Promise.all([person(pidOf()), person(pidOf("p"), TO_BORN)]);
    const [x, y] = await fill(from, 2);
    // Run 1 writes `to`, then fails re-pointing X: X's entry still names `from`.
    failOn("replaceIf", (k) => k === globalKey.passkeyCred(credHash(x)));
    await expect(movePasskeys(from, to, { personLocked: true })).rejects.toThrow("store down");
    vi.restoreAllMocks();
    expect(await reverse(x)).toBe(from);
    expect(await removePasskey(to, TO_BORN, refOf(x))).toBe("ok");
    expect(await reverse(x)).toBe(from); // not `to`'s to delete
    // The retry fails deleting X's leftover entry: the `from` set must still be there to list it.
    failOn("del", (k) => k === globalKey.passkeyCred(credHash(x)));
    await expect(movePasskeys(from, to, { personLocked: true })).rejects.toThrow("store down");
    vi.restoreAllMocks();
    expect(await rawSet(from)).not.toBeNull();
    expect(await passkeyKeys(from)).toContain(globalKey.passkeyCred(credHash(x)));
    expect(await movePasskeys(from, to, { personLocked: true })).toBe("moved");
    expect(await rawSet(from)).toBeNull();
    expect(await reverse(x)).toBeNull();
    expect(await reverse(y)).toBe(to);
    expect((await rawSet(to))!.creds.map((c) => c.id)).toEqual([y]);
    expect(await orphans(from, [x, y])).toEqual([]);
    expect(await orphans(to, [x, y])).toEqual([]);
  });

  it("N3: an add whose set write landed before the error keeps its reverse entry; one whose re-read fails too releases it", async () => {
    const pid = pidOf();
    const c = cred();
    const set = db.set.bind(db);
    vi.spyOn(db, "set").mockImplementation((async (key: string, ...rest: unknown[]) => {
      await (set as (...a: unknown[]) => Promise<void>)(key, ...rest);
      if (key === personKey.passkeys(pid)) throw new Error("timeout after apply");
    }) as never);
    await expect(addPasskey(pid, BORN, c, "Key")).rejects.toThrow("timeout after apply");
    vi.restoreAllMocks();
    expect((await rawSet(pid))!.creds.map((x) => x.id)).toEqual([c.id]);
    expect(await reverse(c.id)).toBe(pid);

    const other = pidOf();
    const d = cred();
    failOn("set", (k) => k === personKey.passkeys(other));
    const get = db.get.bind(db);
    let reads = 0;
    vi.spyOn(db, "get").mockImplementation((async (key: string) => {
      if (key === personKey.passkeys(other) && ++reads > 1) throw new Error("store down");
      return get(key);
    }) as never);
    await expect(addPasskey(other, BORN, d, "Key")).rejects.toThrow("store down");
    vi.restoreAllMocks();
    expect(await reverse(d.id)).toBeNull();
  });

  it("N4: ensureUid answers { uid } or invalid, never a bare string", async () => {
    const r = await ensureUid(pidOf(), BORN);
    // @ts-expect-error: the union keeps "invalid" apart from a uid, so a caller cannot use it as a string unchecked.
    const asString: string = r;
    expect(typeof asString).toBe("object");
    expect(r).toEqual({ uid: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  });

  it("N5: movePasskeys answers what it did, and skipped leaves the from set for the retry", async () => {
    const [from, to] = await Promise.all([person(pidOf()), person(pidOf("p"))]);
    await fill(from, 1);
    expect(await movePasskeys(from, from, { personLocked: true })).toBe("nothing");
    const ghost = pidOf("p");
    expect(await movePasskeys(from, ghost, { personLocked: true })).toBe("skipped");
    expect(await rawSet(from)).not.toBeNull();
    expect(await movePasskeys(from, to, { personLocked: true })).toBe("moved");
    expect(await movePasskeys(from, to, { personLocked: true })).toBe("nothing");
    const stale = await person(pidOf());
    await fill(stale, 1, "2020-01-01T00:00:00.000Z");
    expect(await movePasskeys(stale, await person(pidOf("p")), { personLocked: true })).toBe("dropped");
    const [mover, live] = await Promise.all([person(pidOf()), person(pidOf("p"))]);
    await fill(mover, 1);
    await fill(live, 1);
    expect(await movePasskeys(mover, live, { personLocked: true })).toBe("kept_to");
  });
});
