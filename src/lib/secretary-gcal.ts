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
import { SEC_KEYS, audit, withLock } from "./secretary";
import { dropLink, getLink, openTokens, putLink, sealTokens, type CalLink } from "./secretary-cal-link";
import { decodeIdToken, googleAccount, microsoftDomain, MS_CONSUMER_TENANT } from "./secretary-cal-proof";

export const GOOGLE_API = "https://www.googleapis.com";
export const GRAPH = "https://graph.microsoft.com/v1.0";

/** One provider call must not hold the brand's calendar lock for long. */
const PROVIDER_TIMEOUT_MS = 8_000;
/** The lock is held across the proof calls, so it outlives the default 10 s. */
// Worst case inside the lock: Graph `/me` plus `/organization` at 8 s each is 16 s, under 25 s.
export const LOCK_TTL_S = 25;

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
  const r = await withLock(scope, "cal", async (): Promise<ConnectResult> => {
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
  }, LOCK_TTL_S);
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
 * the provider refused with `invalid_grant` or 401, or tokens that no longer open; anything else is `retry`. The provider's
 * text never leaves this function: the error's name is all that is logged.
 */
export async function freshAccess(scope: string, link: CalLink, now: number): Promise<Fresh> {
  const t = openTokens(link);
  if (!t) return { ok: false, lost: "token" };
  if (t.expiresAt - now >= REFRESH_SKEW_MS) return { ok: true, access: t.access, link, data: {} };
  const p = getProvider(link.provider);
  if (!p) return { ok: false, retry: true };
  let data: Record<string, string>;
  try {
    data = await refreshTokens(p, t.refresh);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("invalid_grant") || msg.includes(`${link.provider} token 401:`)) return { ok: false, lost: "token" };
    console.error("cal refresh failed", e instanceof Error ? e.name : "error");
    return { ok: false, retry: true };
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
