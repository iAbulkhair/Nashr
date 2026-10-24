import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/log";
import { MembershipRow, parseStored, PersonRow, TEAM_LOG_KINDS, TeamLogRow, type MembershipValue, type PersonRowValue, type TeamLogRowValue } from "@/lib/stored";
import { newPersonId, PERSON_ID } from "@/lib/multi-org";

/**
 * Rules 2115, 2132, 2134 (multi-workspace membership, release M1 expand, docs/specs/2026-10-18-multi-org.md sections 6
 * and 13): the stored shapes of a person, a membership and a team log row.
 */

afterEach(() => vi.restoreAllMocks());
const warns = () => vi.spyOn(log, "warn");

describe("rule 2115: a membership never names the owner", () => {
  const row = { aid: "a_bbbbbbbbbbbbbbbbbbbbbbbb", pid: "p_aaaaaaaaaaaaaaaaaaaaaaaa", role: "admin", acceptedAt: "2026-10-19T08:00:00.000Z", invitedBy: "owner@example.com" };

  it("admin and member rows parse", () => {
    for (const role of ["admin", "member"] as const) {
      const r = parseStored("membership", MembershipRow, { ...row, role }, null);
      expect(r).toMatchObject({ role, aid: row.aid, pid: row.pid });
    }
  });

  it("a row with role owner fails, reads as no membership and logs only the shape", () => {
    const w = warns();
    const secret = "owner-secret-address@example.com";
    expect(parseStored("membership", MembershipRow, { ...row, role: "owner", invitedBy: secret }, null)).toBeNull();
    expect(w).toHaveBeenCalledTimes(1);
    expect(w.mock.calls[0][0]).toBe("stored shape invalid");
    expect(w.mock.calls[0][1]).toEqual({ shape: "membership", issues: [{ path: "role", code: "invalid_value" }] });
    expect(JSON.stringify(w.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(w.mock.calls)).not.toContain(row.pid);
  });

  it("a row without a role, a person or an account fails closed", () => {
    for (const bad of [{ ...row, role: undefined }, { ...row, pid: "" }, { ...row, aid: "" }, { ...row, acceptedAt: "" }, "owner", 5, []]) {
      expect(parseStored("membership", MembershipRow, bad, null)).toBeNull();
    }
  });

  it("an unknown field survives a parse (loose), and invitedBy defaults to empty", () => {
    const r = parseStored("membership", MembershipRow, { ...row, invitedBy: undefined, future: { x: 1 }, disabled: "seats" }, null) as MembershipValue & { future?: unknown };
    expect(r.future).toEqual({ x: 1 });
    expect(r.invitedBy).toBe("");
    expect(r.disabled).toBe("seats");
  });

  it("only the seats pause is a valid disabled value", () => {
    expect(parseStored("membership", MembershipRow, { ...row, disabled: "other" }, null)).toBeNull();
  });
});

describe("rule 2134: the person row", () => {
  const min = { pid: "p_aaaaaaaaaaaaaaaaaaaaaaaa", email: "a@example.com" };

  it("defaults: name empty, language ar, createdAt empty; no credential is invented", () => {
    const r = parseStored("person", PersonRow, min, null) as PersonRowValue;
    expect(r.name).toBe("");
    expect(r.lang).toBe("ar");
    expect(r.createdAt).toBe("");
    expect(r.passHash).toBeUndefined();
    expect(r.suspended).toBeUndefined();
  });

  it("a language outside ar/en reads as ar, a name of the wrong type as empty", () => {
    const r = parseStored("person", PersonRow, { ...min, lang: "fr", name: 7 }, null) as PersonRowValue;
    expect(r.lang).toBe("ar");
    expect(r.name).toBe("");
  });

  it("en stays en; the credential fields and unknown fields survive a parse", () => {
    const full = { ...min, name: "Sara", lang: "en", passHash: "$2a$x", emailVerifiedAt: "2026-10-19T08:00:00.000Z", sessionsAfter: "2026-10-19T09:00:00.000Z", devicesAfter: "2026-10-19T10:00:00.000Z", trialUsedAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", future: 1 };
    expect(parseStored("person", PersonRow, full, null)).toEqual(full);
  });

  it("suspended is true or { until }; anything else fails the row", () => {
    expect((parseStored("person", PersonRow, { ...min, suspended: true }, null) as PersonRowValue).suspended).toBe(true);
    expect((parseStored("person", PersonRow, { ...min, suspended: { until: "2026-12-01T00:00:00.000Z" } }, null) as PersonRowValue).suspended).toEqual({ until: "2026-12-01T00:00:00.000Z" });
    const w = warns();
    expect(parseStored("person", PersonRow, { ...min, suspended: false }, null)).toBeNull();
    expect(w).toHaveBeenCalledTimes(1);
  });

  it("a row without a pid or with an address under three characters fails", () => {
    expect(parseStored("person", PersonRow, { email: "a@example.com" }, null)).toBeNull();
    expect(parseStored("person", PersonRow, { pid: "p_aaaaaaaaaaaaaaaaaaaaaaaa", email: "a@" }, null)).toBeNull();
  });
});

describe("rule 2129: the team log row", () => {
  const row = { at: "2026-10-19T08:00:00.000Z", kind: "joined", actor: { pid: "p_aaaaaaaaaaaaaaaaaaaaaaaa", email: "a@example.com" }, target: { email: "b@example.com" }, via: "web" };

  it("the eleven kinds of spec section 13, and access_changed (customer roles, rule 3763)", () => {
    expect([...TEAM_LOG_KINDS]).toEqual(["invited", "invite_cancelled", "joined", "role_changed", "removed", "left", "paused_for_seats", "resumed", "ownership_offered", "ownership_transferred", "workspace_created", "access_changed"]);
    for (const kind of TEAM_LOG_KINDS) expect(parseStored("teamlog", TeamLogRow, { ...row, kind }, null)).toMatchObject({ kind });
  });

  it("a target may carry a pid and a role; via is web, console or system", () => {
    const r = parseStored("teamlog", TeamLogRow, { ...row, kind: "role_changed", role: "admin", target: { pid: "p_cccccccccccccccccccccccc", email: "b@example.com" }, via: "system" }, null) as TeamLogRowValue;
    expect(r.role).toBe("admin");
    expect(r.target.pid).toBe("p_cccccccccccccccccccccccc");
  });

  it("an unknown kind or via fails the row", () => {
    expect(parseStored("teamlog", TeamLogRow, { ...row, kind: "deleted" }, null)).toBeNull();
    expect(parseStored("teamlog", TeamLogRow, { ...row, via: "staff" }, null)).toBeNull();
  });

  it("a row from a later release keeps its extra fields", () => {
    const r = parseStored("teamlog", TeamLogRow, { ...row, later: true }, null) as TeamLogRowValue & { later?: boolean };
    expect(r.later).toBe(true);
  });
});

describe("rule 2132: a new person id", () => {
  it("matches PERSON_ID and never contains @, : or #", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newPersonId();
      expect(id).toMatch(PERSON_ID);
      expect(id).not.toMatch(/[@:#]/);
      expect(id).toHaveLength(26);
      seen.add(id);
    }
    expect(seen.size).toBe(200);
  });
});
