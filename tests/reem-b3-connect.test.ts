/**
 * Reem B3, the OAuth start and callback for the secretary calendar providers (spec
 * 2026-10-05-secretary-reem-b3-calendar-read-design.md §3 and §5). Rule 910 (connect part): only the account owner starts or
 * finishes a `gcal` or `mscal` flow, the shared state, cookie, login and actor rules still hold, the link is written in state
 * `choose` and never as a publishing connection, a second link replaces the first (no revoke call, ruling R7), and no provider text ever
 * reaches a URL or a log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jar, json, newMember, newUser, params, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { SEC_KEYS } from "@/lib/secretary";
import { addBrand, listBrands, saveBrands, scopeFor } from "@/lib/brands";
import { OAUTH_COOKIE, getConnection, listConnections, saveState } from "@/lib/connectors/store";
import { getLink, openTokens, putLink, sealTokens, type CalLink } from "@/lib/secretary-cal-link";
import * as start from "@/app/api/connect/[provider]/start/route";
import * as callback from "@/app/api/connect/[provider]/callback/route";
import * as key from "@/app/api/connect/[provider]/key/route";

const ENV = { GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "msecret" };
const PROVIDER_TEXT = "SECRET-PROVIDER-TEXT";
/** Nashr never calls it (ruling R7): a Google grant is shared per user and client with the publishing connection. */
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";

const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

type Fake = { tokenStatus?: number; refresh?: string | null; hd?: string | null; email?: string; tid?: string; graphStatus?: number; mail?: string | null; orgDomains?: string[] };
let calls: { url: string; method: string; body: string }[] = [];
function fakeProviders(o: Fake = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (url === "https://oauth2.googleapis.com/token") {
      if (o.tokenStatus) return new Response(PROVIDER_TEXT, { status: o.tokenStatus });
      const t: Record<string, unknown> = { access_token: "g-access", expires_in: 3599, id_token: idToken({ email: o.email ?? "o@brand.example", email_verified: true, ...(o.hd === null ? {} : { hd: o.hd ?? "brand.example" }) }) };
      if (o.refresh !== null) t.refresh_token = o.refresh ?? "g-refresh";
      return Response.json(t);
    }
    if (url === GOOGLE_REVOKE) return new Response("{}", { status: 200 });
    if (url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
      if (o.tokenStatus) return new Response(PROVIDER_TEXT, { status: o.tokenStatus });
      return Response.json({ access_token: "m-access", refresh_token: o.refresh === null ? undefined : (o.refresh ?? "m-refresh"), expires_in: 3599, id_token: idToken({ tid: o.tid ?? "tenant-1" }) });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
      if (o.graphStatus) return new Response(PROVIDER_TEXT, { status: o.graphStatus });
      return Response.json({ userPrincipalName: o.email ?? "o@brand.example", mail: o.mail === undefined ? "o@brand.example" : o.mail });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/organization")) return Response.json({ value: [{ verifiedDomains: (o.orgDomains ?? ["brand.example"]).map((name) => ({ name })) }] });
    return new Response("not mocked", { status: 500 });
  }));
}

beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const ctx = (provider: string) => params({ provider });
const startReq = (provider: string, q = "") => new Request(`https://app.test/api/connect/${provider}/start${q}`);
const cbReq = (provider: string, q: string) => new Request(`https://app.test/api/connect/${provider}/callback?${q}`);
const where = (res: Response) => new URL(res.headers.get("location")!);
const tokenCalls = () => calls.filter((c) => c.url.endsWith("/token"));
const auditOf = async (scope: string) => (await db.lrange(SEC_KEYS.audit(scope), 0, -1)).map((x) => JSON.parse(x) as { action: string; actor: string; login?: string; diff: string });

/** Start as the signed-in owner and return the state and cookie the browser would carry back. */
async function begin(provider: string, q = "") {
  const res = await start.GET(startReq(provider, q), ctx(provider));
  expect(res.status).toBe(307);
  return jar().get(OAUTH_COOKIE)!;
}

