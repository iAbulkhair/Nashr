import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { accountKey, globalKey, personKey, storedPersonId } from "@/lib/keys";
import { PERSON_ID } from "@/lib/multi-org";
import { PASSKEY_CHALLENGE_TTL, PASSKEY_NAME_MAX, PASSKEYS_MAX } from "@/lib/passkey-limits";
import { passkeysOn, setPasskeysOn } from "@/lib/passkey-switch";
import { parseStored, PasskeyCred, PasskeySet, type PasskeySetValue } from "@/lib/stored";

/**
 * Customer passkeys, task 2 (docs/specs/2026-10-20-passkeys.md, docs/system/tests/2400-passkeys.md): the key builders
 * (rule 2400, keys half), the stored shape of a passkey set (rule 2401) and the read half of the off switch (rule 2426).
 */

afterEach(() => vi.restoreAllMocks());

const LEGACY = storedPersonId("owner@example.com");
const OPAQUE = storedPersonId("p_aaaaaaaaaaaaaaaaaaaaaaaa");
const HASH = "a".repeat(64);

describe("rule 2400: the passkey key builders", () => {
  it("each builder returns its exact bytes", () => {
    const pairs: [string, string][] = [
      [personKey.passkeys(LEGACY), "passkeys:owner@example.com"],
      [personKey.passkeys(OPAQUE), "passkeys:p_aaaaaaaaaaaaaaaaaaaaaaaa"],
      [personKey.passkeyReg(LEGACY), "pkreg:owner@example.com"],
      [personKey.passkeyReg(OPAQUE), "pkreg:p_aaaaaaaaaaaaaaaaaaaaaaaa"],
      [globalKey.passkeyCred(HASH), `pkcred:${"a".repeat(64)}`],
      [globalKey.passkeyAuth(HASH), `pkauth:${"a".repeat(64)}`],
      [globalKey.passkeysOff(), "passkeys:off"],
      [globalKey.passkeyIpBucket("203.0.113.7"), "pk:ip:203.0.113.7"],
      [globalKey.passkeyVerifyIpBucket("203.0.113.7"), "pkv:ip:203.0.113.7"],
      [globalKey.passkeyCredBucket(HASH), `pkv:cred:${"a".repeat(64)}`],
      [accountKey.passkeyProofBucket("owner@example.com"), "pkpw:owner@example.com"],
    ];
    for (const [built, bytes] of pairs) expect(built).toBe(bytes);
  });

  it("the rate buckets are stored under rate: by allow", () => {
    expect(globalKey.rate(globalKey.passkeyIpBucket("1.2.3.4"))).toBe("rate:pk:ip:1.2.3.4");
    expect(globalKey.rate(globalKey.passkeyVerifyIpBucket("1.2.3.4"))).toBe("rate:pkv:ip:1.2.3.4");
    expect(globalKey.rate(globalKey.passkeyCredBucket(HASH))).toBe(`rate:pkv:cred:${HASH}`);
    expect(globalKey.rate(accountKey.passkeyProofBucket("a@example.com"))).toBe("rate:pkpw:a@example.com");
  });

  it("passkeys:off never equals the set of a valid pid (an address has @, an opaque id matches PERSON_ID)", () => {
    // The only pid that could build "passkeys:off" is "off", and "off" is neither a pid form.
    expect("off").not.toMatch(/@/);
    expect("off").not.toMatch(PERSON_ID);
    const pids = ["owner@example.com", "a@b.co", "off@example.com", "p_aaaaaaaaaaaaaaaaaaaaaaaa", "p_234567abcdefghijklmnopqr"];
    for (const p of pids) {
      expect(p.includes("@") || PERSON_ID.test(p)).toBe(true);
      expect(personKey.passkeys(storedPersonId(p))).not.toBe(globalKey.passkeysOff());
    }
  });

  it("the person-keyed builders refuse a plain string (a request value cannot name a set)", () => {
    const fromRequest: string = "victim@example.com";
    // @ts-expect-error a request value is a plain string, not a PersonId
    personKey.passkeys(fromRequest);
    // @ts-expect-error same for the registration challenge
    personKey.passkeyReg(fromRequest);
    expect(true).toBe(true);
  });

  it("the builders sit in the groups of their holder: person, global, login", () => {
    const src = readFileSync("src/lib/keys.ts", "utf8");
    const group = (name: string) => src.slice(src.indexOf(`export const ${name} = {`), src.indexOf("} as const;", src.indexOf(`export const ${name} = {`)));
    expect(group("personKey")).toMatch(/passkeys: \(p: PersonId\)/);
    expect(group("personKey")).toMatch(/passkeyReg: \(p: PersonId\)/);
    for (const b of ["passkeyCred", "passkeyAuth", "passkeysOff", "passkeyIpBucket", "passkeyVerifyIpBucket", "passkeyCredBucket"]) expect(group("globalKey")).toContain(`${b}: (`);
    expect(group("accountKey")).toContain("passkeyProofBucket: (");
    expect(group("wsKey")).not.toMatch(/passkey/i);
  });
});

