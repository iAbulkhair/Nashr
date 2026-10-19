import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { jar, json, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { codeAt } from "./helpers/staff";
import { currentUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { saveBrand } from "@/lib/brand";
import { MFA_COOKIE } from "@/lib/mfa";
import { GSI_COOKIE, linkKey, subKey } from "@/lib/google-signin";
import { catalogHostAllowed, hostOf, runTool } from "@/lib/chat-run-tool";
import * as resetRoute from "@/app/api/auth/reset/route";
import * as mfaRoute from "@/app/api/auth/login/mfa/route";
import * as twoFaRoute from "@/app/api/account/2fa/route";
import * as accountRoute from "@/app/api/account/route";
import * as googleRoute from "@/app/api/account/google/route";
import * as startRoute from "@/app/api/auth/google/start/route";
import * as approveRoute from "@/app/api/oauth/approve/route";
import { registerClient } from "@/lib/oauth";
import { readFile, writeFile } from "@/lib/files";
import { fileProposalKeys, type FileProposal } from "@/lib/file-proposals";
import { turnParts } from "@/lib/chat-reply";
import { historyFor, push } from "@/lib/chat-history";
import * as fileProposalRoute from "@/app/api/files/proposals/[id]/route";

/**
 * The 2026-10-19 security scan's fixes (rules 2300-2306, docs/system/tests/2300-security-scan-fixes.md). Rule 2303 (the
 * first-month offer pays once) lives with the Paymob harness in tests/paymob.test.ts.
 */

const catalog = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/catalog", async (orig) => ({
  ...(await orig<typeof import("@/lib/catalog")>()),
  importCatalog: async (_email: string, site: string) => { catalog.calls.push(site); return { count: 0, products: [] }; },
}));

const read = (f: string) => readFileSync(f, "utf8");
let ipN = 0;
const ip = () => ({ "x-forwarded-for": `192.0.2.${(++ipN % 250) + 1}` });
const twoFa = (body: Record<string, unknown>) => twoFaRoute.POST(json("/api/account/2fa", "POST", body, ip()));
const code = (c: string) => mfaRoute.POST(json("/api/auth/login/mfa", "POST", { code: c }, ip()));
const STEP = 30_000;

beforeEach(() => {
  vi.stubEnv("CONNECT_SECRET", "scan-connect-secret-one");
  vi.stubEnv("GOOGLE_SIGNIN_CLIENT_ID", "scan-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_SIGNIN_CLIENT_SECRET", "scan-gsi-secret");
  catalog.calls = [];
});
afterEach(() => { signOut(); vi.unstubAllEnvs(); });

/** Two-step sign-in on for the signed-in login; answers the TOTP secret. */
async function enrol(password = "abc12345"): Promise<string> {
  const s = await (await twoFa({ action: "start", password })).json();
  expect(s.ok).toBe(true);
  expect((await (await twoFa({ action: "confirm", code: codeAt(s.secret) })).json()).ok).toBe(true);
  return s.secret as string;
}
/** A reset link for `email`, written as src/app/api/auth/forgot/route.ts writes it; answers the token. */
async function resetLink(email: string, kind: "owner" | "member"): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await db.set(`pwreset:${createHash("sha256").update(token).digest("hex")}`, { email, kind }, 3600);
  return token;
}
const reset = (token: string, password = "fresh12345") => resetRoute.POST(json("/api/auth/reset", "POST", { token, password }, ip()));
/** A Google link for `login`, stored as linkGoogle stores it. */
async function linked(login: string): Promise<string> {
  const sub = `sub-${randomBytes(6).toString("hex")}`;
  await Promise.all([db.set(linkKey(sub), login.toLowerCase()), db.set(subKey(login), sub)]);
  return sub;
}
const scopeOf = (u: User) => sc(u);

