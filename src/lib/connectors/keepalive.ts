import { pmap } from "../parallel";
import { isComposio } from "./composio-shape";
import { getFreshConnection, ReconnectRequired } from "./fresh";
import { getProvider } from "./registry";
import { listConnections } from "./store";

/**
 * Keep short-lived refresh tokens alive (rule 2179, docs/system/tests/2160-integrations-panel-drift.md). Salla's refresh
 * token lasts a month when it is not used and its access token 14 days. A connection is refreshed only when something
 * uses it (`getFreshConnection`), so a paused brand, a suspended account, or a workspace whose sales snapshot reads another
 * store would lose its Salla connection after a month and the owner would have to connect again.
 *
 * Twice a day the stores cron passes the roster's scopes here. A connection of a provider with `oauth.refreshTokenDays`
 * whose access token has expired is refreshed through `getFreshConnection`, the same path a publish takes: under its lock,
 * a rotated refresh token saved, a refusal marking `needsReconnect`. Connections already marked, Composio ones and ones
 * with no stored expiry are left alone. At most `MAX_PER_RUN` refreshes a run; the rest wait 12 hours, well inside the
 * 16 days a Salla refresh token still has once its access token lapses. No credits, no model call, nothing published.
 */

export const MAX_PER_RUN = 60;

export type KeepAlive = { due: number; refreshed: number; lost: number; failed: number };

export async function keepTokensAlive(scopes: readonly string[], now = Date.now()): Promise<KeepAlive> {
  const lists = await pmap(scopes, (scope) => listConnections(scope));
  const due = lists.flatMap((conns, i) =>
    conns
      .filter((c) => !!getProvider(c.provider)?.oauth?.refreshTokenDays && !c.needsReconnect && !isComposio(c) && !!c.expiresAt && Date.parse(c.expiresAt) <= now)
      .map((c) => ({ scope: scopes[i], provider: c.provider })),
  );
  const picked = due.slice(0, MAX_PER_RUN);
  const results = await pmap(picked, async ({ scope, provider }) => {
    try {
      await getFreshConnection(scope, provider);
      return "refreshed" as const;
    } catch (e) {
      return e instanceof ReconnectRequired ? ("lost" as const) : ("failed" as const);
    }
  }, 6);
  const count = (r: string) => results.filter((x) => x === r).length;
  return { due: due.length, refreshed: count("refreshed"), lost: count("lost"), failed: count("failed") };
}
