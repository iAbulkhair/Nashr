import { db } from "../db";
import { globalKey } from "../keys";
import { pmap } from "../parallel";
import { isComposio } from "./composio-shape";
import { getProvider } from "./registry";
import { listConnections } from "./store";

/**
 * Connection health across every workspace (rules 2177-2178, docs/system/tests/2160-integrations-panel-drift.md). The
 * stores cron counts, per platform, how many workspaces hold a connection, how many of those the platform refused (the
 * owner was asked to reconnect, `needsReconnect`), and how many go through Composio, then keeps the totals under one
 * fixed key. The founder console's Integrations page reads that key, so a platform that starts refusing tokens (a
 * revoked app, an expired review, a key rotated in hPanel) shows as a number instead of as owners' complaints.
 *
 * Counts only: no workspace, account, store or page name is kept or shown. Provider ids not in the registry are left out.
 */

export type ProviderHealth = { connected: number; reconnect: number; composio: number };
export type ConnectionHealth = { at: string; workspaces: number; providers: Record<string, ProviderHealth> };

/** One listing per workspace (pmap, never a loop of awaits), then one write. Returns what it stored. */
export async function tallyConnections(scopes: readonly string[], now = new Date()): Promise<ConnectionHealth> {
  const lists = await pmap(scopes, (scope) => listConnections(scope));
  const providers: Record<string, ProviderHealth> = {};
  for (const conns of lists) {
    for (const c of conns) {
      if (!getProvider(c.provider)) continue;
      const p = (providers[c.provider] ??= { connected: 0, reconnect: 0, composio: 0 });
      p.connected++;
      if (c.needsReconnect) p.reconnect++;
      if (isComposio(c)) p.composio++;
    }
  }
  const health: ConnectionHealth = { at: now.toISOString(), workspaces: scopes.length, providers };
  await db.set(globalKey.connectionHealth(), health);
  return health;
}

const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** The last tally, or null before the first stores run. A broken row reads as zeros; an unknown provider is left out. */
export async function connectionHealth(): Promise<ConnectionHealth | null> {
  const raw = await db.get<unknown>(globalKey.connectionHealth());
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { at?: unknown; workspaces?: unknown; providers?: unknown };
  if (typeof r.at !== "string") return null;
  const providers: Record<string, ProviderHealth> = {};
  if (r.providers && typeof r.providers === "object") {
    for (const [id, v] of Object.entries(r.providers as Record<string, unknown>)) {
      if (!getProvider(id) || !v || typeof v !== "object") continue;
      const x = v as Record<string, unknown>;
      providers[id] = { connected: count(x.connected), reconnect: count(x.reconnect), composio: count(x.composio) };
    }
  }
  return { at: r.at, workspaces: count(r.workspaces), providers };
}