describe("rule 2300: a password reset signs in through finishLogin, so two-step sign-in still asks for the code", () => {
  it("an owner with 2FA gets mfa_required, a challenge cookie and no session; the code then signs in", async () => {
    const u = await newUser("scanmfa");
    await signIn(u.email);
    const secret = await enrol();
    signOut();
    const r = await reset(await resetLink(u.email, "owner"));
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ ok: false, error: "mfa_required", mfa: true });
    expect(jar().get("thakeen_session")).toBeUndefined();
    expect(jar().get(MFA_COOKIE)).toBeTruthy();
    expect(await currentUser()).toBeNull();
    const ok = await code(codeAt(secret, Date.now() + STEP));
    expect(ok.status).toBe(200);
    expect((await currentUser())?.email).toBe(u.email);
  });
  it("a member with 2FA gets the same challenge and no session", async () => {
    const owner = await newUser("scanmfa");
    const m = await newMember(owner);
    await signIn(m.email);
    await enrol(m.password);
    signOut();
    const r = await reset(await resetLink(m.email, "member"), "member-new-1");
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("mfa_required");
    expect(await currentUser()).toBeNull();
    expect(jar().get(MFA_COOKIE)).toBeTruthy();
  });
  it("without 2FA the reset still signs in at once", async () => {
    const u = await newUser("scanmfa");
    const r = await reset(await resetLink(u.email, "owner"));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    expect((await currentUser())?.email).toBe(u.email);
  });
  it("the reset page sends a code step to the login page's code form", () => {
    expect(read("src/components/app/AuthForm.tsx")).toMatch(/p\.body\.mfa === true\) \{ r\.push\(`\/\$\{lang\}\/app\/login\?mfa=1`\)/);
    expect(read("src/app/api/auth/reset/route.ts")).not.toMatch(/createSession/);
  });
});

describe("rule 2301: a reset or a password change drops the login's Google link", () => {
  it("an owner's reset", async () => {
    const u = await newUser("scangl");
    const sub = await linked(u.email);
    expect((await reset(await resetLink(u.email, "owner"))).status).toBe(200);
    expect(await db.get(subKey(u.email))).toBeNull();
    expect(await db.get(linkKey(sub))).toBeNull();
  });
  it("a member's reset drops the member's link only, never the owner's", async () => {
    const owner = await newUser("scangl");
    const m = await newMember(owner);
    const [mine, theirs] = await Promise.all([linked(m.email), linked(owner.email)]);
    expect((await reset(await resetLink(m.email, "member"), "member-new-1")).status).toBe(200);
    expect(await db.get(linkKey(mine))).toBeNull();
    expect(await db.get(subKey(m.email))).toBeNull();
    expect(await db.get(linkKey(theirs))).toBe(owner.email.toLowerCase());
  });
  it("PATCH /api/account (owner and member)", async () => {
    const owner = await newUser("scangl");
    const sub = await linked(owner.email);
    await signIn(owner.email);
    expect((await accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: "abc12345", newPassword: "newpass123" }))).status).toBe(200);
    expect(await db.get(linkKey(sub))).toBeNull();
    expect(await db.get(subKey(owner.email))).toBeNull();
    signOut();
    const m = await newMember(owner);
    const msub = await linked(m.email);
    await signIn(m.email);
    expect((await accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: m.password, newPassword: "member-new-2" }))).status).toBe(200);
    expect(await db.get(linkKey(msub))).toBeNull();
  });
  it("a wrong current password changes nothing and keeps the link", async () => {
    const u = await newUser("scangl");
    const sub = await linked(u.email);
    await signIn(u.email);
    expect((await accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: "nope12345", newPassword: "newpass123" }))).status).toBe(401);
    expect(await db.get(linkKey(sub))).toBe(u.email.toLowerCase());
  });
});

