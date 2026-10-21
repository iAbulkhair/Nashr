import { pmap } from "../parallel";
import { isComposio } from "./composio-shape";
import { getFreshConnection, ReconnectRequired, refreshDue } from "./fresh";
import { getProvider } from "./registry";
import { listConnections } from "./store";

/**
 * Keep short-lived refresh tokens alive (rule 2179, docs/system/tests/2160-integrations-panel-drift.md). Salla's refresh
 * token lasts a month when it is not used and its access token 14 days. A connection is refreshed only when something
 * uses it (`getFreshConnection`), so a paused brand, a suspended account, or a workspace whose sales snapshot reads another
 * store would lose its Salla connection after a month and the owner would have to connect again.
 *
 * Twice a day the stores cron passes the roster's scopes here. A connection of a provider with `oauth.refreshTokenDays`
 * whose access token has expired (or lapses within five minutes) is refreshed through `getFreshConnection`, the same path a publish takes: under its lock,
 * a rotated refresh token saved, a refusal marking `needsReconnect`. Connections already marked, Composio ones and ones
 * with no stored expiry are left alone. At most `MAX_PER_RUN` refreshes a run; the rest wait 12 hours, well inside the
 * 16 days a Salla refresh token still has once its access token lapses. No credits, no model call, nothing published.
 *
 * A provider with `oauth.refreshLeadDays` (Zid, 60 days: its access and refresh tokens both last a year) is picked as soon
 * as its token is inside that lead time (`refreshDue`, rule 2212), so an unused Zid connection is refreshed about ten
 * months in, as Zid's docs advise, and not in the last minutes when its refresh token lapses with it. Only a connection
 * that comes back no longer due counts as refreshed; one the lock holder or a passing failure left due counts as failed
 * and waits for the next run.
 */

export const MAX_PER_RUN = 60;

/** Providers the stores cron keeps alive: a refresh token that lapses unused (Salla) or a lead time (Zid, rule 2212). */
const keptAlive = (provider: string) => {
  const o = getProvider(provider)?.oauth;
  return !!o?.refreshTokenDays || !!o?.refreshLeadDays;
};

export type KeepAlive = { due: number; refreshed: number; lost: number; failed: number };

export async function keepTokensAlive(scopes: readonly string[], now = Date.now()): Promise<KeepAlive> {
  const lists = await pmap(scopes, (scope) => listConnections(scope));
  const due = lists.flatMap((conns, i) =>
    conns
      .filter((c) => keptAlive(c.provider) && !c.needsReconnect && !isComposio(c) && refreshDue(c, now))
      .map((c) => ({ scope: scopes[i], provider: c.provider })),
  );
  const picked = due.slice(0, MAX_PER_RUN);
  const results = await pmap(picked, async ({ scope, provider }) => {
    try {
      const c = await getFreshConnection(scope, provider);
      return c && !refreshDue(c) ? ("refreshed" as const) : ("failed" as const);
    } catch (e) {
      return e instanceof ReconnectRequired ? ("lost" as const) : ("failed" as const);
    }
  }, 6);
  const count = (r: string) => results.filter((x) => x === r).length;
  return { due: due.length, refreshed: count("refreshed"), lost: count("lost"), failed: count("failed") };
}
