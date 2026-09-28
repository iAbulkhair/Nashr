import { afterEach, describe, expect, it, vi } from "vitest";
import { json, newUser, signIn } from "./helpers/session";
import { nextPageInfo, shopifySales } from "@/lib/connectors/shopify";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { readFile, memoryBlock } from "@/lib/files";
import { getSalesSnapshot } from "@/lib/store-sales";
import * as connectRoute from "@/app/api/connect/[provider]/route";

/**
 * Rule 73: Shopify orders and abandoned checkouts reach Reports and Noor as totals only. Requests go to the connected
 * shop alone (a cursor is taken from the Link header, never the URL), orders are asked for without customer fields,
 * and canceled or refunded orders are not revenue. The mock answers in the shape of Shopify's REST Admin resources
 * (@shopify/shopify-api rest/admin Order and AbandonedCheckout).
 */
const SHOP = "ward.myshopify.com";
const conn = (): Connection => ({ provider: "shopify", data: { access_token: "shpat" }, meta: { shop: SHOP }, connectedAt: new Date().toISOString() });
const customer = { first_name: "ريم", last_name: "العتيبي", email: "reem@example.com", phone: "+966500000001" };
const order = (total: string | null, extra: Record<string, unknown> = {}, items: { title: string; quantity: number }[] = []) => ({ id: Math.random(), current_total_price: total ?? undefined, total_price: total ?? undefined, currency: "SAR", cancelled_at: null, financial_status: "paid", line_items: items, customer, email: customer.email, ...extra });
const checkout = (total: string, items: { title: string; quantity: number }[], extra: Record<string, unknown> = {}) => ({ id: Math.random(), total_price: total, currency: "SAR", completed_at: null, line_items: items, email: "salman@example.com", phone: "+966500000002", abandoned_checkout_url: "https://ward.example/checkouts/secret", customer: { first_name: "سلمان" }, ...extra });

