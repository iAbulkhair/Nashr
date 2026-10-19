import { db } from "../db";
import { getProvider } from "./registry";
import { refreshTokens, tokenExpiry } from "./oauth";
import { getConnection, saveConnection, type Connection } from "./store";
import { log } from "../log";

/** Refresh this long before the stored expiry, so a publish never starts with a token about to lapse. */
const EARLY_MS = 5 * 60_000;
const LOCK_S = 30;

/** Thrown when the owner must connect the platform again; routes return it as `reconnect_required`. */
export class ReconnectRequired extends Error {
  constructor(public provider: string) {
    super("reconnect_required");
  }
}

const due = (c: Connection) => !!c.expiresAt && new Date(c.expiresAt).getTime() - Date.now() < EARLY_MS;

async function markNeedsReconnect(scope: string, c: Connection) {
  await saveConnection(scope, { ...c, needsReconnect: new Date().toISOString() });
}

/**
 * The connection with a usable access token. An OAuth token that expires within five minutes is refreshed first,
 * under a per-connection lock: X rotates its refresh token on every use, so two publishes refreshing at once would
 * spend the same single-use token and the second would fail. A refresh the platform refuses marks the connection
 * `needsReconnect` and throws `ReconnectRequired`, instead of letting the raw 401 of the next call reach the owner (#34).
 */
export async function getFreshConnection(scope: string, provider: string): Promise<Connection | null> {
  const c = await getConnection(scope, provider);
  if (!c) return null;
  if (c.needsReconnect) throw new ReconnectRequired(provider);
  const p = getProvider(provider);
  if (!p || p.kind !== "oauth" || !due(c)) return c;
  if (!c.data.refresh_token) {
    await markNeedsReconnect(scope, c);
    throw new ReconnectRequired(provider);
  }
  const lock = `connlock:${scope}:${provider}`;
  for (let i = 0; i < 20 && !(await db.lock(lock, LOCK_S)); i++) {
    // Another request is refreshing: wait for it, then use what it saved.
    await new Promise((r) => setTimeout(r, 250));
    const now = await getConnection(scope, provider);
    if (!now) return null;
    if (now.needsReconnect) throw new ReconnectRequired(provider);
    if (!due(now)) return now;
  }
  try {
    const cur = (await getConnection(scope, provider)) ?? c;
    if (!due(cur)) return cur;
    let data: Record<string, string>;
    try {
      data = await refreshTokens(p, cur.data.refresh_token ?? c.data.refresh_token, cur.meta?.shop);
    } catch (e) {
      log.error("connector refresh failed", { provider, error: e instanceof Error ? e.message.slice(0, 120) : e });
      await markNeedsReconnect(scope, cur);
      throw new ReconnectRequired(provider);
    }
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
    await db.unlock(lock);
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
