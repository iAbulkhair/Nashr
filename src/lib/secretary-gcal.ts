/**
 * Reem B3: the provider side of the calendar link (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §3, §4, §5).
 * This part: the proof read at connection time and the connect step the OAuth callback calls. Nashr never calls a
 * provider's revoke endpoint (ruling R7): Google grants are shared per user and client with the publishing connection.
 * Also here: the token refresh (`freshAccess`), the list of the account's own calendars, the lost-link step the calendar-link
 * routes and the sync share (`loseLink`), the event fetch, and the sync itself (`sweepCalendars`, `syncOne`; spec §7).
 *
 * Importers: `src/app/api/connect/[provider]/callback/route.ts`, the calendar-link routes, `src/app/api/cron/secretary/route.ts`
 * (the sweep) and `src/lib/account.ts` and the two password-reset routes (`revokeCalendarLinks`). The hosts
 * below are fixed constants called with plain `fetch`, the way `tokenRequest` does; no URL here comes from a user.
 * Tokens, provider answers and the account address never go into a log, an audit line or a URL.
 */
import { getUser } from "./auth";
import { getBrand } from "./brand";
import { listBrands, scopeFor } from "./brands";
import { refreshTokens } from "./connectors/oauth";
import { getProvider, type CalProvider } from "./connectors/registry";
import { db } from "./db";
import { notifyItem } from "./notifications";
import { pmap } from "./parallel";
import { SEC_KEYS, audit } from "./secretary";
import { dropLink, getLink, openTokens, putEvents, putLink, scheduleSync, sealTokens, type CalLink } from "./secretary-cal-link";
import { decodeIdToken, googleAccount, microsoftDomain, MS_CONSUMER_TENANT, proofOf } from "./secretary-cal-proof";
import { keepGoogle, keepGraph, limitMeetings, type GEvent, type GraphEvent, type Meeting } from "./secretary-meetings";
import { zoneOf } from "./zones";
import { log } from "./log";

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
    await db.unlockOwned(key, token).catch((e) => log.error("cal lock release failed", e));
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

/** The link as it was when this run read it: the same record (rev and connection), still there (ruling R5, R15). */
const same = (now: CalLink | null, was: CalLink): now is CalLink => !!now && now.rev === was.rev && now.connectedAt === was.connectedAt;

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
    log.error("cal refresh failed", e);
    return { ok: false, retry: true };
  } finally {
    clearTimeout(timer);
  }
  const access = data.access_token;
  if (!access) return { ok: false, retry: true };
  const expires = Number(data.expires_in);
  const next: CalLink = { ...link, tokens: sealTokens({ access, refresh: data.refresh_token || t.refresh, expiresAt: now + (Number.isFinite(expires) && expires > 0 ? expires : 3600) * 1000 }) };
  // The refresh was slow: a link unlinked, reset away or replaced meanwhile must not be brought back with these tokens (ruling R15).
  // The caller sees a retry, and its own re-read finds nothing to write.
  if (!same(await getLink(scope), link)) return { ok: false, retry: true };
  await putLink(scope, next);
  return { ok: true, access, link: next, data };
}

type LostReason = NonNullable<CalLink["lostReason"]>;

/** The in-app notice of a lost grant (spec §7.3): Reem stopped reading the calendar until the owner connects it again. Says nothing of the provider. */
async function noticeLost(scope: string, link: CalLink): Promise<void> {
  const owner = await getUser(scope.split("#")[0]);
  if (!owner) return;
  const ar = owner.lang === "ar";
  await notifyItem(
    owner.email,
    owner.lang,
    {
      kind: "todo",
      agent: "reem",
      title: ar ? "تقويم التسويق يحتاج إعادة ربط" : "Marketing calendar needs reconnecting",
      body: ar ? "توقفت ريم عن قراءة تقويم التسويق إلى أن تعيد ربطه." : "Reem stopped reading the marketing calendar until you reconnect it.",
      href: `/${owner.lang}/app/todo`,
    },
    `cal-lost:${scope}:${link.connectedAt}`,
    30,
  );
}

/**
 * The link cannot be read any more (spec §7.1-§7.3): state `reconnect` with `lostReason` (default `"token"`: the tokens are gone), the
 * synced events deleted, the scope out of the sync queue, one `cal_lost` audit line with the login and the provider. A lost token
 * also sends the owner one in-app notice (fingerprint `cal-lost:{scope}:{connectedAt}`), so a loss found by a route notifies as
 * one found by the sync does (`via: "cron"` for the sync's own losses, audited as the cron's); a failed notice is logged by name and never undoes the loss. Only our side changes; nothing is sent
 * to the provider (ruling R7). The caller holds the lock.
 */
