/**
 * Reem B3: the provider side of the calendar link (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §3, §4, §5).
 * This part: the proof read at connection time, the best-effort revoke and the connect step the OAuth callback calls.
 * Later tasks add the calendar list, the token refresh and the event fetch to this file.
 *
 * Importers: `src/app/api/connect/[provider]/callback/route.ts` (and the calendar routes and the sync, later). The hosts
 * below are fixed constants called with plain `fetch`, the way `tokenRequest` does; no URL here comes from a user.
 * Tokens, provider answers and the account address never go into a log, an audit line or a URL.
 */
import { listBrands, scopeFor } from "./brands";
import type { CalProvider } from "./connectors/registry";
import { audit, withLock } from "./secretary";
import { dropLink, getLink, openTokens, putLink, sealTokens, type CalLink } from "./secretary-cal-link";
import { decodeIdToken, googleAccount, microsoftDomain, MS_CONSUMER_TENANT } from "./secretary-cal-proof";

export const GOOGLE_API = "https://www.googleapis.com";
export const GRAPH = "https://graph.microsoft.com/v1.0";
export const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";

/** One provider call must not hold the brand's calendar lock for long. */
const PROVIDER_TIMEOUT_MS = 8_000;
/** The lock is held across the proof calls, so it outlives the default 10 s. */
const LOCK_TTL_S = 25;

const bearer = (access: string) => ({ Authorization: `Bearer ${access}`, Accept: "application/json" });

/**
 * Who the signed-in account is and the domain the provider proves for it (spec §4.2). Throws on any provider failure;
 * callers map that to `provider_error` and never show its text.
 * - Google: from the `id_token` of the token response (`email`, `email_verified`, `hd`).
 * - Microsoft: the token's tenant must not be the consumer one, and `/organization` must list the domain of the user's UPN.
 */
export async function connectProof(p: CalProvider, data: Record<string, string>, access: string): Promise<{ account: string; accountDomain: string | null }> {
  if (p === "gcal") {
    const claims = decodeIdToken(data.id_token);
    if (!claims) throw new Error("no_id_token");
    const { account, domain } = googleAccount(claims);
    if (!account) throw new Error("no_account");
    return { account, accountDomain: domain };
  }
  const tid = decodeIdToken(data.id_token)?.tid;
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

/** Google only: tells Google to forget this refresh token. Best effort, never throws, says nothing about the answer. */
async function revokeGoogle(refresh: string | undefined): Promise<void> {
  if (!refresh) return;
  try {
    await fetch(GOOGLE_REVOKE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    // Best effort: the link is dropped on our side either way.
  }
}

/** Revokes the link's grant at the provider where the provider has an endpoint for it (Google; Microsoft has none here). */
export async function revokeAtProvider(link: CalLink): Promise<void> {
  try {
    if (link.provider !== "gcal") return;
    await revokeGoogle(openTokens(link)?.refresh);
  } catch {
    // Never throws.
  }
}

export type ConnectResult = { ok: true } | { ok: false; code: "brand_inactive" | "token_failed" | "provider_error" };

/**
 * What the OAuth callback does with a code exchange: under the brand's calendar lock, check the brand is still active, read
 * the proof, revoke and drop any earlier link, and write the new one in state `choose` (no calendar yet, proof decided at
 * the save). `scope` is the brand the flow started on (from the saved state), `login` the owner login that finished it.
 * Throws when the provider could not be read; the callback turns that into `provider_error`.
 */
export async function connectCalendar(scope: string, login: string, p: CalProvider, data: Record<string, string>, now: number): Promise<ConnectResult> {
  const r = await withLock(scope, "cal", async (): Promise<ConnectResult> => {
    const owner = scope.split("#")[0];
    const active = (await listBrands(owner)).some((b) => b.status === "active" && scopeFor(owner, b.id) === scope);
    if (!active) {
      // The code was already traded: the grant must not outlive a link that is never written.
      if (p === "gcal") await revokeGoogle(data.refresh_token);
      return { ok: false, code: "brand_inactive" };
    }
    const access = data.access_token;
    const refresh = data.refresh_token;
    if (!access || !refresh) return { ok: false, code: "token_failed" };
    const proof = await connectProof(p, data, access);
    const earlier = await getLink(scope);
    if (earlier) {
      await revokeAtProvider(earlier);
      await dropLink(scope);
    }
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
