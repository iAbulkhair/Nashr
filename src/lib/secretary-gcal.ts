/**
 * Reem B3: the provider side of the calendar link (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §3, §4, §5).
 * This part: the proof read at connection time and the connect step the OAuth callback calls. Nashr never calls a
 * provider's revoke endpoint (ruling R7): Google grants are shared per user and client with the publishing connection.
 * Task 5 adds the token refresh (`freshAccess`), the list of the account's own calendars and the lost-token step the calendar-link
 * routes share; the event fetch follows.
 *
 * Importers: `src/app/api/connect/[provider]/callback/route.ts` (and the calendar routes and the sync, later). The hosts
 * below are fixed constants called with plain `fetch`, the way `tokenRequest` does; no URL here comes from a user.
 * Tokens, provider answers and the account address never go into a log, an audit line or a URL.
 */
import { listBrands, scopeFor } from "./brands";
import { refreshTokens } from "./connectors/oauth";
import { getProvider, type CalProvider } from "./connectors/registry";
import { db } from "./db";
import { SEC_KEYS, audit } from "./secretary";
import { dropLink, getLink, openTokens, putLink, sealTokens, type CalLink } from "./secretary-cal-link";
import { decodeIdToken, googleAccount, microsoftDomain, MS_CONSUMER_TENANT } from "./secretary-cal-proof";

export const GOOGLE_API = "https://www.googleapis.com";
export const GRAPH = "https://graph.microsoft.com/v1.0";

/** One provider call must not hold the brand's calendar lock for long. */
const PROVIDER_TIMEOUT_MS = 8_000;
/** One refresh of the token gets the same 8 s as a provider call (`refreshTokens` itself has no timeout). */
const REFRESH_TIMEOUT_MS = 8_000;
/**
 * How long a calendar critical section may hold the brand's calendar lock (ruling R8). The worst case inside it is a refresh
 * (8 s), Graph `/me` and `/organization` (8 s each) and the calendar list (8 s): 32 s of provider time plus a few store reads,
 * so 45 s outlives it; a run that still overran would lose its lock to the next one, never free that one's (`unlockOwned`).
 */
export const CAL_LOCK_TTL_S = 45;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What a calendar critical section answers when the lock could not be taken: a busy brand, shown as a provider failure (ruling R8). */
export type CalBusy = { ok: false; error: "provider_error"; status: 503 };

/**
 * The calendar link's own lock (`sec:lock:{scope}:callink`, apart from the Working days save's `cal` lock) for its critical
 * sections: connect, choose, the calendar list, unlink and, later, the sync. SET NX with an owner token and `CAL_LOCK_TTL_S`,
 * 60 tries 50 ms apart, released with `unlockOwned` so a run whose lock expired can never delete the lock of the run that took
 * it next (plain `withLock` would, and a slow choose could then undo an unlink).
 */
export async function withCalLock<T>(scope: string, fn: () => Promise<T>): Promise<T | CalBusy> {
  const key = SEC_KEYS.lock(scope, "callink");
  let token: string | null = null;
  for (let i = 0; i < 60 && !token; i++) {
    token = await db.lockOwned(key, CAL_LOCK_TTL_S);
    if (!token) await sleep(50);
  }
  if (!token) return { ok: false, error: "provider_error", status: 503 };
  try {
    return await fn();
  } finally {
    await db.unlockOwned(key, token).catch((e) => console.error("cal lock release failed", e instanceof Error ? e.name : "error"));
  }
}

const bearer = (access: string) => ({ Authorization: `Bearer ${access}`, Accept: "application/json" });

/**
 * Who the signed-in account is and the domain the provider proves for it (spec §4.2). Throws on any provider failure;
 * callers map that to `provider_error` and never show its text.
 * - Google: from the `id_token` of the token response (`email`, `email_verified`, `hd`).
 * - Microsoft: the token's tenant must not be the consumer one, and `/organization` must list the domain of the user's UPN.
 *   A token that carries no `id_token` (an unrefreshed one, or a refresh without it) names no tenant: `workTenant` says the
 *   link was earlier proven on a work or school tenant, so `/organization` is asked again instead of failing closed to "no
 *   domain". The proof is still only what `/organization` lists; a consumer account has none to ask and is never `workTenant`.
 */
