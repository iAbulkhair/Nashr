import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { jar, json, newMember, newOpaqueUser, newUser, signIn, signOut } from "./helpers/session";
import { accountByLogin, acct, accountOfScope, claimLogin, createSession, createUser, currentUser, getAccount, getLogin, getUser, releaseLogin, saveUser, sc, sessionKey, type User } from "@/lib/auth";
import { brandOfScope, idForNewAccount, LoginIndex, newAccountId, OPAQUE_ACCOUNT_ID, OPAQUE_IDS } from "@/lib/account-id";
import { db } from "@/lib/db";
import { accountKey, globalKey } from "@/lib/keys";
import { charge } from "@/lib/credits";
import { getMember, memberPid, saveMember, withLoginLock } from "@/lib/team";
import { revokeAllMcp, userFromBearer } from "@/lib/mcp";
import { chatStatus } from "@/lib/chat-allowance";
import { chatMsgKey, chatTrialKey } from "@/lib/usage";
import { route } from "@/lib/models/route";
import * as signupRoute from "@/app/api/auth/signup/route";
import * as mcpTokenRoute from "@/app/api/mcp/token/route";
import { wipeAccount } from "@/lib/account";
import { dailyRoster } from "@/lib/schedule";
import { convertAccountIds } from "../scripts/account-ids";

/**
 * Account-id release R1, the expand step (docs/specs/2026-10-17-account-id.md, amended by docs/specs/2026-10-18-multi-org.md
 * "Changes forced on the account-id spec"): rules 1980-1999, listed in docs/system/tests/1980-account-id-r1.md. In R1
 * every new account's id is its address (`OPAQUE_IDS` off), so nothing on production changes bytes; the tests here build
 * accounts with an opaque id on purpose (`newOpaqueUser`) to prove that no path still reaches an account by its address.
 */

afterEach(() => { vi.restoreAllMocks(); signOut(); });

const read = (p: string) => readFileSync(p, "utf8");
const srcFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true }).map(String).filter((p) => /\.(ts|tsx)$/.test(p)).map((p) => join(dir, p));
const index = (email: string) => db.get(accountKey.login(email));
/** The session record behind the test jar's cookie. */
const sessionNow = () => sessionKey(jar().get("thakeen_session")!);
let n = 0;
const addr = (p: string) => `${p}${++n}-${Math.random().toString(36).slice(2, 8)}@test.example`;
const input = (email: string) => ({ email, name: "Test", phone: "", password: "abc12345", lang: "ar" as const });
const signupLocked = (e: string) => withLoginLock(e, async () => ((await getLogin(e)) ? null : createUser(input(e))));
/** The stored record without its `id`: what a build from before R1 wrote. */
async function stripId(key: string): Promise<void> {
  const { id: _id, ...rest } = (await db.get<Record<string, unknown>>(key))!;
  void _id;
  await db.set(key, rest);
}