describe("rule 912c: start for the calendar providers is owner only", () => {
  it("sends the owner to Google, and refuses an admin and a member with 403", async () => {
    const owner = await newUser("calstart");
    const admin = await newMember(owner, "admin");
    const member = await newMember(owner, "member");
    await signIn(owner.email);
    const res = await start.GET(startReq("gcal"), ctx("gcal"));
    expect(res.status).toBe(307);
    const to = where(res);
    expect(to.host).toBe("accounts.google.com");
    expect(to.searchParams.get("redirect_uri")).toMatch(/\/api\/connect\/gcal\/callback$/);
    expect(to.searchParams.get("scope")).toContain("calendar.events.owned.readonly");
    expect(to.searchParams.get("access_type")).toBe("offline");
    await signIn(admin.email);
    expect((await start.GET(startReq("gcal"), ctx("gcal"))).status).toBe(403);
    await signIn(member.email);
    expect((await start.GET(startReq("mscal"), ctx("mscal"))).status).toBe(403);
  });

  it("an admin still starts a publishing provider (the connectors gate is unchanged)", async () => {
    const owner = await newUser("calstart2");
    const admin = await newMember(owner, "admin");
    await signIn(admin.email);
    // X: a publishing provider on its own OAuth app (`google` is in `COMPOSIO_ONLY`, src/lib/connectors/registry.ts).
    vi.stubEnv("X_CLIENT_ID", "xid");
    vi.stubEnv("X_CLIENT_SECRET", "xsecret");
    expect((await start.GET(startReq("x"), ctx("x"))).status).toBe(307);
  });

  it("answers 503 provider_not_configured when the Microsoft app is not set", async () => {
    const owner = await newUser("calstart3");
    await signIn(owner.email);
    vi.stubEnv("MICROSOFT_CLIENT_ID", "");
    const res = await start.GET(startReq("mscal"), ctx("mscal"));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("provider_not_configured");
  });

  it("Outlook starts with PKCE, and an unknown provider is still a 404 for the owner", async () => {
    const owner = await newUser("calstart4");
    await signIn(owner.email);
    const res = await start.GET(startReq("mscal"), ctx("mscal"));
    expect(res.status).toBe(307);
    expect(where(res).searchParams.get("code_challenge_method")).toBe("S256");
    expect((await start.GET(startReq("nope"), ctx("nope"))).status).toBe(404);
  });
});

describe("rule 912c: the callback writes the link in state choose and never a publishing connection", () => {
  it("Google, owner, same cookie and state: 307 to the Todo page with cal=choose", async () => {
    fakeProviders();
    const owner = await newUser("calcb");
    await signIn(owner.email);
    const state = await begin("gcal");
    const res = await callback.GET(cbReq("gcal", `state=${state}&code=c1`), ctx("gcal"));
    expect(res.status).toBe(307);
    const to = where(res);
    expect(to.pathname).toBe("/ar/app/b/default/todo");
    expect(to.search).toBe("?cal=choose");
    const link = (await getLink(owner.email))!;
    expect(link).toMatchObject({ v: 1, provider: "gcal", login: owner.email, account: "o@brand.example", accountDomain: "brand.example", proof: null, state: "choose", rev: 1 });
    expect(link.calendarId).toBeUndefined();
    expect(openTokens(link)).toMatchObject({ access: "g-access", refresh: "g-refresh" });
    expect(JSON.stringify(link)).not.toContain("g-refresh");
    expect((await listConnections(owner.email)).map((c) => c.provider)).not.toContain("gcal");
    expect(await getConnection(owner.email, "gcal")).toBeNull();
    const log = await auditOf(owner.email);
    expect(log.find((l) => l.action === "cal_link")).toMatchObject({ actor: "owner", login: owner.email, diff: "provider=gcal" });
    expect(JSON.stringify(log)).not.toContain("o@brand.example");
  });

  it("the English flow lands on the English Todo page", async () => {
    fakeProviders();
    const owner = await newUser("calcb2");
    await signIn(owner.email);
    const state = await begin("gcal", "?lang=en");
    const to = where(await callback.GET(cbReq("gcal", `state=${state}&code=c1`), ctx("gcal")));
    expect(to.pathname).toBe("/en/app/b/default/todo");
  });

  it("Gmail has no proven domain: the link carries no accountDomain", async () => {
    fakeProviders({ hd: null, email: "shop@gmail.com" });
    const owner = await newUser("calcb3");
    await signIn(owner.email);
    const state = await begin("gcal");
    await callback.GET(cbReq("gcal", `state=${state}&code=c1`), ctx("gcal"));
    const link = (await getLink(owner.email))!;
    expect(link.account).toBe("shop@gmail.com");
    expect(link.accountDomain).toBeUndefined();
  });

  it("Outlook, work account: the domain comes from the verified domains; the account is mail, else the UPN", async () => {
    fakeProviders({ email: "o@brand.example", mail: null });
    const owner = await newUser("calcb4");
    await signIn(owner.email);
    const state = await begin("mscal");
    const res = await callback.GET(cbReq("mscal", `state=${state}&code=c1`), ctx("mscal"));
    expect(where(res).search).toBe("?cal=choose");
    const link = (await getLink(owner.email))!;
    expect(link).toMatchObject({ provider: "mscal", account: "o@brand.example", accountDomain: "brand.example", state: "choose" });
    // PKCE: the verifier saved at start went to the token endpoint.
    expect(tokenCalls()[0].body).toContain("code_verifier=");
    expect(calls.some((c) => c.url.includes("/me?%24select") || c.url.includes("/me?$select"))).toBe(true);
    expect(await getConnection(owner.email, "mscal")).toBeNull();
  });

  it("Outlook, personal account: no domain, and the organization is never asked", async () => {
    fakeProviders({ tid: "9188040d-6c67-4c5b-b112-36a304b66dad", email: "x@outlook.com" });
    const owner = await newUser("calcb5");
    await signIn(owner.email);
    const state = await begin("mscal");
    await callback.GET(cbReq("mscal", `state=${state}&code=c1`), ctx("mscal"));
    const link = (await getLink(owner.email))!;
    expect(link.accountDomain).toBeUndefined();
    expect(calls.some((c) => c.url.includes("/organization"))).toBe(false);
  });

  it("a link goes to the brand the flow started on, not the one active at the callback", async () => {
    fakeProviders();
    const owner = await newUser("calcb6");
    const b = (await addBrand({ ...owner, brandCap: 2 }, "Second")) as { id: string };
    const scope = scopeFor(owner.email, b.id);
    await signIn(owner.email);
    await saveState("s-brand", { email: scope, provider: "gcal", lang: "ar", shop: "", verifier: "", actor: owner.email });
    jar().set(OAUTH_COOKIE, "s-brand");
    await callback.GET(cbReq("gcal", "state=s-brand&code=c1"), ctx("gcal"));
    expect(await getLink(scope)).not.toBeNull();
    expect(await getLink(owner.email)).toBeNull();
  });
});