export async function connectProof(p: CalProvider, data: Record<string, string>, access: string, workTenant = false): Promise<{ account: string; accountDomain: string | null }> {
  if (p === "gcal") {
    const claims = decodeIdToken(data.id_token);
    if (!claims) throw new Error("no_id_token");
    const { account, domain } = googleAccount(claims);
    if (!account) throw new Error("no_account");
    return { account, accountDomain: domain };
  }
  const tid = decodeIdToken(data.id_token)?.tid ?? (workTenant ? "work-tenant" : undefined);
  const me = await fetch(`${GRAPH}/me?$select=userPrincipalName,mail`, { headers: bearer(access), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  if (!me.ok) throw new Error("graph_me");
  const who = (await me.json()) as { userPrincipalName?: unknown; mail?: unknown };
  const upn = typeof who.userPrincipalName === "string" ? who.userPrincipalName : "";
  const mail = typeof who.mail === "string" && who.mail ? who.mail : "";
  const account = mail || upn;
  if (!account) throw new Error("no_account");
  // A personal Microsoft account has no organization to ask, and never proves a domain.
  if (typeof tid !== "string" || !tid || tid === MS_CONSUMER_TENANT) return { account, accountDomain: null };
  const org = await fetch(`${GRAPH}/organization?$select=verifiedDomains`, { headers: bearer(access), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  if (!org.ok) throw new Error("graph_organization");
  const rows = ((await org.json()) as { value?: { verifiedDomains?: { name?: unknown }[] }[] }).value ?? [];
  const names = rows.flatMap((r) => (r.verifiedDomains ?? []).map((d) => d.name)).filter((n): n is string => typeof n === "string");
  return { account, accountDomain: microsoftDomain(tid, upn, names) };
}

export type ConnectResult = { ok: true } | { ok: false; code: "brand_inactive" | "token_failed" | "provider_error" };

/**
 * What the OAuth callback does with a code exchange: under the brand's calendar lock, check the brand is still active, read
 * the proof, drop any earlier link, and write the new one in state `choose` (no calendar yet, proof decided at
 * the save). `scope` is the brand the flow started on (from the saved state), `login` the owner login that finished it.
 * Throws when the provider could not be read; the callback turns that into `provider_error`.
 */
export async function connectCalendar(scope: string, login: string, p: CalProvider, data: Record<string, string>, now: number): Promise<ConnectResult> {
  const r = await withCalLock(scope, async (): Promise<ConnectResult> => {
    const owner = scope.split("#")[0];
    const active = (await listBrands(owner)).some((b) => b.status === "active" && scopeFor(owner, b.id) === scope);
    if (!active) {
      return { ok: false, code: "brand_inactive" };
    }
    const access = data.access_token;
    const refresh = data.refresh_token;
    if (!access || !refresh) return { ok: false, code: "token_failed" };
    const proof = await connectProof(p, data, access);
    const earlier = await getLink(scope);
    // Only our side: the sealed tokens go with the record. Nashr never calls Google's revoke endpoint (ruling R7).
    if (earlier) await dropLink(scope);
    const expires = Number(data.expires_in);
    const link: CalLink = {
      v: 1,
      provider: p,
      login,
      account: proof.account,
      ...(proof.accountDomain ? { accountDomain: proof.accountDomain } : {}),
      proof: null,
      tokens: sealTokens({ access, refresh, expiresAt: now + (Number.isFinite(expires) && expires > 0 ? expires : 3600) * 1000 }),
      state: "choose",
      connectedAt: now,
      rev: 1,
    };
    await putLink(scope, link);
    await audit(scope, { actor: "owner", via: "web", login }, "cal_link", "-", `provider=${p}`);
    return { ok: true };
  });
  // A lock that could not be taken is a busy brand, not a bad token: the owner can try again.
  return "code" in r || r.ok ? r : { ok: false, code: "provider_error" };
}

/** The proof of a link being saved (spec §4, ruling R3): Google keeps what the code exchange proved unless the refresh answered with an `id_token`; Microsoft asks Graph every time. */
export async function reproof(link: CalLink, data: Record<string, string>, access: string): Promise<{ account: string; accountDomain: string | null }> {
  if (link.provider === "gcal") {
    if (!data.id_token) return { account: link.account, accountDomain: link.accountDomain ?? null };
    return connectProof("gcal", data, access);
  }
  return connectProof("mscal", data, access, !!link.accountDomain);
}

/** An access token with at least this much life left is used as it is. */
const REFRESH_SKEW_MS = 120_000;

export type Fresh =
  | { ok: true; access: string; link: CalLink; data: Record<string, string> }
  | { ok: false; lost: "token" }
  | { ok: false; retry: true };

/**
 * A usable access token for the link, refreshed through `refreshTokens` when it expires within 2 minutes. The caller holds the
 * brand's calendar lock. The refresh token is kept when the answer carries none; the resealed tokens are written to the link
 * (same `rev`). `data` is the refresh answer (empty when nothing was refreshed), for `reproof`. `lost: "token"` is a refresh
 * the provider refused with `invalid_grant`, or tokens that no longer open (ruling R9); anything else, a 401 from the token
 * endpoint (a wrong client secret) and a refresh slower than 8 s included, is `retry` and changes nothing. The provider's
 * text never leaves this function: the error's name is all that is logged.
 */
export async function freshAccess(scope: string, link: CalLink, now: number): Promise<Fresh> {
  const t = openTokens(link);
  if (!t) return { ok: false, lost: "token" };
  if (t.expiresAt - now >= REFRESH_SKEW_MS) return { ok: true, access: t.access, link, data: {} };
  const p = getProvider(link.provider);
  if (!p) return { ok: false, retry: true };
  let data: Record<string, string>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const slow = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("refresh_timeout")), REFRESH_TIMEOUT_MS); });
    data = await Promise.race([refreshTokens(p, t.refresh), slow]);
  } catch (e) {
    if (e instanceof Error && e.message.includes("invalid_grant")) return { ok: false, lost: "token" };
    console.error("cal refresh failed", e instanceof Error ? e.name : "error");
    return { ok: false, retry: true };
  } finally {
    clearTimeout(timer);
  }
  const access = data.access_token;
  if (!access) return { ok: false, retry: true };
  const expires = Number(data.expires_in);
  const next: CalLink = { ...link, tokens: sealTokens({ access, refresh: data.refresh_token || t.refresh, expiresAt: now + (Number.isFinite(expires) && expires > 0 ? expires : 3600) * 1000 }) };
  await putLink(scope, next);
  return { ok: true, access, link: next, data };
}

