import { afterEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { readOrders, storeTime, totals, type OrderRow } from "@/lib/connectors/orders";
import { storeMetrics } from "@/lib/store-metrics";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";

/**
 * Rule 73: store order readers. Void orders (cancelled, refunded, failed, test) are neither orders nor revenue; revenue
 * is kept per currency; a read cut short by the page cap is `partial`, never a whole; every URL stays on the platform's
 * fixed host (a Shopify cursor is read for its token, not followed); WooCommerce goes through safeFetch; a refused
 * token marks the connection for reconnecting; results are cached per workspace scope.
 */
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
let calls: string[] = [];
function fake(handler: (url: URL) => Response) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => { calls.push(String(input)); return handler(new URL(String(input))); }) as typeof fetch;
}
const conn = (provider: string, data: Record<string, string> = { access_token: "tok" }, meta: Record<string, string> = {}): Connection => ({ provider, data, meta, connectedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 864e5).toISOString() });
const from = new Date("2026-09-01T00:00:00Z"), to = new Date("2026-09-30T23:59:59Z");

describe("order totals (rule 73)", () => {
  const row = (at: string, total: number, currency = "SAR", v = false): OrderRow => ({ at, total, currency, void: v });
  it("counts orders inside the window, leaves void ones out and keeps currencies apart", () => {
    const t = totals([row("2026-09-02T10:00:00Z", 100.1), row("2026-09-03T10:00:00Z", 50.2), row("2026-09-04T10:00:00Z", 999, "SAR", true), row("2026-09-05T10:00:00Z", 20, "USD"), row("2026-08-31T23:59:59Z", 70), row("", 5)], from, to);
    expect(t).toEqual({ orders: 3, revenue: { SAR: 150.3, USD: 20 } });
  });
  it("reads a bare store timestamp as Riyadh time and keeps an explicit zone", () => {
    expect(storeTime("2026-09-01 02:00:00")).toBe("2026-08-31T23:00:00.000Z");
    expect(storeTime("2026-09-01 02:00:00.000000")).toBe("2026-08-31T23:00:00.000Z");
    expect(storeTime("2026-09-01T02:00:00Z")).toBe("2026-09-01T02:00:00.000Z");
    expect(storeTime("2026-09-01T02:00:00", "Z")).toBe("2026-09-01T02:00:00.000Z");
    expect(storeTime("not a date")).toBe("");
  });
});

describe("Salla orders (rule 73)", () => {
  const order = (date: string, amount: number, slug = "completed") => ({ date: { date, timezone: "Asia/Riyadh" }, total: { amount, currency: "SAR" }, status: { slug } });
  it("walks every page on Salla's host with the date filter and marks cancelled and refunded orders void", async () => {
    fake((u) => {
      const page = Number(u.searchParams.get("page"));
      const pages = [[order("2026-09-02 12:00:00", 100), order("2026-09-02 13:00:00", 40, "canceled")], [order("2026-09-03 12:00:00", 60, "restored")]];
      return Response.json({ data: pages[page - 1], pagination: { currentPage: page, totalPages: 2 } });
    });
    const r = await readOrders(conn("salla"), from, to);
    expect(r.partial).toBe(false);
    expect(calls.every((c) => c.startsWith("https://api.salla.dev/admin/v2/orders?"))).toBe(true);
    expect(new URL(calls[0]).searchParams.get("from_date")).toBe("2026-09-01");
    expect(totals(r.rows, from, to)).toEqual({ orders: 1, revenue: { SAR: 100 } });
  });
  it("reports a read cut short by the page cap as partial", async () => {
    fake((u) => Response.json({ data: [order("2026-09-02 12:00:00", 1)], pagination: { currentPage: Number(u.searchParams.get("page")), totalPages: 999 } }));
    const r = await readOrders(conn("salla"), from, to);
    expect(calls).toHaveLength(20);
    expect(r.partial).toBe(true);
  });
});

describe("Zid orders (rule 73)", () => {
  it("reads newest first and stops at the first page that reaches before the window", async () => {
    const pages = [
      [{ created_at: "2026-09-20 10:00:00", order_total: "120.50", currency_code: "SAR", order_status: { code: "delivered" } }, { created_at: "2026-09-10 10:00:00", order_total: "80", currency_code: "SAR", order_status: { code: "cancelled" } }],
      [{ created_at: "2026-09-05 10:00:00", order_total: "30", currency_code: "SAR", order_status: { code: "new" } }, { created_at: "2026-08-20 10:00:00", order_total: "500", currency_code: "SAR", order_status: { code: "delivered" } }],
      [{ created_at: "2026-08-01 10:00:00", order_total: "1", currency_code: "SAR", order_status: { code: "new" } }],
    ];
    fake((u) => Response.json({ orders: pages[Number(u.searchParams.get("page")) - 1] ?? [] }));
    const r = await readOrders(conn("zid", { access_token: "mgr", authorization: "auth" }, { storeId: "7" }), from, to);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.startsWith("https://api.zid.sa/v1/managers/store/orders?"))).toBe(true);
    expect(r.partial).toBe(false);
    expect(totals(r.rows, from, to)).toEqual({ orders: 2, revenue: { SAR: 150.5 } });
  });
});

