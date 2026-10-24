import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { adminSignIn, jar, json, markVerified, newMember, newUser, signIn, signOut } from "./helpers/session";
import { codeAt } from "./helpers/staff";
import { enrolPasskeys } from "./helpers/passkeys";
import { accountByLogin, acct, createUser, currentUser, getAccount, getLogin, getUser, sc, saveUser, verifyPassword, type User } from "@/lib/auth";
import { OPAQUE_ACCOUNT_ID } from "@/lib/account-id";
import { db } from "@/lib/db";
import { accountKey, globalKey, personKey, storedPersonId, wsKey, type Scope } from "@/lib/keys";
import { getMember } from "@/lib/team";
import { mfaKey } from "@/lib/mfa";
import { linkKey, subKey } from "@/lib/google-signin";
import { getPerson } from "@/lib/person";
import { ownerOf } from "@/lib/membership";
import { listPasskeys } from "@/lib/passkeys";
import { addressBlocked, holdOn } from "@/lib/email-hold";
import { movePersonLogin } from "@/lib/email-move";
import { ownerHasData } from "@/lib/email-change";
import { carryFeedLogin, FEED_KEYS } from "@/lib/feed-token";
import { BOOK_KEYS, carryBookLogin } from "@/lib/booking-token";
import { composioUserId } from "@/lib/connectors/composio";
import { applyReferral, moveReferral, registerCode } from "@/lib/referral";
import { listPartners } from "@/lib/partners";
import { forgetWishlistUser, setVote, WISH_KEYS } from "@/lib/wishlist";
import { SEED_WISH_IDS } from "@/lib/changelog";
import { convertAccountIds } from "../scripts/account-ids";

// Account-id release R2, built behind the constant (rules 2740-2749; docs/system/tests/2740-account-id-r2.md). The
// constant stays false in code; this file turns it on, and off again where a test needs an account made before the
// flip (a legacy owner whose id is its address) or the behaviour while it is off. Read live by every module: vitest
// rewrites `import { OPAQUE_IDS }` into a property read of the mocked module, so the getter decides each call.
const flags = vi.hoisted(() => ({ opaque: true }));
vi.mock("@/lib/account-id", async (orig) => {
  const m = await orig<typeof import("@/lib/account-id")>();
  return { ...m, get OPAQUE_IDS() { return flags.opaque; } };
});

type Mail = { to: string; subject: string; text: string };
let mails: Mail[] = [];
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (...a: unknown[]) => {
    const m = (typeof a[0] === "string" ? { to: a[0], subject: a[1], text: a[2] } : a[0]) as Mail;
    mails.push({ to: m.to, subject: m.subject, text: m.text });
    return true;
  },
}));

import * as emailRoute from "@/app/api/account/email/route";
import * as revertRoute from "@/app/api/auth/email-revert/route";
import * as resetRoute from "@/app/api/auth/reset/route";
import * as signupRoute from "@/app/api/auth/signup/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as twoFaRoute from "@/app/api/account/2fa/route";
import * as verifyEmailRoute from "@/app/api/auth/verify/email/route";
import * as planRoute from "@/app/api/admin/plan/route";

const read = (f: string) => readFileSync(f, "utf8");
let ipN = 0;
const ip = () => { ipN++; return { "x-forwarded-for": `203.0.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}` }; };
const addr = (p: string) => `${p}-${randomBytes(4).toString("hex")}@test.example`;
const post = (body: Record<string, unknown>) => emailRoute.POST(json("/api/account/email", "POST", body, ip()));
const start = (email: string, password = "abc12345", extra: Record<string, unknown> = {}) => post({ action: "start", email, password, ...extra });
const confirm = (code: string) => post({ action: "confirm", code });
const codeFor = (to: string) => mails.filter((m) => m.to === to).at(-1)!.text.match(/\b\d{6}\b/)![0];
const revertTokenIn = (to: string) => mails.filter((m) => m.to === to).at(-1)?.text.match(/#r=([a-f0-9]{64})/)?.[1];
const revert = (token: unknown) => revertRoute.POST(json("/api/auth/email-revert", "POST", { token }, ip()));
const login = (email: string, password = "abc12345") => loginRoute.POST(json("/api/auth/login", "POST", { email, password }, ip()));
const signup = (email: string) => signupRoute.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "X", lang: "en" }, ip()));
const answer = async (r: Response) => ({ status: r.status, body: await r.json() });

/** An owner made BEFORE the flip: a legacy person whose account id and person id are its address. */
async function preFlipOwner(prefix = "pre"): Promise<User> {
  flags.opaque = false;
  try {
    return await newUser(prefix, { legacy: true });
  } finally {
    flags.opaque = true;
  }
}
/** A `p_` person owning an account (multi-workspace M1 shape), verified. */
async function pOwner(prefix = "po"): Promise<User> {
  const u = await createUser({ email: addr(prefix), name: "P", phone: "", password: "abc12345", lang: "en" }, { person: "p" });
  return markVerified(u.email);
}
/** Signed in as `u`, start and confirm a change to `to`; the confirm's answer. */
async function changeTo(u: { email: string }, to: string, password = "abc12345") {
  await signIn(u.email);
  const s = await start(to, password);
  expect(s.status, JSON.stringify(await s.clone().json())).toBe(200);
  return answer(await confirm(codeFor(to)));
}

