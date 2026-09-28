import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jar, json, newUser, signIn } from "./helpers/session";
import { importZid, zidStore } from "@/lib/connectors/zid";
import { getConnection, OAUTH_COOKIE, saveConnection, saveState, type Connection } from "@/lib/connectors/store";
import { readFile } from "@/lib/files";
import * as callback from "@/app/api/connect/[provider]/callback/route";
import * as connectRoute from "@/app/api/connect/[provider]/route";

/**
 * Rule 77: the Zid connector imports the store's products into products.md from Zid's fixed API host, sending the two
 * tokens Zid issues (the bearer `authorization` and the X-Manager-Token `access_token`) and the store id, which the
 * callback records from the manager profile. The network is mocked with the shapes Zid's docs describe: products as
 * `{ count, next, previous, results }` with `{ ar, en }` names, the profile as `{ user: { store: { id, title, url } } }`.
 * Orders and abandoned carts reach the workspace as totals only, mocked with the shapes of Zid's official Python SDK
 * fixtures: `{ orders, total_order_count }` with a decimal-string `order_total`, and carts under "abandoned-carts".
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

describe("Zid product import (rule 77)", () => {
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

  it("prefers Arabic names, shows no discount when the sale price equals the price, and skips the profile when the store id is known", async () => {
    fakeZid([[product("تمر", { name: { ar: "تمر", en: "Dates" }, sale_price: 80 })]]);
    const u = await newUser("zid");
    expect(await importZid(u.email, conn())).toBe(1);
    const md = (await readFile(u.email, "products.md"))!.content;
    expect(md).toContain("**تمر** — 80 SAR");
    expect(md).not.toContain("Dates");
    expect(md).not.toContain("(was");
    expect(calls.some((c) => c.url.includes("/managers/account/profile"))).toBe(false);
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

  it("reports a refused products permission without marking the connection for reconnecting", async () => {
    fakeZid([], { status: 403 });
    const u = await newUser("zid403p");
    await saveConnection(u.email, conn());
    await signIn(u.email);
    const res = await connectRoute.POST(json("/api/connect/zid", "POST", { action: "import_products" }), { params: Promise.resolve({ provider: "zid" }) });
    expect((await res.json()).error).toBe("zid_access_denied");
    expect((await getConnection(u.email, "zid"))?.needsReconnect).toBeFalsy();
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

describe("connecting Zid records the store (rule 77)", () => {
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

describe("Zid orders and abandoned carts, as totals only (rule 77)", () => {
  // Zid's answers carry customer details; none of them may reach the snapshot, the file or the model.
  const NOW = new Date("2026-09-28T09:00:00Z");
  const order = (created: string, total: string | number | null, code: string, products: { name: string; quantity: number }[] = [], payment = "paid", id: number | string = Math.random()) => ({ id, code: "Z1", created_at: created, order_total: total ?? undefined, order_total_string: `${total} SAR`, currency_code: "SAR", order_status: { name: `label-${code}`, code }, payment_status: payment, customer: { name: "ريم العتيبي", email: "reem@example.com", mobile: "+966500000001" }, products });
  const cart = (id: string, total: number | null, phase = "shipping_method", created = "2026-09-27 10:00:00", currency: string | undefined = "SAR") => ({ id, phase, cart_total: total, cart_total_string: `${total} SAR`, currency_code: currency, customer_name: "سلمان", customer_mobile: "+966500000002", customer_email: "s@example.com", url: `https://nakhla.example/cart/${id}/secret`, whatsapp_message: "مرحبا سلمان", products_count: 1, created_at: created });
  let salesCalls: string[] = [];
  function fakeSales(orderPages: unknown[][], cartPages: unknown[][], details: Record<string, { name: string; quantity: number }[]>, opts: { total?: number; status?: number; orderStatus?: number; cartStatus?: number; cartStatusPage?: number; ordersBody?: unknown } = {}) {
    salesCalls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      salesCalls.push(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(u.host).toBe("api.zid.sa");
      expect(headers.Authorization).toBe("Bearer auth");
      expect(headers["X-Manager-Token"]).toBe("mgr");
      expect(headers["Store-Id"]).toBe("77");
      if (opts.status) return new Response("no", { status: opts.status });
      const page = Number(u.searchParams.get("page") ?? 1);
      if (u.pathname === "/v1/managers/store/orders") {
        if (opts.orderStatus) return new Response("no", { status: opts.orderStatus });
        return Response.json(opts.ordersBody ?? { status: "object", orders: orderPages[page - 1] ?? [], total_order_count: opts.total ?? orderPages.flat().length, grand_total: 0, message: {} });
      }
      if (u.pathname === "/v1/managers/store/abandoned-carts") return opts.cartStatus && (!opts.cartStatusPage || opts.cartStatusPage === page) ? new Response("no", { status: opts.cartStatus }) : Response.json({ "abandoned-carts": cartPages[page - 1] ?? [] });
      const id = decodeURIComponent(u.pathname.split("/").pop()!);
      if (u.pathname.startsWith("/v1/managers/store/abandoned-carts/")) return Response.json({ abandoned_cart: { id, customer_name: "سلمان", customer_mobile: "+966500000002", products: details[id] ?? [] } });
      return new Response("not mocked", { status: 500 });
    }) as typeof fetch;
  }

  it("sums the last 30 days of orders without canceled, reversed or refunded ones, counts open carts, and ranks products", async () => {
    fakeSales(
      [[order("2026-09-20 12:00:00", "300.00000000000000", "delivered", [{ name: "سكري القصيم", quantity: 2 }]), order("2026-09-19 12:00:00", "150", "cancelled", [{ name: "سكري القصيم", quantity: 9 }]), order("2026-09-18 12:00:00", "80", "reversed"), order("2026-09-17 12:00:00", "70", "new", [], "refunded"), order("2026-09-16 12:00:00", "200.5", "partially_reversed", [{ name: "خلاص", quantity: 1 }, { name: "سكري القصيم", quantity: 1 }]), order("2026-09-15 12:00:00", null, "new"), order("2026-09-14 12:00:00", "40", "canceled"), order("2026-09-13 12:00:00", "30", "reverse_in_progress"), order("2026-09-12 12:00:00", "20", "new", [], "voided")]],
      [[cart("c1", 90), cart("c2", 60.5), cart("c3", 400, "completed")]],
      { c1: [{ name: "خلاص", quantity: 1 }], c2: [{ name: "خلاص", quantity: 2 }], c3: [{ name: "لا يُحتسب", quantity: 5 }] },
    );
    const { zidSales } = await import("@/lib/connectors/zid");
    const s = await zidSales(conn(), NOW);
    const orders = new URL(salesCalls.find((c) => c.includes("/orders"))!);
    expect(orders.searchParams.get("payload_type")).toBe("default");
    expect(orders.searchParams.get("sort_by")).toBe("desc");
    expect(orders.searchParams.get("date_from")).toBe("2026-08-28");
    expect(orders.searchParams.has("date_to")).toBe(false);
    expect(new URL(salesCalls.find((c) => c.includes("/abandoned-carts?"))!).searchParams.get("page_size")).toBe("100");
    expect(s.provider).toBe("zid");
    expect(s.orders).toMatchObject({ count: 9, read: 9, canceled: 6, revenue: { SAR: 500.5 } });
    expect(s.orders.top).toEqual([{ name: "سكري القصيم", qty: 3 }, { name: "خلاص", qty: 1 }]);
    // The completed cart became an order: it is neither counted nor read for products.
    expect(s.carts).toMatchObject({ count: 2, read: 2, value: { SAR: 150.5 } });
    expect(s.carts.top).toEqual([{ name: "خلاص", qty: 3 }]);
    expect(salesCalls.some((c) => c.endsWith("/abandoned-carts/c3"))).toBe(false);
    expect(s.unread).toBe(1); // the order with no readable total is counted, never guessed
    for (const pii of ["ريم", "reem@example.com", "+9665", "سلمان", "secret", "مرحبا"]) expect(JSON.stringify(s)).not.toContain(pii);
  });

  it("drops orders outside the 30 days when the date filter was not applied, stops there, and never reports the store's total", async () => {
    fakeSales([[order("2026-09-20 12:00:00", "100", "delivered"), order("2026-07-01 12:00:00", "999", "delivered")]], [[]], {}, { total: 2689 });
    const { zidSales } = await import("@/lib/connectors/zid");
    const s = await zidSales(conn(), NOW);
    expect(s.orders).toMatchObject({ count: 1, read: 1, revenue: { SAR: 100 } });
  });

  it("stops at five pages and reports the count as a floor, never the store's all-time total", async () => {
    const full = (p: number) => Array.from({ length: 100 }, (_, i) => order(`2026-09-${String(10 + (i % 15)).padStart(2, "0")} 12:00:00`, "1", "delivered", [{ name: `p${p}`, quantity: 1 }]));
    fakeSales(Array.from({ length: 9 }, (_, p) => full(p)), [[]], {}, { total: 900 });
    const { zidSales } = await import("@/lib/connectors/zid");
    const s = await zidSales(conn(), NOW);
    expect(salesCalls.filter((c) => c.includes("/orders?"))).toHaveLength(5);
    expect(s.orders).toMatchObject({ count: 500, read: 500, capped: true, revenue: { SAR: 500 } });
    const { salesMarkdown } = await import("@/lib/connectors/sales");
    expect(salesMarkdown(s)).toContain("Orders: 500 or more (totals below cover the latest 500)");
  });

  it("marks carts capped past three full pages and reads products for the newest twenty only", async () => {
    const page = (p: number) => Array.from({ length: 100 }, (_, i) => cart(`k${p}-${i}`, 1, "payment_method", `2026-09-${String(1 + ((p * 100 + i) % 27)).padStart(2, "0")} 10:00:00`));
    fakeSales([[]], [page(0), page(1), page(2), page(3)], {});
    const { zidSales, CART_DETAILS } = await import("@/lib/connectors/zid");
    const s = await zidSales(conn(), NOW);
    expect(salesCalls.filter((c) => c.includes("/abandoned-carts?"))).toHaveLength(3);
    expect(s.carts).toMatchObject({ count: 300, read: 300, capped: true });
    expect(salesCalls.filter((c) => /\/abandoned-carts\/[^?]+$/.test(c))).toHaveLength(CART_DETAILS);
  });

  it("counts a Riyadh after-midnight order on a late-UTC sync, and holds the 30-day edge to the hour", async () => {
    const late = new Date("2026-09-27T22:30:00Z"); // 01:30 on 28 September in Riyadh
    fakeSales([[order("2026-09-28 00:45:00", "100", "delivered"), order("2026-08-29 01:31:00", "7", "delivered"), order("2026-08-29 01:29:00", "999", "delivered")]], [[]], {});
    const { zidSales } = await import("@/lib/connectors/zid");
    const s = await zidSales(conn(), late);
    expect(s.orders).toMatchObject({ count: 2, revenue: { SAR: 107 } });
    expect(new URL(salesCalls.find((c) => c.includes("/orders?"))!).searchParams.has("date_to")).toBe(false);
  });

  it("stops paging at the first page that reaches past the window, even when the store has many more orders", async () => {
    const page1 = [...Array.from({ length: 90 }, (_, i) => order("2026-09-20 12:00:00", "1", "delivered", [], "paid", `n${i}`)), ...Array.from({ length: 10 }, (_, i) => order("2026-07-01 12:00:00", "1", "delivered", [], "paid", `o${i}`))];
    const full = Array.from({ length: 100 }, (_, i) => order("2026-06-01 12:00:00", "1", "delivered", [], "paid", `x${i}`));
    fakeSales([page1, full, full, full], [[]], {}, { total: 2689 });
    const { zidSales } = await import("@/lib/connectors/zid");
    const s = await zidSales(conn(), NOW);
    expect(salesCalls.filter((c) => c.includes("/orders?"))).toHaveLength(1);
    expect(s.orders.count).toBe(90);
    expect(s.orders.capped).toBeUndefined();
  });

  it("does not mark the count capped when the fifth page was the last", async () => {
    const full = (p: number) => Array.from({ length: 100 }, (_, i) => order("2026-09-20 12:00:00", "1", "delivered", [], "paid", `${p}-${i}`));
    fakeSales([full(0), full(1), full(2), full(3), full(4).slice(0, 50)], [[]], {}, { total: 450 });
    const { zidSales } = await import("@/lib/connectors/zid");
    const s = await zidSales(conn(), NOW);
    expect(s.orders).toMatchObject({ count: 450 });
    expect(s.orders.capped).toBeUndefined();
  });

  it("reads products for the twenty newest carts, counts a cart once across pages, and keeps unreadable and currency-less carts honest", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => cart(`k${i}`, 1, "payment_method", `2026-09-${String(1 + (i % 27)).padStart(2, "0")} ${String(i % 24).padStart(2, "0")}:00:00`));
    const page2 = [page1[99], { ...cart("nocur", 5, "new", "2026-08-01 10:00:00"), currency_code: undefined }, cart("bad", null, "new", "2026-08-01 10:00:00")];
    fakeSales([[]], [page1, page2], {});
    const { zidSales } = await import("@/lib/connectors/zid");
    const s = await zidSales(conn(), NOW);
    expect(s.carts).toMatchObject({ count: 102, value: { SAR: 100, "": 5 } });
    expect(s.unread).toBe(1);
    const newest = [...page1].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20).map((c) => c.id).sort();
    const fetched = salesCalls.filter((c) => /\/abandoned-carts\/[^?]+$/.test(c)).map((c) => c.split("/").pop()!).sort();
    expect(fetched).toEqual(newest);
  });

  it("fails the sync on any cart error other than a refused permission, and forgets carts read before a later 403", async () => {
    fakeSales([[order("2026-09-20 12:00:00", "1", "delivered")]], [[]], {}, { cartStatus: 500 });
    const { zidSales } = await import("@/lib/connectors/zid");
    await expect(zidSales(conn(), NOW)).rejects.toThrow("zid 500");
    fakeSales([[order("2026-09-20 12:00:00", "1", "delivered")]], [[]], {}, { cartStatus: 401 });
    await expect(zidSales(conn(), NOW)).rejects.toThrow("zid 401");
    const full = Array.from({ length: 100 }, (_, i) => cart(`c${i}`, 1));
    fakeSales([[order("2026-09-20 12:00:00", "1", "delivered")]], [full, full], {}, { cartStatus: 403, cartStatusPage: 2 });
    const s = await zidSales(conn(), NOW);
    expect(s.carts).toMatchObject({ count: 0, read: 0, value: {}, unavailable: true });
    expect(salesCalls.some((c) => /\/abandoned-carts\/[^?]+$/.test(c))).toBe(false);
  });

  it("counts an order once when it shows up on two pages, and never turns a missing currency into SAR", async () => {
    const dup = order("2026-09-20 12:00:00", "10", "delivered", [], "paid", 42);
    const noCur = { ...order("2026-09-19 12:00:00", "5", "delivered"), currency_code: undefined };
    fakeSales([[...Array.from({ length: 99 }, (_, i) => order("2026-09-21 12:00:00", "1", "delivered", [], "paid", `a${i}`)), dup], [dup, noCur]], [[]], {}, { total: 102 });
    const { zidSales } = await import("@/lib/connectors/zid");
    const s = await zidSales(conn(), NOW);
    expect(s.orders).toMatchObject({ count: 101, read: 101, revenue: { SAR: 109, "": 5 } });
  });

  it("fails the sync on an answer that is not the orders list, instead of reporting zero orders", async () => {
    fakeSales([], [[]], {}, { ordersBody: { status: "error", message: { type: "object" } } });
    const { zidSales } = await import("@/lib/connectors/zid");
    await expect(zidSales(conn(), NOW)).rejects.toThrow("zid unexpected_orders");
  });

  it("keeps the orders when the store refuses the carts, and says carts are unavailable rather than zero", async () => {
    fakeSales([[order("2026-09-20 12:00:00", "300", "delivered", [{ name: "سكري القصيم", quantity: 1 }])]], [], {}, { cartStatus: 403 });
    const { zidSales } = await import("@/lib/connectors/zid");
    const s = await zidSales(conn(), NOW);
    expect(s.orders).toMatchObject({ count: 1, revenue: { SAR: 300 } });
    expect(s.carts).toMatchObject({ count: 0, unavailable: true, top: [] });
    const { salesMarkdown } = await import("@/lib/connectors/sales");
    const md = salesMarkdown(s);
    expect(md).toContain("Their number and value are unknown, not zero.");
    expect(md).not.toContain("Open abandoned carts: 0");
  });

  it("reports a refused orders permission without marking the connection for reconnecting", async () => {
    fakeSales([], [], {}, { orderStatus: 403 });
    const u = await newUser("zid403");
    await saveConnection(u.email, conn());
    await signIn(u.email);
    const res = await connectRoute.POST(json("/api/connect/zid", "POST", { action: "sync_sales" }), { params: Promise.resolve({ provider: "zid" }) });
    expect((await res.json()).error).toBe("zid_access_denied");
    expect((await getConnection(u.email, "zid"))?.needsReconnect).toBeFalsy();
  });

  it("syncs through the connect route into the snapshot and store-sales.md, and a refused token asks for a reconnect", async () => {
    fakeSales([[order("2026-09-20 12:00:00", "300", "delivered", [{ name: "سكري القصيم", quantity: 2 }])]], [[cart("c1", 90)]], { c1: [{ name: "خلاص", quantity: 1 }] });
    const u = await newUser("zidsales");
    await saveConnection(u.email, conn());
    await signIn(u.email);
    const res = await connectRoute.POST(json("/api/connect/zid", "POST", { action: "sync_sales" }), { params: Promise.resolve({ provider: "zid" }) });
    expect((await res.json()).ok).toBe(true);
    const { getSalesSnapshot } = await import("@/lib/store-sales");
    expect((await getSalesSnapshot(u.email))?.provider).toBe("zid");
    const md = (await readFile(u.email, "store-sales.md"))!.content;
    expect(md).toContain("# Store sales (Zid متجر النخلة, last 30 days");
    expect(md).toContain("Value left in them: 90 SAR");
    expect(md).not.toContain("سلمان");

    fakeSales([], [], {}, { status: 401 });
    const bad = await connectRoute.POST(json("/api/connect/zid", "POST", { action: "sync_sales" }), { params: Promise.resolve({ provider: "zid" }) });
    expect((await bad.json()).error).toBe("reconnect_required");
    expect((await getConnection(u.email, "zid"))?.needsReconnect).toBeTruthy();
  });
});
