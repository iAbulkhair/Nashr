import { db } from "./db";
import { writeFile } from "./files";
import type { Connection } from "./connectors/store";
import { sallaSales, salesMarkdown, type SalesSnapshot } from "./connectors/salla";

const KEY = (scope: string) => `storesales:${scope}`;

/** The latest store sales snapshot for this workspace, or null if it was never synced. */
export async function getSalesSnapshot(scope: string) {
  return db.get<SalesSnapshot>(KEY(scope));
}

/** Read orders and abandoned carts from the store, keep the totals, and give Noor the same totals as store-sales.md. */
export async function syncSales(scope: string, c: Connection): Promise<SalesSnapshot> {
  const snap = await sallaSales(c);
  await Promise.all([db.set(KEY(scope), snap), writeFile(scope, "store-sales.md", salesMarkdown(snap, c.meta?.account), "noor")]);
  return snap;
}
