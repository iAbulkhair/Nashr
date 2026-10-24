import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign } from "crypto";
import { readFileSync } from "fs";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { codeAt } from "./helpers/staff";
import { currentUser, getUser, saveUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { CALLBACK_PATH, GOOGLE_AUTH_URL, GOOGLE_CERTS_URL, GOOGLE_TOKEN_URL, GSI_COOKIE, linkKey, subKey, verifyIdToken } from "@/lib/google-signin";
import { MIN_ROLE, IMPERSONATION_BLOCKED } from "@/lib/roles";
import * as startRoute from "@/app/api/auth/google/start/route";
import * as callbackRoute from "@/app/api/auth/google/callback/route";
import * as googleRoute from "@/app/api/account/google/route";
import * as twoFaRoute from "@/app/api/account/2fa/route";

/** Sign in with Google (rules 1946-1953, docs/system/tests/1930-account-security.md, docs/specs/2026-10-13-google-sign-in.md). */
const read = (f: string) => readFileSync(f, "utf8");
const CLIENT = "test-client.apps.googleusercontent.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...(publicKey.export({ format: "jwk" }) as Record<string, string>), kid: "k1", alg: "RS256", use: "sig" };
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

let ipN = 0;
const ipHeader = () => ({ "x-forwarded-for": `203.0.113.${(++ipN % 250) + 1}` });
const get = (path: string) => new Request(`https://nashr.test${path}`, { headers: ipHeader() });

function token(claims: Record<string, unknown>, opts: { key?: typeof privateKey; kid?: string; alg?: string } = {}): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
  const body = enc(claims);
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), opts.key ?? privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}
const now = () => Math.floor(Date.now() / 1000);
const claimsFor = (email: string, nonce: string, extra: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com", aud: CLIENT, sub: `g${randomBytes(6).toString("hex")}`, email, email_verified: true,
  name: "Google User", nonce, iat: now(), exp: now() + 3600, ...extra,
});

/** What Google's token endpoint answers next; the certs endpoint always answers with the test key. */
let idToken = "";
let tokenCalls: URLSearchParams[] = [];
beforeEach(() => {
  vi.stubEnv("GOOGLE_SIGNIN_CLIENT_ID", CLIENT);
  vi.stubEnv("GOOGLE_SIGNIN_CLIENT_SECRET", "gsi-test-secret");
  vi.stubEnv("CONNECT_SECRET", "mfa-connect-secret-one");
  tokenCalls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === GOOGLE_CERTS_URL) return new Response(JSON.stringify({ keys: [JWK] }), { status: 200 });
    if (url === GOOGLE_TOKEN_URL) {
      tokenCalls.push(new URLSearchParams(String(init?.body ?? "")));
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    }
    return new Response("not mocked", { status: 500 });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); signOut(); });

/** Start a flow; returns Google's address split into its parameters (the cookie is now in the jar). */
async function begin(query: string) {
  const r = await startRoute.GET(get(`/api/auth/google/start?${query}`));
  expect(r.status).toBe(303);
  const to = new URL(r.headers.get("location")!);
  return { to, q: to.searchParams };
}
/** Start linking from settings (rule 2302): the password in a JSON body, Google's address in the answer. */
async function beginLink(password = "abc12345", lang?: string) {
  const r = await googleRoute.POST(json("/api/account/google", "POST", { action: "link", password, ...(lang ? { lang } : {}) }, ipHeader()));
  expect(r.status).toBe(200);
  const to = new URL((await r.json()).url);
  return { to, q: to.searchParams };
}
/** The whole round trip: start, Google answers with an ID token for `email`, the callback runs. */
async function roundTrip(query: string, email: string, extra: Record<string, unknown> = {}) {
  const { q } = await begin(query);
  const claims = claimsFor(email, q.get("nonce")!, extra);
  idToken = token(claims);
  const r = await callbackRoute.GET(get(`${CALLBACK_PATH}?code=auth-code&state=${q.get("state")}`));
  return { r, loc: r.headers.get("location") ?? "", claims, q };
}

