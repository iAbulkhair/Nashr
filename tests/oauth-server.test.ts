import { createHash } from "crypto";
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { newUser } from "./helpers/session";
import { issueCode, registerClient } from "@/lib/oauth";
import { userFromBearer } from "@/lib/mcp";
import { OAUTH_REGISTER_PER_IP, OAUTH_TOKEN_PER_IP } from "@/lib/rate";
import * as token from "@/app/api/oauth/token/route";
import * as register from "@/app/api/oauth/register/route";

/**
 * Rule 18, the two public endpoints of the MCP OAuth server: `/api/oauth/token` authenticates a confidential client
 * with its secret in constant time (`sameSecret`) and still serves a public client with PKCE alone, and both it and
 * `/api/oauth/register` stop one address after their per-IP allowance, answering in OAuth's shape with CORS intact.
 */
// Each test gets its own client IP so one test's throttle window never leaks into the next.
let ipN = 0;
const ip = () => ({ "x-real-ip": `192.0.2.${++ipN}` });
const REDIRECT = "https://claude.example/cb";
const verifier = "v".repeat(50), challenge = createHash("sha256").update(verifier).digest("base64url");

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://nashr.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const form = (body: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request("https://nashr.test/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() });
const basic = (id: string, secret: string) => ({ authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` });

/** A registered client and a fresh authorization code for a new account. */
async function setup(confidential: boolean) {
  const u = await newUser("oauthsrv");
  const client = await registerClient({ redirect_uris: [REDIRECT], client_name: "Claude", ...(confidential ? { token_endpoint_auth_method: "client_secret_post" } : {}) });
  const code = await issueCode({ client_id: client.client_id, redirect_uri: REDIRECT, challenge, email: u.email, scope: "noor" });
  const exchange = { grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT };
  return { u, client, exchange };
}

describe("token endpoint client authentication (rule 18)", () => {
  it("refuses a confidential client with a wrong, missing or non-string secret, in the body or the Basic header, and spends no code", async () => {
    const { client, exchange } = await setup(true);
    const h = ip();
    const tries = [
      post("/api/oauth/token", { ...exchange, client_secret: "not-the-secret" }, h),
      post("/api/oauth/token", { ...exchange, client_secret: client.client_secret!.slice(0, -1) }, h),
      post("/api/oauth/token", exchange, h),
      post("/api/oauth/token", { ...exchange, client_secret: 12345 }, h),
      post("/api/oauth/token", { ...exchange, client_secret: [client.client_secret] }, h),
      form(exchange, { ...h, ...basic(client.client_id, "not-the-secret") }),
    ];
    for (const [i, req] of tries.entries()) {
      const res = await token.POST(req);
      expect(res.status, `attempt ${i + 1}`).toBe(400);
      expect(await res.json(), `attempt ${i + 1}`).toMatchObject({ error: "invalid_client" });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    // None of the refusals reached the code: the right secret still redeems it once.
    const ok = await token.POST(post("/api/oauth/token", { ...exchange, client_secret: client.client_secret }, h));
    expect(ok.status).toBe(200);
    expect((await ok.json()).access_token).toMatch(/^nashr_/);
  });

  it("accepts the right secret in the Basic header", async () => {
    const { client, exchange } = await setup(true);
    const { client_id: _id, ...rest } = exchange;
    void _id;
    const res = await token.POST(form(rest, { ...ip(), ...basic(client.client_id, client.client_secret!) }));
    expect(res.status).toBe(200);
  });

  it("a public client (no secret) still exchanges a code with PKCE alone and refreshes, and the tokens work", async () => {
    const { u, client, exchange } = await setup(false);
    expect(client.client_secret).toBeUndefined();
    const h = ip();
    const res = await token.POST(form(exchange, h));
    expect(res.status).toBe(200);
    const t = await res.json();
    expect((await userFromBearer(new Request("https://nashr.test/api/mcp", { headers: { authorization: `Bearer ${t.access_token}` } })))!.email).toBe(u.email);
    const r = await token.POST(post("/api/oauth/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: t.refresh_token }, h));
    expect(r.status).toBe(200);
    expect((await r.json()).refresh_token).not.toBe(t.refresh_token);
  });

  it("compares the secret with sameSecret, never with === or !==", () => {
    const src = readFileSync("src/app/api/oauth/token/route.ts", "utf8");
    expect(src).toMatch(/sameSecret\(client\.client_secret,/);
    expect(src).not.toMatch(/client\.client_secret\s*[!=]==|[!=]==\s*(?:b|client)\.client_secret/);
  });
});

describe("the public OAuth endpoints are rate limited per IP (rule 18)", () => {
  it("token: one address gets its allowance, then 429 slow_down with CORS, even for a valid exchange; another address is unaffected", async () => {
    const h = ip();
    for (let i = 0; i < OAUTH_TOKEN_PER_IP; i++) expect((await token.POST(form({ grant_type: "refresh_token", client_id: "nc_nobody" }, h))).status, `attempt ${i + 1}`).toBe(400);
    const { exchange } = await setup(false);
    const blocked = await token.POST(form(exchange, h));
    expect(blocked.status, "the budget is spent, so even a valid exchange is refused").toBe(429);
    expect(await blocked.json()).toMatchObject({ error: "slow_down" });
    expect(blocked.headers.get("access-control-allow-origin")).toBe("*");
    expect(blocked.headers.get("cache-control")).toBe("no-store");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // The refused request never reached the code, so the same exchange from another address still works.
    expect((await token.POST(form(exchange, ip()))).status).toBe(200);
  });

  it("register: one address may add its allowance of clients, then 429 slow_down with CORS; another address is unaffected", async () => {
    const h = ip();
    const reg = (headers: Record<string, string>) => register.POST(post("/api/oauth/register", { redirect_uris: [REDIRECT], client_name: "flood" }, headers));
    for (let i = 0; i < OAUTH_REGISTER_PER_IP; i++) expect((await reg(h)).status, `registration ${i + 1}`).toBe(201);
    const blocked = await reg(h);
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body).toMatchObject({ error: "slow_down" });
    expect(body.client_id).toBeUndefined();
    expect(blocked.headers.get("access-control-allow-origin")).toBe("*");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await reg(ip())).status).toBe(201);
  });

  it("a refused registration (bad redirect URI) still counts toward the allowance", async () => {
    const h = ip();
    for (let i = 0; i < OAUTH_REGISTER_PER_IP; i++) expect((await register.POST(post("/api/oauth/register", { redirect_uris: ["http://evil.example/cb"] }, h))).status).toBe(400);
    expect((await register.POST(post("/api/oauth/register", { redirect_uris: [REDIRECT] }, h))).status).toBe(429);
  });
});
