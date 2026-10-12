/**
 * Proof that a linked calendar belongs to the brand (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §4).
 * Pure: no db, no fetch. The callback, the PUT route and the sync import it to decide whether the calendar account is
 * proven to sit on the brand's own domain ("domain"); anything else needs the owner's declaration.
 */

/** Free mail domains never prove a brand: anyone can open one. */
export const FREE_MAIL: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.sa",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "live.com",
  "live.co.uk",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.com.sa",
  "ymail.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

/** Version of the declaration text; a reworded text bumps it and asks the owner again. */
export const CAL_DECLARATION_V = 1;

/** Microsoft's tenant id for personal accounts: it never proves a domain. */
export const MS_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** The host of the brand's website, lower-case, without one leading `www.`. Null for no site, an IP, or no dot. */
export function brandHost(website: string | undefined): string | null {
  const raw = (website || "").trim();
  if (!raw) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  let host: string;
  try {
    host = new URL(scheme ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith("[") || host.includes(":")) return null; // IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null; // IPv4
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return null;
  return host;
}

/** One way only: the account domain equals the host or is a parent of it. Free mail never matches. */
export function domainMatches(accountDomain: string | null, host: string | null): boolean {
  if (!accountDomain || !host) return false;
  const d = accountDomain.toLowerCase();
  const h = host.toLowerCase();
  if (FREE_MAIL.has(d)) return false;
  return h === d || h.endsWith("." + d);
}

/**
 * Reads the base64url payload of an id_token with NO signature check. Only valid on a token-endpoint response received
 * directly over TLS (spec §4.2, as OpenID Connect allows); never use it on a token that came from a browser or a URL.
 * Never throws: anything unreadable is null.
 */
export function decodeIdToken(jwt: string | undefined): Record<string, unknown> | null {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Google: the domain is proven only by a verified email plus the Workspace `hd` claim. A Gmail account has none. */
export function googleAccount(claims: Record<string, unknown>): { account: string; domain: string | null } {
  const account = typeof claims.email === "string" ? claims.email : "";
  const domain = claims.email_verified === true && typeof claims.hd === "string" && claims.hd ? claims.hd.toLowerCase() : null;
  return { account, domain };
}

/**
 * Microsoft: a work or school tenant (not the consumer one) whose verified domains include the domain of the signed-in
 * user's UPN. The `email` claim alone is never trusted.
 */
export function microsoftDomain(tid: unknown, upn: string, verifiedDomains: string[]): string | null {
  if (typeof tid !== "string" || !tid || tid === MS_CONSUMER_TENANT) return null;
  const at = upn.lastIndexOf("@");
  if (at < 0) return null;
  const domain = upn.slice(at + 1).toLowerCase();
  if (!domain) return null;
  return verifiedDomains.some((v) => typeof v === "string" && v.toLowerCase() === domain) ? domain : null;
}

/** "domain" when the provider-proven account domain matches the brand's website, else null (declaration path). */
export function proofOf(accountDomain: string | null, website: string | undefined): "domain" | null {
  return domainMatches(accountDomain, brandHost(website)) ? "domain" : null;
}
