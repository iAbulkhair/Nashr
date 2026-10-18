import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { saveConnection, type Connection } from "@/lib/connectors/store";
import { AUTO_SYNC_MIN_AGE_MS, getSalesSnapshot, getSyncFailure, syncSales, syncStoreIfDue } from "@/lib/store-sales";
import { appDict } from "@/lib/app-i18n";
import * as storesCron from "@/app/api/cron/stores/route";

vi.mock("dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

/**
 * Rules 623-627: the store sales snapshot refreshes on its own twice a day, with no model call and no credits. Two cron
 * entries (one each, so a plan that allows a cron once a day runs both) reach a route that only the cron bearer opens. A
 * workspace is synced only for the store it already reports on, or its only connected store, never a guess between
 * several; a recent snapshot is left alone; and a failed read keeps the last good snapshot with its own date and leaves
 * a note, with the platform's message never kept. WooCommerce is the mocked store (the same orders endpoint as its own tests).
 */
const SITE = "https://shop.example.com";
const woo = (over: Partial<Connection> = {}): Connection => ({ provider: "woocommerce", data: { site: SITE, consumerKey: "ck_secret_key", consumerSecret: "cs_secret" }, meta: { site: SITE }, connectedAt: new Date().toISOString(), ...over });
const shopify = (): Connection => ({ provider: "shopify", data: { access_token: "shpat" }, meta: { shop: "a.myshopify.com" }, connectedAt: new Date().toISOString() });

const realFetch = globalThis.fetch;
let asked = 0;
function fakeWoo(o: { status?: number; boom?: boolean } = {}) {
  asked = 0;
  globalThis.fetch = vi.fn(async () => {
    asked++;
    if (o.boom) throw new TypeError("fetch failed for ck_secret_key");
    return o.status ? new Response("platform says ck_secret_key is wrong", { status: o.status }) : Response.json([]);
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; vi.unstubAllEnvs(); });

const wooUser = async (tag: string) => {
  const u = await newUser(tag);
  await saveConnection(u.email, woo());
  return u.email;
};
/** A snapshot of the store as it was `hours` ago, written the way a sync writes it. */
async function snapshotAgo(scope: string, hours: number) {
  fakeWoo();
  await syncSales(scope, "woocommerce", woo());
  const s = (await getSalesSnapshot(scope))!;
  const at = new Date(Date.now() - hours * 36e5).toISOString();
  await db.set(`storesales:${scope}`, { ...s, at });
  return at;
}

describe("two cron entries and a bearer-only route (rule 623)", () => {
  it("crons.json runs the stores job twice a day, each entry once a day", () => {
    const crons = (JSON.parse(readFileSync("crons.json", "utf8")) as { crons: { path: string; schedule: string }[] }).crons.filter((c) => c.path === "/api/cron/stores");
    expect(crons).toHaveLength(2);
    const hours = crons.map((c) => {
      const f = c.schedule.split(" ");
      expect(f).toHaveLength(5);
      expect(f[0]).toMatch(/^\d+$/);
      expect(f[1]).toMatch(/^\d+$/);
      expect(f.slice(2)).toEqual(["*", "*", "*"]);
      return Number(f[1]);
    });
    expect(hours[0]).toBeLessThan(12);
    expect(hours[1]).toBeGreaterThanOrEqual(12);
  });

  it("the route needs the exact bearer secret", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-abcdef");
    const call = (auth?: string) => storesCron.GET(new Request("https://nashr.test/api/cron/stores", { headers: auth ? { authorization: auth } : {} }));
    for (const auth of [undefined, "Bearer cron-secret-abcdeX", "Bearer ", "cron-secret-abcdef-extra"]) expect((await call(auth)).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(401);
  });
});

describe("which store a workspace is synced for (rule 624)", () => {
  it("the only connected store, when it never synced", async () => {
    const scope = await wooUser("ss-only");
    fakeWoo();
    expect(await syncStoreIfDue(scope)).toBe("synced:woocommerce");
    expect(asked).toBeGreaterThan(0);
    expect((await getSalesSnapshot(scope))?.provider).toBe("woocommerce");
  });

  it("no store connected: nothing is read", async () => {
    const u = await newUser("ss-none");
    fakeWoo();
    expect(await syncStoreIfDue(u.email)).toBe("none");
    expect(asked).toBe(0);
  });

  it("several stores and no snapshot is the owner's choice: nothing is read", async () => {
    const u = await newUser("ss-choose");
    await saveConnection(u.email, woo());
    await saveConnection(u.email, shopify());
    fakeWoo();
    expect(await syncStoreIfDue(u.email)).toBe("choose");
    expect(asked).toBe(0);
    expect(await getSalesSnapshot(u.email)).toBeNull();
  });

  it("several stores and a snapshot: only the store of that snapshot is read", async () => {
    const u = await newUser("ss-keep");
    await saveConnection(u.email, woo());
    await saveConnection(u.email, shopify());
    await snapshotAgo(u.email, 20);
    fakeWoo();
    expect(await syncStoreIfDue(u.email)).toBe("synced:woocommerce");
    const hosts = (globalThis.fetch as unknown as { mock: { calls: [RequestInfo][] } }).mock.calls.map((c) => new URL(String(c[0])).host);
    expect(new Set(hosts)).toEqual(new Set(["shop.example.com"]));
  });

  it("a snapshot of a store that is no longer connected is not followed to another one", async () => {
    const u = await newUser("ss-gone");
    await saveConnection(u.email, woo());
    await saveConnection(u.email, shopify());
    await snapshotAgo(u.email, 20);
    await db.set(`storesales:${u.email}`, { ...(await getSalesSnapshot(u.email))!, provider: "salla" });
    fakeWoo();
    expect(await syncStoreIfDue(u.email)).toBe("choose");
    expect(asked).toBe(0);
  });

  it("a connection that needs reconnecting is skipped, not retried every run", async () => {
    const u = await newUser("ss-reconnect");
    await saveConnection(u.email, woo({ needsReconnect: new Date().toISOString() }));
    fakeWoo();
    expect(await syncStoreIfDue(u.email)).toBe("reconnect");
    expect(asked).toBe(0);
  });
});

describe("a recent snapshot is left alone (rule 625)", () => {
  it("younger than the minimum age: no read, the snapshot is untouched", async () => {
    const scope = await wooUser("ss-fresh");
    const at = await snapshotAgo(scope, 2);
    fakeWoo();
    expect(await syncStoreIfDue(scope)).toBe("fresh");
    expect(asked).toBe(0);
    expect((await getSalesSnapshot(scope))?.at).toBe(at);
  });

  it("older than the minimum age: read again and the snapshot is replaced", async () => {
    const scope = await wooUser("ss-old");
    const at = await snapshotAgo(scope, AUTO_SYNC_MIN_AGE_MS / 36e5 + 1);
    fakeWoo();
    expect(await syncStoreIfDue(scope)).toBe("synced:woocommerce");
    expect((await getSalesSnapshot(scope))!.at > at).toBe(true);
  });

  it("the minimum age is under half a day, so both daily runs can sync", () => {
    expect(AUTO_SYNC_MIN_AGE_MS).toBeLessThan(12 * 36e5);
  });
});

describe("a failed sync keeps the last good snapshot (rule 626)", () => {
  it("a server error throws for the batch to retry once, keeps the snapshot and its date, and notes the failure", async () => {
    const scope = await wooUser("ss-5xx");
    const at = await snapshotAgo(scope, 20);
    fakeWoo({ status: 502 });
    await expect(syncStoreIfDue(scope)).rejects.toThrow("woo 502");
    expect((await getSalesSnapshot(scope))?.at).toBe(at);
    expect(await getSyncFailure(scope)).toMatchObject({ provider: "woocommerce", error: "woo 502" });
  });

  it("a key without access answers failed with no throw (retrying cannot help)", async () => {
    const scope = await wooUser("ss-denied");
    fakeWoo({ status: 401 });
    expect(await syncStoreIfDue(scope)).toBe("failed:woo_access_denied");
    expect((await getSyncFailure(scope))?.error).toBe("woo_access_denied");
  });

  it("the note keeps a status or a known code, never the platform's message or a secret", async () => {
    const scope = await wooUser("ss-secret");
    fakeWoo({ boom: true });
    await expect(syncStoreIfDue(scope)).rejects.toThrow();
    const failure = await getSyncFailure(scope);
    expect(failure?.error).toBe("failed");
    expect(JSON.stringify(failure)).not.toMatch(/ck_secret_key|cs_secret/);
  });

  it("a good sync, scheduled or by the button, clears the note", async () => {
    const scope = await wooUser("ss-clear");
    fakeWoo({ status: 502 });
    await expect(syncStoreIfDue(scope)).rejects.toThrow();
    expect(await getSyncFailure(scope)).not.toBeNull();
    fakeWoo();
    await syncSales(scope, "woocommerce", woo());
    expect(await getSyncFailure(scope)).toBeNull();
  });

  it("the card says so in both languages, with the date", () => {
    for (const lang of ["ar", "en"] as const) {
      const R = appDict[lang].reports.store;
      expect(R.syncFailed).toContain("{date}");
      expect(R.auto.length).toBeGreaterThan(10);
    }
  });
});

describe("the route runs each workspace once per slot (rule 627)", () => {
  it("syncs the workspaces that have a store, leaves the others, and does nothing twice in the same slot", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-abcdef");
    const withStore = await wooUser("ss-cron-a");
    const without = (await newUser("ss-cron-b")).email;
    const call = () => storesCron.GET(new Request("https://nashr.test/api/cron/stores", { headers: { authorization: "Bearer cron-secret-abcdef" } }));
    fakeWoo();
    const first = await call();
    expect(first.status).toBe(200);
    const report = (await first.json()) as { job: string; results: Record<string, string>; synced: number };
    expect(report.job).toBe("stores");
    expect(report.results[withStore]).toBe("synced:woocommerce");
    expect(report.results[without]).toBe("none");
    expect(report.synced).toBeGreaterThanOrEqual(1);
    expect((await getSalesSnapshot(withStore))?.provider).toBe("woocommerce");
    expect(await getSalesSnapshot(without)).toBeNull();

    // Store reads only: the cron also retries the `app/uninstalled` subscription of the Shopify connections other tests
    // here left unmarked (rule 2204), which is not a sync.
    const reads = () => (globalThis.fetch as unknown as { mock: { calls: [RequestInfo, RequestInit?][] } }).mock.calls.filter(([, init]) => !String(init?.body ?? "").includes("webhookSubscription")).length;
    const before = reads();
    const second = (await (await call()).json()) as { alreadyDone: number; processed: number };
    expect(reads()).toBe(before);
    expect(second.processed).toBe(0);
    expect(second.alreadyDone).toBeGreaterThanOrEqual(2);
  });

  it("makes no model call and charges no credits", () => {
    const src = readFileSync("src/app/api/cron/stores/route.ts", "utf8") + readFileSync("src/lib/store-sales.ts", "utf8");
    expect(src).not.toMatch(/anthropic|generateBatch|chargeCredits|spendCredits|@\/lib\/credits/i);
  });
});
