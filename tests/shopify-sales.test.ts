import { afterEach, describe, expect, it, vi } from "vitest";
import { json, newUser, signIn } from "./helpers/session";
import { API_VERSION, importShopify, publishShopifyArticle, shopifyGql, shopifySales } from "@/lib/connectors/shopify";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { readFile, memoryBlock } from "@/lib/files";
import { getSalesSnapshot } from "@/lib/store-sales";
import * as connectRoute from "@/app/api/connect/[provider]/route";

/**
 * Rule 73: Shopify orders and abandoned checkouts reach Reports and Noor as totals only. Rule 81: every Shopify call
 * goes through the Admin GraphQL API (required for new public App Store apps) on the connected *.myshopify.com host.
 * The mock answers in the shapes of the Admin GraphQL schema the queries were validated against.
 */
const SHOP = "ward.myshopify.com";
const conn = (): Connection => ({ provider: "shopify", data: { access_token: "shpat" }, meta: { shop: SHOP }, connectedAt: new Date().toISOString() });
const money = (amount: string | null) => (amount == null ? undefined : { shopMoney: { amount, currencyCode: "SAR" } });
const order = (total: string | null, extra: Record<string, unknown> = {}, items: { title: string; quantity: number }[] = []) => ({ cancelledAt: null, displayFinancialStatus: "PAID", currentTotalPriceSet: money(total), lineItems: { nodes: items }, ...extra });
const checkout = (total: string, items: { title: string; quantity: number }[], extra: Record<string, unknown> = {}) => ({ completedAt: null, totalPriceSet: money(total), lineItems: { nodes: items }, ...extra });

