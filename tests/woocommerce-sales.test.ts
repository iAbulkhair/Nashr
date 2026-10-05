import { afterEach, describe, expect, it, vi } from "vitest";
import { json, newUser, signIn } from "./helpers/session";
import { WOO_ACCESS_DENIED, importWoo, verifyWoo, wooSales } from "@/lib/connectors/woocommerce";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { readFile, memoryBlock } from "@/lib/files";
import { getSalesSnapshot, salesDataBlock } from "@/lib/store-sales";
import { READS_METRICS } from "@/lib/connectors/working";
import { SALES_PROVIDERS } from "@/lib/connectors/sales";
import * as connectRoute from "@/app/api/connect/[provider]/route";

vi.mock("dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

/**
 * Rules 612-617: WooCommerce orders reach Reports and Noor as totals only (the Salla, Shopify and Zid shape), read from
 * the store's REST API v3 over https. The mock answers in the shape of GET /wp-json/wc/v3/orders: a JSON array, `total`
 * and `refunds[].total` as decimal strings (refunds negative), `status` a slug, `date_created_gmt` without a zone, and the
 * pagination in the X-WP-TotalPages header. The orders it returns carry billing and shipping blocks on purpose, to
 * prove none of it is kept.
 */
const SITE = "https://shop.example.com";
const NOW = new Date("2026-10-05T12:00:00Z");
const conn = (over: Partial<Connection> = {}): Connection => ({ provider: "woocommerce", data: { site: `${SITE}/`, consumerKey: "ck_test", consumerSecret: "cs_test" }, meta: { site: SITE }, connectedAt: NOW.toISOString(), ...over });
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 864e5).toISOString().slice(0, 19);

let n = 0;
const order = (total: string, extra: Record<string, unknown> = {}, items: { name: string; quantity: number }[] = []) => ({
  id: ++n, status: "completed", total, currency: "SAR", date_created_gmt: daysAgo(2), date_paid_gmt: daysAgo(2), line_items: items, refunds: [],
  billing: { first_name: "سلمان", email: "salman@example.com", phone: "0500000000", address_1: "حي الملقا" },
  shipping: { first_name: "سلمان", address_1: "حي الملقا" }, customer_id: 77, ...extra,
});

