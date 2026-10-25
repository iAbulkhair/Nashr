import { createHash, randomBytes } from "crypto";
import { acct } from "@/lib/account-id";
import { describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { createMcpToken, getMcpToken, revokeAllMcp, revokeMcpToken, userFromBearer } from "@/lib/mcp";
import { grantKey, issueCode, issueTokens, listGrants, redeemCode, registerClient, revokeGrant, rotateRefresh, tokenHash } from "@/lib/oauth";

/**
 * Rules 548-555: MCP and OAuth tokens are single-use where they must be (GETDEL), hashed at rest, migrated from the raw
 * form on first use, and every one of them dies with its grant.
 */
const bearer = (t: string) => new Request("https://nashr.test/api/mcp", { headers: { authorization: `Bearer ${t}` } });
const REDIRECT = "https://claude.example/cb";
const verifier = "v".repeat(50), challenge = createHash("sha256").update(verifier).digest("base64url");
const client = () => registerClient({ redirect_uris: [REDIRECT], client_name: "Claude" });
/** Everything the in-memory store holds, keys and values, as one string. */
const dump = () => {
  const m = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown> } }).__nashrMem;
  return [...m.kv.entries()].map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n");
};

describe("single use under concurrency (rules 548, 549)", () => {
  it("548: two refreshes with the same token at once: exactly one succeeds, and only its access token works", async () => {
    const u = await newUser("oafix");
    const c = await client();
    const first = await issueTokens(acct(u), c.client_id, "noor");
    const results = await Promise.all([rotateRefresh(first.refresh_token, c.client_id), rotateRefresh(first.refresh_token, c.client_id)]);
    const won = results.filter((r) => r !== null);
    expect(won).toHaveLength(1);
    expect(await userFromBearer(bearer(won[0]!.access_token))).not.toBeNull();
    expect(await userFromBearer(bearer(first.access_token))).toBeNull();
    expect(await listGrants(acct(u))).toHaveLength(1);
  });
  it("549: one code redeemed twice at once yields one grant", async () => {
    const u = await newUser("oafix");
    const c = await client();
    const code = await issueCode({ client_id: c.client_id, redirect_uri: REDIRECT, challenge, email: acct(u), scope: "noor" });
    const results = await Promise.all([redeemCode(code, c.client_id, REDIRECT, verifier), redeemCode(code, c.client_id, REDIRECT, verifier)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe("the grant is the authority over its tokens (rules 550, 551)", () => {
  it("550: a revoked grant's refresh token fails, even when its refresh record survived", async () => {
    const u = await newUser("oafix");
    const c = await client();
    const t = await issueTokens(acct(u), c.client_id, "noor");
    const [g] = await listGrants(acct(u));
    // Only the grant record goes (the shape a partial revocation would leave): its tokens must still be refused.
    await db.del(grantKey(acct(u), g.id));
    expect(await rotateRefresh(t.refresh_token, c.client_id)).toBeNull();
    expect(await userFromBearer(bearer(t.access_token))).toBeNull();
    expect(await db.get(grantKey(acct(u), g.id))).toBeNull();
  });
  it("551: a rotation that overlaps a revocation never re-creates the grant, and its new tokens are dead", async () => {
    const u = await newUser("oafix");
    const c = await client();
    const t = await issueTokens(acct(u), c.client_id, "noor");
    const [g] = await listGrants(acct(u));
    // The revocation lands right after the rotation read the grant.
    const get = db.get.bind(db);
    const spy = vi.spyOn(db, "get").mockImplementation(async (key: string) => {
      const v = await get(key);
      if (key === grantKey(acct(u), g.id)) { spy.mockRestore(); await revokeGrant(acct(u), g.id); }
      return v as never;
    });
    const r = await rotateRefresh(t.refresh_token, c.client_id);
    spy.mockRestore();
    expect(r).toBeNull();
    expect(await db.get(grantKey(acct(u), g.id))).toBeNull();
    expect(await listGrants(acct(u))).toHaveLength(0);
    expect(await userFromBearer(bearer(t.access_token))).toBeNull();
  });
  it("551: an access token its grant does not list is refused (one a lost race left behind)", async () => {
    const u = await newUser("oafix");
    const c = await client();
    await issueTokens(acct(u), c.client_id, "noor");
    const [g] = await listGrants(acct(u));
    const stray = "nashr_" + randomBytes(24).toString("base64url");
    await db.set(`mcptoken:${tokenHash(stray)}`, { email: acct(u), grant: g.id }, 3600);
    expect(await userFromBearer(bearer(stray))).toBeNull();
  });
});

describe("tokens are hashed at rest (rules 552, 553)", () => {
  it("552: no stored key or value holds a raw access, refresh, code or personal token", async () => {
    const u = await newUser("oafix");
    const c = await client();
    const code = await issueCode({ client_id: c.client_id, redirect_uri: REDIRECT, challenge, email: acct(u), scope: "noor" });
    const codeDump = dump();
    expect(codeDump).not.toContain(code);
    expect(codeDump).toContain(`oauthcode:${tokenHash(code)}`);
    const t = await issueTokens(acct(u), c.client_id, "noor");
    const r = (await rotateRefresh(t.refresh_token, c.client_id))!;
    const personal = await createMcpToken(acct(u));
    const all = dump();
    for (const raw of [t.access_token, t.refresh_token, r.access_token, r.refresh_token, personal]) expect(all).not.toContain(raw);
    expect(all).toContain(`mcptoken:${tokenHash(r.access_token)}`);
    expect(all).toContain(`oauthrefresh:${tokenHash(r.refresh_token)}`);
    expect(await getMcpToken(acct(u))).toBe(tokenHash(personal));
    // And they still work.
    expect(await userFromBearer(bearer(r.access_token))).not.toBeNull();
    expect(await userFromBearer(bearer(personal))).not.toBeNull();
  });
  it("553: a personal token from before hashing authenticates, is moved to its hash, and still revokes", async () => {
    const u = await newUser("oafix");
    const raw = "nashr_" + randomBytes(24).toString("base64url");
    await db.set(`mcptoken:${raw}`, acct(u));
    await db.set(`mcptoken-of:${acct(u)}`, raw);
    expect(acct((await userFromBearer(bearer(raw)))!)).toBe(acct(u));
    expect(await db.get(`mcptoken:${raw}`)).toBeNull();
    expect(await db.get(`mcptoken:${tokenHash(raw)}`)).toBe(acct(u));
    expect(await getMcpToken(acct(u))).toBe(tokenHash(raw));
    expect(dump()).not.toContain(raw);
    expect(acct((await userFromBearer(bearer(raw)))!)).toBe(acct(u)); // the migrated form keeps working
    await revokeMcpToken(acct(u));
    expect(await userFromBearer(bearer(raw))).toBeNull();
  });
  it("553: an OAuth pair from before hashing authenticates, refreshes once, and keeps its access TTL when moved", async () => {
    const u = await newUser("oafix");
    const c = await client();
    const access = "nashr_" + randomBytes(24).toString("base64url"), refresh = "nashr_r_" + randomBytes(24).toString("base64url");
    const id = randomBytes(8).toString("hex"), now = new Date().toISOString();
    await Promise.all([
      db.set(`mcptoken:${access}`, acct(u), 1000),
      db.set(`oauthrefresh:${refresh}`, { email: acct(u), client_id: c.client_id, scope: "noor", grant: id }, 5000),
      db.set(grantKey(acct(u), id), { id, client_id: c.client_id, client_name: "Claude", scope: "noor", createdAt: now, lastIssuedAt: now, access, refresh }, 5000),
      db.sadd(`mcpgrants:${acct(u)}`, id),
    ]);
    expect(await userFromBearer(bearer(access))).not.toBeNull();
    const ttl = await db.ttl(`mcptoken:${tokenHash(access)}`);
    expect(ttl).toBeGreaterThan(900);
    expect(ttl).toBeLessThanOrEqual(1000);
    const next = (await rotateRefresh(refresh, c.client_id))!;
    expect(next).not.toBeNull();
    expect(await rotateRefresh(refresh, c.client_id)).toBeNull();
    expect(await userFromBearer(bearer(access))).toBeNull();
    expect(await userFromBearer(bearer(next.access_token))).not.toBeNull();
    expect(dump()).not.toContain(access);
  });
  it("553: a refresh token with no grant (issued before grants existed) is refused", async () => {
    const u = await newUser("oafix");
    const c = await client();
    const refresh = "nashr_r_" + randomBytes(24).toString("base64url");
    await db.set(`oauthrefresh:${refresh}`, { email: acct(u), client_id: c.client_id, scope: "noor" }, 5000);
    expect(await rotateRefresh(refresh, c.client_id)).toBeNull();
    expect(await listGrants(acct(u))).toHaveLength(0);
  });
});

describe("revocation leaves nothing that works (rules 554, 555)", () => {
  it("554: revokeAllMcp ends the personal token, every grant, legacy forms included, and every refresh", async () => {
    const u = await newUser("oafix");
    const c = await client();
    const personal = await createMcpToken(acct(u));
    const a = await issueTokens(acct(u), c.client_id, "noor");
    const b0 = await issueTokens(acct(u), c.client_id, "noor");
    const b = (await rotateRefresh(b0.refresh_token, c.client_id))!;
    const legacyAccess = "nashr_" + randomBytes(24).toString("base64url"), legacyRefresh = "nashr_r_" + randomBytes(24).toString("base64url");
    const id = randomBytes(8).toString("hex"), now = new Date().toISOString();
    await Promise.all([
      db.set(`mcptoken:${legacyAccess}`, acct(u), 1000),
      db.set(`oauthrefresh:${legacyRefresh}`, { email: acct(u), client_id: c.client_id, scope: "noor", grant: id }, 5000),
      db.set(grantKey(acct(u), id), { id, client_id: c.client_id, client_name: "Claude", scope: "noor", createdAt: now, lastIssuedAt: now, access: legacyAccess, refresh: legacyRefresh }, 5000),
      db.sadd(`mcpgrants:${acct(u)}`, id),
    ]);
    // One legacy token is used (moved to its hash) before the revocation, which must still find it.
    expect(await userFromBearer(bearer(legacyAccess))).not.toBeNull();

    await revokeAllMcp(acct(u));
    for (const t of [personal, a.access_token, b0.access_token, b.access_token, legacyAccess]) expect(await userFromBearer(bearer(t)), t.slice(0, 8)).toBeNull();
    for (const r of [a.refresh_token, b.refresh_token, legacyRefresh]) expect(await rotateRefresh(r, c.client_id)).toBeNull();
    expect(await listGrants(acct(u))).toHaveLength(0);
    expect(dump()).not.toMatch(new RegExp(`^(mcptoken|oauthrefresh):[^=]*=.*${acct(u).replace(/[.+]/g, "\\$&")}`, "m"));
  });
  it("555: the token route never returns a stored token, only whether one exists", async () => {
    const src = (await import("fs")).readFileSync(new URL("../src/app/api/mcp/token/route.ts", import.meta.url), "utf8");
    const get = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function POST"));
    expect(get).toMatch(/exists: !!t/);
    expect(get).not.toMatch(/token:/);
  });
});