const realFetch = globalThis.fetch;
let calls: URL[] = [];
function fakeShopify(opts: { orders: unknown[][]; checkouts: unknown[][]; count?: number; status?: number; link?: (resource: string, page: number) => string }) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    expect((init?.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat");
    if (opts.status) return new Response("{}", { status: opts.status });
    if (url.pathname.endsWith("/orders/count.json")) return Response.json({ count: opts.count ?? opts.orders.flat().length });
    const resource = url.pathname.endsWith("/orders.json") ? "orders" : url.pathname.endsWith("/checkouts.json") ? "checkouts" : "";
    if (!resource) return new Response("not mocked", { status: 500 });
    const pages = resource === "orders" ? opts.orders : opts.checkouts;
    const page = Number(url.searchParams.get("page_info")?.replace(`${resource}-`, "") ?? 1);
    const headers = new Headers();
    if (page < pages.length) headers.set("link", opts.link ? opts.link(resource, page + 1) : `<https://${SHOP}/admin/api/2024-10/${resource}.json?limit=250&page_info=${resource}-${page + 1}>; rel="next"`);
    return Response.json({ [resource]: pages[page - 1] ?? [] }, { headers });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

describe("Shopify orders and abandoned checkouts, as totals only (rule 73)", () => {
  it("sums 30 days of orders without canceled, refunded or voided ones, follows the cursor, and ranks products", async () => {
    fakeShopify({
      orders: [
        [order("300.00", {}, [{ title: "عود ملكي", quantity: 2 }]), order("150.00", { cancelled_at: "2026-09-20T10:00:00Z" }, [{ title: "عود ملكي", quantity: 5 }]), order("80.00", { financial_status: "refunded" })],
        [order("120.50", { financial_status: "partially_refunded", total_price: "200.00" }, [{ title: "مسك أبيض", quantity: 1 }, { title: "عود ملكي", quantity: 1 }]), order("40.00", { financial_status: "voided" }), order(null)],
      ],
      checkouts: [[checkout("90.00", [{ title: "مسك أبيض", quantity: 1 }]), checkout("60.50", [{ title: "مسك أبيض", quantity: 2 }]), checkout("999.00", [{ title: "مكتمل", quantity: 1 }], { completed_at: "2026-09-27T00:00:00Z" })]],
      count: 6,
    });
    const s = await shopifySales(conn(), new Date("2026-09-28T09:00:00Z"));

    expect(calls.every((u) => u.host === SHOP && u.pathname.startsWith("/admin/api/"))).toBe(true);
    const orderCalls = calls.filter((u) => u.pathname.endsWith("/orders.json"));
    expect(orderCalls).toHaveLength(2);
    expect(Object.fromEntries(orderCalls[0].searchParams)).toMatchObject({ status: "any", created_at_min: "2026-08-29T09:00:00.000Z", limit: "250" });
    // The fields list keeps the customer, email and address out of the order response altogether.
    for (const u of orderCalls) expect(u.searchParams.get("fields")).not.toMatch(/customer|email|address|phone/);
    // A cursor request carries only limit, page_info and fields; the filters live in the cursor.
    expect([...orderCalls[1].searchParams.keys()].sort()).toEqual(["fields", "limit", "page_info"]);

    expect(s.provider).toBe("shopify");
    expect(s.orders).toMatchObject({ count: 6, read: 6, canceled: 3, revenue: { SAR: 420.5 } });
    expect(s.orders.top).toEqual([{ name: "عود ملكي", qty: 3 }, { name: "مسك أبيض", qty: 1 }]);
    expect(s.carts).toMatchObject({ count: 2, read: 2, value: { SAR: 150.5 } });
    expect(s.carts.capped).toBeUndefined();
    expect(s.carts.top).toEqual([{ name: "مسك أبيض", qty: 3 }]);
    expect(s.unread).toBe(1); // the order with no readable total is counted, never read as 0
  });

  it("never follows a next link to another host", async () => {
    fakeShopify({ orders: [[order("10.00")], [order("20.00")]], checkouts: [[]], link: (r, p) => `<https://evil.example/admin/api/2024-10/${r}.json?page_info=${r}-${p}>; rel="next"` });
    const s = await shopifySales(conn());
    expect(calls.every((u) => u.host === SHOP)).toBe(true);
    expect(s.orders.revenue).toEqual({ SAR: 30 });
    expect(nextPageInfo(`<https://${SHOP}/x.json?page_info=a>; rel="previous", <https://${SHOP}/x.json?page_info=b>; rel="next"`)).toBe("b");
    expect(nextPageInfo(`<https://${SHOP}/x.json?page_info=a>; rel="previous"`)).toBeNull();
  });

  it("says when there are more open checkouts than it reads", async () => {
    fakeShopify({ orders: [[]], checkouts: Array.from({ length: 5 }, () => [checkout("10.00", [])]) });
    const s = await shopifySales(conn());
    expect(calls.filter((u) => u.pathname.endsWith("/checkouts.json"))).toHaveLength(3);
    expect(s.carts).toMatchObject({ count: 3, read: 3, capped: true });
  });

  it("refuses a connection whose shop is not a myshopify.com host", async () => {
    fakeShopify({ orders: [[]], checkouts: [[]] });
    await expect(shopifySales({ ...conn(), meta: { shop: "evil.example" } })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("syncs through the connect route, writes store-sales.md with no customer detail, and Noor reads it", async () => {
    fakeShopify({ orders: [[order("300.00", {}, [{ title: "عود ملكي", quantity: 2 }])]], checkouts: [[checkout("90.00", [{ title: "مسك أبيض", quantity: 1 }])]], count: 1 });
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
    for (const pii of ["ريم", "العتيبي", "reem@example.com", "+9665", "salman@example.com", "سلمان", "checkouts/secret"]) {
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

    fakeShopify({ orders: [], checkouts: [], status: 403 });
    expect((await (await call()).json()).error).toBe("orders_access_denied");
    expect((await getConnection(u.email, "shopify"))?.needsReconnect).toBeFalsy();

    fakeShopify({ orders: [], checkouts: [], status: 401 });
    expect((await (await call()).json()).error).toBe("reconnect_required");
    expect((await getConnection(u.email, "shopify"))?.needsReconnect).toBeTruthy();
  });
});
