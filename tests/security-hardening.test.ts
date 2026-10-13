import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminSignIn, jar, json, newUser, signIn, signOut } from "./helpers/session";
import { createSession, currentUser, dropSession, sessionKey, sessionKeys, sessionRecord } from "@/lib/auth";
import { db } from "@/lib/db";
import { legacySettingsPath } from "@/lib/settings-nav";

/**
 * Security hardening batch of 2026-10-12 (360 study C-006, C-007, C-013, C-014, C-015, C-016, C-018, F-019, J-004;
 * leftovers L065, L066, L089). Rules 1340-1356, docs/system/tests/1340-security-hardening.md.
 */

// The resolver pinnedLookup asks. Each test sets the answer; nothing here touches DNS or the network.
const dns = vi.hoisted(() => ({ answer: [] as { address: string; family: number }[], fail: false }));
vi.mock("dns/promises", async (orig) => ({
  ...(await orig<typeof import("dns/promises")>()),
  lookup: vi.fn(async () => {
    if (dns.fail) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return dns.answer;
  }),
}));

const read = (p: string) => readFileSync(p, "utf8");

describe("rule 1340: no framework banner, a security.txt", () => {
  it("next.config turns X-Powered-By off", async () => {
    const config = (await import("../next.config")).default;
    expect(config.poweredByHeader).toBe(false);
  });
  it("/.well-known/security.txt names the contact, an expiry in the future and the canonical address", () => {
    const txt = read("public/.well-known/security.txt");
    expect(txt).toMatch(/^Contact: mailto:hello@thakeen\.com$/m);
    expect(txt).toMatch(/^Canonical: https:\/\/thakeen\.com\/\.well-known\/security\.txt$/m);
    const expires = Date.parse(txt.match(/^Expires: (.+)$/m)![1]);
    expect(expires).toBeGreaterThan(Date.now());
    // RFC 9116 recommends less than a year ahead; the founder renews it before then.
    expect(expires - Date.now()).toBeLessThan(400 * 864e5);
    // The proxy passes the path through untouched (no language redirect, no settings move), so the static file answers.
    expect(legacySettingsPath("/.well-known/security.txt")).toBeFalsy();
  });
});