describe("rule 912c: the same state, cookie, login and role rules as every provider", () => {
  it("an admin finishing a state saved for their own login gets cal_error=forbidden, no link and no code exchange", async () => {
    fakeProviders();
    const owner = await newUser("calrole");
    const admin = await newMember(owner, "admin");
    await signIn(admin.email);
    await saveState("s-admin", { email: owner.email, provider: "gcal", lang: "ar", shop: "", verifier: "", actor: admin.email });
    jar().set(OAUTH_COOKIE, "s-admin");
    const res = await callback.GET(cbReq("gcal", "state=s-admin&code=c1"), ctx("gcal"));
    expect(where(res).pathname).toBe("/ar/app/b/default/todo");
    expect(where(res).search).toBe("?cal_error=forbidden");
    expect(await getLink(owner.email)).toBeNull();
    expect(tokenCalls()).toHaveLength(0);
  });

  it("a wrong cookie is session_mismatch, with no exchange", async () => {
    fakeProviders();
    const owner = await newUser("calmis");
    await signIn(owner.email);
    await saveState("s-real", { email: owner.email, provider: "gcal", lang: "ar", shop: "", verifier: "", actor: owner.email });
    jar().set(OAUTH_COOKIE, "someone-elses-state");
    const res = await callback.GET(cbReq("gcal", "state=s-real&code=c1"), ctx("gcal"));
    expect(where(res).search).toBe("?cal_error=session_mismatch");
    expect(await getLink(owner.email)).toBeNull();
    expect(tokenCalls()).toHaveLength(0);
  });

  it("a state saved for another login in the account (the actor) cannot be finished by the owner", async () => {
    fakeProviders();
    const owner = await newUser("calact");
    const admin = await newMember(owner, "admin");
    await signIn(owner.email);
    await saveState("s-act", { email: owner.email, provider: "gcal", lang: "ar", shop: "", verifier: "", actor: admin.email });
    jar().set(OAUTH_COOKIE, "s-act");
    const res = await callback.GET(cbReq("gcal", "state=s-act&code=c1"), ctx("gcal"));
    expect(where(res).search).toBe("?cal_error=session_mismatch");
    expect(await getLink(owner.email)).toBeNull();
  });

  it("a state from the google flow cannot finish gcal", async () => {
    fakeProviders();
    const owner = await newUser("calprov");
    await signIn(owner.email);
    await saveState("s-google", { email: owner.email, provider: "google", lang: "ar", shop: "", verifier: "", actor: owner.email });
    jar().set(OAUTH_COOKIE, "s-google");
    const res = await callback.GET(cbReq("gcal", "state=s-google&code=c1"), ctx("gcal"));
    expect(where(res).pathname).toBe("/ar/app/b/default/todo");
    expect(where(res).search).toBe("?cal_error=invalid_state");
    expect(await getLink(owner.email)).toBeNull();
    expect(tokenCalls()).toHaveLength(0);
  });

  it("a gcal state used at the google callback is refused with the Integrations invalid-state error and adds no connection (R4)", async () => {
    fakeProviders();
    const owner = await newUser("calrev");
    await signIn(owner.email);
    const state = await begin("gcal");
    const res = await callback.GET(cbReq("google", `state=${state}&code=c1`), ctx("google"));
    expect(where(res).pathname).toBe("/ar/app/b/default/settings/connections");
    expect(where(res).search).toBe("?error=invalid_state");
    expect(await listConnections(owner.email)).toEqual([]);
    expect(await getConnection(owner.email, "google")).toBeNull();
    expect(await getConnection(owner.email, "gcal")).toBeNull();
    expect(await getLink(owner.email)).toBeNull();
    expect(tokenCalls()).toHaveLength(0);
  });

  it("an unknown or reused state is invalid_state", async () => {
    fakeProviders();
    const owner = await newUser("caluse");
    await signIn(owner.email);
    const state = await begin("gcal");
    expect(where(await callback.GET(cbReq("gcal", `state=${state}&code=c1`), ctx("gcal"))).search).toBe("?cal=choose");
    jar().set(OAUTH_COOKIE, state);
    expect(where(await callback.GET(cbReq("gcal", `state=${state}&code=c1`), ctx("gcal"))).search).toBe("?cal_error=invalid_state");
  });

  it("consent denied is denied; any other provider error, or a missing code, is invalid_state", async () => {
    fakeProviders();
    const owner = await newUser("calden");
    await signIn(owner.email);
    let state = await begin("gcal");
    expect(where(await callback.GET(cbReq("gcal", `state=${state}&error=access_denied`), ctx("gcal"))).search).toBe("?cal_error=denied");
    state = await begin("gcal");
    expect(where(await callback.GET(cbReq("gcal", `state=${state}&error=server_error`), ctx("gcal"))).search).toBe("?cal_error=invalid_state");
    state = await begin("gcal");
    expect(where(await callback.GET(cbReq("gcal", `state=${state}`), ctx("gcal"))).search).toBe("?cal_error=invalid_state");
    expect(await getLink(owner.email)).toBeNull();
    expect(tokenCalls()).toHaveLength(0);
  });
});

