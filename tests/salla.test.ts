import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jar, json, newUser, signIn } from "./helpers/session";
import { sc } from "@/lib/auth";
import { importSalla, sallaStore } from "@/lib/connectors/salla";
import { getConnection, OAUTH_COOKIE, saveConnection, saveState, type Connection } from "@/lib/connectors/store";
import { readFile } from "@/lib/files";
import * as callback from "@/app/api/connect/[provider]/callback/route";
import * as connectRoute from "@/app/api/connect/[provider]/route";

/**
 * Rule 71: the Salla connector imports the store's products into products.md from Salla's own API, with no host taken
 * from the request, and shows the store it connected to. The network is mocked with the response shape Salla's
 * published SDK and actions map describe: `{ data: [...], pagination: { currentPage, totalPages } }`.
 */
const conn = (over: Partial<Connection> = {}): Connection => ({ provider: "salla", data: { access_token: "tok", refresh_token: "r" }, meta: { account: "متجر الورد" }, connectedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 14 * 864e5).toISOString(), ...over });

const product = (name: string, extra: Record<string, unknown> = {}) => ({ name, price: { amount: 120, currency: "SAR" }, description: "<p>عطر <b>فاخر</b></p>", status: "sale", urls: { customer: `https://store.example/p/${encodeURIComponent(name)}` }, ...extra });

