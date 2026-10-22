import { db } from "../db";
import { getProvider } from "./registry";
import { refreshTokens, tokenExpiry } from "./oauth";
import { getConnection, saveConnection, type Connection } from "./store";
import { log } from "../log";

/** Refresh this long before the stored expiry, so a publish never starts with a token about to lapse. */
const EARLY_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const LOCK_S = 30;
/** Tries for the refresh lock, 250 ms apart: about five seconds for the request that holds it to save the new token. */
const LOCK_TRIES = 20;
/** The Retry-After, in seconds, of a 503 `busy` answer: by then the holder has saved the new token or its lock lapsed. */
export const BUSY_RETRY_S = 5;

/** Thrown when the owner must connect the platform again; routes return it as `reconnect_required`. */
export class ReconnectRequired extends Error {
  constructor(public provider: string) {
    super("reconnect_required");
  }
}

/**
 * Thrown when another request held the refresh lock through every wait and the token is still due (rule 2192). Nothing
 * was refreshed or sent; routes answer it as 503 `busy` and the caller may try again in a moment.
 */
export class RefreshBusy extends Error {
  constructor(public provider: string) {
    super("busy");
  }
}

/**
 * How long before its stored expiry a provider's token is refreshed (rule 2210): `oauth.refreshLeadDays` where the
 * registry sets it (Zid, 60 days: its access and refresh tokens both last a year), five minutes for every other
 * provider.
 */
export function refreshLeadMs(provider: string): number {
  const days = getProvider(provider)?.oauth?.refreshLeadDays;
  return days && days > 0 ? days * DAY_MS : EARLY_MS;
}

/** The connection's token expires within its provider's lead time, so the next use refreshes it (rule 2210). */
export function refreshDue(c: Pick<Connection, "provider" | "expiresAt">, now = Date.now()): boolean {
  return !!c.expiresAt && Date.parse(c.expiresAt) - now < refreshLeadMs(c.provider);
}

/** Within the last five minutes: the token cannot be used as it is, whatever its provider's lead time (rule 2211). */
const urgent = (c: Connection) => !!c.expiresAt && Date.parse(c.expiresAt) - Date.now() < EARLY_MS;
/** The token URL answered 400, 401 or 403: the refresh token itself was refused, not a passing failure. */
const refused = (e: unknown) => e instanceof Error && /\btoken 40[013]\b/.test(e.message);

async function markNeedsReconnect(scope: string, c: Connection) {
  await saveConnection(scope, { ...c, needsReconnect: new Date().toISOString() });
}

/** The connection lock (rule 2192): the refresh, a disconnect and a new connection of one provider take it in turn (rule 2931). */
const connLock = (scope: string, provider: string) => `connlock:${scope}:${provider}`;

/** The connection lock could not be had: a refresh held it through every wait. Nothing was written; try again shortly. */
export class ConnectionBusy extends Error {
  constructor(public provider: string) {
    super("busy");
  }
}

/**
 * Runs `fn` holding the connection's owned lock (rule 2931), the one the refresh takes (rule 2192), so a disconnect or a
 * new connection never lands in the middle of a refresh: the refresh would otherwise save the old grant's tokens over
 * the new connection, or bring a deleted one back. Tried for as long as a refresher waits (about five seconds); a lock
 * that stays held throws `ConnectionBusy` and `fn` never runs. Only this call's own lock is released.
 */
export async function withConnectionLock<T>(scope: string, provider: string, fn: () => Promise<T>): Promise<T> {
  const lock = connLock(scope, provider);
  let token: string | null = null;
  for (let i = 0; i < LOCK_TRIES && !token; i++) {
    if (i) await new Promise((r) => setTimeout(r, 250));
    token = await db.lockOwned(lock, LOCK_S);
  }
  if (!token) throw new ConnectionBusy(provider);
  try {
    return await fn();
  } finally {
    await db.unlockOwned(lock, token);
  }
}

/**
 * The connection with a usable access token. An OAuth token that expires within five minutes (Zid: 60 days, rule
 * 2210, `refreshDue`) is refreshed first, under a per-connection lock: X rotates its refresh token on every use, so
 * two publishes refreshing at once would spend the same single-use token and the second would fail. A refresh the
 * platform refuses marks the connection `needsReconnect` and throws `ReconnectRequired`, instead of letting the raw 401
 * of the next call reach the owner (#34).
 * The lock is owned (`lockOwned`): a request that never wins it does not refresh, it returns what the holder saved or
 * throws `RefreshBusy` (rule 2192). A token that is only inside its provider's lead time still works, so there a busy
 * lock or a passing refresh failure returns the connection as it is, unmarked, and a later use tries again (rule 2211).
 */