describe("rule 912c: failures end in fixed codes, with no provider text and no leftover link", () => {
  it("a brand archived between start and callback is brand_inactive, with no link and no revoke call", async () => {
    fakeProviders();
    const owner = await newUser("calarch");
    const b = (await addBrand({ ...owner, brandCap: 2 }, "Gone")) as { id: string };
    const scope = scopeFor(owner.email, b.id);
    await signIn(owner.email);
    await saveState("s-arch", { email: scope, provider: "gcal", lang: "ar", shop: "", verifier: "", actor: owner.email });
    jar().set(OAUTH_COOKIE, "s-arch");
    await saveBrands(owner.email, (await listBrands(owner.email)).map((r) => (r.id === b.id ? { ...r, status: "archived" as const } : r)));
    const res = await callback.GET(cbReq("gcal", "state=s-arch&code=c1"), ctx("gcal"));
    expect(where(res).search).toBe("?cal_error=brand_inactive");
    expect(await getLink(scope)).toBeNull();
    expect(calls.some((c) => c.url === GOOGLE_REVOKE)).toBe(false);
  });

  it("a token endpoint 500 is token_failed, and neither the URL nor the log carries the provider's text", async () => {
    fakeProviders({ tokenStatus: 500 });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = await newUser("caltok");
    await signIn(owner.email);
    const state = await begin("gcal");
    const res = await callback.GET(cbReq("gcal", `state=${state}&code=c1`), ctx("gcal"));
    expect(where(res).search).toBe("?cal_error=token_failed");
    expect(res.headers.get("location")).not.toContain(PROVIDER_TEXT);
    expect(JSON.stringify(log.mock.calls)).not.toContain(PROVIDER_TEXT);
    expect(JSON.stringify(log.mock.calls)).not.toContain("500");
    expect(await getLink(owner.email)).toBeNull();
  });

  it("Google answering without a refresh token is token_failed and keeps any earlier link", async () => {
    const owner = await newUser("calnoref");
    const first: CalLink = { v: 1, provider: "gcal", login: owner.email, account: "old@brand.example", proof: "domain", calendarId: "c0", tokens: sealTokens({ access: "a0", refresh: "r0", expiresAt: 1 }), state: "ok", connectedAt: 1, rev: 4 };
    await putLink(owner.email, first);
    fakeProviders({ refresh: null });
    await signIn(owner.email);
    const state = await begin("gcal");
    const res = await callback.GET(cbReq("gcal", `state=${state}&code=c1`), ctx("gcal"));
    expect(where(res).search).toBe("?cal_error=token_failed");
    expect(await getLink(owner.email)).toEqual(first);
    expect(calls.some((c) => c.url === GOOGLE_REVOKE)).toBe(false);
  });

  it("a Graph failure is provider_error, with no link and no provider text in the URL or the log", async () => {
    fakeProviders({ graphStatus: 500 });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = await newUser("calgraph");
    await signIn(owner.email);
    const state = await begin("mscal");
    const res = await callback.GET(cbReq("mscal", `state=${state}&code=c1`), ctx("mscal"));
    expect(where(res).search).toBe("?cal_error=provider_error");
    expect(res.headers.get("location")).not.toContain(PROVIDER_TEXT);
    expect(JSON.stringify(log.mock.calls)).not.toContain(PROVIDER_TEXT);
    expect(await getLink(owner.email)).toBeNull();
  });
});

