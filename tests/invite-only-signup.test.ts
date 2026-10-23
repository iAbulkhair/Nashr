import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import * as signupRoute from "@/app/api/auth/signup/route";
import * as acceptRoute from "@/app/api/team/accept/route";
import { acct, currentUser, getLogin, getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, globalKey } from "@/lib/keys";
import { resolveGoogle } from "@/lib/google-signin";
import { signupMode } from "@/lib/signup-mode";
import { cancelInvite, createInvite, getMember, inviteTokenFor, verifiedAddressInvited } from "@/lib/team";
import { json, newMember, newUser, signIn, signOut } from "./helpers/session";

/**
 * Invite-only sign-up (rules 3520-3529, docs/system/tests/3520-invite-only-signup.md), `MULTI_ORG` as shipped (off).
 * Every path in both modes: password sign-up, Google sign-up and sign-in, and invite acceptance.
 */

const read = (f: string) => readFileSync(f, "utf8");
const freshEmail = (p = "ios") => `${p}-${randomBytes(4).toString("hex")}@test.example`;
let ipN = 0;
const freshIp = () => { ipN++; return `198.51.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}`; };
const signup = (body: Record<string, unknown>, ip = freshIp()) =>
  signupRoute.POST(json("/api/auth/signup", "POST", { password: "Passw0rd!x", name: "New", lang: "en", ...body }, { "x-forwarded-for": ip }));
const accept = (body: Record<string, unknown>) => acceptRoute.POST(json("/api/team/accept", "POST", body, { "x-forwarded-for": freshIp() }));
const google = (email: string, mode: "login" | "signup" = "signup") => resolveGoogle({ sub: `g${randomBytes(6).toString("hex")}`, email, name: "G" }, mode, "en");
const pro = async (u: User) => { const x = { ...(await getUser(acct(u)))!, plan: "pro" as const, seats: 10 }; await saveUser(x); return x; };
async function ownerSession(prefix: string) {
  const u = await pro(await newUser(prefix, { shadow: false }));
  await signIn(u.email);
  const me = (await currentUser())!;
  signOut();
  return { u, me, actor: me.actor! };
}
const invite = async (o: Awaited<ReturnType<typeof ownerSession>>, email: string) => {
  const r = await createInvite(o.me, o.actor, email, "member", "ar");
  if (!r.ok) throw new Error(`invite: ${r.error}`);
  return r;
};
const invite_mode = () => vi.stubEnv("SIGNUP_MODE", "invite");

afterEach(() => { vi.unstubAllEnvs(); signOut(); });

describe("rule 3520: the switch is SIGNUP_MODE, default open", () => {
  it("only the exact word invite closes sign-up; unset, empty, open and typos stay open", () => {
    vi.stubEnv("SIGNUP_MODE", "");
    expect(signupMode()).toBe("open");
    for (const v of ["open", "invited", "INVITE-ONLY", "closed", "1"]) { vi.stubEnv("SIGNUP_MODE", v); expect(signupMode(), v).toBe("open"); }
    for (const v of ["invite", " Invite ", "INVITE"]) { vi.stubEnv("SIGNUP_MODE", v); expect(signupMode(), v).toBe("invite"); }
  });

  it("is a server-only variable named in variables.md and .env.example, never public", () => {
    expect(read("docs/system/variables.md")).toMatch(/^\| `SIGNUP_MODE` \|/m);
    expect(read(".env.example")).toMatch(/^SIGNUP_MODE=$/m);
    expect(read("src/lib/signup-mode.ts")).toMatch(/process\.env\.SIGNUP_MODE/);
    expect(read("src/lib/signup-mode.ts")).not.toMatch(/process\.env\.NEXT_PUBLIC/);
  });
});

describe("rule 3521: password sign-up", () => {
  it("open: a new address signs up as today, an existing one gets 409 exists", async () => {
    const e = freshEmail();
    const r = await signup({ email: e });
    expect(r.status).toBe(200);
    expect(await getLogin(e)).not.toBeNull();
    const u = await newUser("iso");
    expect((await signup({ email: u.email })).status).toBe(409);
  });

  it("invite: a new address without the invite token is 403 invite_only and nothing is written", async () => {
    invite_mode();
    const e = freshEmail();
    const r = await signup({ email: e });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, error: "invite_only" });
    expect(await getLogin(e)).toBeNull();
  });

  it("invite: the invite link's token for this exact address lets it sign up; another address or a cancelled invite does not", async () => {
    invite_mode();
    const A = await ownerSession("isa");
    const e = freshEmail();
    const inv = await invite(A, e);
    expect(await inviteTokenFor(inv.token, e)).toBe(true);
    expect(await inviteTokenFor(inv.token, e.toUpperCase())).toBe(true);
    // The token names one address: another one, a malformed token or a missing one is refused.
    const other = freshEmail();
    expect((await signup({ email: other, invite: inv.token })).status).toBe(403);
    expect(await inviteTokenFor("x".repeat(64), e)).toBe(false);
    expect(await inviteTokenFor(undefined, e)).toBe(false);
    // A cancelled invite no longer stands.
    const e2 = freshEmail();
    const inv2 = await invite(A, e2);
    expect((await cancelInvite(A.me, A.actor, inv2.id)).ok).toBe(true);
    expect((await signup({ email: e2, invite: inv2.token })).status).toBe(403);
    // The standing one.
    const r = await signup({ email: e, invite: inv.token });
    expect(r.status).toBe(200);
    expect(await getLogin(e)).not.toBeNull();
  });

  it("invite: an expired invite no longer stands", async () => {
    const A = await ownerSession("ise");
    const e = freshEmail();
    const inv = await invite(A, e);
    await db.set(globalKey.invite(inv.id), { ...inv.invite, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await inviteTokenFor(inv.token, e)).toBe(false);
  });
});