/**
 * The link's tokens are gone (spec §7.3): state `reconnect` with `lostReason: "token"`, the synced events deleted, one
 * `cal_lost` audit line with the login and the provider. Only our side changes; nothing is sent to the provider (ruling R7).
 * The caller holds the lock. The in-app notice and the sync's own use of this belong to the sync task.
 */
export async function loseLink(scope: string, link: CalLink, login: string): Promise<void> {
  const next: CalLink = { ...link, state: "reconnect", lostReason: "token", rev: link.rev + 1 };
  delete next.choices;
  await Promise.all([putLink(scope, next), db.del(SEC_KEYS.calEvents(scope)), audit(scope, { actor: "owner", via: "web", login }, "cal_lost", "-", `provider=${link.provider}`)]);
}

/** Calendar names are the provider's text: no control characters, at most 100 characters. */
const cleanName = (v: unknown): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100) : "") || "—";

/**
 * The calendars the signed-in account owns, live from the provider, at most 50 (spec §4.5). Google keeps `accessRole ===
 * "owner"`; Microsoft keeps `canEdit === true` whose `owner.address` is the account's address (case-insensitive), so a calendar
 * shared in by someone else is never offered. Throws on any provider failure with `status` set to the HTTP status (401 means
 * the token is lost); callers map it to `provider_error` and never show its text.
 */