describe("rule 1341: a full CSP, report-only; the enforced one unchanged", () => {
  const headers = async () => {
    const config = (await import("../next.config")).default;
    const rules = await config.headers!();
    return rules.flatMap((r) => r.headers);
  };
  it("the enforced policy is the one customers had", async () => {
    const h = await headers();
    expect(h.find((x) => x.key === "Content-Security-Policy")?.value).toBe("frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  });
  it("the report-only policy closes the defaults and still lets Turnstile and the media in", async () => {
    const ro = (await headers()).find((x) => x.key === "Content-Security-Policy-Report-Only")?.value ?? "";
    const d = (name: string) => ro.split(";").map((x) => x.trim()).find((x) => x.startsWith(`${name} `)) ?? "";
    expect(d("default-src")).toBe("default-src 'self'");
    for (const name of ["script-src", "frame-src", "connect-src"]) expect(d(name), name).toContain("https://challenges.cloudflare.com");
    expect(d("object-src")).toBe("object-src 'none'");
    expect(d("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(d("media-src")).toContain("blob:");
    expect(d("connect-src")).toContain("https://*.public.blob.vercel-storage.com");
    expect(ro).not.toMatch(/'unsafe-eval'|\*(?!\.)/);
  });
});

describe("rule 1342: safeFetch connects only to the addresses it checked", () => {
  beforeEach(() => { dns.answer = []; dns.fail = false; });
  afterEach(() => vi.unstubAllGlobals());
  const ask = (opts: { all?: boolean } = {}) => new Promise<{ err: Error | null; address: unknown; family?: number }>(async (done) => {
    const { pinnedLookup } = await import("@/lib/safe-fetch");
    pinnedLookup("shop.example", opts, (err, address, family) => done({ err, address, family }));
  });

  it("a name that now resolves to a private address is refused at connect time", async () => {
    dns.answer = [{ address: "93.184.215.14", family: 4 }, { address: "127.0.0.1", family: 4 }];
    expect((await ask()).err?.message).toBe("unsafe_url:private_ip");
    dns.answer = [{ address: "169.254.169.254", family: 4 }];
    expect((await ask({ all: true })).err?.message).toBe("unsafe_url:private_ip");
    dns.answer = [];
    expect((await ask()).err?.message).toBe("unsafe_url:private_ip");
    dns.fail = true;
    expect((await ask()).err?.message).toBe("unsafe_url:dns");
  });
  it("a public answer is handed to the socket as it was checked", async () => {
    dns.answer = [{ address: "93.184.215.14", family: 4 }, { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 }];
    expect(await ask()).toEqual({ err: null, address: "93.184.215.14", family: 4 });
    expect((await ask({ all: true })).address).toEqual(dns.answer);
  });
  it("every hop goes through the pinned agent", async () => {
    const { pinnedAgent, safeFetch } = await import("@/lib/safe-fetch");
    const f = vi.fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>(async () => new Response("ok"));
    vi.stubGlobal("fetch", f);
    await safeFetch("https://8.8.8.8/");
    expect((f.mock.calls[0][1] as RequestInit & { dispatcher?: unknown }).dispatcher).toBe(pinnedAgent());
    expect(pinnedAgent()).toBe(pinnedAgent());
  });
});

describe("rules 1343-1344: every outside call has a deadline", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("safeFetch adds a 30 second deadline when the caller sets none, and keeps the caller's own", async () => {
    const { safeFetch } = await import("@/lib/safe-fetch");
    const { PROVIDER_TIMEOUT_MS } = await import("@/lib/fetch-timeout");
    expect(PROVIDER_TIMEOUT_MS).toBe(30_000);
    const f = vi.fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>(async () => new Response("ok"));
    vi.stubGlobal("fetch", f);
    await safeFetch("https://8.8.8.8/");
    expect(f.mock.calls[0][1]!.signal).toBeInstanceOf(AbortSignal);
    const mine = new AbortController().signal;
    await safeFetch("https://8.8.8.8/", { signal: mine });
    expect(f.mock.calls[1][1]!.signal).toBe(mine);
  });
  it("each direct provider call in the connectors carries a signal", () => {
    for (const name of ["salla", "zid", "meta", "ads", "keyed", "shopify", "x", "oauth"]) {
      const src = read(`src/lib/connectors/${name}.ts`);
      const calls = src.split(/\bfetch\(/).slice(1);
      expect(calls.length, name).toBeGreaterThan(0);
      for (const [i, c] of calls.entries()) expect(c.slice(0, 700), `${name} fetch #${i + 1}`).toMatch(/signal: (providerTimeout\(\)|AbortSignal\.timeout\()/);
    }
  });
});

describe("rules 1345-1346: session tokens are stored hashed (expand step)", () => {
  it("a new session is written under the token's SHA-256, never the token", async () => {
    const u = await newUser("hs1");
    await createSession(u.email);
    const token = jar().get("thakeen_session")!;
    expect(sessionKey(token)).toBe(`session:h:${createHash("sha256").update(token).digest("hex")}`);
    expect(await db.get(sessionKey(token))).toMatchObject({ email: u.email });
    expect(await db.get(`session:${token}`)).toBeNull();
    expect((await currentUser())?.email).toBe(u.email);
  });
  it("a session written before the change (raw key) still signs in: nobody is signed out", async () => {
    const u = await newUser("hs2");
    const legacy = randomBytes(32).toString("hex");
    await db.set(`session:${legacy}`, { email: u.email, at: Date.now() }, 3600);
    signOut();
    jar().set("thakeen_session", legacy);
    expect((await currentUser())?.email).toBe(u.email);
  });
  it("only a 64-hex token may read a raw key, so a cookie set to a stored key's name reads nothing", async () => {
    const u = await newUser("hs3");
    const token = await signIn(u.email);
    const hashed = sessionKey(token).slice("session:".length); // "h:<sha256>"
    expect(sessionKeys(hashed)).toEqual([sessionKey(hashed)]);
    expect(await sessionRecord(hashed)).toBeNull();
    signOut();
    jar().set("thakeen_session", hashed);
    expect(await currentUser()).toBeNull();
    expect(sessionKeys("a".repeat(64))).toEqual([sessionKey("a".repeat(64)), `session:${"a".repeat(64)}`]);
  });
  it("sign-out, rotation and impersonation stop remove both shapes", async () => {
    const u = await newUser("hs4");
    const t = randomBytes(32).toString("hex");
    await Promise.all([db.set(`session:${t}`, { email: u.email, at: Date.now() }, 3600), db.set(sessionKey(t), { email: u.email, at: Date.now() }, 3600)]);
    await dropSession(t);
    expect(await db.get(`session:${t}`)).toBeNull();
    expect(await db.get(sessionKey(t))).toBeNull();
    const auth = read("src/lib/auth.ts");
    expect(auth).not.toMatch(/db\.(set|get|del)\(`session:\$\{/);
    const stop = read("src/app/api/admin/impersonate/route.ts");
    expect(stop).not.toContain("`session:");
    expect(stop).toContain("await dropSession(temp)");
  });
});

describe("rules 1347-1349: MCP OAuth tokens", () => {
  it("1347: an access token lives one hour; the refresh token keeps the client connected", async () => {
    const { ACCESS_TTL, issueTokens } = await import("@/lib/oauth");
    expect(ACCESS_TTL).toBe(3600);
    const u = await newUser("mcpttl");
    const t = await issueTokens(u.email, "client-ttl", "noor");
    expect(t.expires_in).toBe(3600);
    const ttl = await db.ttl(`mcptoken:${createHash("sha256").update(t.access_token).digest("hex")}`);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });
  it("1348: authorising the same client again replaces its grant; another client's grant stays", async () => {
    const { issueTokens, listGrants } = await import("@/lib/oauth");
    const { userFromBearer } = await import("@/lib/mcp");
    const bearer = (t: string) => new Request("https://thakeen.com/api/mcp", { headers: { authorization: `Bearer ${t}` } });
    const u = await newUser("mcpone");
    const first = await issueTokens(u.email, "client-a", "noor");
    const other = await issueTokens(u.email, "client-b", "noor");
    const second = await issueTokens(u.email, "client-a", "noor");
    const grants = await listGrants(u.email);
    expect(grants.map((g) => g.client_id).sort()).toEqual(["client-a", "client-b"]);
    expect(await userFromBearer(bearer(first.access_token))).toBeNull();
    expect((await userFromBearer(bearer(second.access_token)))?.email).toBe(u.email);
    expect((await userFromBearer(bearer(other.access_token)))?.email).toBe(u.email);
  });
  it("1349: a registered client expires after 90 days unused, and every code or token renews it", async () => {
    const { CLIENT_TTL, issueCode, issueTokens, registerClient } = await import("@/lib/oauth");
    expect(CLIENT_TTL).toBe(90 * 86400);
    const c = await registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "T" });
    const key = `oauthclient:${c.client_id}`;
    expect(await db.ttl(key)).toBeGreaterThan(CLIENT_TTL - 60);
    await db.expire(key, 100);
    await issueCode({ client_id: c.client_id, redirect_uri: c.redirect_uris[0], challenge: "x", email: "x@test.example", scope: "noor" });
    expect(await db.ttl(key)).toBeGreaterThan(CLIENT_TTL - 60);
    await db.expire(key, 100);
    const u = await newUser("mcpcl");
    await issueTokens(u.email, c.client_id, "noor");
    expect(await db.ttl(key)).toBeGreaterThan(CLIENT_TTL - 60);
  });
});

describe("rule 1350: one impersonation at a time", () => {
  beforeEach(() => vi.stubEnv("WAITLIST_ADMIN_KEY", "k".repeat(40)));
  afterEach(() => vi.unstubAllEnvs());
  it("starting one from a browser that already shows a customer is refused, and nothing is logged", async () => {
    const a = await newUser("imp1a");
    const b = await newUser("imp1b");
    const users = await import("@/app/api/admin/users/[email]/route");
    await signIn(a.email, { imp: "key" });
    const temp = jar().get("thakeen_session");
    await adminSignIn();
    const before = (await db.lrange("admin:log", 0, -1)).length;
    const res = await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate", minutes: 15, reason: "ticket 1" }), { params: Promise.resolve({ email: encodeURIComponent(b.email) }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "impersonation_active" });
    expect((await db.lrange("admin:log", 0, -1)).length).toBe(before);
    expect(jar().get("thakeen_session")).toBe(temp);
    expect(jar().get("thakeen_return")).toBeUndefined();
  });
  it("the founder's own session may start one", async () => {
    const b = await newUser("imp2b");
    const users = await import("@/app/api/admin/users/[email]/route");
    signOut();
    await adminSignIn();
    const res = await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate", minutes: 15, reason: "ticket 2" }), { params: Promise.resolve({ email: encodeURIComponent(b.email) }) });
    expect(res.status).toBe(200);
  });
});

describe("rule 1351: connector records name their key, and the previous key still opens them", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("a record sealed with the old key opens after a rotation, and is sealed with the new key on its next save", async () => {
    const store = await import("@/lib/connectors/store");
    vi.stubEnv("CONNECT_SECRET", "old-secret-for-tests");
    const scope = `kid-${randomBytes(4).toString("hex")}@test.example`;
    await store.saveConnection(scope, { provider: "telegram", meta: {}, connectedAt: new Date().toISOString(), data: { botToken: "t" } } as Parameters<typeof store.saveConnection>[1]);
    const raw = await db.get<{ kid?: string; enc: string }>(`conn:${scope}:telegram`);
    expect(raw!.kid).toBe(store.kidOf("old-secret-for-tests"));
    expect(raw!.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(raw)).not.toContain("old-secret-for-tests");

    vi.stubEnv("CONNECT_SECRET", "new-secret-for-tests");
    vi.stubEnv("CONNECT_SECRET_PREVIOUS", "old-secret-for-tests");
    const c = await store.getConnection(scope, "telegram");
    expect(c!.data).toEqual({ botToken: "t" });
    await store.saveConnection(scope, c!);
    expect((await db.get<{ kid?: string }>(`conn:${scope}:telegram`))!.kid).toBe(store.kidOf("new-secret-for-tests"));

    vi.stubEnv("CONNECT_SECRET_PREVIOUS", "");
    expect((await store.getConnection(scope, "telegram"))!.data).toEqual({ botToken: "t" });
  });
  it("a record whose key is neither current nor previous says so; one with no kid tries both", async () => {
    const store = await import("@/lib/connectors/store");
    vi.stubEnv("CONNECT_SECRET", "a-secret-for-tests");
    const blob = store.encrypt("hello");
    expect(store.decrypt(blob)).toBe("hello");
    expect(() => store.decrypt(blob, "0000000000000000")).toThrow("connect_key_unknown");
    vi.stubEnv("CONNECT_SECRET", "b-secret-for-tests");
    vi.stubEnv("CONNECT_SECRET_PREVIOUS", "a-secret-for-tests");
    expect(store.decrypt(blob)).toBe("hello");
    expect(store.decrypt(blob, store.kidOf("a-secret-for-tests"))).toBe("hello");
  });
});

describe("rule 1353: integration votes count only listed ids, and are rate limited", () => {
  const post = async (body: unknown) => (await import("@/app/api/integrations/route")).POST(json("/api/integrations", "POST", body));
  it("a listed id counts under its id, whatever name the body sends", async () => {
    const u = await newUser("iv1");
    await signIn(u.email);
    const before = Number((await db.get("integration-votes:salla")) ?? 0);
    const res = await post({ id: "salla", name: "<b>anything</b>" });
    expect(res.status).toBe(200);
    expect(Number(await db.get("integration-votes:salla"))).toBe(before + 1);
    expect(await db.get("integration-votes:<b>anything</b>")).toBeNull();
    const row = JSON.parse((await db.lrange("integration-requests", 0, 0))[0]);
    expect(row).toMatchObject({ id: "salla", name: "Salla (سلة)", email: u.email });
  });
  it("an unlisted id is refused; the 'other' box is logged and counted under one key", async () => {
    const u = await newUser("iv2");
    await signIn(u.email);
    expect((await post({ id: "made-up-" + Date.now() })).status).toBe(400);
    expect((await post({ name: "Zoho" })).status).toBe(400);
    const before = Number((await db.get("integration-votes:other")) ?? 0);
    expect((await post({ id: "other:zoho crm", name: "Zoho CRM" + "x".repeat(200) })).status).toBe(200);
    expect(Number(await db.get("integration-votes:other"))).toBe(before + 1);
    const row = JSON.parse((await db.lrange("integration-requests", 0, 0))[0]);
    expect(row.other).toBe(true);
    expect(row.name.length).toBe(80);
  });
  it("a login gets INTEGRATION_REQUESTS_PER_HOUR an hour, then 429 with Retry-After", async () => {
    const { INTEGRATION_REQUESTS_PER_HOUR } = await import("@/lib/rate");
    const u = await newUser("iv3");
    await signIn(u.email);
    for (let i = 0; i < INTEGRATION_REQUESTS_PER_HOUR; i++) expect((await post({ id: "zid" })).status).toBe(200);
    const res = await post({ id: "zid" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    signOut();
    expect((await post({ id: "zid" })).status).toBe(401);
  });
});

describe("rule 1354: provider error text stays out of logs", () => {
  it("errorTag keeps the error's name and an HTTP status, never its message", async () => {
    const { errorTag } = await import("@/lib/log-safe");
    expect(errorTag(new Error("salla token 400 invalid_client: secret=abc"))).toBe("Error 400");
    expect(errorTag(new TypeError("fetch failed for https://x/?token=abc"))).toBe("TypeError");
    expect(errorTag("a string")).toBe("error");
  });
  it("a refused token exchange keeps the provider, the status and the OAuth code only", async () => {
    const { oauthErrorCode } = await import("@/lib/connectors/oauth");
    expect(oauthErrorCode(JSON.stringify({ error: "invalid_grant", error_description: "Token for user@x.com was revoked" }))).toBe(" invalid_grant");
    expect(oauthErrorCode(JSON.stringify({ error: "Bad Thing <script>" }))).toBe("");
    expect(oauthErrorCode("<html>oops</html>")).toBe("");
    const src = read("src/lib/connectors/oauth.ts");
    expect(src).toContain("throw new Error(`${p.id} token ${res.status}${oauthErrorCode(text)}`)");
    expect(src).not.toMatch(/token \$\{res\.status\}: \$\{text/);
  });
  it("the OAuth callback logs the tag, not the error", () => {
    const src = read("src/app/api/connect/[provider]/callback/route.ts");
    expect(src).toContain('console.error("oauth callback failed", p.id, errorTag(e));');
    expect(src).not.toMatch(/console\.error\([^)]*,\s*e\)/);
  });
});

describe("rule 1355: secret scan in CI, every action pinned", () => {
  const yml = read(".github/workflows/ci.yml");
  it("the scan runs before any install, on the PR's commits, from a checksummed binary, redacted", () => {
    const scan = yml.indexOf("- name: Secret scan");
    expect(scan).toBeGreaterThan(yml.indexOf("- name: Scope"));
    expect(scan).toBeLessThan(yml.indexOf("actions/setup-node@"));
    const step = yml.slice(scan, yml.indexOf("\n      - ", scan + 10));
    expect(step).toMatch(/GITLEAKS_VERSION: \d+\.\d+\.\d+/);
    expect(step).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}/);
    expect(step).toContain('sha256sum -c -');
    expect(step).toContain('range="HEAD^1..HEAD^2"');
    expect(step).toContain("--redact");
    expect(step).toContain("--exit-code 1");
    expect(step).toContain("--config .gitleaks.toml");
  });
  it("every action in every workflow is pinned to a full commit SHA", () => {
    for (const f of [".github/workflows/ci.yml", ".github/workflows/upstream-watch.yml"]) {
      const uses = [...read(f).matchAll(/uses: (\S+)/g)].map((m) => m[1]);
      expect(uses.length, f).toBeGreaterThan(0);
      for (const u of uses) expect(u, `${f}: ${u}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });
  it("the allowance covers the generic rule on fake-value paths only", () => {
    const toml = read(".gitleaks.toml");
    expect(toml).toMatch(/\[extend\]\s*\nuseDefault = true/);
    expect(toml).toContain('targetRules = ["generic-api-key"]');
    expect(toml.match(/\[\[allowlists\]\]/g)).toHaveLength(1);
    expect(toml).not.toMatch(/\^src\//);
  });
});

describe("rule 1356: the docs name the change", () => {
  it("flows, architecture, permissions, variables and the coverage file", () => {
    expect(read("docs/system/flows.md")).toMatch(/^## 66\. Security hardening/m);
    const arch = read("docs/system/architecture.md");
    for (const s of ["`session:h:{sha256(token)}`", "`CLIENT_TTL`", "rule 1347", "rule 1348", "`kid`", "`integration-votes:{id}`", "`pinnedAgent()`", "`Content-Security-Policy-Report-Only`"]) expect(arch, s).toContain(s);
    const perms = read("docs/system/permissions.md");
    for (const s of ["impersonation_active", "INTEGRATION_REQUESTS_PER_HOUR", "rule 1347", "rules 1342-1343"]) expect(perms, s).toContain(s);
    expect(read("docs/system/variables.md")).toMatch(/^\| `CONNECT_SECRET_PREVIOUS` \|/m);
    const cov = read("docs/system/tests/1340-security-hardening.md");
    for (let n = 1340; n <= 1356; n++) expect(cov, String(n)).toMatch(new RegExp(`^\\| ${n} \\|`, "m"));
  });
});