export async function loseLink(scope: string, link: CalLink, login: string, reason: LostReason = "token", via: "web" | "cron" = "web"): Promise<void> {
  const next: CalLink = { ...link, state: "reconnect", lostReason: reason, rev: link.rev + 1 };
  delete next.choices;
  await Promise.all([putLink(scope, next), db.del(SEC_KEYS.calEvents(scope)), db.zrem(SEC_KEYS.calDue, scope), audit(scope, { actor: via === "cron" ? "cron" : "owner", via, login }, "cal_lost", "-", `provider=${link.provider}`)]);
  if (reason === "token") await noticeLost(scope, link).catch((e) => log.error("cal lost notice failed", e));
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
    log.error("cal events fetch failed", e);
    return { ok: false, kind: "retry" };
  }
}

/** The sync (spec §7): every 15 minutes per linked brand, 50 scopes a tick, 8 at a time, the next 7 days of the chosen calendar. */
export const CAL_SYNC_MS = 15 * 60_000;
export const CAL_TICK_MAX = 50;
export const CAL_CONCURRENCY = 8;
const CAL_WINDOW_MS = 7 * 86_400_000;
/** A busy brand lock is looked at again after this. */
const CAL_BUSY_RETRY_MS = 60_000;
/** A provider error with no `Retry-After` is tried again after 15 minutes; one that has it is floored at 60 s (0 must not retry at once). */
const RETRY_DEFAULT_S = 900;
const RETRY_FLOOR_S = 60;
/** More raw events than this in one answer are never read (the request asks for 300). */
const RAW_EVENTS_MAX = 600;
/**
 * A sync starts only this long before the deadline (ruling R16): one can take up to ~32 s of provider time (a refresh, Graph proof
 * and events, 8 s each), and the tick's `maxDuration` is 60 s against its 40 s start budget.
 */
const CAL_START_MARGIN_MS = 35_000;
/** A scope whose sync threw is looked at again after this (best effort), so one broken scope cannot hold the head of the queue. */
const CAL_ERROR_RETRY_MS = 900_000;

export type CalSweepReport = { scopes: number; synced: number; lost: number; retried: number; deferred: number };
/** What one scope's sync came to; `dropped` is a link that was gone, not in state `ok`, or archived with its brand: nothing to count. */
type Outcome = "synced" | "lost" | "retried" | "deferred" | "dropped";

/**
 * Lose the link for `reason`, unless it was unlinked or replaced since this run read it (ruling R5: a loss written over a deleted
 * link would bring it back). The caller holds the lock; the re-read covers a lock that expired under a slow provider.
 */
async function loseSync(scope: string, was: CalLink, reason: LostReason): Promise<Outcome> {
  const cur = await getLink(scope);
  if (!same(cur, was)) return "dropped";
  await loseLink(scope, cur, cur.login, reason, "cron");
  return "lost";
}

/** Look at this scope again at `atMs`, unless the link is gone or replaced (ruling R5: a reschedule would revive a dropped scope). */
async function retryAt(scope: string, was: CalLink, atMs: number): Promise<Outcome> {
  if (!same(await getLink(scope), was)) return "dropped";
  await scheduleSync(scope, atMs);
  return "retried";
}