beforeEach(() => {
  mails = [];
  flags.opaque = true;
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("MAIL_FROM", "Thakeen <no-reply@test.example>");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); signOut(); flags.opaque = true; });

describe("rule 2740 (1996, R2 half): with OPAQUE_IDS on a new account is opaque, and a moved account's old key is never reused (L3)", () => {
  it("createUser and the signup route make an a_ id; nothing is written at user:{address}", async () => {
    const u = await createUser({ email: addr("new"), name: "N", phone: "", password: "abc12345", lang: "en" });
    expect(acct(u)).toMatch(OPAQUE_ACCOUNT_ID);
    expect(await db.get(accountKey.user(u.email))).toBeNull();
    const e = addr("route");
    expect((await signup(e)).status).toBe(200);
    const l = (await getLogin(e))!;
    expect(l.kind).toBe("owner");
    expect(l.acct).toMatch(OPAQUE_ACCOUNT_ID);
    expect(await db.get(accountKey.user(e))).toBeNull();
  });

  it("L3: after a legacy owner moved in place its old address is 'moved' to everyone but that owner, and a signup there gets a new opaque account", async () => {
    const u = await preFlipOwner();
    const old = u.email;
    const to = addr("l3");
    expect((await changeTo(u, to)).status).toBe(200);
    await db.del(accountKey.emailHold(old)); // past the 30 days: only the L3 guard is left
    expect(await addressBlocked(old)).toBe("moved");
    expect(await addressBlocked(old, old)).toBeNull();
    signOut();
    expect((await signup(old)).status).toBe(200);
    const fresh = (await getLogin(old))!;
    expect(fresh.acct).toMatch(OPAQUE_ACCOUNT_ID);
    // The moved account's record at its old key still holds the new address: the signup never touched it.
    expect(await db.get(accountKey.user(old))).toMatchObject({ id: old, email: to });
    expect((await getLogin(to))!.acct).toBe(old);
  });

  it("L3 holds with the constant turned off again after a move: a signup at the old address never overwrites the moved account", async () => {
    const u = await preFlipOwner();
    const old = u.email;
    const to = addr("l3off");
    expect((await changeTo(u, to)).status).toBe(200);
    await db.del(accountKey.emailHold(old));
    flags.opaque = false;
    signOut();
    expect(await addressBlocked(old)).toBe("moved");
    expect((await signup(old)).status).toBe(200);
    expect((await getLogin(old))!.acct).toMatch(OPAQUE_ACCOUNT_ID);
    expect(await db.get(accountKey.user(old))).toMatchObject({ id: old, email: to });
    expect((await getLogin(to))).toMatchObject({ kind: "owner", acct: old });
  });

  it("L3 guards every address-derived write: legacy invite accept, member move and createUser", () => {
    const team = read("src/lib/team.ts");
    expect(team).toContain('if (blocked === "held" || (blocked === "moved" && !MULTI_ORG)) return fail("unavailable");');
    expect(team).toContain("addressBlocked(to, oldPid)");
    expect(read("src/lib/auth.ts")).toContain("idForNewAccount(email, opts.opaque || OPAQUE_IDS || (split && MULTI_ORG) || moved)");
    expect(read("src/lib/email-hold.ts")).not.toMatch(/export async function addressBlocked[^{]*\{\s*if \(!OPAQUE_IDS\)/);
  });
});

describe("rules 2741, 1987, 1989: the move in place (an owner with work, a p_ person, an opaque owner)", () => {
  it("a legacy owner WITH work moves; the id, scope, users:all and work stay; the new address signs in and the old one signs nothing in", async () => {
    const u = await preFlipOwner();
    const old = u.email;
    const scope = sc(u) as Scope;
    await db.set(wsKey.brand(scope), { name: "Kept brand" });
    expect(await ownerHasData(u)).toBe(true);
    await signIn(old);
    const before = jar().get("thakeen_session")!;
    const to = addr("moved");
    const s = await start(to);
    expect(s.status).toBe(200);
    const ok = await answer(await confirm(codeFor(to)));
    expect(ok).toMatchObject({ status: 200, body: { ok: true, email: to } });
    // In place: the record under the old key now holds the new address; nothing at user:{to}.
    expect(await db.get(accountKey.user(old))).toMatchObject({ id: old, email: to });
    expect(await db.get(accountKey.user(to))).toBeNull();
    expect((await getAccount(old))!.emailVerifiedAt).toBeTruthy();
    expect(await db.sismember(globalKey.usersAll(), old)).toBeTruthy();
    expect(await db.get(wsKey.brand(scope))).toEqual({ name: "Kept brand" });
    expect(await db.get(accountKey.login(old))).toBeNull();
    expect((await getLogin(to))).toMatchObject({ kind: "owner", pid: old, acct: old });
    expect(await getLogin(old)).toBeNull();
    // This device has a new session at the new address with the same scope; the old cookie opens nothing.
    const me = (await currentUser())!;
    expect(me.email).toBe(to);
    expect(sc(me)).toBe(scope);
    jar().set("thakeen_session", before);
    expect(await currentUser()).toBeNull();
    signOut();
    expect((await login(to)).status).toBe(200);
    expect((await login(old)).status).toBe(401);
    // The old address got the notice with a revert link (D1); the new one got only the code.
    expect(revertTokenIn(old)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("a p_ person moves with its opaque account; ids unchanged, person and account carry the new address", async () => {
    const u = await pOwner();
    const pid = ownerOf(u);
    expect(pid.startsWith("p_")).toBe(true);
    const to = addr("pmoved");
    expect((await changeTo(u, to)).status).toBe(200);
    expect((await getPerson(pid))!.email).toBe(to);
    expect((await getAccount(acct(u)))!.email).toBe(to);
    expect(await getLogin(to)).toMatchObject({ pid, acct: acct(u) });
    expect(await getLogin(u.email)).toBeNull();
    signOut();
    expect((await login(to)).status).toBe(200);
  });

  it("an opaque owner made after the flip moves the same way (rule 1992: the Composio user id, keyed by scope, is unchanged)", async () => {
    const u = await newUser("op", { legacy: true });
    expect(acct(u)).toMatch(OPAQUE_ACCOUNT_ID);
    const cid = composioUserId(sc(u));
    const to = addr("opmoved");
    expect((await changeTo(u, to)).status).toBe(200);
    const after = (await getAccount(acct(u)))!;
    expect(after.email).toBe(to);
    expect(composioUserId(sc(after))).toBe(cid);
  });

  it("rule 1993: the account keeps its key, so the daily roster and every cron read it by id; mail goes to the new address", async () => {
    const u = await preFlipOwner();
    const to = addr("cron");
    expect((await changeTo(u, to)).status).toBe(200);
    expect((await getUser(acct(u)))!.email).toBe(to);
    expect(read("src/lib/schedule.ts")).not.toMatch(/accountKey\.user\(u\.email\)/);
  });

  it("a taken target is refused (taken), and a legacy member record keeps R1's copy", async () => {
    const a = await preFlipOwner();
    const b = await preFlipOwner();
    await signIn(a.email);
    expect(await answer(await start(b.email))).toMatchObject({ status: 409, body: { error: "taken" } });
    const m = await newMember(a, "member", "m", { legacy: true });
    const to = addr("mnew");
    expect((await changeTo(m, to, m.password)).status).toBe(200);
    expect(await getMember(to)).toMatchObject({ email: to });
    expect(await getMember(m.email)).toBeNull();
  });

  it("three moves a day, then limit", async () => {
    const u = await pOwner();
    const pid = ownerOf(u);
    const opts = { may: () => true, proved: true, limited: true, hold: false };
    let at = u.email;
    for (let i = 0; i < 3; i++) {
      const next = addr(`lim${i}`);
      expect((await movePersonLogin(pid, at, next, opts)).result).toBe("ok");
      at = next;
    }
    expect((await movePersonLogin(pid, at, addr("lim3"), opts)).result).toBe("limit");
  });
});

describe("rule 1988: a stopped move and its retry end in one account and one login", () => {
  it("login:{to} already claimed for this person (a stop after the first write) is a retry, not a conflict", async () => {
    const u = await pOwner();
    const pid = ownerOf(u);
    const to = addr("retry");
    await db.set(accountKey.login(to), { kind: "person", pid });
    const r = await movePersonLogin(pid, u.email, to, { may: () => true, proved: true, limited: true, hold: true });
    expect(r.result).toBe("ok");
    expect(await getLogin(to)).toMatchObject({ pid, acct: acct(u) });
    expect(await getLogin(u.email)).toBeNull();
    // A target index naming someone else is refused.
    const other = await pOwner();
    expect((await movePersonLogin(pid, to, other.email, { may: () => true, proved: true, limited: false, hold: false })).result).toBe("exists");
  });

  it("a stop before the old index is released leaves login:{old} signing nothing in; the retry from the session's address finishes", async () => {
    const u = await pOwner();
    const pid = ownerOf(u);
    const to = addr("half");
    expect((await movePersonLogin(pid, u.email, to, { may: () => true, proved: true, limited: false, hold: false })).result).toBe("ok");
    // Simulate the residue: the old index written back as if the release never ran.
    await db.set(accountKey.login(u.email), { kind: "person", pid });
    expect(await getLogin(u.email)).toBeNull();
    expect((await getLogin(to))!.pid).toBe(pid);
  });
});

describe("rule 1990: two-step, the active brand, the Google link, the feed and booking links follow the login", () => {
  it("all per-login state moves to the new address and none stays at the old one", async () => {
    const u = await preFlipOwner();
    const old = u.email;
    await db.set(mfaKey(old), { enc: "x", kid: "k", rc: [], at: new Date(Date.now() - 864e5).toISOString() });
    await db.set(accountKey.activeBrand(old), "default");
    await Promise.all([db.set(subKey(old), "gR2Sub"), db.set(linkKey("gR2Sub"), old)]);
    const to = addr("carry");
    // Two-step on: the change needs its code (D2), proved below with a stored enrolment the route cannot open, so this
    // test moves through the library with the same options the route passes.
    const r = await movePersonLogin(storedPersonId(old), old, to, { may: () => true, proved: true, limited: true, hold: true });
    expect(r.result).toBe("ok");
    expect(await db.get(mfaKey(to))).toBeTruthy();
    expect(await db.get(mfaKey(old))).toBeNull();
    expect(await db.get(accountKey.activeBrand(to))).toBe("default");
    expect(await db.get(accountKey.activeBrand(old))).toBeNull();
    expect(await db.get(subKey(to))).toBe("gR2Sub");
    expect(await db.get(linkKey("gR2Sub"))).toBe(to);
    expect(await db.get(subKey(old))).toBeNull();
  });

  it("carryFeedLogin and carryBookLogin move the pointer and the record's login; a leftover at the target is replaced", async () => {
    const from = addr("feedfrom");
    const to = addr("feedto");
    await Promise.all([
      db.set(FEED_KEYS.of(from), "fh1"),
      db.set(FEED_KEYS.rec("fh1"), { login: from, scope: from, lang: "en", createdAt: "2026-10-01T00:00:00.000Z" }),
      db.set(FEED_KEYS.of(to), "fhOld"),
      db.set(FEED_KEYS.rec("fhOld"), { login: to, scope: "x", lang: "en", createdAt: "2026-09-01T00:00:00.000Z" }),
      db.set(BOOK_KEYS.of(from, "calcom"), "bh1"),
      db.set(BOOK_KEYS.rec("bh1"), { login: from, scope: from, provider: "calcom", lang: "en", createdAt: "2026-10-01T00:00:00.000Z" }),
    ]);
    await Promise.all([carryFeedLogin(from, to), carryBookLogin(from, to)]);
    expect(await db.get(FEED_KEYS.of(to))).toBe("fh1");
    expect(await db.get(FEED_KEYS.of(from))).toBeNull();
    expect(await db.get(FEED_KEYS.rec("fh1"))).toMatchObject({ login: to });
    expect(await db.get(FEED_KEYS.rec("fhOld"))).toBeNull();
    expect(await db.get(BOOK_KEYS.of(to, "calcom"))).toBe("bh1");
    expect(await db.get(BOOK_KEYS.of(from, "calcom"))).toBeNull();
    expect(await db.get(BOOK_KEYS.rec("bh1"))).toMatchObject({ login: to });
  });
});

describe("rule 2742: a partner's address is refused (the programme is keyed by the address)", () => {
  it("confirm answers 409 partner and nothing moves", async () => {
    const u = await preFlipOwner();
    await db.set(`partner:${u.email}`, { email: u.email, name: "P", code: "PRTNR1", approvedAt: "2026-10-01T00:00:00.000Z", approvedBy: "f@test.example" });
    await signIn(u.email);
    const to = addr("ptr");
    expect((await start(to)).status).toBe(200);
    expect(await answer(await confirm(codeFor(to)))).toMatchObject({ status: 409, body: { error: "partner" } });
    expect((await getLogin(u.email))!.kind).toBe("owner");
    expect(await getLogin(to)).toBeNull();
  });
});

describe("rules 2743, 1997: the old address is held for 30 days", () => {
  it("signup, another login's address change and the hold record; the person itself may move back, which drops the hold", async () => {
    const u = await pOwner();
    const pid = ownerOf(u);
    const old = u.email;
    const to = addr("held");
    expect((await changeTo(u, to)).status).toBe(200);
    expect(await holdOn(old)).toMatchObject({ pid, to });
    expect(await addressBlocked(old)).toBe("held");
    signOut();
    expect((await signup(old)).status).toBe(409);
    const other = await pOwner();
    await signIn(other.email);
    expect(await answer(await start(old))).toMatchObject({ status: 409, body: { error: "taken" } });
    // The holder moves back: a normal change, allowed, and the hold goes.
    // (The refused start above spent the one-a-minute send gap to that address, which is counted before the checks.)
    await db.del(globalKey.rate(`verify:gap:${old}`));
    expect((await changeTo({ email: to }, old)).status).toBe(200);
    expect(await holdOn(old)).toBeNull();
    expect((await getLogin(old))!.pid).toBe(pid);
  });

  it("Google sign-up and invite acceptance check the hold; the typo fix writes none", async () => {
    expect(read("src/lib/google-signin.ts")).toMatch(/addressBlocked\(id\.email\)\) === "held"\) return \{ kind: "refused", error: "google_taken" \}/);
    expect(read("src/lib/team.ts")).toMatch(/"held"/);
    const u = await newUser("typo", { legacy: true, verified: false });
    await signIn(u.email);
    const to = addr("typofix");
    const r = await verifyEmailRoute.POST(json("/api/auth/verify/email", "POST", { email: to }, ip()));
    expect(r.status).toBe(200);
    expect(await getLogin(to)).toMatchObject({ kind: "owner", acct: acct(u) });
    expect(await holdOn(u.email)).toBeNull();
    expect(mails.some((m) => m.to === u.email && /#r=/.test(m.text))).toBe(false);
  });
});

describe("rules 2744, 1997: the revert link", () => {
  it("moves the person back, ends every session, makes the password unknown, drops EVERY passkey, two-step, Google, feed and booking links, and hands a reset token", async () => {
    const u = await pOwner();
    const pid = ownerOf(u);
    const old = u.email;
    const to = addr("hijack");
    const kept = await enrolPasskeys(old, { count: 1, reg: false });
    expect((await changeTo(u, to)).status).toBe(200);
    const token = revertTokenIn(old)!;
    // What a hijacker adds after the move: two-step, a passkey, a Google link.
    await db.set(mfaKey(to), { enc: "x", kid: "k", rc: [], at: new Date(Date.now() + 1000).toISOString() });
    await new Promise((r) => setTimeout(r, 5));
    await enrolPasskeys(to, { count: 1, reg: false });
    await Promise.all([
      db.set(subKey(to), "gHijack"),
      db.set(linkKey("gHijack"), to),
      // A calendar feed and a booking link the hijacker made (fix round 1: the revert ends them, not only a later reset).
      db.set(FEED_KEYS.of(to), "fhRev"),
      db.set(FEED_KEYS.rec("fhRev"), { login: to, scope: acct(u), lang: "en", createdAt: new Date().toISOString() }),
      db.set(BOOK_KEYS.of(to, "calcom"), "bhRev"),
      db.set(BOOK_KEYS.rec("bhRev"), { login: to, scope: acct(u), provider: "calcom", lang: "en", createdAt: new Date().toISOString() }),
    ]);
    expect((await listPasskeys(pid, kept.born)).length).toBe(2);
    await signIn(to);
    const hijackSession = jar().get("thakeen_session")!;

    const r = await answer(await revert(token));
    expect(r.status).toBe(200);
    expect(r.body.reset).toMatch(/^[a-f0-9]{64}$/);
    expect((await getLogin(old))!.pid).toBe(pid);
    expect(await getLogin(to)).toBeNull();
    expect((await getPerson(pid))!.email).toBe(old);
    jar().set("thakeen_session", hijackSession);
    expect(await currentUser()).toBeNull();
    expect(await verifyPassword((await getPerson(pid))!, "abc12345")).toBe(false);
    expect(await db.get(mfaKey(old))).toBeNull();
    expect(await db.get(mfaKey(to))).toBeNull();
    expect(await db.get(subKey(old))).toBeNull();
    expect(await db.get(linkKey("gHijack"))).toBeNull();
    // Every passkey goes, the one from before the move too (ruling: the old mailbox's holder is the rightful owner).
    expect(await listPasskeys(pid, kept.born)).toEqual([]);
    expect(await db.get(personKey.passkeys(pid))).toBeNull();
    for (const k of [FEED_KEYS.of(old), FEED_KEYS.of(to), FEED_KEYS.rec("fhRev"), BOOK_KEYS.of(old, "calcom"), BOOK_KEYS.of(to, "calcom"), BOOK_KEYS.rec("bhRev")]) expect(await db.get(k), k).toBeNull();
    // Single use.
    expect((await revert(token)).status).toBe(400);
    // The reset token sets a new password at the old address.
    signOut();
    const set = await resetRoute.POST(json("/api/auth/reset", "POST", { token: r.body.reset, password: "new-pass-2744" }, ip()));
    expect(set.status).toBe(200);
    expect(await verifyPassword((await getPerson(pid))!, "new-pass-2744")).toBe(true);
  });

  it("a legacy owner (person id = its first address) reverts back to that address; the record keeps its key", async () => {
    const u = await preFlipOwner();
    const old = u.email;
    expect((await changeTo(u, addr("legrev"))).status).toBe(200);
    expect((await revert(revertTokenIn(old)!)).status).toBe(200);
    expect(await getLogin(old)).toMatchObject({ kind: "owner", pid: old, acct: old });
    expect(await db.get(accountKey.user(old))).toMatchObject({ id: old, email: old });
  });

  it("a revert kills the token of a later move (the hijacker's own move cannot be reverted back to them)", async () => {
    const u = await pOwner();
    const a = u.email;
    const b = addr("b");
    const c = addr("c");
    expect((await changeTo(u, b)).status).toBe(200);
    const t1 = revertTokenIn(a)!;
    await new Promise((r) => setTimeout(r, 5));
    expect((await changeTo({ email: b }, c)).status).toBe(200);
    const t2 = revertTokenIn(b)!;
    expect((await revert(t1)).status).toBe(200);
    expect((await getLogin(a))!.pid).toBe(ownerOf(u));
    expect((await revert(t2)).status).toBe(400);
    expect((await getLogin(a))!.pid).toBe(ownerOf(u));
  });

  it("two-step enrolled after the move or within 7 days before it goes; one enrolled earlier stays", async () => {
    const recentU = await pOwner("mfarecent");
    const oldU = await pOwner("mfaold");
    await Promise.all([
      db.set(mfaKey(recentU.email), { enc: "x", kid: "k", rc: [], at: new Date(Date.now() - 3 * 864e5).toISOString() }),
      db.set(mfaKey(oldU.email), { enc: "x", kid: "k", rc: [], at: new Date(Date.now() - 10 * 864e5).toISOString() }),
    ]);
    // Two-step is on, so the route would ask for a code (D2, its own test): the move runs as the confirm runs it.
    for (const u of [recentU, oldU]) {
      const r = await movePersonLogin(ownerOf(u), u.email, addr("mfato"), { may: () => true, proved: true, limited: true, hold: true });
      expect(r.result).toBe("ok");
      expect((await revert((r as { revert: string }).revert)).status).toBe(200);
    }
    expect(await db.get(mfaKey(recentU.email))).toBeNull();
    expect(await db.get(mfaKey(oldU.email))).toBeTruthy();
  });

  it("the token is used up only under the locks once the revert can finish: a busy person lock leaves it usable", async () => {
    const u = await pOwner("busyrev");
    const pid = ownerOf(u);
    const to = addr("busyto");
    expect((await changeTo(u, to)).status).toBe(200);
    const token = revertTokenIn(u.email)!;
    const lock = personKey.lock(pid);
    const held = await db.lockOwned(lock, 60);
    expect(held).toBeTruthy();
    try {
      expect(await answer(await revert(token))).toMatchObject({ status: 409, body: { error: "busy" } });
    } finally {
      await db.unlockOwned(lock, held!);
    }
    expect((await getPerson(pid))!.email).toBe(to);
    // The same link works once the lock is free, and only once.
    expect((await revert(token)).status).toBe(200);
    expect((await getPerson(pid))!.email).toBe(u.email);
    expect((await revert(token)).status).toBe(400);
  }, 20_000);

  it("a failure after the token is claimed puts it back: the route answers an error and the same link then works once", async () => {
    const u = await pOwner("throwrev");
    const pid = ownerOf(u);
    const old = u.email;
    const to = addr("throwto");
    expect((await changeTo(u, to)).status).toBe(200);
    const token = revertTokenIn(old)!;
    const tokenKey = globalKey.emailRevert(createHash("sha256").update(token).digest("hex"));
    // Armed by the claim (GETDEL of the token), the first read the extra step makes (two-step at the old address)
    // throws once: the move has finished, the token is gone, the revert's own removals have not run.
    let armed = false;
    let thrown = 0;
    const getdel = db.getdel.bind(db);
    const get = db.get.bind(db);
    const spies = [
      vi.spyOn(db, "getdel").mockImplementation(async (k: string) => {
        const v = await getdel(k);
        if (k === tokenKey && v) armed = true;
        return v as never;
      }),
      vi.spyOn(db, "get").mockImplementation(async (k: string) => {
        if (armed && k === mfaKey(old)) {
          armed = false;
          thrown++;
          throw new Error("boom-2744");
        }
        return (await get(k)) as never;
      }),
    ];
    try {
      await expect(revert(token)).rejects.toThrow("boom-2744");
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(thrown).toBe(1);
    // The token is back (claimed, then restored), with the rest of its 7 days.
    expect(await db.get(tokenKey)).toBeTruthy();
    // The same link finishes the revert, and only once.
    const r = await answer(await revert(token));
    expect(r.status).toBe(200);
    expect(r.body.reset).toMatch(/^[a-f0-9]{64}$/);
    expect((await getPerson(pid))!.email).toBe(old);
    expect(await getLogin(to)).toBeNull();
    expect((await revert(token)).status).toBe(400);
  }, 20_000);

  it("a refused revert (the old address taken meanwhile) keeps the token; claim, restore and the batch removals are in the source", async () => {
    const u = await pOwner("takenrev");
    const old = u.email;
    const to = addr("takento");
    expect((await changeTo(u, to)).status).toBe(200);
    const token = revertTokenIn(old)!;
    // Another existing person's hold on the old address (not reachable in the product while this person's own hold
    // stands; written here directly so the re-check under the locks refuses).
    const other = await pOwner("otherhold");
    const until = new Date(Date.now() + 864e5).toISOString();
    await db.set(accountKey.emailHold(old), { pid: ownerOf(other), to: other.email, at: new Date().toISOString(), until });
    expect(await answer(await revert(token))).toMatchObject({ status: 409, body: { error: "unavailable" } });
    expect(await db.get(globalKey.emailRevert(createHash("sha256").update(token).digest("hex")))).toBeTruthy();
    expect((await getPerson(ownerOf(u)))!.email).toBe(to);
    await db.del(accountKey.emailHold(old));
    expect((await revert(token)).status).toBe(200);
    const src = read("src/lib/email-move.ts");
    expect(src).toMatch(/const rec = await peekRevert\(token\)/);
    expect(src).toMatch(/if \(opts\.claim && !\(await opts\.claim\(\)\)\) return \{ result: "not_allowed" \};\n    const fresh/);
    expect(src).toMatch(/if \(claimed\) await restoreRevert\(token, rec\);/);
    expect(src).toMatch(/removeAllPasskeys\(pid, \{ personLocked: true \}\)/);
    expect(src).toMatch(/revokeCalendarLinks\(acct\(x\)\)/);
    // No loop at all in the move or the revert (fix round 1: the passkeys went one await at a time): every batch is a
    // Promise.all or pmap.
    expect(src).not.toMatch(/\b(for|while)\s*(await\s*)?\(/);
  });

  it("the reset page never reverts on load: it shows a confirm screen and only its button posts the token", () => {
    const src = read("src/components/app/AuthForm.tsx");
    const reset = src.slice(src.indexOf("export function ResetForm"));
    const effect = reset.slice(reset.indexOf("useEffect("), reset.indexOf("}, []);"));
    expect(effect).toContain("readRevertToken(window.location.hash)");
    expect(effect).not.toMatch(/postJson|fetch\(/);
    expect(reset).toMatch(/async function onUndo\(\) \{[\s\S]*?postJson\("\/api\/auth\/email-revert"/);
    expect(reset).toMatch(/onClick=\{onUndo\}/);
    expect(reset).toMatch(/revert === "confirm" \?/);
  });

  it("a malformed or unknown token is 400; nothing works while the constant is off; the route is rate limited", async () => {
    expect((await revert("nope")).status).toBe(400);
    expect((await revert("a".repeat(64))).status).toBe(400);
    const u = await pOwner();
    expect((await changeTo(u, addr("off"))).status).toBe(200);
    const token = revertTokenIn(u.email)!;
    flags.opaque = false;
    expect((await revert(token)).status).toBe(400);
    expect(read("src/app/api/auth/email-revert/route.ts")).toMatch(/allow\(globalKey\.emailRevertIpBucket\(clientIp\(req\)\)/);
  });
});

describe("rules 2745, 1998: with OPAQUE_IDS on, starting a change with two-step on needs its code (D2)", () => {
  it("mfa_required without a code, bad_code with a wrong one, 200 with the right one; not asked while the constant is off", async () => {
    const u = await pOwner();
    await signIn(u.email);
    const s = await (await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "start", password: "abc12345" }, ip()))).json();
    expect((await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "confirm", code: codeAt(s.secret) }, ip()))).status).toBe(200);
    const to = addr("d2");
    expect(await answer(await start(to))).toMatchObject({ status: 401, body: { error: "mfa_required" } });
    expect(await answer(await start(to, "abc12345", { mfaCode: "000000" }))).toMatchObject({ status: 400, body: { error: "bad_code" } });
    expect(mails.filter((m) => m.to === to)).toHaveLength(0);
    expect((await start(to, "abc12345", { mfaCode: codeAt(s.secret, Date.now() + 30_000) })).status).toBe(200);
    flags.opaque = false;
    expect((await start(addr("d2off"))).status).toBe(200);
  });
});

describe("rule 2746 (1996): ownerHasData refuses an owner move only while the constant is off", () => {
  it("off: owner_has_data; on: the same owner moves", async () => {
    const u = await preFlipOwner();
    await db.set(wsKey.brand(sc(u) as Scope), { name: "Work" });
    await signIn(u.email);
    flags.opaque = false;
    expect(await answer(await start(addr("data")))).toMatchObject({ status: 409, body: { error: "owner_has_data" } });
    flags.opaque = true;
    const to = addr("data2");
    expect((await start(to)).status).toBe(200);
    expect((await confirm(codeFor(to))).status).toBe(200);
  });
});

describe("rule 2747: the account-ids script after moves in place (L2)", () => {
  it("a moved legacy owner and an opaque owner are indexed, not conflicts; the script never writes login:{old}", async () => {
    const moved = await preFlipOwner();
    const old = moved.email;
    const to = addr("script");
    expect((await changeTo(moved, to)).status).toBe(200);
    await newUser("scropq", { legacy: true });
    await convertAccountIds(true);
    expect(await db.get(accountKey.login(old))).toBeNull();
    expect((await getLogin(to))!.acct).toBe(old);
    const src = read("scripts/account-ids.ts") + read("src/lib/conversions/account-ids.ts"); // rule 4100: the work moved
    expect(src).toContain("const [raw, still] = await Promise.all([db.get(accountKey.login(login)), holds()]);");
    expect(src).toContain("if (!still) return \"conflict\" as const;");
  });
});

describe("rule 2748: partners, referral rows, the wishlist and the console's sign-in flag", () => {
  it("listPartners finds an opaque partner's account through its login", async () => {
    const u = await newUser("prt", { legacy: true });
    await Promise.all([
      db.set(`partner:${u.email}`, { email: u.email, name: "P", code: "PRTNR2", approvedAt: "2026-01-01T00:00:00.000Z", approvedBy: "f@test.example" }),
      db.sadd("partners:all", u.email),
    ]);
    const row = (await listPartners()).find((p) => p.email === u.email)!;
    expect(row.hasAccount).toBe(true);
  });

  it("a referral row carries id (and email for older builds); a moved row keeps both", async () => {
    flags.opaque = false;
    const ref = await newUser("ref", { legacy: true });
    const nu = await newUser("refd", { legacy: true });
    flags.opaque = true;
    const code = await registerCode(ref.email);
    expect(await applyReferral(nu.email, code)).toBe(true);
    const rows = (await db.lrange(accountKey.referrals(ref.email), 0, -1)).map((r) => JSON.parse(r));
    expect(rows.find((r) => r.id === nu.email)).toMatchObject({ id: nu.email, email: nu.email });
    const to = addr("refmoved");
    await moveReferral(nu.email, to);
    const after = (await db.lrange(accountKey.referrals(ref.email), 0, -1)).map((r) => JSON.parse(r));
    expect(after.find((r) => r.id === to)).toMatchObject({ id: to, email: to });
    expect(after.some((r) => r.id === nu.email)).toBe(false);
  });

  it("wishlist votes are keyed by the account id; forgetting takes the id's and the address's votes", async () => {
    const [item] = [...SEED_WISH_IDS];
    const id = `a_${"b".repeat(24)}`;
    const login = addr("wish");
    await setVote(id, item, true);
    await setVote(login, item, true);
    const keys = await forgetWishlistUser(id, login);
    expect(keys).toEqual([WISH_KEYS.mine(id), WISH_KEYS.mine(login)]);
    expect(await db.sismember(WISH_KEYS.votes(item), id)).toBeFalsy();
    expect(await db.sismember(WISH_KEYS.votes(item), login)).toBeFalsy();
    expect(read("src/app/api/wishlist/vote/route.ts")).toMatch(/setVote\(acct\(u\)/);
  });

  it("L4: the console's user row says whether the stored address signs in to that account", async () => {
    vi.stubEnv("WAITLIST_ADMIN_KEY", "r2-admin-key-0123456789");
    const good = await newUser("l4ok", { legacy: true });
    const bad = await newUser("l4bad", { legacy: true });
    await saveUser({ ...(await getAccount(acct(bad)))!, email: addr("ghost") });
    expect(await accountByLogin(good.email)).toBeTruthy();
    jar().clear();
    await adminSignIn();
    const rows = ((await (await planRoute.GET(json("/api/admin/plan", "GET"))).json()) as { users: { email: string; signsIn: boolean }[] }).users;
    expect(rows.find((r) => r.email === good.email)?.signsIn).toBe(true);
    expect(rows.find((r) => r.email !== good.email && r.signsIn === false)).toBeTruthy();
    expect(read("src/components/admin/Users.tsx")).toContain('data-testid="no-sign-in"');
  });
});

describe("rule 1981 (R2 half): a record holding another address resolves at neither address", () => {
  it("after an in-place move, user:{old} holds the new address and getLogin(old) is null even with a stale index", async () => {
    const u = await preFlipOwner();
    const old = u.email;
    const to = addr("r1981");
    expect((await changeTo(u, to)).status).toBe(200);
    await db.set(accountKey.login(old), { kind: "person", pid: old });
    expect(await getLogin(old)).toBeNull();
    expect(await db.get(personKey.person(storedPersonId(old)))).toMatchObject({ email: to });
  });
});

describe("rule 1999 (R2 half): wiping a moved account", () => {
  it("wipeAccount forgets the wishlist by id and by the current address", () => {
    expect(read("src/lib/account.ts")).toMatch(/forgetWishlistUser\(e, login\)/);
  });
});