describe("rule 3524: the refusal never says whether an address has a login, and the rate limit still counts", () => {
  it("an owner, a member and a new address all get the same 403 body", async () => {
    invite_mode();
    const owner = await newUser("isx");
    const member = await newMember(owner, "member", "isy");
    const bodies = await Promise.all([owner.email, member.email, freshEmail()].map(async (email) => {
      const r = await signup({ email });
      return { status: r.status, body: await r.json() };
    }));
    for (const b of bodies) expect(b).toEqual({ status: 403, body: { ok: false, error: "invite_only" } });
  });

  it("the sixth attempt in an hour from one connection is 429, as in open mode", async () => {
    invite_mode();
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await signup({ email: freshEmail() }, ip)).status).toBe(403);
    const r = await signup({ email: freshEmail() }, ip);
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("3600");
  });

  it("the gate runs after Turnstile and before any address lookup", () => {
    const s = read("src/app/api/auth/signup/route.ts");
    const gate = s.indexOf("passwordSignupAllowed(email");
    expect(gate).toBeGreaterThan(s.indexOf("captchaRefusal(req"));
    expect(gate).toBeLessThan(s.indexOf("getLogin(email)"));
    expect(gate).toBeGreaterThan(s.indexOf("allow(`signup:ip:"));
  });
});

describe("rule 3522: Google sign-up and sign-in", () => {
  it("open: a new Google address is created", async () => {
    const e = freshEmail("gso");
    const r = await google(e);
    expect(r.kind).toBe("created");
  });

  it("invite: a new Google address without a standing invite is refused google_invite_only and nothing is written", async () => {
    invite_mode();
    const e = freshEmail("gsi");
    expect(await google(e)).toEqual({ kind: "refused", error: "google_invite_only" });
    expect(await getLogin(e)).toBeNull();
    // With MULTI_ORG off the inbox is never written, so even an invited address joins only through its link.
    const A = await ownerSession("gsa");
    const e2 = freshEmail("gsj");
    await invite(A, e2);
    expect(await db.smembers(accountKey.invitesFor(e2))).toEqual([]);
    expect(await verifiedAddressInvited(e2)).toBe(false);
    expect(await google(e2)).toEqual({ kind: "refused", error: "google_invite_only" });
  });

  it("invite: an existing verified owner still signs in with Google, in both modes", async () => {
    invite_mode();
    const u = await newUser("gse");
    expect((await google(u.email, "signup")).kind).toBe("login");
    const v = await newUser("gsf");
    expect((await google(v.email, "login")).kind).toBe("login");
    // Login mode with no account is the old answer, not a new one.
    expect(await google(freshEmail("gsk"), "login")).toEqual({ kind: "refused", error: "google_no_account" });
  });

  it("the sign-up page knows the code in both languages", () => {
    const f = read("src/components/app/AuthForm.tsx");
    expect(f.match(/google_invite_only:/g)?.length).toBe(2);
  });
});

describe("rule 3525: accepting an invite stays open in both modes", () => {
  for (const mode of ["open", "invite"] as const) {
    it(`${mode}: the invitee sets a password on the join link and is a member`, async () => {
      vi.stubEnv("SIGNUP_MODE", mode);
      const A = await ownerSession(`acc${mode[0]}`);
      const e = freshEmail("acc");
      const inv = await invite(A, e);
      const r = await accept({ token: inv.token, name: "Joiner", password: "Passw0rd!x", lang: "en" });
      expect(r.status).toBe(200);
      expect(await getMember(e)).not.toBeNull();
    });
  }
});

describe("rule 3526: the closed sign-up page", () => {
  it("renders SignupClosed instead of the form while the mode is invite", () => {
    const page = read("src/app/[lang]/app/signup/page.tsx");
    expect(page).toMatch(/if \(signupMode\(\) === "invite"\) return <SignupClosed lang=\{lang\} \/>;/);
    expect(page.indexOf("SignupClosed lang")).toBeLessThan(page.indexOf("<SignupForm"));
  });

  it("says it in Arabic and English, offers the waitlist and has no password, Google or sign-up post", () => {
    const c = read("src/components/app/SignupClosed.tsx");
    expect(c).toMatch(/التسجيل الآن بدعوة فقط/);
    expect(c).toMatch(/Sign-up is by invitation only/);
    expect(c).toMatch(/postJson\("\/api\/waitlist"/);
    expect(c).not.toMatch(/password|api\/auth\/signup|GoogleButton|Turnstile/i);
  });
});

describe("rule 3523: no other path creates a login", () => {
  it("createUser is called only by the sign-up route and the Google resolver, both gated", () => {
    const hits = execSync("grep -rln 'createUser(' src --include='*.ts' --include='*.tsx'", { encoding: "utf8" }).trim().split("\n").sort();
    expect(hits).toEqual(["src/app/api/auth/signup/route.ts", "src/lib/auth.ts", "src/lib/google-signin.ts"]);
    expect(read("src/lib/google-signin.ts")).toMatch(/googleSignupAllowed\(id\.email\)[\s\S]*createUser\(/);
  });
});
