import { db } from "./db";
import { writeFile } from "./files";
import type { Connection } from "./connectors/store";
import { sallaSales } from "./connectors/salla";
import { shopifySales } from "./connectors/shopify";
import { salesMarkdown, type SalesProvider, type SalesSnapshot } from "./connectors/sales";

const KEY = (scope: string) => `storesales:${scope}`;

/** The latest store sales snapshot for this workspace, or null if it was never synced. One store per workspace. */
export async function getSalesSnapshot(scope: string) {
  return db.get<SalesSnapshot>(KEY(scope));
}

/** Read orders and abandoned carts from the store, keep the totals, and give Noor the same totals as store-sales.md. */
export async function syncSales(scope: string, provider: SalesProvider, c: Connection): Promise<SalesSnapshot> {
  const snap = provider === "shopify" ? await shopifySales(c) : await sallaSales(c);
  const store = provider === "shopify" ? c.meta?.shop : c.meta?.account;
  await Promise.all([db.set(KEY(scope), snap), writeFile(scope, "store-sales.md", salesMarkdown(snap, store), "noor")]);
  return snap;
}