describe("rule 1946: off until both variable names are set; the buttons and routes do not exist while off", () => {
  it("every route answers 404 and no page draws a button", async () => {
    vi.stubEnv("GOOGLE_SIGNIN_CLIENT_SECRET", "");
    expect((await startRoute.GET(get("/api/auth/google/start?mode=login"))).status).toBe(404);
    expect((await callbackRoute.GET(get(`${CALLBACK_PATH}?code=x&state=y`))).status).toBe(404);
    const u = await newUser("gsi");
    await signIn(u.email);
    expect(await (await googleRoute.GET()).json()).toMatchObject({ ok: true, on: false, linked: false });
    for (const p of ["src/app/[lang]/app/login/page.tsx", "src/app/[lang]/app/signup/page.tsx"]) expect(read(p)).toContain("google={googleSignInOn()}");
    expect(read("src/components/app/AuthForm.tsx")).toMatch(/\{google && <div[^>]*><GoogleButton/);
    expect(read("src/components/app/settings/GoogleLink.tsx")).toMatch(/if \(!st\?\.on\) return null/);
  });

  it("the variable names are documented, never the values", () => {
    const v = read("docs/system/variables.md");
    expect(v).toContain("GOOGLE_SIGNIN_CLIENT_ID");
    expect(v).toContain("GOOGLE_SIGNIN_CLIENT_SECRET");
  });
});

describe("rule 1947: code flow with PKCE S256, a state bound to this browser, a nonce, and fixed addresses", () => {
  it("the consent address carries a fixed redirect, the openid scopes and an S256 challenge; the verifier goes to the token call", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    const { to, q } = await begin("mode=login&lang=en&next=https://evil.example/x&redirect_uri=https://evil.example");
    expect(`${to.origin}${to.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(q.get("redirect_uri")).toBe(`https://thakeen.com${CALLBACK_PATH}`);
    expect(q.get("scope")).toBe("openid email profile");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("client_id")).toBe(CLIENT);
    expect(jar().get(GSI_COOKIE)).toBe(q.get("state"));
    const u = await newUser("gsi");
    idToken = token(claimsFor(u.email, q.get("nonce")!));
    await callbackRoute.GET(get(`${CALLBACK_PATH}?code=auth-code&state=${q.get("state")}`));
    const sent = tokenCalls[0];
    expect(sent.get("redirect_uri")).toBe(`https://thakeen.com${CALLBACK_PATH}`);
    expect(createHash("sha256").update(sent.get("code_verifier")!).digest("base64url")).toBe(q.get("code_challenge"));
    // `next` off this site was dropped: the sign-in lands in the app.
    expect((await currentUser())?.email).toBe(u.email);
  });

  it("a state without this browser's cookie or with a different one opens nothing, and does not burn the real flow", async () => {
    const u = await newUser("gsi");
    const { q } = await begin("mode=login");
    idToken = token(claimsFor(u.email, q.get("nonce")!));
    const state = q.get("state")!;
    jar().delete(GSI_COOKIE);
    expect((await callbackRoute.GET(get(`${CALLBACK_PATH}?code=c&state=${state}`))).headers.get("location")).toContain("google=google_failed");
    jar().set(GSI_COOKIE, "x".repeat(43));
    expect((await callbackRoute.GET(get(`${CALLBACK_PATH}?code=c&state=${state}`))).headers.get("location")).toContain("google=google_failed");
    expect(tokenCalls).toHaveLength(0);
    expect(await currentUser()).toBeNull();
    // The browser that started it still finishes it: a forged callback can not use up somebody else's state.
    jar().set(GSI_COOKIE, state);
    expect((await callbackRoute.GET(get(`${CALLBACK_PATH}?code=c&state=${state}`))).headers.get("location")).toMatch(/\/ar\/app$/);
  });

  it("a fresh state is used once: replaying the callback opens nothing", async () => {
    const u = await newUser("gsi");
    const { r, q } = await roundTrip("mode=login", u.email);
    expect(r.headers.get("location")).toMatch(/\/ar\/app$/);
    signOut();
    jar().set(GSI_COOKIE, q.get("state")!);
    const again = await callbackRoute.GET(get(`${CALLBACK_PATH}?code=auth-code&state=${q.get("state")}`));
    expect(again.headers.get("location")).toContain("google=google_failed");
    expect(await currentUser()).toBeNull();
  });
});