export async function getFreshConnection(scope: string, provider: string): Promise<Connection | null> {
  const c = await getConnection(scope, provider);
  if (!c) return null;
  if (c.needsReconnect) throw new ReconnectRequired(provider);
  const p = getProvider(provider);
  if (!p || p.kind !== "oauth" || !refreshDue(c)) return c;
  if (!c.data.refresh_token) {
    if (!urgent(c)) return c;
    await markNeedsReconnect(scope, c);
    throw new ReconnectRequired(provider);
  }
  const lock = connLock(scope, provider);
  // Never refresh without the lock (rule 2192): X rotates its refresh token on every use and Salla revokes every token
  // when one is used twice, so a refresh outside the lock spends the same single-use token twice.
  let token: string | null = null;
  let latest = c;
  for (let i = 0; i < LOCK_TRIES; i++) {
    token = await db.lockOwned(lock, LOCK_S);
    if (token) break;
    // Another request is refreshing: wait for it, then use what it saved.
    await new Promise((r) => setTimeout(r, 250));
    const now = await getConnection(scope, provider);
    if (!now) return null;
    if (now.needsReconnect) throw new ReconnectRequired(provider);
    if (!refreshDue(now)) return now;
    latest = now;
  }
  if (!token) {
    // The holder is refreshing a token that still works for weeks: use it rather than fail the request (rule 2211).
    if (!urgent(latest)) return latest;
    throw new RefreshBusy(provider);
  }
  try {
    // A connection deleted while this request waited stays deleted: never the record read before the lock (rule 2931).
    const cur = await getConnection(scope, provider);
    if (!cur) return null;
    if (cur.needsReconnect) throw new ReconnectRequired(provider);
    if (!refreshDue(cur)) return cur;
    if (!cur.data.refresh_token) {
      if (!urgent(cur)) return cur;
      await markNeedsReconnect(scope, cur);
      throw new ReconnectRequired(provider);
    }
    let data: Record<string, string>;
    try {
      data = await refreshTokens(p, cur.data.refresh_token, cur.meta?.shop);
    } catch (e) {
      log.error("connector refresh failed", { provider, error: e instanceof Error ? e.message.slice(0, 120) : e });
      // Weeks left on the token and the platform did not refuse the refresh token: keep the connection (rule 2211).
      if (!urgent(cur) && !refused(e)) return cur;
      // Only the grant this refresh spent is marked: a disconnect or a new connection since then is left as it is.
      const now = await getConnection(scope, provider);
      if (!now) return null;
      if (now.connectedAt !== cur.connectedAt) return now;
      await markNeedsReconnect(scope, cur);
      throw new ReconnectRequired(provider);
    }
    // Read again before the save (rule 2931), as backfillUninstallHooks does: a connection deleted during the refresh is not
    // brought back, and one connected again since (another `connectedAt`) keeps its own tokens, never the old grant's.
    const again = await getConnection(scope, provider);
    if (!again) return null;
    if (again.connectedAt !== cur.connectedAt) return again;
    const next: Connection = {
      ...cur,
      // Keep the old refresh token when the platform does not rotate it.
      data: { ...cur.data, ...data, refresh_token: data.refresh_token ?? cur.data.refresh_token },
      expiresAt: tokenExpiry(data),
      needsReconnect: undefined,
    };
    await saveConnection(scope, next);
    return next;
  } finally {
    // Only this request's own lock: one whose lock expired mid-refresh must not free the next holder's (rule 2192).
    await db.unlockOwned(lock, token);
  }
}

/** A platform refused a token that was not due: nothing but a new connection can fix that. */
export async function refusedToken(scope: string, provider: string, err: unknown): Promise<unknown> {
  const p = getProvider(provider);
  const msg = err instanceof Error ? err.message : "";
  if (p?.kind !== "oauth" || !/\b(401|403)\b/.test(msg)) return err;
  const c = await getConnection(scope, provider);
  if (c) await markNeedsReconnect(scope, c);
  return new ReconnectRequired(provider);
}