describe("rule 912c: a second link replaces the first and Nashr never calls Google's revoke endpoint (R7)", () => {
  it("drops the first link's tokens, keeps only the new link, and never calls the revoke URL", async () => {
    const owner = await newUser("calswap");
    await signIn(owner.email);
    fakeProviders({ refresh: "refresh-one" });
    let state = await begin("gcal");
    await callback.GET(cbReq("gcal", `state=${state}&code=c1`), ctx("gcal"));
    // The owner picks a calendar in between: the next link still starts over in "choose".
    const one = (await getLink(owner.email))!;
    expect(openTokens(one)?.refresh).toBe("refresh-one");
    await putLink(owner.email, { ...one, state: "ok", calendarId: "cal1", proof: "domain", rev: 5 });
    fakeProviders({ refresh: "refresh-two", email: "new@brand.example" });
    state = await begin("gcal");
    await callback.GET(cbReq("gcal", `state=${state}&code=c2`), ctx("gcal"));
    const two = (await getLink(owner.email))!;
    expect(two).toMatchObject({ account: "new@brand.example", state: "choose", proof: null, rev: 1 });
    expect(two.calendarId).toBeUndefined();
    expect(openTokens(two)?.refresh).toBe("refresh-two");
    expect(two.tokens).not.toBe(one.tokens);
    expect(JSON.stringify(await db.get(SEC_KEYS.calLink(owner.email)))).not.toContain(one.tokens);
    expect(calls.some((c) => c.url === GOOGLE_REVOKE || c.url.includes("/revoke"))).toBe(false);
    expect((await auditOf(owner.email)).filter((l) => l.action === "cal_link")).toHaveLength(2);
  });

  it("replacing an Outlook link by a Google one calls no revoke endpoint either", async () => {
    const owner = await newUser("calswap2");
    await putLink(owner.email, { v: 1, provider: "mscal", login: owner.email, account: "a@brand.example", proof: null, tokens: sealTokens({ access: "a", refresh: "r", expiresAt: 1 }), state: "choose", connectedAt: 1, rev: 1 });
    fakeProviders();
    await signIn(owner.email);
    const state = await begin("gcal");
    await callback.GET(cbReq("gcal", `state=${state}&code=c1`), ctx("gcal"));
    expect(calls.some((c) => c.url === GOOGLE_REVOKE)).toBe(false);
    expect((await getLink(owner.email))!.provider).toBe("gcal");
  });
});

describe("rule 912c: the key route never takes a calendar provider (ruling R4)", () => {
  it("POST /api/connect/gcal/key and mscal/key are 404 unknown_provider for the owner and save nothing", async () => {
    const owner = await newUser("calkey");
    await signIn(owner.email);
    for (const p of ["gcal", "mscal"]) {
      const res = await key.POST(json(`/api/connect/${p}/key`, "POST", { apiKey: "x" }), ctx(p));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("unknown_provider");
      expect(await getConnection(owner.email, p)).toBeNull();
    }
    expect((await listConnections(owner.email)).map((c) => c.provider)).not.toContain("gcal");
  });
});
