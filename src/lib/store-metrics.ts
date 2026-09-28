import { db } from "./db";
import { getFreshConnection, refusedToken } from "./connectors/fresh";
import { ORDER_READERS, readOrders, totals, type Totals } from "./connectors/orders";

/**
 * Store orders and revenue for the Reports page, per connected store, for the selected window and the one before it.
 * One read covers both windows. Answers are cached per workspace for 15 minutes, so reopening Reports does not walk a
 * store's orders again; the key holds the caller's scope and nothing from the request but the window boundaries.
 */
export type StoreMetric = { provider: string; cur: Totals; prev: Totals; partial: boolean; error?: string };

const TTL_S = 15 * 60;
const bucket = (d: Date) => Math.floor(d.getTime() / (TTL_S * 1000));

export async function storeMetrics(scope: string, providers: string[], win: { from: Date; to: Date; prevFrom: Date }): Promise<StoreMetric[]> {
  const readable = providers.filter((p): p is (typeof ORDER_READERS)[number] => (ORDER_READERS as readonly string[]).includes(p));
  return Promise.all(readable.map((p) => one(scope, p, win)));
}

async function one(scope: string, provider: string, win: { from: Date; to: Date; prevFrom: Date }): Promise<StoreMetric> {
  const key = `storemetrics:${scope}:${provider}:${bucket(win.prevFrom)}:${bucket(win.from)}:${bucket(win.to)}`;
  const hit = await db.get<StoreMetric>(key);
  if (hit) return hit;
  try {
    const c = await getFreshConnection(scope, provider);
    if (!c) return { provider, cur: { orders: 0, revenue: {} }, prev: { orders: 0, revenue: {} }, partial: false, error: "not_connected" };
    const read = await readOrders(c, win.prevFrom, win.to);
    const prevTo = new Date(win.from.getTime() - 1);
    const out: StoreMetric = { provider, cur: totals(read.rows, win.from, win.to), prev: totals(read.rows, win.prevFrom, prevTo), partial: read.partial };
    await db.set(key, out, TTL_S);
    return out;
  } catch (e) {
    const err = await refusedToken(scope, provider, e);
    console.error("store metrics failed", provider, err instanceof Error ? err.message.slice(0, 120) : err);
    return { provider, cur: { orders: 0, revenue: {} }, prev: { orders: 0, revenue: {} }, partial: false, error: err instanceof Error ? err.message : "failed" };
  }
}
