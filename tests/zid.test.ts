import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jar, json, newUser, signIn } from "./helpers/session";
import { importZid, zidStore } from "@/lib/connectors/zid";
import { getConnection, OAUTH_COOKIE, saveConnection, saveState, type Connection } from "@/lib/connectors/store";
import { readFile } from "@/lib/files";
import * as callback from "@/app/api/connect/[provider]/callback/route";
import * as connectRoute from "@/app/api/connect/[provider]/route";

/**
 * Rule 72: the Zid connector imports the store's products into products.md from Zid's fixed API host, sending the two
 * tokens Zid issues (the bearer `authorization` and the X-Manager-Token `access_token`) and the store id, which the
 * callback records from the manager profile. The network is mocked with the shapes Zid's docs describe: products as
 * `{ count, next, previous, results }` with `{ ar, en }` names, the profile as `{ user: { store: { id, title, url } } }`.
 */
const conn = (over: Partial<Connection> = {}): Connection => ({ provider: "zid", data: { access_token: "mgr", authorization: "auth", refresh_token: "r" }, meta: { account: "متجر النخلة", storeId: "77" }, connectedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300 * 864e5).toISOString(), ...over });

const product = (ar: string, extra: Record<string, unknown> = {}) => ({ name: { ar, en: "" }, price: 80, sale_price: null, currency: "SAR", description: { ar: "<p>تمر <b>سكري</b></p>" }, html_url: `https://nakhla.example/p/${encodeURIComponent(ar)}`, is_published: true, ...extra });

const realFetch = globalThis.fetch;
let calls: { url: string; headers: Record<string, string> }[] = [];
function fakeZid(pages: unknown[][], opts: { status?: number } = {}) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    if (url.startsWith("https://oauth.zid.sa/oauth/token")) return Response.json({ access_token: "mgr", authorization: "auth", refresh_token: "r", expires_in: 31536000, token_type: "Bearer" });
    expect(headers.Authorization).toBe("Bearer auth");
    expect(headers["X-Manager-Token"]).toBe("mgr");
    if (url === "https://api.zid.sa/v1/managers/account/profile") return Response.json({ user: { id: 1, name: "مدير", store: { id: 77, title: "متجر النخلة", url: "https://nakhla.example" } } });
    if (url.startsWith("https://api.zid.sa/v1/products/")) {
      if (opts.status) return new Response("nope", { status: opts.status });
      const page = Number(new URL(url).searchParams.get("page"));
      const more = page < pages.length;
      return Response.json({ count: pages.flat().length, next: more ? `https://api.zid.sa/v1/products/?page=${page + 1}` : null, previous: null, results: pages[page - 1] ?? [] });
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

describe("Zid product import (rule 72)", () => {
  it("walks the pages with both tokens and the store id, skips unpublished products, and writes a readable catalog", async () => {
    fakeZid([[product("سكري القصيم", { sale_price: 65 }), product("مسودة", { is_published: false })], [product("خلاص الأحساء")]]);
    const u = await newUser("zid");
    expect(await importZid(u.email, conn())).toBe(2);
    const productCalls = calls.filter((c) => c.url.includes("/products/"));
    expect(productCalls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
    for (const c of productCalls) expect(c.headers["Store-Id"]).toBe("77");
    const md = (await readFile(u.email, "products.md"))!.content;
    expect(md).toContain("# Product catalog (Zid متجر النخلة,");
    expect(md).toContain("**سكري القصيم** — 65 SAR (was 80 SAR)");
    expect(md).toContain("**خلاص الأحساء** — 80 SAR");
    expect(md).toContain("تمر سكري");
    expect(md).not.toContain("<p>");
    expect(md).not.toContain("مسودة");
  });

  it("stops after three pages however large the store is", async () => {
    fakeZid(Array.from({ length: 6 }, (_, i) => [product(`p${i}`)]));
    const u = await newUser("zid");
    expect(await importZid(u.email, conn())).toBe(3);
    expect(calls.filter((c) => c.url.includes("/products/"))).toHaveLength(3);
  });

  it("asks the profile for the store id when an older connection has none", async () => {
    fakeZid([[product("عجوة")]]);
    const u = await newUser("zid");
    expect(await importZid(u.email, conn({ meta: {} }))).toBe(1);
    expect(calls[0].url).toBe("https://api.zid.sa/v1/managers/account/profile");
    expect(calls.find((c) => c.url.includes("/products/"))?.headers["Store-Id"]).toBe("77");
  });

  it("fails loudly on a refused request instead of writing an empty catalog", async () => {
    fakeZid([], { status: 401 });
    const u = await newUser("zid");
    await expect(importZid(u.email, conn())).rejects.toThrow("zid 401");
    expect(await readFile(u.email, "products.md")).toBeNull();
  });

  it("imports through the connect route for the signed-in workspace, and a refused token asks for a reconnect", async () => {
    fakeZid([[product("عجوة")]]);
    const u = await newUser("zidr");
    await saveConnection(u.email, conn());
    await signIn(u.email);
    const res = await connectRoute.POST(json("/api/connect/zid", "POST", { action: "import_products" }), { params: Promise.resolve({ provider: "zid" }) });
    expect(await res.json()).toEqual({ ok: true, count: 1 });

    fakeZid([], { status: 401 });
    const bad = await connectRoute.POST(json("/api/connect/zid", "POST", { action: "import_products" }), { params: Promise.resolve({ provider: "zid" }) });
    expect((await bad.json()).error).toBe("reconnect_required");
    expect((await getConnection(u.email, "zid"))?.needsReconnect).toBeTruthy();
  });
});

describe("connecting Zid records the store (rule 72)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => { for (const k of ["ZID_CLIENT_ID", "ZID_CLIENT_SECRET"]) { saved[k] = process.env[k]; process.env[k] = "test"; } });
  afterAll(() => { for (const k of Object.keys(saved)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

  it("reads the store id, name and address from the manager profile", async () => {
    fakeZid([]);
    expect(await zidStore(conn({ meta: {} }))).toEqual({ id: "77", name: "متجر النخلة", url: "https://nakhla.example" });
  });

  it("keeps both tokens and the store id on the connection after the OAuth callback", async () => {
    fakeZid([]);
    const u = await newUser("zidcb");
    await saveState("s-zid", { email: u.email, provider: "zid", lang: "ar", shop: "", verifier: "" });
    await signIn(u.email);
    jar().set(OAUTH_COOKIE, "s-zid");
    const res = await callback.GET(new Request("https://app.test/api/connect/zid/callback?state=s-zid&code=c"), { params: Promise.resolve({ provider: "zid" }) });
    expect(new URL(res.headers.get("location")!).searchParams.get("connected")).toBe("zid");
    const c = await getConnection(u.email, "zid");
    expect(c?.data).toMatchObject({ access_token: "mgr", authorization: "auth" });
    expect(c?.meta).toMatchObject({ storeId: "77", account: "متجر النخلة", site: "https://nakhla.example" });
  });
});
