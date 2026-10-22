import { describe, expect, it } from "vitest";
import { validEmail } from "@/lib/auth";
import { accountKey, globalKey, personKey, storedAccountId, storedPersonId, wsKey, type AccountId, type PersonId } from "@/lib/keys";
import { CAPS } from "@/lib/db";
import { MULTI_ORG, newPersonId, PERSON_ID } from "@/lib/multi-org";

/**
 * Rules 2132, 2137 (multi-workspace membership, release M1 expand, docs/specs/2026-10-18-multi-org.md section 5):
 * the nine new key families have exact bytes, no new key can equal a legacy one, a plain string from a request does not
 * type-check in any builder, and the switch is off.
 */

const p = storedPersonId("p_aaaaaaaaaaaaaaaaaaaaaaaa");
const a = storedAccountId("a_bbbbbbbbbbbbbbbbbbbbbbbb");
const legacyP = storedPersonId("owner@example.com");
const legacyA = storedAccountId("owner@example.com");

describe("rule 2137: the exact bytes of every new family", () => {
  it("personKey", () => {
    expect(personKey.person(p)).toBe("person:p_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(personKey.lock(p)).toBe("lock:person:p_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(personKey.orgs(p)).toBe("orgs:p_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(personKey.lastOrg(p)).toBe("lastorg:p_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(personKey.activeBrand(p, a)).toBe("activebrand:p_aaaaaaaaaaaaaaaaaaaaaaaa:a_bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(personKey.feedOf(p, a)).toBe("sec:feedof:p_aaaaaaaaaaaaaaaaaaaaaaaa:a_bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(personKey.bookOf(p, a, "calcom")).toBe("sec:bookof:p_aaaaaaaaaaaaaaaaaaaaaaaa:a_bbbbbbbbbbbbbbbbbbbbbbbb:calcom");
  });

  it("accountKey.membership and teamLog", () => {
    expect(accountKey.membership(a, p)).toBe("mbr:a_bbbbbbbbbbbbbbbbbbbbbbbb:p_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(accountKey.teamLog(a)).toBe("teamlog:a_bbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("accountKey.xfer and invitesFor (M3)", () => {
    expect(accountKey.xfer(a)).toBe("xfer:a_bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(accountKey.xfer(legacyA)).toBe("xfer:owner@example.com");
    expect(accountKey.invitesFor("member@example.com")).toBe("invitesfor:member@example.com");
  });

  it("a legacy person and account (both an address) build the same shapes", () => {
    expect(personKey.person(legacyP)).toBe("person:owner@example.com");
    expect(accountKey.membership(legacyA, legacyP)).toBe("mbr:owner@example.com:owner@example.com");
    expect(personKey.activeBrand(legacyP, legacyA)).toBe("activebrand:owner@example.com:owner@example.com");
  });

  it("the team log cap is 500 (spec section 13)", () => {
    expect(CAPS.teamLog).toBe(500);
  });
});

describe("rule 2137: no new key can equal a legacy key", () => {
  const POOL = ["owner@example.com", "member@example.com", "p_aaaaaaaaaaaaaaaaaaaaaaaa", "a_bbbbbbbbbbbbbbbbbbbbbbbb", "default", "calcom", "2026-10", "x"];

  function allKeys(group: Record<string, unknown>): string[] {
    const out: string[] = [];
    for (const fn of Object.values(group)) {
      if (typeof fn !== "function") continue;
      const arity = Math.min(fn.length, 3);
      const walk = (args: string[]) => {
        if (args.length === arity) {
          out.push((fn as (...x: string[]) => string)(...args));
          return;
        }
        for (const v of POOL) walk([...args, v]);
      };
      walk([]);
    }
    return out;
  }

  const legacy = new Set<string>([
    ...allKeys(wsKey),
    ...allKeys(globalKey),
    ...Object.entries(accountKey)
      .filter(([k]) => k !== "membership" && k !== "teamLog" && k !== "xfer" && k !== "invitesFor")
      .flatMap(([, fn]) => allKeys({ fn })),
    // The raw legacy templates still written outside keys.ts (src/lib/feed-token.ts, src/lib/booking-token.ts).
    ...POOL.flatMap((login) => [`sec:feedof:${login}`, ...POOL.map((prov) => `sec:bookof:${login}:${prov}`)]),
  ]);

  const fresh = new Set<string>([
    ...allKeys({ ...personKey, membership: accountKey.membership, teamLog: accountKey.teamLog, xfer: accountKey.xfer, invitesFor: accountKey.invitesFor }),
  ]);

  it("the corpora are not empty", () => {
    expect(legacy.size).toBeGreaterThan(500);
    expect(fresh.size).toBeGreaterThan(500);
  });

  it("no new key is a legacy key, for every combination of address-like and opaque ids", () => {
    const clash = [...fresh].filter((k) => legacy.has(k));
    expect(clash).toEqual([]);
  });

  it("a pid and an aid contain no ':' so the segment count tells the families apart", () => {
    for (const id of [newPersonId(), "p_aaaaaaaaaaaaaaaaaaaaaaaa", "a_bbbbbbbbbbbbbbbbbbbbbbbb"]) expect(id).not.toMatch(/[:#@]/);
    // validEmail bans ':' and '#', so a legacy pid or aid (an address) has none either.
    expect(validEmail("a:b@example.com")).toBe(false);
    expect(validEmail("a#b@example.com")).toBe(false);
  });

  it("the three per-login keys have one segment after the prefix (two for booking); the new ones have two (three)", () => {
    const segs = (k: string, prefix: string) => k.slice(prefix.length).split(":").length;
    expect(segs(accountKey.activeBrand("owner@example.com"), "activebrand:")).toBe(1);
    expect(segs(personKey.activeBrand(legacyP, legacyA), "activebrand:")).toBe(2);
    expect(segs("sec:feedof:owner@example.com", "sec:feedof:")).toBe(1);
    expect(segs(personKey.feedOf(legacyP, legacyA), "sec:feedof:")).toBe(2);
    expect(segs("sec:bookof:owner@example.com:calcom", "sec:bookof:")).toBe(2);
    expect(segs(personKey.bookOf(legacyP, legacyA, "calcom"), "sec:bookof:")).toBe(3);
  });

  it("the new prefixes are used by no legacy builder", () => {
    const prefixes = ["person:", "orgs:", "lastorg:", "mbr:", "teamlog:", "lock:person:", "xfer:", "invitesfor:"];
    for (const k of legacy) for (const pre of prefixes) expect(k.startsWith(pre)).toBe(false);
  });
});

describe("rule 2137: a plain string from a request does not type-check in any builder", () => {
  it("every personKey and accountKey builder refuses a plain string", () => {
    const s: string = "from-a-request";
    // The calls below only have to compile or fail to compile; their results are not used.
    const ok = [
      // @ts-expect-error a plain string is not a PersonId
      personKey.person(s),
      // @ts-expect-error a plain string is not a PersonId
      personKey.lock(s),
      // @ts-expect-error a plain string is not a PersonId
      personKey.orgs(s),
      // @ts-expect-error a plain string is not a PersonId
      personKey.lastOrg(s),
      // @ts-expect-error a plain string is not a PersonId or an AccountId
      personKey.activeBrand(s, s),
      // @ts-expect-error a plain string is not an AccountId
      personKey.activeBrand(p, s),
      // @ts-expect-error a plain string is not a PersonId or an AccountId
      personKey.feedOf(s, s),
      // @ts-expect-error a plain string is not an AccountId
      personKey.feedOf(p, s),
      // @ts-expect-error a plain string is not a PersonId or an AccountId
      personKey.bookOf(s, s, "calcom"),
      // @ts-expect-error a plain string is not an AccountId
      personKey.bookOf(p, s, "calcom"),
      // @ts-expect-error a plain string is not an AccountId or a PersonId
      accountKey.membership(s, s),
      // @ts-expect-error a plain string is not an AccountId
      accountKey.membership(s, p),
      // @ts-expect-error a plain string is not a PersonId
      accountKey.membership(a, s),
      // @ts-expect-error a plain string is not an AccountId
      accountKey.teamLog(s),
      // @ts-expect-error a plain string is not an AccountId
      accountKey.xfer(s),
    ];
    expect(ok).toHaveLength(15);
  });

  it("the brands are not interchangeable, and both are assignable to string", () => {
    // @ts-expect-error an AccountId is not a PersonId
    personKey.person(a);
    // @ts-expect-error a PersonId is not an AccountId
    accountKey.teamLog(p);
    // @ts-expect-error the arguments are not swapped silently
    accountKey.membership(p, a);
    const asString: string = p;
    const asString2: string = a;
    expect([asString, asString2]).toEqual([p, a]);
    // A string typed variable never becomes a PersonId by assignment.
    // @ts-expect-error a plain string is not assignable to PersonId
    const bad: PersonId = "x" as string;
    // @ts-expect-error a plain string is not assignable to AccountId
    const bad2: AccountId = "x" as string;
    expect([bad, bad2]).toEqual(["x", "x"]);
  });
});

describe("rule 2132: the switch is off and a new person id has the pinned shape", () => {
  it("MULTI_ORG is false", () => {
    expect(MULTI_ORG).toBe(false);
  });
  it("PERSON_ID accepts p_ and 24 base32 characters and nothing else", () => {
    expect(PERSON_ID.test("p_aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    for (const bad of ["p_aaaaaaaaaaaaaaaaaaaaaaa", "p_aaaaaaaaaaaaaaaaaaaaaaaaa", "P_aaaaaaaaaaaaaaaaaaaaaaaa", "a_aaaaaaaaaaaaaaaaaaaaaaaa", "p_aaaaaaaaaaaaaaaaaaaaaaa1", "owner@example.com", "p_aaaaaaaaaaaaaaaaaaaaaaaa\n"]) {
      expect(PERSON_ID.test(bad)).toBe(false);
    }
  });
});