const realFetch = globalThis.fetch;
let calls: string[] = [];
function fakeSalla(pages: unknown[][], opts: { status?: number } = {}) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://accounts.salla.sa/oauth2/token")) return Response.json({ access_token: "tok", refresh_token: "r", expires_in: 1209600 });
    // Every API call after the token exchange carries the stored access token.
    expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer tok");
    if (url === "https://accounts.salla.sa/oauth2/user/info") return Response.json({ data: { merchant: { name: "متجر الورد", domain: "https://ward.example" } } });
    if (url.startsWith("https://api.salla.dev/admin/v2/products")) {
      if (opts.status) return new Response("nope", { status: opts.status });
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json({ status: 200, success: true, data: pages[page - 1] ?? [], pagination: { count: (pages[page - 1] ?? []).length, total: pages.flat().length, perPage: 50, currentPage: page, totalPages: pages.length } });
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

describe("Salla product import (rule 71)", () => {
  it("walks the pages, skips hidden and deleted products, and writes a readable catalog", async () => {
    fakeSalla([[product("عود ملكي", { sale_price: { amount: 99, currency: "SAR" } }), product("مخفي", { status: "hidden" })], [product("مسك أبيض"), product("محذوف", { status: "deleted" })]]);
    const u = await newUser("salla");
    expect(await importSalla(sc(u), conn())).toBe(2);
    expect(calls.filter((c) => c.includes("/products")).map((c) => new URL(c).searchParams.get("page"))).toEqual(["1", "2"]);
    const md = (await readFile(sc(u), "products.md"))!.content;
    expect(md).toContain("# Product catalog (Salla متجر الورد,");
    expect(md).toContain("**عود ملكي** — 99 SAR (was 120 SAR)");
    expect(md).toContain("**مسك أبيض** — 120 SAR");
    expect(md).toContain("عطر فاخر");
    expect(md).not.toContain("<p>");
    expect(md).not.toContain("مخفي");
    expect(md).not.toContain("محذوف");
  });

  it("stops after three pages however large the store is", async () => {
    fakeSalla(Array.from({ length: 6 }, (_, i) => [product(`p${i}`)]));
    const u = await newUser("salla");
    expect(await importSalla(sc(u), conn())).toBe(3);
    expect(calls.filter((c) => c.includes("/products"))).toHaveLength(3);
  });

  it("fails loudly on a refused request instead of writing an empty catalog", async () => {
    fakeSalla([], { status: 401 });
    const u = await newUser("salla");
    await expect(importSalla(sc(u), conn())).rejects.toThrow("salla 401");
    expect(await readFile(sc(u), "products.md")).toBeNull();
  });

  it("imports through the connect route for the signed-in workspace, and a refused token asks for a reconnect", async () => {
    fakeSalla([[product("عود")]]);
    const u = await newUser("sallar");
    await saveConnection(sc(u), conn());
    await signIn(u.email);
    const res = await connectRoute.POST(json("/api/connect/salla", "POST", { action: "import_products" }), { params: Promise.resolve({ provider: "salla" }) });
    expect(await res.json()).toEqual({ ok: true, count: 1 });

    fakeSalla([], { status: 401 });
    const bad = await connectRoute.POST(json("/api/connect/salla", "POST", { action: "import_products" }), { params: Promise.resolve({ provider: "salla" }) });
    expect((await bad.json()).error).toBe("reconnect_required");
    expect((await getConnection(sc(u), "salla"))?.needsReconnect).toBeTruthy();
  });
});

describe("connecting Salla shows the store (rule 71)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => { for (const k of ["SALLA_CLIENT_ID", "SALLA_CLIENT_SECRET"]) { saved[k] = process.env[k]; process.env[k] = "test"; } });
  afterAll(() => { for (const k of Object.keys(saved)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

  it("reads the merchant's name and domain", async () => {
    fakeSalla([]);
    expect(await sallaStore(conn())).toEqual({ name: "متجر الورد", domain: "https://ward.example" });
  });

  it("stores the store name on the connection after the OAuth callback", async () => {
    fakeSalla([]);
    const u = await newUser("sallacb");
    await saveState("s-salla", { email: sc(u), provider: "salla", lang: "ar", shop: "", verifier: "" });
    await signIn(u.email);
    jar().set(OAUTH_COOKIE, "s-salla");
    const res = await callback.GET(new Request("https://app.test/api/connect/salla/callback?state=s-salla&code=c"), { params: Promise.resolve({ provider: "salla" }) });
    expect(new URL(res.headers.get("location")!).searchParams.get("connected")).toBe("salla");
    const c = await getConnection(sc(u), "salla");
    expect(c?.meta).toMatchObject({ account: "متجر الورد", site: "https://ward.example" });
  });
});

describe("Salla orders and abandoned carts, as totals only (rule 72)", () => {
  // Salla's list responses carry customer details; none of them may reach the snapshot, the file or the model.
  const order = (total: number | null, status: string, items: { name: string; quantity: number }[] = []) => ({ id: Math.random(), reference_id: 1001, total: total == null ? undefined : { amount: total, currency: "SAR" }, status: { slug: status, name: status }, customer: { first_name: "ريم", last_name: "العتيبي", mobile: "+966500000001", email: "reem@example.com" }, items });
  const cart = (total: number, items: { name: string; quantity: number }[]) => ({ id: Math.random(), total: { amount: total, currency: "SAR" }, customer: { name: "سلمان", mobile: "+966500000002" }, checkout_url: "https://ward.example/checkout/secret", items });

  function fakeSales(orderPages: unknown[][], cartPages: unknown[][], opts: { orderTotal?: number } = {}) {
    calls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(String(input));
      const page = Number(url.searchParams.get("page") ?? 1);
      const list = (pages: unknown[][], total?: number) => Response.json({ data: pages[page - 1] ?? [], pagination: { total: total ?? pages.flat().length, currentPage: page, totalPages: pages.length } });
      if (url.pathname === "/admin/v2/orders") return list(orderPages, opts.orderTotal);
      if (url.pathname === "/admin/v2/carts/abandoned") return list(cartPages);
      return new Response("not mocked", { status: 500 });
    }) as typeof fetch;
  }

  it("sums the last 30 days of orders without canceled or refunded ones, counts carts and their value, and ranks products", async () => {
    fakeSales(
      [[order(300, "completed", [{ name: "عود ملكي", quantity: 2 }]), order(150, "canceled", [{ name: "عود ملكي", quantity: 5 }])], [order(200, "delivered", [{ name: "مسك أبيض", quantity: 1 }, { name: "عود ملكي", quantity: 1 }]), order(null, "completed")]],
      [[cart(90, [{ name: "مسك أبيض", quantity: 1 }]), cart(60.5, [{ name: "مسك أبيض", quantity: 2 }])]],
    );
    const { sallaSales } = await import("@/lib/connectors/salla");
    const s = await sallaSales(conn(), new Date("2026-09-28T09:00:00Z"));
    const orders = calls.filter((c) => c.includes("/orders"));
    expect(new URL(orders[0]).searchParams.get("from_date")).toBe("2026-08-29");
    expect(new URL(orders[0]).searchParams.get("to_date")).toBe("2026-09-28");
    expect(orders).toHaveLength(2);
    expect(s.orders).toMatchObject({ count: 4, read: 4, canceled: 1, revenue: { SAR: 500 } });
    expect(s.orders.top).toEqual([{ name: "عود ملكي", qty: 3 }, { name: "مسك أبيض", qty: 1 }]);
    expect(s.carts).toMatchObject({ count: 2, read: 2, value: { SAR: 150.5 } });
    expect(s.carts.top).toEqual([{ name: "مسك أبيض", qty: 3 }]);
    expect(s.unread).toBe(1); // the order with no readable total is counted, never guessed
  });

  it("stores the snapshot and writes store-sales.md with no customer detail, and Noor reads it", async () => {
    fakeSales([[order(300, "completed", [{ name: "عود ملكي", quantity: 2 }])]], [[cart(90, [{ name: "مسك أبيض", quantity: 1 }])]], { orderTotal: 40 });
    const u = await newUser("sales");
    await saveConnection(sc(u), conn());
    await signIn(u.email);
    const res = await connectRoute.POST(json("/api/connect/salla", "POST", { action: "sync_sales" }), { params: Promise.resolve({ provider: "salla" }) });
    const j = await res.json();
    expect(j.ok).toBe(true);
    const { getSalesSnapshot } = await import("@/lib/store-sales");
    expect((await getSalesSnapshot(sc(u)))?.orders.count).toBe(40);
    const md = (await readFile(sc(u), "store-sales.md"))!.content;
    expect(md).toContain("Orders: 40 (totals below cover the latest 1 of 40)");
    expect(md).toContain("Revenue (excluding 0 canceled or refunded): 300 SAR");
    expect(md).toContain("عود ملكي: 2");
    expect(md).toContain("Value left in them: 90 SAR");
    for (const pii of ["ريم", "العتيبي", "+9665", "reem@example.com", "سلمان", "checkout/secret"]) {
      expect(md).not.toContain(pii);
      expect(JSON.stringify(await getSalesSnapshot(sc(u)))).not.toContain(pii);
    }
    const { memoryBlock } = await import("@/lib/files");
    expect(await memoryBlock(sc(u))).toContain("--- store-sales.md ---");
  });

  it("offers the sales sync only to store connectors that read sales", async () => {
    const u = await newUser("sales2");
    await saveConnection(sc(u), { provider: "prestashop", data: { site: "https://p.example", apiKey: "k" }, connectedAt: new Date().toISOString() });
    await signIn(u.email);
    const res = await connectRoute.POST(json("/api/connect/prestashop", "POST", { action: "sync_sales" }), { params: Promise.resolve({ provider: "prestashop" }) });
    expect(res.status).toBe(400);
  });
});