describe("rule 1948: the ID token is verified: signature, issuer, audience, expiry, nonce, verified address", () => {
  const ok = (c: Record<string, unknown>, o?: Parameters<typeof token>[1]) => verifyIdToken(token(c, o), { clientId: CLIENT, nonce: "n1" }, [JWK]);
  it("accepts a good token and refuses each bad claim", async () => {
    const good = claimsFor("a@test.example", "n1");
    expect(await ok(good)).toMatchObject({ email: "a@test.example", sub: good.sub });
    expect(await ok({ ...good, aud: "someone-else" })).toBeNull();
    expect(await ok({ ...good, iss: "https://evil.example" })).toBeNull();
    expect(await ok({ ...good, exp: now() - 3600 })).toBeNull();
    expect(await ok({ ...good, nonce: "n2" })).toBeNull();
    expect(await ok({ ...good, email_verified: false })).toBeNull();
    expect(await ok({ ...good, sub: "../x" })).toBeNull();
    expect(await ok(good, { key: other.privateKey })).toBeNull();
    expect(await ok(good, { kid: "nope" })).toBeNull();
    expect(await ok(good, { alg: "none" })).toBeNull();
    expect(await verifyIdToken("not.a.jwt", { clientId: CLIENT, nonce: "n1" }, [JWK])).toBeNull();
  });

  it("a token signed by another key fails the whole callback", async () => {
    const u = await newUser("gsi");
    const { q } = await begin("mode=login");
    idToken = token(claimsFor(u.email, q.get("nonce")!), { key: other.privateKey });
    const r = await callbackRoute.GET(get(`${CALLBACK_PATH}?code=c&state=${q.get("state")}`));
    expect(r.headers.get("location")).toContain("google=google_failed");
    expect(await currentUser()).toBeNull();
  });
});

describe("rule 1949: a link is made only to an owner whose address is proved; never to an unproved owner or a member by address", () => {
  it("a proved owner signs in and is linked both ways", async () => {
    const u = await newUser("gsi");
    const { loc, claims } = await roundTrip("mode=login", u.email);
    expect(loc).toMatch(/\/ar\/app$/);
    expect(await db.get(linkKey(String(claims.sub)))).toBe(u.email);
    expect(await db.get(subKey(u.email))).toBe(claims.sub);
  });

  it("an unproved owner and a member are refused and nothing is linked", async () => {
    const raw = await newUser("gsi", { verified: false });
    const a = await roundTrip("mode=login", raw.email);
    expect(a.loc).toContain("google=google_unverified_owner");
    expect(await db.get(subKey(raw.email))).toBeNull();
    const owner = await newUser("gsi");
    const m = await newMember(owner);
    const b = await roundTrip("mode=login", m.email);
    expect(b.loc).toContain("google=google_not_linked");
    expect(await currentUser()).toBeNull();
  });

  it("an owner already linked to another Google account is not re-linked", async () => {
    const u = await newUser("gsi");
    await db.set(subKey(u.email), "gOtherSub");
    const { loc } = await roundTrip("mode=login", u.email);
    expect(loc).toContain("google=google_taken");
  });

  it("the link and the account creation run under the login lock", () => {
    expect(read("src/lib/google-signin.ts")).toMatch(/return withLoginLock\(id\.email, async/);
  });
});

describe("rule 1950: signup creates an owner whose address is already proved; login with no account creates nothing", () => {
  it("login mode with an unknown address is refused", async () => {
    const email = `gnew-${randomBytes(4).toString("hex")}@test.example`;
    const { loc } = await roundTrip("mode=login", email);
    expect(loc).toContain("/ar/app/login?google=google_no_account");
    expect(await getUser(email)).toBeNull();
  });

  it("signup mode creates the owner, proved, linked and signed in", async () => {
    const email = `gnew-${randomBytes(4).toString("hex")}@test.example`;
    const { loc, claims } = await roundTrip("mode=signup&lang=en", email);
    expect(loc).toMatch(/\/en\/app\/b\/default\/start$/);
    const u = (await getUser(email))!;
    expect(u.emailVerifiedAt).toBeTruthy();
    expect(await db.get(linkKey(String(claims.sub)))).toBe(email);
    expect((await currentUser())?.email).toBe(email);
  });

  it("a linked account opens its login even after the Google address changed", async () => {
    const u = await newUser("gsi");
    const sub = `g${randomBytes(6).toString("hex")}`;
    await Promise.all([db.set(linkKey(sub), u.email), db.set(subKey(u.email), sub)]);
    const { loc } = await roundTrip("mode=login", `renamed-${randomBytes(3).toString("hex")}@test.example`, { sub });
    expect(loc).toMatch(/\/ar\/app$/);
    expect((await currentUser())?.email).toBe(u.email);
  });
});

describe("rule 1951: Google goes through the same refusals and two-step challenge as a password sign-in", () => {
  it("a login with two-step sign-in on gets the code step, not a session", async () => {
    const u = await newUser("gsi");
    await signIn(u.email);
    const ip = ipHeader();
    const s = await (await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "start", password: "abc12345" }, ip))).json();
    await twoFaRoute.POST(json("/api/account/2fa", "POST", { action: "confirm", code: codeAt(s.secret) }, ip));
    signOut();
    const { loc } = await roundTrip("mode=login&next=/ar/app/tasks", u.email);
    expect(loc).toContain("/ar/app/login?mfa=1&next=%2Far%2Fapp%2Ftasks");
    expect(await currentUser()).toBeNull();
    expect(read("src/app/api/auth/google/callback/route.ts")).toContain('finishLogin(res.login, { via: "google", next: st.next })');
  });

  it("a suspended owner is refused", async () => {
    const u = await newUser("gsi");
    await saveUser({ ...(await getUser(u.email))!, suspended: true });
    const { loc } = await roundTrip("mode=login", u.email);
    expect(loc).toContain("google=suspended");
    expect(await currentUser()).toBeNull();
  });

  it("the callback shares the login route's per-address limit and the signup limit", () => {
    const src = read("src/app/api/auth/google/callback/route.ts");
    expect(src).toContain("allow(`login:ip:${clientIp(req)}`, 20, 900)");
    expect(src).toContain("allow(`signup:ip:${clientIp(req)}`, 5, 3600)");
  });
});