export async function listOwnCalendars(p: CalProvider, access: string, account: string): Promise<{ id: string; name: string }[]> {
  const url = p === "gcal" ? `${GOOGLE_API}/calendar/v3/users/me/calendarList?minAccessRole=owner&maxResults=50&fields=items(id,summary,accessRole)` : `${GRAPH}/me/calendars?$select=id,name,canEdit,owner&$top=50`;
  const res = await fetch(url, { headers: bearer(access), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  if (!res.ok) throw Object.assign(new Error(`calendar_list_${res.status}`), { status: res.status });
  const j = (await res.json()) as { items?: unknown; value?: unknown };
  const rows = (p === "gcal" ? j.items : j.value) as { id?: unknown; summary?: unknown; name?: unknown; accessRole?: unknown; canEdit?: unknown; owner?: { address?: unknown } }[] | undefined;
  const mine = (c: NonNullable<typeof rows>[number]) => (p === "gcal" ? c.accessRole === "owner" : c.canEdit === true && typeof c.owner?.address === "string" && c.owner.address.toLowerCase() === account.toLowerCase());
  return (Array.isArray(rows) ? rows : [])
    .filter((c) => c && typeof c.id === "string" && c.id && mine(c))
    .slice(0, 50)
    .map((c) => ({ id: c.id as string, name: cleanName(p === "gcal" ? c.summary : c.name) }));
}

/** The longest a provider's `Retry-After` is honoured (spec §7: capped at 60 minutes). */
const RETRY_AFTER_MAX_S = 3_600;
export type EventsResult = { ok: true; raw: unknown[] } | { ok: false; kind: "auth" | "gone" | "retry"; retryAfterS?: number };

/** `Retry-After` as whole seconds (the number form, or an HTTP date), at most 60 minutes; anything else is undefined. */
function retryAfter(h: string | null, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const t = h.trim();
  const secs = /^\d+$/.test(t) ? Number(t) : (Date.parse(t) - now) / 1000;
  return Number.isFinite(secs) && secs >= 0 ? Math.min(RETRY_AFTER_MAX_S, Math.ceil(secs)) : undefined;
}

/**
 * The raw events of the chosen calendar between two instants (spec §7 step 4), requested from `link.calendarId` and nothing
 * else: no `primary`, no calendar list, never Outlook's all-calendars `/me/events`. The hosts are the fixed constants above and
 * the id only goes through `encodeURIComponent` into the path. Only the selected fields are asked for, so no attendee names,
 * descriptions, places or meeting links are ever received. 401 is `auth`, 404 `gone` (the calendar is no longer there); 429,
 * 5xx, any other status, a timeout, a network error and an unreadable answer are `retry`, with the provider's `Retry-After`
 * when it gave one. Nothing of a response text leaves this function and only the error's name is logged. `raw` is untrusted:
 * the caller passes each item through `keepGoogle` / `keepGraph`.
 */
export async function fetchEvents(link: CalLink, access: string, fromMs: number, toMs: number): Promise<EventsResult> {
  if (!link.calendarId) return { ok: false, kind: "gone" };
  // `encodeURIComponent` leaves dots alone and a dot segment is resolved by URL parsing, so these two would leave the calendar path.
  if (link.calendarId === "." || link.calendarId === "..") return { ok: false, kind: "retry" };
  const id = encodeURIComponent(link.calendarId);
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const google = link.provider === "gcal";
  const url = google
    ? `${GOOGLE_API}/calendar/v3/calendars/${id}/events?${new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: "300", fields: "items(status,summary,start,end,transparency,visibility,attendees(self,responseStatus))" })}`
    : `${GRAPH}/me/calendars/${id}/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}&$select=subject,start,end,isAllDay,showAs,isCancelled,sensitivity,responseStatus&$top=300`;
  try {
    const res = await fetch(url, { headers: google ? bearer(access) : { ...bearer(access), Prefer: 'outlook.timezone="UTC"' }, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    if (res.status === 401) return { ok: false, kind: "auth" };
    if (res.status === 404) return { ok: false, kind: "gone" };
    if (!res.ok) {
      const after = retryAfter(res.headers.get("retry-after"));
      return { ok: false, kind: "retry", ...(after === undefined ? {} : { retryAfterS: after }) };
    }
    const j = (await res.json()) as { items?: unknown; value?: unknown } | null;
    const rows = google ? j?.items ?? [] : j?.value;
    return Array.isArray(rows) ? { ok: true, raw: rows } : { ok: false, kind: "retry" };
  } catch (e) {
    console.error("cal events fetch failed", e instanceof Error ? e.name : "error");
    return { ok: false, kind: "retry" };
  }
}