describe("Shopify orders (rule 73)", () => {
  const shop = "ward.myshopify.com";
  it("follows the next cursor on the shop's own host only, and voids cancelled, refunded and test orders", async () => {
    fake((u) => {
      if (!u.searchParams.get("page_info")) {
        return Response.json({ orders: [{ created_at: "2026-09-02T10:00:00+03:00", total_price: "200.00", currency: "SAR" }, { created_at: "2026-09-02T11:00:00+03:00", total_price: "50.00", currency: "SAR", cancelled_at: "2026-09-02T12:00:00+03:00" }] }, { headers: { link: '<https://evil.example/admin/api/2024-10/orders.json?page_info=abc%3D&limit=250>; rel="next"' } });
      }
      return Response.json({ orders: [{ created_at: "2026-09-03T10:00:00+03:00", total_price: "70.00", currency: "SAR", financial_status: "refunded" }, { created_at: "2026-09-03T10:00:00+03:00", total_price: "9.00", currency: "SAR", test: true }, { created_at: "2026-09-04T10:00:00+03:00", total_price: "30.00", currency: "SAR", financial_status: "paid" }, { created_at: "2026-09-04T11:00:00+03:00", total_price: "10.00", currency: "SAR", financial_status: "partially_refunded" }] });
    });
    const r = await readOrders(conn("shopify", { access_token: "tok" }, { shop }), new Date(Date.now() - 10 * 864e5), new Date());
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => new URL(c).host === shop)).toBe(true);
    expect(new URL(calls[1]).searchParams.get("page_info")).toBe("abc=");
    expect(totals(r.rows, from, to)).toEqual({ orders: 3, revenue: { SAR: 240 } });
  });
  it("refuses a stored shop that is not a myshopify host", async () => {
    fake(() => Response.json({ orders: [] }));
    await expect(readOrders(conn("shopify", { access_token: "tok" }, { shop: "evil.example" }), from, to)).rejects.toThrow("bad_shop");
    expect(calls).toHaveLength(0);
  });
  it("marks a window older than Shopify's 60 days as partial", async () => {
    fake(() => Response.json({ orders: [] }));
    expect((await readOrders(conn("shopify", { access_token: "tok" }, { shop }), new Date(Date.now() - 90 * 864e5), new Date())).partial).toBe(true);
  });
});

describe("WooCommerce orders (rule 73)", () => {
  it("reads through safeFetch, so a private host is refused", async () => {
    fake(() => Response.json([]));
    await expect(readOrders(conn("woocommerce", { site: "http://127.0.0.1", consumerKey: "k", consumerSecret: "s" }), from, to)).rejects.toThrow(/unsafe_url/);
    expect(calls).toHaveLength(0);
  });
  it("walks the pages the store reports and voids cancelled and failed orders", async () => {
    fake((u) => {
      const page = Number(u.searchParams.get("page"));
      const pages = [[{ date_created_gmt: "2026-09-02T10:00:00", total: "90.00", currency: "AED", status: "completed" }, { date_created_gmt: "2026-09-02T11:00:00", total: "10.00", currency: "AED", status: "failed" }], [{ date_created_gmt: "2026-09-03T10:00:00", total: "15.50", currency: "AED", status: "processing" }]];
      return Response.json(pages[page - 1], { headers: { "x-wp-totalpages": "2" } });
    });
    const r = await readOrders(conn("woocommerce", { site: "https://93.184.215.14", consumerKey: "k", consumerSecret: "s" }), from, to);
    expect(calls).toHaveLength(2);
    expect(totals(r.rows, from, to)).toEqual({ orders: 2, revenue: { AED: 105.5 } });
  });
});

describe("store metrics for Reports (rule 73)", () => {
  const win = { prevFrom: new Date("2026-08-01T00:00:00Z"), from, to };
  const salla = (rows: unknown[], status = 200) => fake(() => (status === 200 ? Response.json({ data: rows, pagination: { currentPage: 1, totalPages: 1 } }) : new Response("no", { status })));
  it("splits one read into the window and the one before it, and caches per workspace", async () => {
    salla([{ date: { date: "2026-09-02 12:00:00" }, total: { amount: 100, currency: "SAR" }, status: { slug: "completed" } }, { date: { date: "2026-08-15 12:00:00" }, total: { amount: 40, currency: "SAR" }, status: { slug: "completed" } }]);
    const a = await newUser("sm"), b = await newUser("sm");
    await saveConnection(a.email, conn("salla"));
    const [m] = await storeMetrics(a.email, ["salla", "meta"], win);
    expect(m).toMatchObject({ provider: "salla", cur: { orders: 1, revenue: { SAR: 100 } }, prev: { orders: 1, revenue: { SAR: 40 } }, partial: false });
    await storeMetrics(a.email, ["salla"], win);
    expect(calls).toHaveLength(1);
    // Another workspace neither sees that cache nor has a connection to read.
    const [other] = await storeMetrics(b.email, ["salla"], win);
    expect(other.error).toBe("not_connected");
    expect(other.cur.orders).toBe(0);
  });
  it("turns a refused token into reconnect_required and marks the connection", async () => {
    salla([], 401);
    const u = await newUser("sm401");
    await saveConnection(u.email, conn("salla"));
    const [m] = await storeMetrics(u.email, ["salla"], win);
    expect(m.error).toBe("reconnect_required");
    expect((await getConnection(u.email, "salla"))?.needsReconnect).toBeTruthy();
    // The next read does not call Salla again: the card keeps asking for a reconnect.
    const before = calls.length;
    const [again] = await storeMetrics(u.email, ["salla"], { ...win, to: new Date("2026-09-30T23:00:00Z") });
    expect(again.error).toBe("reconnect_required");
    expect(calls.length).toBe(before);
  });
});
