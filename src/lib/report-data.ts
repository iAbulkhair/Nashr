import type { TaskType } from "./brand";
import { agentForTask } from "./agents";
import { kpis, rangeWindow, statsText } from "./stats";
import { listConnections } from "./connectors/store";
import { READS_METRICS } from "./connectors/working";
import { storeMetrics, type StoreMetric } from "./store-metrics";
import type { Totals } from "./connectors/orders";

/**
 * The data block Dana's report tasks are generated from: the workspace KPIs, plus STORE DATA when a connected store
 * has an order reader. Every other agent gets an empty string. Workspace KPIs stay in stats.ts, which never reads a
 * connection; store numbers come from store-metrics.ts, for the caller's scope only.
 */
export async function reportData(type: TaskType, scope: string): Promise<string> {
  if (agentForTask(type).id !== "dana") return "";
  const [k, conns] = await Promise.all([kpis(scope), listConnections(scope)]);
  const stores = conns.map((c) => c.provider).filter((p) => READS_METRICS.includes(p));
  if (!stores.length) return statsText(k);
  const w7 = rangeWindow("7"), w30 = rangeWindow("30");
  const [m7, m30] = await Promise.all([storeMetrics(scope, stores, w7), storeMetrics(scope, stores, w30)]);
  return `${statsText(k, { store: true })}\n\n${storeText(m7, m30, w7, w30)}`;
}

const NAMES: Record<string, string> = { salla: "Salla", zid: "Zid", shopify: "Shopify", woocommerce: "WooCommerce" };
const day = (d: Date) => d.toISOString().slice(0, 10);

function money(t: Totals, floor: boolean): string {
  const parts = Object.entries(t.revenue).map(([cur, amt]) => `${amt} ${cur}`);
  return `${floor ? "at least " : ""}${parts.length ? parts.join(" + ") : "0"}`;
}

function line(label: string, win: { from: Date; to: Date }, m: StoreMetric, prevLabel: string): string {
  const f = m.partial;
  const prev = f ? "" : ` (${prevLabel}: ${m.prev.orders} orders, ${money(m.prev, false)})`;
  return `- ${NAMES[m.provider] ?? m.provider}, ${label} (${day(win.from)} to ${day(win.to)}): ${f ? "at least " : ""}${m.cur.orders} orders, revenue ${money(m.cur, f)}${prev}`;
}

/** Plain-text block for prompts. Only numbers, dates, our own store names and validated currency codes reach it. */
export function storeText(m7: StoreMetric[], m30: StoreMetric[], w7: { from: Date; to: Date }, w30: { from: Date; to: Date }): string {
  const out = ["STORE DATA (read from each connected store's own API; orders exclude cancelled, refunded, failed and test orders; revenue is order totals per currency, before fees and refunds of kept orders)"];
  for (const m of m7) {
    const month = m30.find((x) => x.provider === m.provider);
    if (m.error || !month || month.error) {
      out.push(`- ${NAMES[m.provider] ?? m.provider}: could not be read (${m.error === "reconnect_required" || month?.error === "reconnect_required" ? "the owner must reconnect it" : "the store did not answer"}). Do not estimate its numbers; use [رقم].`);
      continue;
    }
    out.push(line("last 7 days", w7, m, "previous 7 days"));
    out.push(line("last 30 days", w30, month, "previous 30 days"));
  }
  out.push("- \"at least\" marks a floor: the store had more orders than one read covers, so no comparison is given. Never add amounts in different currencies.");
  return out.join("\n");
}
