import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acct, createUser, currentUser, currentUserUnverified, emailVerified, getUser, saveUser } from "@/lib/auth";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import * as login from "@/app/api/auth/login/route";
import * as reset from "@/app/api/auth/reset/route";

afterEach(() => { vi.unstubAllEnvs(); signOut(); });

let ipN = 0;
/** Never repeats within a run, and never meets the IPs of the other verify test files. */
const freshIp = () => { ipN++; return `192.0.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}`; };
const logIn = (email: string, password = "abc12345") => login.POST(json("/api/auth/login", "POST", { email, password }, { "x-forwarded-for": freshIp() }));

/** Rules 751-752: a password-signup owner who has not proved the address reads as signed out, everywhere. */
describe("email verification gate", () => {
  it("unverified owner reads as signed out", async () => {
    const u = await newUser("g", { verified: false });
    await signIn(u.email);
    expect(await currentUser()).toBeNull();
    expect((await currentUserUnverified())!.email).toBe(u.email);
  });

  it("verified owner passes", async () => {
    const u = await newUser("g");
    await signIn(u.email);
    const me = await currentUser();
    expect(me!.email).toBe(u.email);
    expect(me!.actor!.kind).toBe("owner");
  });

  it("founder impersonation passes the gate", async () => {
    const u = await newUser("g", { verified: false });
    await signIn(u.email, { imp: "founder@test.example" });
    const me = await currentUser();
    expect(me).not.toBeNull();
    expect(me!.actor!.kind).toBe("founder");
  });

  // Rule 751 with the founder's console key (`imp: "key"`): the only way into the console before the founder verifies.
  it("founder key impersonation passes the gate", async () => {
    vi.stubEnv("WAITLIST_ADMIN_KEY", "gate-test-key-0123456789abcdef");
    const u = await newUser("g", { verified: false });
    await signIn(u.email, { imp: "key" });
    const me = await currentUser();
    expect(me).not.toBeNull();
    expect(me!.email).toBe(u.email);
    expect(me!.actor).toMatchObject({ kind: "founder", impersonating: "key" });
  });

  // Rule 767: the account spends nothing until its owner proves the address, so its members are out too, and the
  // verify page never receives them (they have no owner address to prove).
  it("member of an unverified owner reads as signed out in both resolvers", async () => {
    const owner = await newUser("g", { verified: false });
    const m = await newMember(owner);
    await signIn(m.email);
    expect(await currentUser()).toBeNull();
    expect(await currentUserUnverified()).toBeNull();
  });

  it("member of a verified owner signs in", async () => {
    const owner = await newUser("g");
    const m = await newMember(owner);
    await signIn(m.email);
    const me = await currentUser();
    expect(me).not.toBeNull();
    expect(me!.actor!.kind).toBe("member");
    expect((await currentUserUnverified())!.actor!.kind).toBe("member");
  });

  it("a member session comes back once the owner verifies", async () => {
    const owner = await newUser("g", { verified: false });
    const m = await newMember(owner);
    await signIn(m.email);
    expect(await currentUser()).toBeNull();
    const stored = (await getUser(acct(owner)))!;
    stored.emailVerifiedAt = new Date().toISOString();
    await saveUser(stored);
    expect((await currentUser())!.actor!.kind).toBe("member");
  });

  it("createUser marks gatedSignup and no emailVerifiedAt", async () => {
    const u = await createUser({ email: "gated-new@test.example", name: "T", phone: "", password: "abc12345", lang: "ar" });
    expect(u.gatedSignup).toBe(true);
    expect(u.emailVerifiedAt).toBeUndefined();
    expect(emailVerified(u)).toBe(false);
    expect(emailVerified({ emailVerifiedAt: "2026-01-01T00:00:00.000Z" })).toBe(true);
  });

  it("suspended stays null in both resolvers", async () => {
    const u = await newUser("g", { verified: false });
    const stored = (await getUser(acct(u)))!;
    stored.suspended = true;
    await saveUser(stored);
    await signIn(u.email);
    expect(await currentUser()).toBeNull();
    expect(await currentUserUnverified()).toBeNull();
  });

  // Rule 752: only the app layout, the verify page, the three verify routes and the resolver itself may call
  // `currentUserUnverified`. Anywhere else an unverified owner would read as signed in.
  it("currentUserUnverified has exactly the allowed callers", () => {
    const callers = (readdirSync("src", { recursive: true }) as string[])
      .map((f) => join("src", f))
      .filter((f) => /\.(?:ts|tsx)$/.test(f) && /currentUserUnverified\(/.test(readFileSync(f, "utf8")))
      .sort();
    expect(callers).toEqual(
      [
        "src/app/[lang]/app/layout.tsx",
        "src/app/[lang]/app/verify/page.tsx",
        "src/app/api/auth/verify/check/route.ts",
        "src/app/api/auth/verify/email/route.ts",
        "src/app/api/auth/verify/send/route.ts",
        "src/lib/auth.ts",
      ].sort(),
    );
  });
});

/** Rules 754 and 767 at login: where the form goes next, and who gets a session. */
describe("login and the verification gate", () => {
  it("an unverified owner gets a session and verify: true", async () => {
    const u = await newUser("gl", { verified: false });
    signOut();
    const res = await logIn(u.email);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, verify: true });
    expect(jar().get("thakeen_session")).toBeTruthy();
    expect(await currentUser()).toBeNull();
    expect((await currentUserUnverified())!.email).toBe(u.email);
  });

  it("a verified owner gets verify: false", async () => {
    const u = await newUser("gl");
    signOut();
    const res = await logIn(u.email);
    expect(await res.json()).toEqual({ ok: true, verify: false });
    expect((await currentUser())!.email).toBe(u.email);
  });

  it("a member of an unverified owner is refused with owner_unverified and no session", async () => {
    const owner = await newUser("gl", { verified: false });
    const m = await newMember(owner);
    signOut();
    const res = await logIn(m.email, m.password);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "owner_unverified" });
    expect(jar().get("thakeen_session")).toBeUndefined();
  });

  it("a member of a verified owner signs in as before", async () => {
    const owner = await newUser("gl");
    const m = await newMember(owner);
    signOut();
    const res = await logIn(m.email, m.password);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await currentUser())!.actor!.kind).toBe("member");
  });

  // The form side of rule 754: `verify: true` goes to the code page with the destination (safeNext'd) riding in `next`,
  // checked before the plain `next` jump, so a `next` outside /[lang]/app (the OAuth consent page) cannot loop to login.
  it("LoginForm sends verify: true to the verify page with the destination", () => {
    const src = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    const form = src.slice(src.indexOf("export function LoginForm"), src.indexOf("const PW ="));
    const verify = form.indexOf("p.body.verify === true");
    expect(verify).toBeGreaterThan(-1);
    expect(form).toContain("if (p.body.verify === true) { r.push(`/${lang}/app/verify?next=${encodeURIComponent(next || appHref(lang))}`); return; }");
    expect(form).toMatch(/const next = safeNext\(nextParam\)/);
    expect(verify).toBeLessThan(form.indexOf("if (next) { window.location.href = next"));
  });

  it("the form has a message for owner_unverified in both languages", async () => {
    const { authMessage } = await import("@/lib/auth-client");
    expect(authMessage("owner_unverified", "ar")).toBe("صاحب الحساب لم يؤكد بريده بعد.");
    expect(authMessage("owner_unverified", "en")).toBe("The account owner has not confirmed their email yet.");
  });

  // The consent page's `next` survives the trip: safeNext keeps a same-site /oauth path, so the verify page returns there.
  it("safeNext keeps the OAuth consent path", async () => {
    const { safeNext } = await import("@/lib/safe-next");
    const self = "/oauth/authorize?client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&response_type=code&code_challenge=x";
    expect(safeNext(self)).toBe(self);
    expect(safeNext(decodeURIComponent(encodeURIComponent(self)))).toBe(self);
  });
});