type Sent = { url: URL; auth: string | null };
const realFetch = globalThis.fetch;
let sent: Sent[] = [];
/** `pages[i]` answers `page=i+1`; `totalPages` is sent as X-WP-TotalPages when given. */
function fakeWoo(opts: { pages?: unknown[][]; status?: number; totalPages?: number; body?: string } = {}) {
  sent = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (opts.status) return new Response("{}", { status: opts.status });
    if (opts.body !== undefined) return new Response(opts.body, { status: 200 });
    const page = Number(url.searchParams.get("page") ?? 1);
    const headers: Record<string, string> = opts.totalPages ? { "X-WP-TotalPages": String(opts.totalPages) } : {};
    return Response.json((opts.pages ?? [[]])[page - 1] ?? [], { headers });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

describe("rule 612: WooCommerce orders become totals", () => {
  it("counts what was sold, leaves out what was undone, and keeps orders awaiting payment (pending, on-hold) out of revenue", async () => {
    fakeWoo({ pages: [[
      order("100.00", {}, [{ name: "عود ملكي", quantity: 2 }, { name: "مسك أبيض", quantity: 1 }]),
      order("50.00", { status: "processing" }, [{ name: "عود ملكي", quantity: 1 }]),
      order("20.00", { status: "on-hold", date_paid_gmt: null }),
      order("999.00", { status: "cancelled" }),
      order("999.00", { status: "refunded" }),
      order("999.00", { status: "failed" }),
      order("999.00", { status: "trash" }),
      order("999.00", { status: "checkout-draft" }),
      order("300.00", { status: "pending" }),
    ]] });
    const s = await wooSales(conn(), NOW);
    expect(s.provider).toBe("woocommerce");
    expect(s.orders.count).toBe(9);
    expect(s.orders.canceled).toBe(5);
    expect(s.orders.pending).toBe(2);
    expect(s.orders.revenue).toEqual({ SAR: 150 });
    expect(s.orders.top[0]).toEqual({ name: "عود ملكي", qty: 3 });
    expect(s.unread).toBe(0);
    expect(s.days).toBe(30);
  });

  it("counts a partly refunded order for what the shopper kept, and a fully refunded one not at all", async () => {
    fakeWoo({ pages: [[
      order("200.00", { refunds: [{ id: 1, reason: "", total: "-35.50" }, { id: 2, reason: "", total: "-14.50" }] }, [{ name: "ثوب", quantity: 1 }]),
      order("80.00", { refunds: [{ id: 3, reason: "", total: "-80.00" }] }, [{ name: "غترة", quantity: 4 }]),
      order("10.00", { refunds: [{ id: 4, reason: "", total: "n/a" }] }),
    ]] });
    const s = await wooSales(conn(), NOW);
    expect(s.orders.revenue).toEqual({ SAR: 160 });
    expect(s.orders.canceled).toBe(1);
    expect(s.orders.top).toEqual([{ name: "ثوب", qty: 1 }]);
    // The refund nobody could read leaves the order's full total in and is counted, never hidden.
    expect(s.unread).toBe(1);
  });

  it("keeps each order's own currency, never a default, and counts an unreadable total as unread", async () => {
    fakeWoo({ pages: [[order("100.00"), order("40.00", { currency: "USD" }), order("5.00", { currency: "" }), order("", {}), order("abc", {})]] });
    const s = await wooSales(conn(), NOW);
    expect(s.orders.revenue).toEqual({ SAR: 100, USD: 40, "": 5 });
    expect(s.unread).toBe(2);
  });

  it("enforces the 30-day window on date_created_gmt, reads it as GMT, and counts an order seen twice once", async () => {
    const dup = order("10.00");
    fakeWoo({ pages: [[
      order("100.00", { date_created_gmt: daysAgo(29.9) }),
      order("1000.00", { date_created_gmt: daysAgo(30.2) }),
      order("1000.00", { date_created_gmt: new Date(NOW.getTime() + 3600e3).toISOString().slice(0, 19) }),
      dup, dup,
    ]] });
    const s = await wooSales(conn(), NOW);
    expect(s.orders.count).toBe(2);
    expect(s.orders.revenue).toEqual({ SAR: 110 });
  });

  it("counts only paid orders as revenue: an order with an empty paid stamp is awaiting payment whatever its status, and a store that sends no stamp is read by status", async () => {
    const noStamp = order("40.00", {}, [{ name: "مسك", quantity: 1 }]);
    delete (noStamp as Record<string, unknown>).date_paid_gmt;
    fakeWoo({ pages: [[order("100.00"), order("60.00", { status: "processing", date_paid_gmt: null }), order("70.00", { status: "wc-shipped", date_paid_gmt: "" }), noStamp]] });
    const s = await wooSales(conn(), NOW);
    expect(s.orders.revenue).toEqual({ SAR: 140 });
    expect(s.orders.pending).toBe(2);
    expect(s.orders.count).toBe(4);
  });

  it("says carts are unavailable, not zero, because WooCommerce keeps none", async () => {
    fakeWoo({ pages: [[order("10.00")]] });
    const s = await wooSales(conn(), NOW);
    expect(s.carts).toEqual({ count: 0, read: 0, value: {}, top: [], unavailable: true });
  });
});

describe("rule 613: the request and the snapshot hold no customer detail", () => {
  it("asks only for the fields it reads, with the owner's key in a Basic header, and keeps no personal data", async () => {
    fakeWoo({ pages: [[order("300.00", {}, [{ name: "عود ملكي", quantity: 2 }])]] });
    const s = await wooSales(conn(), NOW);
    const u = sent[0].url;
    expect(u.origin).toBe(SITE);
    expect(u.pathname).toBe("/wp-json/wc/v3/orders");
    expect(u.searchParams.get("_fields")).toBe("id,status,total,currency,date_created_gmt,date_paid_gmt,line_items,refunds");
    for (const field of ["billing", "shipping", "customer_id", "email", "phone"]) expect(u.searchParams.get("_fields")).not.toContain(field);
    expect(u.searchParams.get("per_page")).toBe("100");
    expect(u.searchParams.get("dates_are_gmt")).toBe("true");
    expect(u.search).not.toContain("cs_test");
    expect(sent[0].auth).toBe("Basic " + Buffer.from("ck_test:cs_test").toString("base64"));
    const snap = JSON.stringify(s);
    for (const pii of ["salman@example.com", "سلمان", "0500000000", "الملقا"]) expect(snap).not.toContain(pii);
  });

  it("only ever moves the lower bound a day before the window", async () => {
    fakeWoo({ pages: [[]] });
    await wooSales(conn(), NOW);
    expect(sent[0].url.searchParams.get("after")).toBe("2026-09-04T12:00:00Z");
  });
});

describe("rule 614: paging stops where it should and says when it stopped early", () => {
  const full = (k: number) => Array.from({ length: 100 }, () => order("1.00", { date_created_gmt: daysAgo(k) }));

  it("stops on a short page, on X-WP-TotalPages, and on an order older than the window", async () => {
    fakeWoo({ pages: [full(1), [order("1.00")]] });
    expect((await wooSales(conn(), NOW)).orders.count).toBe(101);
    expect(sent.length).toBe(2);

    fakeWoo({ pages: [full(1), full(1)], totalPages: 1 });
    expect((await wooSales(conn(), NOW)).orders.count).toBe(100);
    expect(sent.length).toBe(1);

    fakeWoo({ pages: [[...full(1).slice(0, 99), order("1.00", { date_created_gmt: daysAgo(40) })], full(1)] });
    expect((await wooSales(conn(), NOW)).orders.count).toBe(99);
    expect(sent.length).toBe(1);
  });

  it("reads at most five pages and marks the count as a floor", async () => {
    fakeWoo({ pages: [full(1), full(1), full(1), full(1), full(1), full(1)] });
    const s = await wooSales(conn(), NOW);
    expect(sent.length).toBe(5);
    expect(s.orders).toMatchObject({ count: 500, read: 500, capped: true });
  });

  it("is not capped when the last page it reads is also the store's last page", async () => {
    fakeWoo({ pages: [full(1), full(1), full(1), full(1), full(1)], totalPages: 5 });
    const s = await wooSales(conn(), NOW);
    expect(s.orders.count).toBe(500);
    expect(s.orders.capped).toBeUndefined();
  });
});

describe("rule 615: a store that refuses or answers oddly is a clear error", () => {
  it("maps 401 and 403 to one error that asks for a new Read key, and 5xx to a status", async () => {
    for (const status of [401, 403]) {
      fakeWoo({ status });
      await expect(wooSales(conn(), NOW)).rejects.toThrow(WOO_ACCESS_DENIED);
    }
    fakeWoo({ status: 500 });
    await expect(wooSales(conn(), NOW)).rejects.toThrow("woo 500");
  });

  it("refuses an answer that is not a list, including a page of HTML", async () => {
    fakeWoo({ body: "{\"code\":\"rest_no_route\"}" });
    await expect(wooSales(conn(), NOW)).rejects.toThrow("woo unexpected_orders");
    fakeWoo({ body: "<html><body>Not found</body></html>" });
    await expect(wooSales(conn(), NOW)).rejects.toThrow("woo unexpected_orders");
  });
});

describe("rule 616: the connect route syncs WooCommerce for any member and Noor and Dana read totals only", () => {
  it("writes the snapshot and store-sales.md under the caller's scope, with the store host and the carts note", async () => {
    // The route syncs at the real time, so the orders are dated from the real clock.
    const fresh = new Date().toISOString().slice(0, 19);
    fakeWoo({ pages: [[order("300.00", { date_created_gmt: fresh }, [{ name: "عود ملكي", quantity: 2 }]), order("90.00", { status: "pending", date_created_gmt: fresh })]] });
    const u = await newUser("woosales");
    await saveConnection(u.email, conn());
    await signIn(u.email);
    const res = await connectRoute.POST(json("/api/connect/woocommerce", "POST", { action: "sync_sales" }), { params: Promise.resolve({ provider: "woocommerce" }) });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sales.provider).toBe("woocommerce");
    const md = (await readFile(u.email, "store-sales.md"))!.content;
    expect(md).toContain("# Store sales (WooCommerce shop.example.com, last 30 days");
    expect(md).toContain("Revenue (excluding 0 canceled or refunded): 300 SAR");
    expect(md).toContain("1 orders are still awaiting payment");
    expect(md).toContain("WooCommerce does not record abandoned carts");
    for (const pii of ["salman@example.com", "سلمان", "0500000000", "الملقا"]) {
      expect(md).not.toContain(pii);
      expect(JSON.stringify(await getSalesSnapshot(u.email))).not.toContain(pii);
    }
    expect(await memoryBlock(u.email)).toContain("--- store-sales.md ---");
    const block = await salesDataBlock(u.email);
    expect(block).toContain("awaiting_payment_in_count_not_in_revenue");
    expect(block).toContain("WooCommerce does not record abandoned carts");
  });

  it("is a store the Reports page reads, and the two lists stay equal", () => {
    expect(SALES_PROVIDERS).toContain("woocommerce");
    expect(READS_METRICS).toContain("woocommerce");
  });

  it("answers not_connected without a connection and never marks a key connection for reconnect on a refusal", async () => {
    const u = await newUser("woonone");
    await signIn(u.email);
    const call = () => connectRoute.POST(json("/api/connect/woocommerce", "POST", { action: "sync_sales" }), { params: Promise.resolve({ provider: "woocommerce" }) });
    expect((await (await call()).json()).error).toBe("not_connected");
    await saveConnection(u.email, conn());
    fakeWoo({ status: 401 });
    expect((await (await call()).json()).error).toBe(WOO_ACCESS_DENIED);
    expect((await getConnection(u.email, "woocommerce"))?.needsReconnect).toBeFalsy();
  });
});

describe("rule 617: the store key travels over https only", () => {
  it("refuses a plain-http store in verify, import and sales before any request", async () => {
    fakeWoo({ pages: [[]] });
    const http = { site: "http://shop.example.com", consumerKey: "ck_test", consumerSecret: "cs_test" };
    const v = await verifyWoo(http);
    expect(v.ok).toBe(false);
    expect((v as { error: string }).error).toBe("unsafe_url:not_https");
    await expect(wooSales(conn({ data: http }), NOW)).rejects.toThrow("unsafe_url:not_https");
    await expect(importWoo("nobody@example.com", conn({ data: http }))).rejects.toThrow("unsafe_url:not_https");
    expect(sent.length).toBe(0);
  });

  it("does not hand the key to another host a redirect points at", async () => {
    sent = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: new URL(String(input)), auth: new Headers(init?.headers).get("authorization") });
      return sent.length === 1 ? new Response(null, { status: 302, headers: { Location: "https://other.example.net/wp-json/wc/v3/orders" } }) : Response.json([]);
    }) as typeof fetch;
    await wooSales(conn(), NOW);
    expect(sent[1].url.host).toBe("other.example.net");
    expect(sent[1].auth).toBeNull();
  });
});