/** One scope's sync with the brand's calendar lock held, in the order of spec §7: holds, domain, token, fetch, store. */
async function syncLocked(scope: string, now: number): Promise<Outcome> {
  const link = await getLink(scope);
  // A link that is gone, still being chosen or already in reconnect is not synced: it leaves the queue.
  if (!link || link.state !== "ok" || !link.calendarId) {
    await db.zrem(SEC_KEYS.calDue, scope);
    return "dropped";
  }
  const owner = scope.split("#")[0];
  const [user, brands, brand] = await Promise.all([getUser(owner), listBrands(owner), getBrand(scope)]);
  const meta = brands.find((b) => scopeFor(owner, b.id) === scope);
  // An archived brand ends its link; Nashr holds no token afterwards and calls no provider (ruling R7).
  if (meta?.status === "archived") {
    await dropLink(scope);
    return "dropped";
  }
  if (!user || user.suspended || link.login !== user.email) return loseSync(scope, link, "owner");
  if (meta?.status !== "active") return loseSync(scope, link, "brand");
  // The brand's website may have moved to another domain since the proof was made.
  if (link.proof === "domain" && proofOf(link.accountDomain ?? null, brand?.website) === null) return loseSync(scope, link, "domain");

  const fresh = await freshAccess(scope, link, now);
  if (!fresh.ok) return "lost" in fresh ? loseSync(scope, link, "token") : retryAt(scope, link, now + RETRY_DEFAULT_S * 1000);
  const cur = fresh.link;
  // Ruling R3: a Google refresh without an `id_token` keeps the stored domain; Outlook asks Graph every time. Only a domain link needs it.
  if (cur.proof === "domain" && (cur.provider === "mscal" || fresh.data.id_token)) {
    try {
      const who = await reproof(cur, fresh.data, fresh.access);
      if (proofOf(who.accountDomain, brand?.website) === null) return loseSync(scope, cur, "domain");
    } catch (e) {
      log.error("cal proof failed", e);
      return retryAt(scope, cur, now + RETRY_DEFAULT_S * 1000);
    }
  }

  const res = await fetchEvents(cur, fresh.access, now, now + CAL_WINDOW_MS);
  if (!res.ok) {
    if (res.kind === "gone") return loseSync(scope, cur, "calendar");
    if (res.kind === "auth") return loseSync(scope, cur, "token");
    const s = Math.min(RETRY_AFTER_MAX_S, Math.max(RETRY_FLOOR_S, res.retryAfterS ?? RETRY_DEFAULT_S));
    return retryAt(scope, cur, now + s * 1000);
  }
  const zone = zoneOf(brand);
  const events = limitMeetings(
    res.raw
      .slice(0, RAW_EVENTS_MAX)
      .map((e) => (cur.provider === "gcal" ? keepGoogle(e as GEvent, zone) : keepGraph(e as GraphEvent, zone)))
      .filter((m): m is Meeting => m !== null),
  );
  // The provider call was slow: store only into the link this run started with (ruling R5).
  const latest = await getLink(scope);
  if (!same(latest, cur)) return "dropped";
  await Promise.all([putEvents(scope, { syncedAt: now, events }), putLink(scope, { ...latest, lastSyncAt: now }), scheduleSync(scope, now + CAL_SYNC_MS)]);
  return "synced";
}

/** One scope's sync under the brand's calendar lock (ruling R8); a busy lock means look again in 60 s (P6), with the tokens untouched. */
async function syncOne(scope: string, now: number): Promise<Outcome> {
  const r = await withCalLock(scope, () => syncLocked(scope, now));
  if (typeof r === "string") return r;
  if (await getLink(scope)) await scheduleSync(scope, now + CAL_BUSY_RETRY_MS);
  else await db.zrem(SEC_KEYS.calDue, scope);
  return "deferred";
}

/**
 * The calendar part of the secretary tick: takes the (at most `CAL_TICK_MAX`) scopes whose next sync time has come out of
 * `sec:cal:due` and syncs them `CAL_CONCURRENCY` at a time. Nothing new starts within 35 s of `deadline` (ruling R16): those scopes
 * keep their past score, come first next tick and count as `deferred`. One scope's failure (a store error) is logged by name,
 * counts as `retried` and the scope is rescheduled 15 minutes out, best effort; it never stops the others. The members are scopes the sweep took from the queue; no key is built
 * from anything else.
 */
export async function sweepCalendars(now: number, deadline: number): Promise<CalSweepReport> {
  const scopes = (await db.zrangeByScore(SEC_KEYS.calDue, now, CAL_TICK_MAX)).map((m) => m.member).filter((s) => s.length > 0 && s.length <= 320);
  const report: CalSweepReport = { scopes: scopes.length, synced: 0, lost: 0, retried: 0, deferred: 0 };
  await pmap(
    scopes,
    async (scope) => {
      if (Date.now() >= deadline - CAL_START_MARGIN_MS) {
        report.deferred++;
        return;
      }
      try {
        const o = await syncOne(scope, now);
        if (o !== "dropped") report[o]++;
      } catch (e) {
        log.error("cal sync failed", e);
        report.retried++;
        await scheduleSync(scope, now + CAL_ERROR_RETRY_MS).catch(() => {});
      }
    },
    CAL_CONCURRENCY,
  );
  return report;
}

/**
 * Password reset or account wipe: every brand's calendar link of this account owner ends, archived brands included (one
 * `listBrands`, then the links in parallel). A member login or an unknown address has no brands of its own: nothing happens.
 * Only our side is dropped; no provider is called (ruling R7). A sync in flight writes nothing afterwards (rulings R5, R15).
 */
export async function revokeCalendarLinks(email: string): Promise<void> {
  const [owner, brands] = await Promise.all([getUser(email), listBrands(email)]);
  if (!owner) return;
  await pmap(brands, async (b) => {
    const scope = scopeFor(email, b.id);
    // Under the brand's calendar lock, so a sync that holds it finishes first; a lock that stays busy never keeps a link alive
    // (ruling R15): it is dropped anyway, and the run in flight finds the link gone before it writes anything.
    const r = await withCalLock(scope, () => dropLink(scope));
    if (r) await dropLink(scope);
  });
}