/** Rule 769: a password reset link, mailed to the owner's address and used once, proves that inbox. */
describe("password reset and the verification gate", () => {
  /** What /api/auth/forgot writes, then the reset POST with that link. */
  async function resetWith(email: string, kind: "owner" | "member") {
    const token = randomBytes(32).toString("hex");
    await db.set(`pwreset:${createHash("sha256").update(token).digest("hex")}`, { email, kind }, 3600);
    return reset.POST(json("/api/auth/reset", "POST", { token, password: "newpass123" }, { "x-forwarded-for": freshIp() }));
  }

  it("an unverified owner's reset stamps emailVerifiedAt and signs in through the gate", async () => {
    const u = await newUser("gr", { verified: false });
    signOut();
    const res = await resetWith(u.email, "owner");
    expect(res.status).toBe(200);
    expect(emailVerified((await getUser(acct(u)))!)).toBe(true);
    expect((await currentUser())!.email).toBe(u.email);
  });

  it("a verified owner's reset keeps the first date", async () => {
    const u = await newUser("gr");
    const stored = (await getUser(acct(u)))!;
    stored.emailVerifiedAt = "2026-01-02T03:04:05.000Z";
    await saveUser(stored);
    expect((await resetWith(u.email, "owner")).status).toBe(200);
    expect((await getUser(acct(u)))!.emailVerifiedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("a member's reset does not verify the owner", async () => {
    const owner = await newUser("gr", { verified: false });
    const m = await newMember(owner);
    signOut();
    const res = await resetWith(m.email, "member");
    // The member's password is saved, but no session while the owner is unverified (rule 767), as login answers.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "owner_unverified" });
    expect((await getUser(acct(owner)))!.emailVerifiedAt).toBeUndefined();
    expect(jar().get("thakeen_session")).toBeUndefined();
  });
});