describe("rule 1952: linking from settings links the session's own login only", () => {
  it("a signed-in member links its own login; a callback finished in another session links nothing", async () => {
    const owner = await newUser("gsi");
    const m = await newMember(owner);
    await signIn(m.email);
    const { q: lq } = await beginLink(m.password, "en");
    const claims = claimsFor(`personal-${randomBytes(3).toString("hex")}@test.example`, lq.get("nonce")!);
    idToken = token(claims);
    const loc = (await callbackRoute.GET(get(`${CALLBACK_PATH}?code=auth-code&state=${lq.get("state")}`))).headers.get("location") ?? "";
    expect(loc).toMatch(/\/en\/app\/settings\/security\?google=linked$/);
    expect(await db.get(subKey(m.email))).toBe(claims.sub);

    const u = await newUser("gsi");
    await signIn(u.email);
    const { q } = await beginLink();
    idToken = token(claimsFor(`x-${randomBytes(3).toString("hex")}@test.example`, q.get("nonce")!));
    const state = q.get("state")!;
    await signIn(owner.email);
    jar().set(GSI_COOKIE, state);
    const r = await callbackRoute.GET(get(`${CALLBACK_PATH}?code=c&state=${state}`));
    expect(r.headers.get("location")).toContain("google=google_failed");
    expect(await db.get(subKey(owner.email))).toBeNull();
    expect(await db.get(subKey(u.email))).toBeNull();
  });

  it("starting a link needs a session and is refused while a founder impersonates", async () => {
    const link = () => googleRoute.POST(json("/api/account/google", "POST", { action: "link", password: "abc12345" }, ipHeader()));
    expect((await link()).status).toBe(401);
    vi.stubEnv("ADMIN_EMAILS", "founder-gsi@test.example");
    const u = await newUser("gsi");
    await signIn(u.email, { imp: "founder-gsi@test.example" });
    expect((await link()).status).toBe(403);
    expect(MIN_ROLE["google.manage"]).toBe("viewer");
    expect(IMPERSONATION_BLOCKED.has("google.manage")).toBe(true);
  });
});

describe("rule 1953: unlinking needs the password and drops the link both ways", () => {
  it("wrong password 401, right password unlinks", async () => {
    const u = await newUser("gsi");
    const { claims } = await roundTrip("mode=login", u.email);
    const post = (password: string) => googleRoute.POST(json("/api/account/google", "POST", { action: "unlink", password }, ipHeader()));
    expect((await post("wrong-pass")).status).toBe(401);
    expect(await (await googleRoute.GET()).json()).toMatchObject({ on: true, linked: true });
    expect((await post("abc12345")).status).toBe(200);
    expect(await db.get(subKey(u.email))).toBeNull();
    expect(await db.get(linkKey(String(claims.sub)))).toBeNull();
  });
});