describe("rule 1980: an account's key is its id, and an id comes only from our records", () => {
  it("acct() is the stored id, or the address of a record without one", () => {
    expect(acct({ email: "a@test.example" })).toBe("a@test.example");
    expect(acct({ id: "a_abcdefghijklmnopqrstuvwx", email: "a@test.example" })).toBe("a_abcdefghijklmnopqrstuvwx");
  });
  it("a new opaque id is a_ and 24 base32 characters from crypto, never Math.random, and never repeats", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAccountId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(OPAQUE_ACCOUNT_ID);
    const src = read("src/lib/account-id.ts");
    expect(src).toContain('import { randomBytes } from "crypto";');
    expect(src).not.toMatch(/Math\.random\(/);
  });
  it("an opaque account is stored under its id and its scope starts with the id, never with the address", async () => {
    const o = await newOpaqueUser();
    expect(acct(o)).toMatch(OPAQUE_ACCOUNT_ID);
    expect(await db.get(accountKey.user(acct(o)))).toMatchObject({ id: acct(o), email: o.email });
    expect(await db.get(accountKey.user(o.email))).toBeNull();
    expect(await db.sismember(globalKey.usersAll(), acct(o))).toBeTruthy();
    expect(await db.sismember(globalKey.usersAll(), o.email)).toBeFalsy();
    await signIn(o.email);
    const u = (await currentUser())!;
    expect(u.email).toBe(o.email);
    expect(sc(u)).toBe(acct(o));
  });
  it("getAccount trusts the key it read: a stored id that differs is replaced in memory and logged", async () => {
    const u = await newUser("rk");
    await db.set(accountKey.user(u.email), { ...(await db.get<User>(accountKey.user(u.email)))!, id: "a_zzzzzzzzzzzzzzzzzzzzzzzz" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(acct((await getAccount(u.email))!)).toBe(u.email);
    expect(warn.mock.calls.flat().join(" ")).toContain("account id differs from its key");
  });
  it("no route reads an account with an id taken from params, a body or a query", () => {
    const offenders = srcFiles("src/app/api").filter((f) => /(getAccount|getUser)\(\s*(b|body|params|searchParams|url\.searchParams)\b/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});

describe("rule 1981: the legacy fallback accepts user:{e} only when the record is e's own", () => {
  it("no index: a record with no id, or id === e, whose address is e signs in as e", async () => {
    const u = await newUser("lg");
    await stripId(accountKey.user(u.email));
    await db.del(accountKey.login(u.email));
    expect(await getLogin(u.email)).toMatchObject({ kind: "owner", pid: u.email });
    await db.set(accountKey.user(u.email), { ...(await db.get<User>(accountKey.user(u.email)))!, id: u.email });
    expect(await getLogin(u.email)).toMatchObject({ kind: "owner", pid: u.email });
  });
  it("a record at user:{x} that holds another address (a moved account) resolves at neither address", async () => {
    const u = await newUser("mv");
    const y = addr("moved");
    await stripId(accountKey.user(u.email));
    await db.set(accountKey.user(u.email), { ...(await db.get<User>(accountKey.user(u.email)))!, email: y });
    await db.del(accountKey.login(u.email));
    expect(await getLogin(u.email)).toBeNull();
    expect(await getLogin(y)).toBeNull();
    // A pre-R1 session of the old address ends too.
    await signIn(u.email);
    expect(await currentUser()).toBeNull();
  });
  it("an index naming another person refuses the account stored at the address", async () => {
    const u = await newUser("ot");
    await claimLogin(u.email, "a_cccccccccccccccccccccccc");
    expect(await getLogin(u.email)).toBeNull();
  });
  it("the index decides when present: it names the person, and an account that changed its address never passes", async () => {
    const o = await newOpaqueUser("ix");
    expect(await index(o.email)).toEqual({ kind: "person", pid: acct(o) });
    expect(await getLogin(o.email)).toMatchObject({ kind: "owner", pid: acct(o), user: { email: o.email } });
    // The account's address changed under the index (what R2's move in place does): the old address resolves nothing.
    await saveUser({ ...(await getAccount(acct(o)))!, email: addr("elsewhere") });
    expect(await getLogin(o.email)).toBeNull();
  });
});

describe("rule 1982: pointers resolve through getAccount, sign-in addresses through getLogin", () => {
  it("the 'is this address taken' checks ask getLogin, never read user:{address} as an account", () => {
    expect(read("src/lib/email-change.ts")).toMatch(/getLogin\(to\)/);
    expect(read("src/lib/team.ts")).toMatch(/getLogin\(/);
    expect(read("src/app/api/auth/signup/route.ts")).toMatch(/getLogin\(/);
    expect(read("src/app/api/admin/users/[email]/route.ts")).toMatch(/await getLogin\(/);
  });
  it("a member's memberOf and the session's acct are read with getAccount; getUser is its alias", () => {
    const auth = read("src/lib/auth.ts");
    expect(auth).toContain("export const getUser = getAccount;");
    expect(auth).toMatch(/getAccount\(m\.memberOf\)/);
    expect(auth).toMatch(/getAccount\(typeof s\.acct === "string" && s\.acct \? s\.acct : email\)/);
  });
});

describe("rule 1983: the login index is written under lock:login after the resolver found nothing", () => {
  it("two parallel signups of one address give one account and one index", async () => {
    const e = addr("race");
    const made = (await Promise.all([signupLocked(e), signupLocked(e)])).filter(Boolean) as User[];
    expect(made).toHaveLength(1);
    expect(await index(e)).toEqual({ kind: "person", pid: acct(made[0]) });
  });
  it("an index a rolled-back build left behind (no account) is replaced by the next signup under the lock", async () => {
    const e = addr("dangling");
    await claimLogin(e, "a_dddddddddddddddddddddddd");
    expect(await getLogin(e)).toBeNull();
    expect(await signupLocked(e)).not.toBeNull();
    expect(await index(e)).toEqual({ kind: "person", pid: e });
  });
  it("a member gets its frozen id and its index on creation (multi-org forced change 2)", async () => {
    const o = await newOpaqueUser("tm");
    const m = await newMember(o);
    expect(await getMember(m.email)).toMatchObject({ id: m.email, email: m.email, memberOf: acct(o) });
    expect(await index(m.email)).toEqual({ kind: "person", pid: m.email });
    expect(await getLogin(m.email)).toMatchObject({ kind: "member", pid: m.email });
  });
});

describe("rule 1984: a session carries its person and its active account, and resolves only while the login maps to them", () => {
  it("createSession writes pid and acct; an owner's acct is its account, a member's is its team", async () => {
    const o = await newOpaqueUser("ss");
    const m = await newMember(o);
    await createSession(o.email);
    expect(await db.get(sessionNow())).toMatchObject({ email: o.email, pid: acct(o), acct: acct(o) });
    expect((await currentUser())!.email).toBe(o.email);
    await createSession(m.email);
    expect(await db.get(sessionNow())).toMatchObject({ email: m.email, pid: m.email, acct: acct(o) });
    const mu = (await currentUser())!;
    expect(mu.actor).toMatchObject({ kind: "member" });
    expect(sc(mu)).toBe(acct(o));
  });
  it("a session whose person no longer holds the address, or whose account is not the login's, resolves to nothing", async () => {
    const o = await newOpaqueUser("sx");
    await createSession(o.email);
    const key = sessionNow();
    expect(await currentUser()).not.toBeNull();
    await claimLogin(o.email, "a_eeeeeeeeeeeeeeeeeeeeeeee");
    expect(await currentUser()).toBeNull();
    await claimLogin(o.email, acct(o));
    expect(await currentUser()).not.toBeNull();
    await db.set(key, { ...(await db.get<Record<string, unknown>>(key))!, acct: "a_ffffffffffffffffffffffff" }, 3600);
    expect(await currentUser()).toBeNull();
  });
  it("a member session naming another team resolves to nothing", async () => {
    const o = await newOpaqueUser("st");
    const m = await newMember(o);
    await createSession(m.email);
    const key = sessionNow();
    await db.set(key, { ...(await db.get<Record<string, unknown>>(key))!, acct: "a_gggggggggggggggggggggggg" }, 3600);
    expect(await currentUser()).toBeNull();
  });
  it("a session from before R1 (no pid, no acct) of a legacy account resolves as before and reads one account key", async () => {
    const u = await newUser("pre");
    await signIn(u.email);
    const gets = vi.spyOn(db, "get");
    expect((await currentUser())!.email).toBe(u.email);
    expect(gets.mock.calls.map((c) => String(c[0])).filter((k) => k.startsWith("user:"))).toEqual([`user:${u.email}`]);
  });
});

describe("rule 1985: account keys come from acct(u), never from u.email", () => {
  it("an opaque account spends credits on its own record", async () => {
    const o = await newOpaqueUser("cr");
    const before = (await getAccount(acct(o)))!.credits;
    await charge(acct(o), 3);
    expect((await getAccount(acct(o)))!.credits).toBe(before - 3);
    expect(await db.get(accountKey.user(o.email))).toBeNull();
  });
  it("the daily roster reads an opaque account by its id and scopes its brands by it", async () => {
    const o = await newOpaqueUser("dr");
    const { users, idle } = await dailyRoster();
    const scopes = [...users.filter((u) => u.email === o.email).map((u) => u.scope!), ...idle.filter((s) => accountOfScope(s) === acct(o))];
    expect(scopes.length).toBeGreaterThan(0);
    for (const s of scopes) expect(accountOfScope(s)).toBe(acct(o));
    expect(idle.some((s) => accountOfScope(s) === o.email)).toBe(false);
  });
  it("no Redis key template in src/ interpolates u.email, user.email or owner.email outside the per-address rate buckets", () => {
    // Rate buckets (`allow(...)`) are per sign-in address on purpose; any other prefix fails here.
    const RATE = new Set(["accountexport:d", "accountexport:h", "billingstatus", "chat:d", "chat:h", "chatfeedback", "chatovf", "govrollback", "handoffdecline", "handoffread", "handoffrun", "meet:notes", "modelpick", "mpoll:u", "notifyprefs", "onboard", "partnerbank", "partnerclaim", "paycheckout", "payrenewal", "perf", "rate:chat:d", "sec:blocked", "sec:cal", "sec:create", "sec:read", "sec:write", "team:invite:acct", "tool:u", "verifymove:acct", "wishsuggest"]);
    const found = new Set<string>();
    for (const f of srcFiles("src")) {
      for (const m of read(f).matchAll(/`([a-z][a-z0-9_-]*(?::[a-z0-9_-]+)*):\$\{(?:u|user|owner)\.email\}/g)) found.add(m[1]);
    }
    expect([...found].filter((p) => !RATE.has(p))).toEqual([]);
  });
  it("no account-key builder or account function is handed u.email, user.email or owner.email", () => {
    // Widened after the security review (M2): the MCP and OAuth slots, billing, notifications, seats, the roster and the chat counters.
    const ACCOUNT = /\b(accountKey\.(?:user|brands|members|invites|teamLock|notifications|referrals|shared|mcpTokenOf)|scopeFor|listBrands|saveBrands|withBrandsLock|withUserLock|charge|chargeOnce|refund|refundOnce|renewIfDue|notifyItem|listNotifs|getUsage|track|wipeAccount|seatsUsed|revokeAllMcp|createMcpToken|getMcpToken|revokeMcpToken|listGrants|revokeAllGrants|revokeGrant|markAllRead|lastCheckout|paymentHistory|paymentsView|renewPaymob|enforceSeats|membersKey|chatTrialKey|chatMsgKey|chatOverKey|chatCredKey|registerCode|applyReferral)\((?:u|user|owner|account|prev)\.email\b/;
    const offenders = srcFiles("src").flatMap((f) => read(f).split("\n").map((l, i) => [f, i + 1, l] as const)).filter(([, , l]) => ACCOUNT.test(l)).map(([f, i]) => `${f}:${i}`);
    expect(offenders).toEqual([]);
  });
  it("no OAuth code, roster check or partner lock is keyed by an address where it means the account", () => {
    const lines = srcFiles("src").flatMap((f) => read(f).split("\n").map((l, i) => [f, i + 1, l] as const));
    const at = (re: RegExp) => lines.filter(([, , l]) => re.test(l)).map(([f, i]) => `${f}:${i}`);
    // issueCode's `email` is the account id (src/lib/oauth.ts CodeRec).
    expect(at(/\bemail: (?:u|user|owner)\.email\b.*\bclientId\b|issueCode\(\{[^}]*email: (?:u|user)\.email/)).toEqual([]);
    // A member's `memberOf` holds the team's account id.
    expect(at(/memberOf [!=]== (?:u|user|owner|account)\.email\b/)).toEqual([]);
    // afterSignup locks the new account by its id, not by its address.
    const partners = read("src/lib/partners.ts");
    const after = partners.slice(partners.indexOf("export async function afterSignup"), partners.indexOf("\n}\n", partners.indexOf("export async function afterSignup")));
    expect(after).not.toMatch(/withUserLock\(e\b/);
    expect(after).toMatch(/withUserLock\(id\b/);
  });
  it("the founder console's address routes resolve the address through getLogin, never read user:{address} as the account", () => {
    for (const f of ["src/app/api/admin/topups/route.ts", "src/app/api/admin/agent-scope/release/route.ts", "src/app/api/admin/plan/route.ts", "src/app/api/admin/payments/[email]/route.ts", "src/app/api/admin/fair-use/route.ts", "src/app/api/admin/founding/route.ts", "src/app/api/admin/brand-cap/route.ts"]) {
      const src = read(f);
      expect(src, f).toContain("accountByLogin(");
      expect(src, f).not.toMatch(/getUser\(email\)|withUserLock\(email\b|listBrands\(email\)|scopeFor\(email\b/);
    }
  });
  it("the default signup still writes id = email, so R1 changes no production key", async () => {
    const e = addr("plain");
    const u = await createUser(input(e));
    expect(u.id).toBe(e);
    expect(await db.get(accountKey.user(e))).toMatchObject({ id: e, email: e });
  });
});

describe("rule 1986: accountOfScope is the only scope parser", () => {
  it("splits at the first #; the default brand is the account itself", () => {
    expect(accountOfScope("a@test.example")).toBe("a@test.example");
    expect(accountOfScope("a@test.example#b2")).toBe("a@test.example");
    expect(accountOfScope("a_abcdefghijklmnopqrstuvwx#b2")).toBe("a_abcdefghijklmnopqrstuvwx");
    expect(brandOfScope("a@test.example")).toBe("default");
    expect(brandOfScope("a@test.example#b2")).toBe("b2");
  });
  it("no other file splits a scope at #", () => {
    const offenders = srcFiles("src").filter((f) => !f.endsWith("account-id.ts")).filter((f) => /split\("#"\)\[0\]|indexOf\("#"\)/.test(read(f)));
    expect(offenders).toEqual([]);
    expect(read("src/app/api/connect/[provider]/callback/route.ts")).toContain("acct(u) !== accountOfScope(st.email)");
  });
});

describe("rule 1994: the conversion script is idempotent, dry by default, never overwrites and awaits no db call in a loop", () => {
  /** An owner and its member as a build from before R1 left them: no ids, no login indexes. */
  async function legacy(): Promise<{ owner: string; member: string }> {
    const u = await newUser("cv");
    const m = await newMember(u);
    await Promise.all([stripId(accountKey.user(u.email)), stripId(accountKey.member(m.email)), db.del(accountKey.login(u.email)), db.del(accountKey.login(m.email))]);
    return { owner: u.email, member: m.email };
  }
  it("a dry run counts and writes nothing; --apply writes ids and indexes; a second run writes nothing", async () => {
    const a = await legacy();
    const set = vi.spyOn(db, "set");
    const dry = await convertAccountIds(false);
    expect(dry.apply).toBe(false);
    expect(dry.idsSet).toBeGreaterThanOrEqual(2);
    expect(dry.indexesSet).toBeGreaterThanOrEqual(2);
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
    const run = await convertAccountIds(true);
    expect(run.idsSet).toBeGreaterThanOrEqual(2);
    expect(await db.get(accountKey.user(a.owner))).toMatchObject({ id: a.owner });
    expect(await db.get(accountKey.member(a.member))).toMatchObject({ id: a.member });
    expect(await index(a.owner)).toEqual({ kind: "person", pid: a.owner });
    expect(await index(a.member)).toEqual({ kind: "person", pid: a.member });
    const again = await convertAccountIds(true);
    expect([again.idsSet, again.indexesSet]).toEqual([0, 0]);
  });
  it("an index naming someone else is a conflict, never overwritten; a roster entry without a record is an orphan", async () => {
    const a = await legacy();
    await claimLogin(a.owner, "a_hhhhhhhhhhhhhhhhhhhhhhhh");
    await db.sadd(accountKey.members(a.owner), addr("ghost"));
    const r = await convertAccountIds(true);
    expect(r.conflicts).toBeGreaterThanOrEqual(1);
    expect(r.orphans).toBeGreaterThanOrEqual(1);
    expect(await index(a.owner)).toEqual({ kind: "person", pid: "a_hhhhhhhhhhhhhhhhhhhhhhhh" });
  });
  it("the script awaits no db call inside a loop and prints counts only", () => {
    const src = read("scripts/account-ids.ts");
    for (const m of src.matchAll(/\bfor \([^)]*\) \{([^}]*)\}/g)) expect(m[1]).not.toContain("await");
    expect(src).not.toMatch(/\bwhile \(/);
    const logs = [...src.matchAll(/console\.(?:log|error)\((.*)\);/g)].map((m) => m[1]);
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l).not.toMatch(/\.email\b|\.login\b|\.id\b|\bpid\b/);
  });
});

describe("rule 1995: R1 writes only shapes older builds ignore", () => {
  it("the login index reads the multi-org shape and the account-id spec's first shape; anything else is no index", () => {
    expect(LoginIndex.parse({ kind: "person", pid: "a@test.example" })).toEqual({ kind: "person", pid: "a@test.example" });
    expect(LoginIndex.parse({ kind: "owner", id: "a@test.example" })).toEqual({ kind: "person", pid: "a@test.example" });
    expect(LoginIndex.safeParse({ kind: "owner" }).success).toBe(false);
    expect(LoginIndex.safeParse("a@test.example").success).toBe(false);
  });
  it("a malformed index is logged and the guarded fallback decides", async () => {
    const u = await newUser("bad");
    await db.set(accountKey.login(u.email), { kind: "nobody" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getLogin(u.email)).toMatchObject({ kind: "owner" });
    expect(warn.mock.calls.flat().map(String).join(" ")).toContain("stored shape invalid");
  });
});

describe("rule 1996: OPAQUE_IDS is off in R1", () => {
  it("is a code constant, false; a new account's id is its address, an opaque id only when asked", () => {
    expect(OPAQUE_IDS).toBe(false);
    expect(idForNewAccount("a@test.example")).toBe("a@test.example");
    expect(idForNewAccount("a@test.example", true)).toMatch(OPAQUE_ACCOUNT_ID);
    expect(read("src/lib/account-id.ts")).toContain("export const OPAQUE_IDS = false;");
    expect(read("docs/system/variables.md")).not.toContain("OPAQUE_IDS");
  });
  it("an owner move with data stays refused while it is off (the copy carries nothing)", () => {
    const src = read("src/lib/email-change.ts");
    expect(src).toContain('if (await ownerHasData(u)) return { ok: false, error: "owner_has_data" };');
    expect(src).toContain("may: async (cur) => !!cur.emailVerifiedAt && !(await ownerHasData(cur)),");
  });
});

describe("rule 1999: wipeAccount(id) deletes the account's own login indexes and never another person's", () => {
  it("an opaque account with a member: record, users:all entry and both indexes go; the deletion row names id and address", async () => {
    const o = await newOpaqueUser("wp");
    const m = await newMember(o);
    await wipeAccount(acct(o));
    expect(await db.get(accountKey.user(acct(o)))).toBeNull();
    expect(await db.sismember(globalKey.usersAll(), acct(o))).toBeFalsy();
    expect(await index(o.email)).toBeNull();
    expect(await index(m.email)).toBeNull();
    expect(await getMember(m.email)).toBeNull();
    const rows = (await db.lrange(globalKey.deletedAccounts(), 0, 50)).map((r) => (typeof r === "string" ? JSON.parse(r) : r));
    expect(rows).toContainEqual(expect.objectContaining({ id: acct(o), email: o.email }));
  });
  it("the per-brand profile keys go with the brands (source scan of wipeAccount)", () => {
    expect(read("src/lib/account.ts")).toMatch(/profileKey\(s\)/);
  });
  it("an index that names someone else stays", async () => {
    const u = await newUser("wk");
    const other = "a_iiiiiiiiiiiiiiiiiiiiiiii";
    await claimLogin(u.email, other);
    await wipeAccount(acct(u));
    expect(await index(u.email)).toEqual({ kind: "person", pid: other });
  });
  it("a signup at the address after a wipe is a fresh account", async () => {
    const u = await newUser("wn");
    await wipeAccount(acct(u));
    expect(await getLogin(u.email)).toBeNull();
    const again = await signupLocked(u.email);
    expect(again).not.toBeNull();
    expect(acct(again!)).toBe(u.email);
  });
});

describe("the owner move in R1 is still a copy: the new record lives under the new address with its index", () => {
  it("moveOwnerLogin writes id = to and claims login:{to}, then wipes the old account by its id", () => {
    const src = read("src/lib/verify-email.ts");
    expect(src).toMatch(/saveUser\(\{ \.\.\.cur, id: to, email: to,/);
    expect(src).toContain("await claimLogin(to, to);");
    expect(src).toContain("await wipeAccount(id, { userLocked: true, loginLocked: true, teamLocked: true });");
  });
  it("a member move claims the new index and releases the old one", () => {
    const team = read("src/lib/team.ts");
    expect(team).toContain("claimLogin(to, to)");
    expect(team).toMatch(/releaseLogin\(/);
  });
  it("a copy stored at its own id with its index resolves at the new address", async () => {
    // End to end in tests/email-verify-change.test.ts and tests/account-security-email.test.ts.
    const u = await newUser("cp");
    const to = addr("cpto");
    await saveUser({ ...(await getUser(u.email))!, id: to, email: to });
    await claimLogin(to, to);
    expect(await getLogin(to)).toMatchObject({ kind: "owner", pid: to });
  });
});

describe("security review of R1 (M1, M2, L1)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it("M1: while OPAQUE_IDS is off, a member's stored id that is not its address is ignored and logged", async () => {
    const o = await newUser("m1");
    const m = await newMember(o);
    const other = addr("m1old");
    await saveMember({ ...(await getMember(m.email))!, id: other });
    await db.del(accountKey.login(m.email));
    const got = (await getMember(m.email))!;
    expect(got.id).toBe(m.email);
    expect(memberPid({ id: other, email: m.email })).toBe(m.email);
    expect(await getLogin(m.email)).toMatchObject({ kind: "member", pid: m.email });
  });
  it("M1: signup refuses an address that still has a member record off its roster", async () => {
    const o = await newUser("m1s");
    const m = await newMember(o);
    await Promise.all([db.srem(accountKey.members(acct(o)), m.email), db.del(accountKey.login(m.email))]);
    expect(await getLogin(m.email)).toBeNull();
    jar().clear();
    const res = await signupRoute.POST(json("/api/auth/signup", "POST", { email: m.email, password: "abc12345", name: "X", lang: "en" }, { "x-forwarded-for": `10.9.${n % 250}.${(n * 7) % 250}` }));
    expect(res.status).toBe(409);
    expect(await db.get(accountKey.user(m.email))).toBeNull();
  });
  it("M1: the script counts a member whose id is not its address as a conflict and writes no index for it", async () => {
    const o = await newUser("m1c");
    const m = await newMember(o);
    await saveMember({ ...(await getMember(m.email))!, id: addr("m1cold") });
    await db.del(accountKey.login(m.email));
    const r = await convertAccountIds(true);
    expect(r.conflicts).toBeGreaterThanOrEqual(1);
    expect(await index(m.email)).toBeNull();
  });
  it("L1: releaseLogin waits for the login lock and re-reads, so an index claimed meanwhile survives", async () => {
    const u = await newUser("l1");
    const next = "a_jjjjjjjjjjjjjjjjjjjjjjjj";
    let release: Promise<void> | null = null;
    await withLoginLock(u.email, async () => {
      release = releaseLogin(u.email, u.email);
      await sleep(150);
      expect(await index(u.email)).toEqual({ kind: "person", pid: u.email });
      await db.set(accountKey.login(u.email), { kind: "person", pid: next });
    });
    await release;
    expect(await index(u.email)).toEqual({ kind: "person", pid: next });
    await releaseLogin(u.email, next);
    expect(await index(u.email)).toBeNull();
  });
  it("L1: callers that already hold the login lock say so, so nothing waits on itself", () => {
    expect(read("src/lib/auth.ts")).toMatch(/withLoginLock\(email, drop\)/);
    expect(read("src/lib/team.ts")).toContain("releaseLogin(old, memberPid(cur), { locked: true })");
    // Multi-workspace M1 Task 6 fix round 2: `wipeAccount` releases the owner's login inside `wipeMemberships`'s finish, under the
    // login lock it takes itself unless the caller (the address move) says it holds it already.
    const account = read("src/lib/account.ts");
    expect(account).toContain("releaseLogin(login, e, { locked: true })");
    expect(account).toContain("if (opts.loginLocked) await owner();\n    else await withLoginLock(login, owner);");
  });
  it("M2: an opaque owner's MCP token is kept under its id, resolves to it, and revokeAllMcp(acct) ends it", async () => {
    const o = await newOpaqueUser("m2t");
    await createSession(o.email);
    const res = await mcpTokenRoute.POST();
    const { token } = (await res.json()) as { token: string };
    expect(await db.get(accountKey.mcpTokenOf(acct(o)))).toBeTruthy();
    expect(await db.get(accountKey.mcpTokenOf(o.email))).toBeNull();
    const bearer = () => new Request("http://x/api/mcp", { headers: { authorization: `Bearer ${token}` } });
    const u = (await userFromBearer(bearer()))!;
    expect(acct(u)).toBe(acct(o));
    expect(accountOfScope(u.scope!)).toBe(acct(o));
    await revokeAllMcp(acct(o));
    expect(await userFromBearer(bearer())).toBeNull();
  });
  it("M2: an opaque account's chat counter is read under its id", async () => {
    const o = await newOpaqueUser("m2c");
    await db.set(chatTrialKey(acct(o)), 4);
    await db.set(chatTrialKey(o.email), 9);
    expect((await chatStatus(o, route("chat").model)).counted).toBe(4);
    const paid = { ...o, plan: "pro" as const };
    await db.set(chatMsgKey(acct(o)), 6);
    expect((await chatStatus(paid, route("chat").model)).counted).toBe(6);
  });
  it("M2: accountByLogin resolves an owner's address to its account and a member's to nothing", async () => {
    const o = await newOpaqueUser("m2a");
    const m = await newMember(o);
    expect(acct((await accountByLogin(o.email))!)).toBe(acct(o));
    expect(await accountByLogin(m.email)).toBeNull();
    expect(await accountByLogin(addr("nobody"))).toBeNull();
  });
});