type Sent = { url: URL; query: string; variables: Record<string, unknown> };
const realFetch = globalThis.fetch;
let sent: Sent[] = [];
function fakeShopify(opts: { orders?: unknown[][]; checkouts?: unknown[][]; orderCount?: number | null; checkoutCount?: number | null; status?: number; errors?: { message: string; extensions: { code: string } }[]; throttleOnce?: boolean; products?: unknown[]; blogs?: unknown[] } = {}) {
  sent = [];
  let throttled = false;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    sent.push({ url, query: body.query, variables: body.variables });
    expect((init?.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat");
    if (opts.status) return new Response("{}", { status: opts.status });
    if (opts.errors) return Response.json({ errors: opts.errors });
    if (opts.throttleOnce && !throttled) { throttled = true; return Response.json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }); }
    const page = (pages: unknown[][] = [[]]) => {
      const i = body.variables.after ? Number(String(body.variables.after).split("-")[1]) : 0;
      return { nodes: pages[i] ?? [], pageInfo: { hasNextPage: i + 1 < pages.length, endCursor: i + 1 < pages.length ? `c-${i + 1}` : null } };
    };
    if (body.query.includes("query Orders")) return Response.json({ data: { orders: page(opts.orders), ordersCount: opts.orderCount === null ? null : { count: opts.orderCount ?? (opts.orders ?? [[]]).flat().length } } });
    if (body.query.includes("query Checkouts")) return Response.json({ data: { abandonedCheckouts: page(opts.checkouts), abandonedCheckoutsCount: opts.checkoutCount === null ? null : { count: opts.checkoutCount ?? (opts.checkouts ?? [[]]).flat().length } } });
    if (body.query.includes("query Products")) return Response.json({ data: { products: { nodes: opts.products ?? [] } } });
    if (body.query.includes("query Blog")) return Response.json({ data: { shop: { name: "متجر الورد" }, blogs: { nodes: opts.blogs ?? [{ id: "gid://shopify/Blog/7", handle: "news" }] } } });
    if (body.query.includes("mutation Article")) return Response.json({ data: { articleCreate: { article: { id: "gid://shopify/Article/99", handle: "oud-guide" }, userErrors: [] } } });
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

describe("Shopify goes through the Admin GraphQL API on the connected shop (rule 81)", () => {
  it("posts every call to the shop's GraphQL endpoint at a supported version", async () => {
    fakeShopify({ products: [{ title: "عود ملكي", handle: "oud", description: "عطر  فاخر", onlineStoreUrl: null, priceRangeV2: { minVariantPrice: { amount: "120.0", currencyCode: "SAR" } } }] });
    const u = await newUser("shopimport");
    expect(await importShopify(u.email, conn())).toBe(1);
    expect(API_VERSION).toBe("2026-07");
    expect(sent.every((s) => s.url.href === `https://${SHOP}/admin/api/2026-07/graphql.json`)).toBe(true);
    const md = (await readFile(u.email, "products.md"))!.content;
    expect(md).toContain("**عود ملكي** — 120.0 SAR\n  عطر فاخر\n  https://ward.myshopify.com/products/oud");
  });

  it("creates the article as a hidden draft in the first blog, authored by the shop", async () => {
    fakeShopify();
    const r = await publishShopifyArticle(conn(), { title: "دليل العود", body: "## مقدمة\nنص" });
    expect(r).toEqual({ id: "99", url: `https://${SHOP}/blogs/news/oud-guide` });
    const input = sent.find((s) => s.query.includes("mutation Article"))!.variables.article as Record<string, unknown>;
    expect(input).toMatchObject({ blogId: "gid://shopify/Blog/7", title: "دليل العود", isPublished: false, author: { name: "متجر الورد" } });
    expect(input.body, "Markdown goes through the same converter as WordPress").toBe("<h3>مقدمة</h3>\n<p>نص</p>");
  });

  it("refuses a connection whose shop is not a myshopify.com host, before any request", async () => {
    fakeShopify();
    await expect(shopifyGql({ ...conn(), meta: { shop: "evil.example" } }, "query { shop { name } }")).rejects.toThrow("shopify shop");
    expect(sent).toEqual([]);
  });

  it("waits and retries once Shopify says the query budget is spent", async () => {
    fakeShopify({ throttleOnce: true, products: [] });
    const pauses: number[] = [];
    await shopifyGql(conn(), "query Products { products(first: 1) { nodes { title } } }", {}, { pause: async (ms) => pauses.push(ms) });
    expect(pauses).toEqual([2000]);
    expect(sent).toHaveLength(2);
  });
});

describe("Shopify orders and abandoned checkouts, as totals only (rule 73)", () => {
  it("sums 30 days of orders without canceled, refunded or voided ones, follows the cursor, and ranks products", async () => {
    fakeShopify({
      orders: [
        [order("300.00", {}, [{ title: "عود ملكي", quantity: 2 }]), order("150.00", { cancelledAt: "2026-09-20T10:00:00Z" }, [{ title: "عود ملكي", quantity: 5 }]), order("80.00", { displayFinancialStatus: "REFUNDED" })],
        [order("120.50", { displayFinancialStatus: "PARTIALLY_REFUNDED" }, [{ title: "مسك أبيض", quantity: 1 }, { title: "عود ملكي", quantity: 1 }]), order("40.00", { displayFinancialStatus: "VOIDED" }), order(null)],
      ],
      checkouts: [[checkout("90.00", [{ title: "مسك أبيض", quantity: 1 }]), checkout("60.50", [{ title: "مسك أبيض", quantity: 2 }]), checkout("999.00", [{ title: "مكتمل", quantity: 1 }], { completedAt: "2026-09-27T00:00:00Z" })]],
      orderCount: 6,
      checkoutCount: 2,
    });
    const s = await shopifySales(conn(), new Date("2026-09-28T09:00:00Z"));

    const orderCalls = sent.filter((x) => x.query.includes("query Orders"));
    expect(orderCalls).toHaveLength(2);
    expect(orderCalls[0].variables).toMatchObject({ first: 100, after: null, q: "created_at:>='2026-08-29T09:00:00.000Z'" });
    expect(orderCalls[1].variables.after).toBe("c-1");
    // The order query asks for no customer, email, phone or address field at all.
    expect(orderCalls[0].query).not.toMatch(/customer|email|phone|address/i);
    expect(sent.find((x) => x.query.includes("query Checkouts"))!.variables.q).toBe("created_at:>='2026-08-29T09:00:00.000Z' AND status:open");

    expect(s.provider).toBe("shopify");
    expect(s.orders).toMatchObject({ count: 6, read: 6, canceled: 3, revenue: { SAR: 420.5 } });
    expect(s.orders.top).toEqual([{ name: "عود ملكي", qty: 3 }, { name: "مسك أبيض", qty: 1 }]);
    expect(s.carts).toMatchObject({ count: 2, read: 2, value: { SAR: 150.5 } });
    expect(s.carts.capped).toBeUndefined();
    expect(s.carts.top).toEqual([{ name: "مسك أبيض", qty: 3 }]);
    expect(s.unread).toBe(1); // the order with no readable total is counted, never read as 0
  });

  it("stops at the page cap and says how many there really were", async () => {
    fakeShopify({ orders: [[]], checkouts: Array.from({ length: 5 }, () => [checkout("10.00", [])]), checkoutCount: 5 });
    const s = await shopifySales(conn());
    expect(sent.filter((x) => x.query.includes("query Checkouts"))).toHaveLength(3);
    expect(s.carts).toMatchObject({ count: 5, read: 3 });

    fakeShopify({ orders: [[]], checkouts: Array.from({ length: 5 }, () => [checkout("10.00", [])]), checkoutCount: null });
    expect((await shopifySales(conn())).carts).toMatchObject({ count: 3, read: 3, capped: true });
  });

  it("syncs through the connect route, writes store-sales.md with no customer detail, and Noor reads it", async () => {
    fakeShopify({ orders: [[order("300.00", {}, [{ title: "عود ملكي", quantity: 2 }])]], checkouts: [[checkout("90.00", [{ title: "مسك أبيض", quantity: 1 }], { email: "salman@example.com", abandonedCheckoutUrl: "https://ward.example/checkouts/secret", customer: { firstName: "سلمان" } })]], orderCount: 1 });
    const u = await newUser("shopsales");
    await saveConnection(u.email, conn());
    await signIn(u.email);
    const res = await connectRoute.POST(json("/api/connect/shopify", "POST", { action: "sync_sales" }), { params: Promise.resolve({ provider: "shopify" }) });
    expect((await res.json()).ok).toBe(true);
    const md = (await readFile(u.email, "store-sales.md"))!.content;
    expect(md).toContain(`# Store sales (Shopify ${SHOP}, last 30 days`);
    expect(md).toContain("Revenue (excluding 0 canceled or refunded): 300 SAR");
    expect(md).toContain("Value left in them: 90 SAR");
    const snap = JSON.stringify(await getSalesSnapshot(u.email));
    for (const pii of ["salman@example.com", "سلمان", "checkouts/secret"]) {
      expect(md).not.toContain(pii);
      expect(snap).not.toContain(pii);
    }
    expect(await memoryBlock(u.email)).toContain("--- store-sales.md ---");
  });

  it("reports missing order access without asking for a reconnect, and a dead token with one", async () => {
    const u = await newUser("shop403");
    await saveConnection(u.email, conn());
    await signIn(u.email);
    const call = () => connectRoute.POST(json("/api/connect/shopify", "POST", { action: "sync_sales" }), { params: Promise.resolve({ provider: "shopify" }) });

    for (const denied of [{ status: 403 }, { errors: [{ message: "Access denied for orders field.", extensions: { code: "ACCESS_DENIED" } }] }]) {
      fakeShopify(denied);
      expect((await (await call()).json()).error).toBe("orders_access_denied");
      expect((await getConnection(u.email, "shopify"))?.needsReconnect).toBeFalsy();
    }

    fakeShopify({ status: 401 });
    expect((await (await call()).json()).error).toBe("reconnect_required");
    expect((await getConnection(u.email, "shopify"))?.needsReconnect).toBeTruthy();
  });
});