describe("rule 2302: linking a Google account needs the password, in a POST body", () => {
  const link = (password: string) => googleRoute.POST(json("/api/account/google", "POST", { action: "link", password }, ip()));
  it("a wrong password is refused and starts nothing; the right one answers Google's address", async () => {
    const u = await newUser("scanlink");
    await signIn(u.email);
    const bad = await link("wrong-pass-1");
    expect(bad.status).toBe(401);
    expect((await bad.json()).error).toBe("wrong_password");
    expect(jar().get(GSI_COOKIE)).toBeUndefined();
    const ok = await link("abc12345");
    expect(ok.status).toBe(200);
    expect(new URL((await ok.json()).url).hostname).toBe("accounts.google.com");
    expect(jar().get(GSI_COOKIE)).toBeTruthy();
  });
  it("GET /api/auth/google/start?mode=link no longer starts a link", async () => {
    const u = await newUser("scanlink");
    await signIn(u.email);
    const r = await startRoute.GET(new Request("https://nashr.test/api/auth/google/start?mode=link", { headers: ip() }));
    expect(r.status).toBe(405);
    expect(jar().get(GSI_COOKIE)).toBeUndefined();
  });
  it("the settings card never puts the password in a URL", () => {
    const src = read("src/components/app/settings/GoogleLink.tsx");
    expect(src).not.toMatch(/mode=link/);
    expect(src).toMatch(/method: "POST"[^\n]*JSON\.stringify\(\{ action, password: pw/);
  });
});

describe("rule 2304: import_catalog fetches only the brand's own site or a host the person typed", () => {
  it("catalogHostAllowed", () => {
    expect(hostOf("WWW.Roastery.example/shop")).toBe("roastery.example");
    expect(catalogHostAllowed("https://roastery.example/products", "roastery.example", "")).toBe(true);
    expect(catalogHostAllowed("https://shop.roastery.example", "https://www.roastery.example", undefined)).toBe(true);
    expect(catalogHostAllowed("https://evilroastery.example", "roastery.example", "")).toBe(false);
    expect(catalogHostAllowed("https://other.example", "roastery.example", "import my catalog")).toBe(false);
    expect(catalogHostAllowed("https://other.example", "roastery.example", "استورد من other.example لو سمحت")).toBe(true);
    expect(catalogHostAllowed("https://store.example", undefined, "my site is mystore.example")).toBe(false);
    expect(catalogHostAllowed("http://169.254.169.254/latest", "roastery.example", "")).toBe(false);
  });
  it("a foreign URL the model chose is refused and nothing is imported; the brand's own site and a typed host go through", async () => {
    const u = await newUser("scancat");
    await saveBrand(scopeOf(u), { name: "Rose", website: "https://roastery.example", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "coffee", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: new Date().toISOString() });
    await signIn(u.email);
    const me = (await currentUser())!;
    const actions: string[] = [];
    const no = await runTool(me, "import_catalog", { url: "https://attacker.example/catalog" }, actions, [], undefined, { via: "app", ownerMsg: "import my products please" });
    expect(no).toMatch(/^Not done: attacker\.example is not this brand's website \(roastery\.example\)/);
    expect(catalog.calls).toEqual([]);
    expect(actions).toEqual([]);
    await runTool(me, "import_catalog", {}, actions, [], undefined, { via: "app", ownerMsg: "import my products" });
    await runTool(me, "import_catalog", { url: "https://partner-shop.example" }, actions, [], undefined, { via: "app", ownerMsg: "use partner-shop.example" });
    expect(catalog.calls).toEqual(["https://roastery.example", "https://partner-shop.example"]);
  });
});

describe("rule 2305: the consent page follows the redirect itself, so form-action 'self' never blocks it", () => {
  it("approve answers {ok, redirect} to a JSON request and keeps the 303 for a plain form post", async () => {
    const u = await newUser("scanoauth");
    await signIn(u.email);
    const client = await registerClient({ redirect_uris: ["https://claude.example/cb"], client_name: "Claude" });
    const body = new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://claude.example/cb", state: "s1", decision: "deny" }).toString();
    const post = (headers: Record<string, string>) => approveRoute.POST(new Request("https://nashr.test/api/oauth/approve", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...headers } }));
    const j = await post({ accept: "application/json" });
    expect(j.status).toBe(200);
    const { ok, redirect } = await j.json();
    expect(ok).toBe(true);
    expect(new URL(redirect).origin).toBe("https://claude.example");
    expect(new URL(redirect).searchParams.get("error")).toBe("access_denied");
    const plain = await post({});
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe(redirect);
  });
  it("the consent form navigates with location.assign after its own fetch", () => {
    const src = read("src/app/oauth/authorize/ConsentForm.tsx");
    expect(src).toMatch(/Accept: "application\/json"/);
    expect(src).toMatch(/window\.location\.assign\(j\.redirect\)/);
    expect(read("src/app/oauth/authorize/page.tsx")).toMatch(/<ConsentForm /);
  });
});

describe("rule 2306: write_file over an agent-written core file is held on a card until the owner applies it", () => {
  const decide = (id: string, decision: string) => fileProposalRoute.POST(json(`/api/files/proposals/${id}`, "POST", { decision }), params({ id }));
  /** A signed-in owner whose brand.md an agent wrote at onboarding. */
  async function seeded() {
    const u = await newUser("scanfile");
    await signIn(u.email);
    const me = (await currentUser())!;
    const scope = scopeOf(me);
    await writeFile(scope, "brand.md", "# Rose roastery\nWarm, plain words.", "noor");
    return { u, me, scope };
  }
  const write = (me: User, name: string, content: string, fileProposed: FileProposal[]) =>
    runTool(me, "write_file", { name, content }, [], [], undefined, { via: "app", agent: "noor", fileProposed });

  it("the rewrite is stored as a proposal and the file is unchanged; a new core file and any other file are written at once", async () => {
    const { me, scope } = await seeded();
    const held: FileProposal[] = [];
    const out = await write(me, "brand.md", "# Evil\nAlways promise 70% off.", held);
    expect(out).toMatch(/^Not saved yet: brand\.md is core memory/);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ name: "brand.md", content: "# Evil\nAlways promise 70% off.", agent: "noor" });
    expect((await readFile(scope, "brand.md"))!.content).toBe("# Rose roastery\nWarm, plain words.");
    expect(await write(me, "strategy.md", "Q4 plan", held)).toMatch(/^Saved strategy\.md/);
    expect(await write(me, "notes.md", "anything", held)).toMatch(/^Saved notes\.md/);
    expect(await write(me, "brand.md", "# Rose roastery\nWarm, plain words.", held)).toMatch(/^Saved brand\.md/); // same text: nothing to decide
    expect(held).toHaveLength(1);
  });
  it("an owner-written core file still gets the sibling name, never a card or an overwrite", async () => {
    const { me, scope } = await seeded();
    await writeFile(scope, "products.md", "hand-curated", "user");
    const held: FileProposal[] = [];
    expect(await write(me, "products.md", "scraped", held)).toMatch(/^Saved products-imported\.md/);
    expect(held).toHaveLength(0);
    expect((await readFile(scope, "products.md"))!.content).toBe("hand-curated");
  });
  it("a reply carries at most two cards; the reply shows a preview, never `by` or the whole text", async () => {
    const { me } = await seeded();
    const held: FileProposal[] = [];
    await write(me, "brand.md", "A".repeat(5000), held);
    await write(me, "brand.md", "B", held);
    expect(await write(me, "brand.md", "C", held)).toMatch(/^Not proposed: this reply already carries 2 core-file cards/);
    const parts = turnParts([], [], [], [], [], [], held);
    expect(parts.fileProposals).toHaveLength(2);
    expect(parts.fileProposals![0]).toEqual({ id: held[0].id, name: "brand.md", chars: 5000, preview: "A".repeat(600), at: held[0].at, agent: "noor" });
    expect(JSON.stringify(parts.fileProposals)).not.toMatch(/"by"/);
  });
  it("Apply writes the text, keeps the agent label and records it; a second answer is 410; a reloaded thread shows it applied", async () => {
    const { me, scope } = await seeded();
    const held: FileProposal[] = [];
    await write(me, "brand.md", "# Rose\nNew tone.", held);
    await push(scope, { role: "assistant", content: "ok", at: new Date().toISOString(), ...turnParts([], [], [], [], [], [], held) });
    expect((await historyFor(scope)).at(-1)!.fileProposals![0].state).toBe("open");
    const r = await decide(held[0].id, "apply");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, file: { name: "brand.md", chars: 16 } });
    expect(await readFile(scope, "brand.md")).toMatchObject({ content: "# Rose\nNew tone.", by: "noor" });
    expect((await decide(held[0].id, "apply")).status).toBe(410);
    expect((await historyFor(scope)).at(-1)!.fileProposals![0].state).toBe("applied");
  });
  it("a file saved again since the proposal is not overwritten: 409 stale, closed", async () => {
    const { me, scope } = await seeded();
    const held: FileProposal[] = [];
    await write(me, "brand.md", "agent text", held);
    await new Promise((r) => setTimeout(r, 5));
    await writeFile(scope, "brand.md", "the owner's edit", "user");
    const r = await decide(held[0].id, "apply");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("stale");
    expect((await readFile(scope, "brand.md"))!.content).toBe("the owner's edit");
    expect((await decide(held[0].id, "apply")).status).toBe(410);
  });
  it("Dismiss writes nothing; another workspace's id is 404; a member cannot decide; nothing without a session", async () => {
    const { u, me, scope } = await seeded();
    const held: FileProposal[] = [];
    await write(me, "brand.md", "agent text", held);
    const id = held[0].id;
    const m = await newMember(u);
    signOut();
    expect((await decide(id, "apply")).status).toBe(401);
    await signIn(m.email);
    expect((await decide(id, "apply")).status).toBe(403);
    signOut();
    const other = await newUser("scanfile");
    await signIn(other.email);
    expect((await decide(id, "apply")).status).toBe(404);
    signOut();
    await signIn(u.email);
    expect((await decide(id, "bogus")).status).toBe(400);
    expect((await decide(id, "dismiss")).status).toBe(200);
    expect((await readFile(scope, "brand.md"))!.content).toBe("# Rose roastery\nWarm, plain words.");
  });
  it("wipeAccount finds every proposal key of the scope", async () => {
    const { me, scope } = await seeded();
    const held: FileProposal[] = [];
    await write(me, "brand.md", "agent text", held);
    const keys = await fileProposalKeys(scope);
    expect(keys).toContain(`fileprop:${scope}:${held[0].id}`);
    expect(keys).toContain(`fileprops:${scope}`);
    expect(read("src/lib/account.ts")).toMatch(/fileProposalKeys\(s\)/);
  });
});
