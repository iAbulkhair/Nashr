import { NextResponse } from "next/server";
import { sameSecret } from "@/lib/rate";
import { recordCronRun } from "@/lib/cron-heartbeat";
import { sc } from "@/lib/auth";
import { dailyRoster } from "@/lib/schedule";
import { runCronBatch } from "@/lib/cron-batch";
import { syncStoreIfDue } from "@/lib/store-sales";
import { applyShopRedactions, backfillUninstallHooks } from "@/lib/connectors/shopify-compliance";
import { appOrigin } from "@/lib/origin";
import { tallyConnections } from "@/lib/connectors/health";
import { keepTokensAlive } from "@/lib/connectors/keepalive";

export const maxDuration = 300;
/** No new workspace's sync starts after this long from the request's start: the limit minus the longest sync (rule 2208). */
const SYNC_START_BUDGET_MS = 240_000;
/** No new Shopify store's subscription starts after this long from the request's start (rule 2208). */
const HOOKS_DEADLINE_MS = 60_000;

/**
 * The store sales snapshot of every active workspace that has a store connected, twice a day (`crons.json`: 02:00 and
 * 14:00 UTC; one entry each, so a plan that allows a cron once a day still runs both). Each workspace's sync runs at most
 * once per slot (`runCronBatch` markers per workspace and half-day), six at a time, resumable like the daily job.
 *
 * Only the cron bearer secret (compared with `sameSecret`) opens it. No model call and no credits: the same read the
 * Sync button does (`syncStoreIfDue` in src/lib/store-sales.ts), which keeps the last good snapshot when a read fails.
 *
 * First, every pending Shopify `shop/redact` (rules 2170-2171, src/lib/connectors/shopify-compliance.ts) is applied to
 * every workspace of the roster, active and idle, so an uninstalled store's connection is gone before any sync. A failed
 * pass keeps the list for the next run and does not stop the syncs.
 *
 * Then expired access tokens of providers whose refresh tokens lapse when unused (Salla, rule 2179,
 * src/lib/connectors/keepalive.ts) are refreshed for the same roster, so a paused brand keeps its store connection.
 * At most 60 a run; a failure does not stop the syncs.
 *
 * Then Shopify stores connected before rule 2203, or whose subscription failed at connect, are subscribed to
 * `app/uninstalled` (rule 2204, src/lib/connectors/shopify-compliance.ts): at most 30 a run; a failure does not stop
 * the syncs.
 *
 * Then the connections of the same roster are counted per platform for the founder console (rules 2177-2178,
 * src/lib/connectors/health.ts), with the keep-alive's and the Shopify subscriptions' counts beside them (rules 2202, 2205): counts only, one fixed key. A failed
 * count leaves the last one and does not stop the syncs.
 *
 * These passes run on the first hop only, never again on a chained one (rule 2208), and the syncs' start budget counts
 * from the request's start, so time the passes take comes out of it instead of past the function's limit; workspaces
 * not started go to the next hop.
 */
export async function GET(req: Request) {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  const now = new Date();
  const slot = now.getUTCHours() < 12 ? "am" : "pm";
  const { users, idle } = await dailyRoster();
  const scopes = [...users.map((u) => sc(u)), ...idle];
  // A chained hop only continues the syncs (rule 2208); its answer leaves the passes' fields out.
  const firstHop = !(Number(new URL(req.url).searchParams.get("chain") ?? 0) > 0);
  const once = <T,>(pass: () => Promise<T>): Promise<T | undefined> => (firstHop ? pass() : Promise.resolve(undefined));
  const shopRedactions = await once(() => applyShopRedactions(scopes).catch((e) => {
    console.error("shop redactions", e instanceof Error ? e.name : "error");
    return -1;
  }));
  const kept = await once(() => keepTokensAlive(scopes, now.getTime()).catch((e) => {
    console.error("token keep-alive", e instanceof Error ? e.name : "error");
    return null;
  }));
  const hooks = await once(() => backfillUninstallHooks(scopes, appOrigin(), now, now.getTime() + HOOKS_DEADLINE_MS).catch((e) => {
    console.error("uninstall hooks", e instanceof Error ? e.name : "error");
    return null;
  }));
  // After the redactions and the keep-alive, so an erased store is not counted and a token lost this run is.
  const health = await once(() => tallyConnections(scopes, now, kept, hooks).then((h) => h.workspaces).catch((e) => {
    console.error("connection health", e instanceof Error ? e.name : "error");
    return -1;
  }));
  const report = await runCronBatch({
    job: "stores", period: `${now.toISOString().slice(0, 10)}-${slot}`, items: users,
    id: (u) => sc(u), run: (u) => syncStoreIfDue(sc(u)),
    concurrency: 6, startBudgetMs: Math.max(0, SYNC_START_BUDGET_MS - (Date.now() - now.getTime())), markerTtlSeconds: 2 * 86400, req,
  });
  await recordCronRun("stores");
  const count = (prefix: string) => Object.values(report.results).filter((r) => r.startsWith(prefix)).length;
  return NextResponse.json({ ok: true, ...report, synced: count("synced:"), failed_sync: count("failed:"), shop_redactions: shopRedactions, health_workspaces: health, kept_alive: kept, uninstall_hooks: hooks });
}