describe("rule 2401: the stored passkey set", () => {
  const uid = "A".repeat(43);
  const cred = (i: number, extra: Record<string, unknown> = {}) => ({
    id: `cred_${String(i).padStart(4, "0")}-abcdefghij`,
    pk: "pQECAyYgASFYIA",
    counter: 0,
    transports: ["internal", "hybrid"],
    name: `Key ${i}`,
    createdAt: "2026-10-20T08:00:00.000Z",
    ...extra,
  });
  const set = (extra: Record<string, unknown> = {}) => ({ v: 1, uid, born: "2026-10-01T00:00:00.000Z", creds: [cred(1)], ...extra });

  it("a valid set parses, with transports and aaguid defaults", () => {
    const r = parseStored("passkeys", PasskeySet, set({ creds: [{ ...cred(1), transports: undefined }] }), null) as PasskeySetValue;
    expect(r.uid).toBe(uid);
    expect(r.creds[0].transports).toEqual([]);
    expect(r.creds[0].aaguid).toBe("");
    expect(r.creds[0].lastUsedAt).toBeUndefined();
  });

  it("ten credentials are the most a set holds", () => {
    expect(PASSKEYS_MAX).toBe(10);
    expect(parseStored("passkeys", PasskeySet, set({ creds: Array.from({ length: 10 }, (_, i) => cred(i)) }), null)).not.toBeNull();
  });

  const bad: [string, unknown, string][] = [
    ["11 credentials", set({ creds: Array.from({ length: 11 }, (_, i) => cred(i)) }), "creds"],
    ["a name of 41 characters", set({ creds: [cred(1, { name: "n".repeat(41) })] }), "creds.0.name"],
    ["an empty name", set({ creds: [cred(1, { name: "" })] }), "creds.0.name"],
    ["a credential id with +", set({ creds: [cred(1, { id: "abcdefghijklmnop+q" })] }), "creds.0.id"],
    ["a credential id with /", set({ creds: [cred(1, { id: "abcdefghijklmnop/q" })] }), "creds.0.id"],
    ["a credential id of 15 characters", set({ creds: [cred(1, { id: "abcdefghijklmno" })] }), "creds.0.id"],
    ["a missing uid", { v: 1, creds: [cred(1)] }, "uid"],
    ["a uid of 42 characters", set({ uid: "A".repeat(42) }), "uid"],
    ["another version", set({ v: 2 }), "v"],
    ["a negative counter", set({ creds: [cred(1, { counter: -1 })] }), "creds.0.counter"],
    ["nine transports", set({ creds: [cred(1, { transports: Array.from({ length: 9 }, () => "usb") })] }), "creds.0.transports"],
    ["a transport of 21 characters", set({ creds: [cred(1, { transports: ["t".repeat(21)] })] }), "creds.0.transports.0"],
    ["a public key of 2049 characters", set({ creds: [cred(1, { pk: "k".repeat(2049) })] }), "creds.0.pk"],
    ["an empty public key", set({ creds: [cred(1, { pk: "" })] }), "creds.0.pk"],
  ];
  for (const [what, raw, path] of bad) {
    it(`${what} fails, reads as no passkeys and logs only the shape`, () => {
      const w = vi.spyOn(log, "warn");
      expect(parseStored("passkeys", PasskeySet, raw, null)).toBeNull();
      expect(w).toHaveBeenCalledTimes(1);
      expect(w.mock.calls[0][0]).toBe("stored shape invalid");
      const logged = w.mock.calls[0][1] as { shape: string; issues: { path: string; code: string }[] };
      expect(logged.shape).toBe("passkeys");
      expect(logged.issues.map((i) => i.path)).toContain(path);
      for (const i of logged.issues) expect(Object.keys(i).sort()).toEqual(["code", "path"]);
      const text = JSON.stringify(w.mock.calls);
      expect(text).not.toContain(uid);
      expect(text).not.toContain("pQECAyYgASFYIA");
      expect(text).not.toContain("cred_0001-abcdefghij");
    });
  }

  it("a value that is not a set reads as no passkeys", () => {
    for (const raw of ["passkeys", 5, [], { v: 1, uid }]) expect(parseStored("passkeys", PasskeySet, raw, null)).toBeNull();
  });

  it("unknown fields survive a parse (loose), on the set and on a credential", () => {
    const r = parseStored("passkeys", PasskeySet, set({ future: { x: 1 }, creds: [cred(1, { later: "kept", backedUp: true, lastUsedAt: "2026-10-20T09:00:00.000Z" })] }), null) as PasskeySetValue & { future?: unknown };
    expect(r.future).toEqual({ x: 1 });
    expect((r.creds[0] as typeof r.creds[0] & { later?: string }).later).toBe("kept");
    expect(r.creds[0].backedUp).toBe(true);
    expect(r.creds[0].lastUsedAt).toBe("2026-10-20T09:00:00.000Z");
  });

  it("a set without born still parses (born is optional)", () => {
    expect(parseStored("passkeys", PasskeySet, set({ born: undefined }), null)).not.toBeNull();
  });

  it("PasskeyCred alone checks one credential (the store validates a new one before writing)", () => {
    expect(PasskeyCred.safeParse(cred(1)).success).toBe(true);
    expect(PasskeyCred.safeParse(cred(1, { name: "n".repeat(PASSKEY_NAME_MAX + 1) })).success).toBe(false);
  });

  it("the shared limits module imports nothing (client components may import it)", () => {
    const src = readFileSync("src/lib/passkey-limits.ts", "utf8");
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\brequire\(/);
    expect(PASSKEY_NAME_MAX).toBe(40);
    expect(PASSKEY_CHALLENGE_TTL).toBe(300);
  });
});

describe("rule 2426 (read half): the off switch", () => {
  const OFF = "passkeys:off";
  beforeEach(async () => {
    await db.del(OFF);
  });

  it("absent key reads as on", async () => {
    expect(await passkeysOn()).toBe(true);
  });

  it('"1" reads as off, as text or as the number the client parses it to', async () => {
    await db.set(OFF, "1");
    expect(await passkeysOn()).toBe(false);
    await db.set(OFF, 1);
    expect(await passkeysOn()).toBe(false);
  });

  it("any other value reads as on", async () => {
    await db.set(OFF, "0");
    expect(await passkeysOn()).toBe(true);
  });

  it("setPasskeysOn(false) writes 1 and setPasskeysOn(true) deletes the key", async () => {
    await setPasskeysOn(false);
    expect(String(await db.get(OFF))).toBe("1");
    expect(await passkeysOn()).toBe(false);
    await setPasskeysOn(true);
    expect(await db.get(OFF)).toBeNull();
    expect(await passkeysOn()).toBe(true);
  });

  it("a read error throws and is never read as on", async () => {
    vi.spyOn(db, "get").mockRejectedValueOnce(new Error("redis down"));
    await expect(passkeysOn()).rejects.toThrow("redis down");
  });
});
