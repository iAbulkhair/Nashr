import { NextResponse } from "next/server";
import { sameSecret } from "@/lib/rate";
import { recordCronRun } from "@/lib/cron-heartbeat";
import { sc } from "@/lib/auth";
import { dailyRoster } from "@/lib/schedule";
import { runCronBatch } from "@/lib/cron-batch";
import { syncStoreIfDue } from "@/lib/store-sales";
import { applyShopRedactions } from "@/lib/connectors/shopify-compliance";
import { tallyConnections } from "@/lib/connectors/health";
import { keepTokensAlive } from "@/lib/connectors/keepalive";

export const maxDuration = 300;

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
 * Then the connections of the same roster are counted per platform for the founder console (rules 2177-2178,
 * src/lib/connectors/health.ts), with the keep-alive's counts beside them (rule 2202): counts only, one fixed key. A failed
 * count leaves the last one and does not stop the syncs.
 */
export async function GET(req: Request) {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  const now = new Date();
  const slot = now.getUTCHours() < 12 ? "am" : "pm";
  const { users, idle } = await dailyRoster();
  const scopes = [...users.map((u) => sc(u)), ...idle];
  const shopRedactions = await applyShopRedactions(scopes).catch((e) => {
    console.error("shop redactions", e instanceof Error ? e.name : "error");
    return -1;
  });
  const kept = await keepTokensAlive(scopes, now.getTime()).catch((e) => {
    console.error("token keep-alive", e instanceof Error ? e.name : "error");
    return null;
  });
  // After the redactions and the keep-alive, so an erased store is not counted and a token lost this run is.
  const health = await tallyConnections(scopes, now, kept).then((h) => h.workspaces).catch((e) => {
    console.error("connection health", e instanceof Error ? e.name : "error");
    return -1;
  });
  const report = await runCronBatch({
    job: "stores", period: `${now.toISOString().slice(0, 10)}-${slot}`, items: users,
    id: (u) => sc(u), run: (u) => syncStoreIfDue(sc(u)),
    concurrency: 6, startBudgetMs: 240_000, markerTtlSeconds: 2 * 86400, req,
  });
  await recordCronRun("stores");
  const count = (prefix: string) => Object.values(report.results).filter((r) => r.startsWith(prefix)).length;
  return NextResponse.json({ ok: true, ...report, synced: count("synced:"), failed_sync: count("failed:"), shop_redactions: shopRedactions, health_workspaces: health, kept_alive: kept });
}
