import { lookup } from "dns/promises";
import { isIP } from "net";

/**
 * fetch() for URLs that come from users (site to crawl, catalog or sitemap,
 * connector base URLs). Blocks SSRF: only http(s), no credentials in the URL,
 * no loopback / private / link-local / metadata / multicast targets, and every
 * redirect hop is validated again instead of followed blindly.
 * Residual risk: DNS can change between the check and the connection
 * (rebinding). Closing that needs a pinned-IP agent; this guard removes the
 * direct and redirect-based paths.
 */
export class UnsafeUrlError extends Error {
  constructor(reason: string) { super(`unsafe_url:${reason}`); }
}

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms. URL parsing rewrites the
  // dotted quad as two hex groups (::ffff:a00:1), so both spellings are decoded before the v4 check.
  const tail = s.match(/^::(?:ffff:)?(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (tail) {
    if (tail[1]) return privateV4(tail[1]);
    const hi = parseInt(tail[2], 16), lo = parseInt(tail[3], 16);
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb") || s.startsWith("ff") || s.startsWith("64:ff9b:");
}
const blockedIp = (ip: string) => (isIP(ip) === 4 ? privateV4(ip) : privateV6(ip));

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UnsafeUrlError("malformed"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UnsafeUrlError("scheme");
  if (u.username || u.password) throw new UnsafeUrlError("credentials");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") throw new UnsafeUrlError("host");
  if (isIP(host)) { if (blockedIp(host)) throw new UnsafeUrlError("private_ip"); return u; }
  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true }); } catch { throw new UnsafeUrlError("dns"); }
  if (!addrs.length || addrs.some((a) => blockedIp(a.address))) throw new UnsafeUrlError("private_ip");
  return u;
}

/** Same signature as fetch. Redirects are followed by hand (max 5), each hop re-validated. */
export async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let url = input;
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) return res;
    url = new URL(res.headers.get("location")!, url).toString();
    // A redirect must never carry credentials or a request body to another host.
    if (init.method && init.method !== "GET") throw new UnsafeUrlError("redirect_on_write");
  }
  throw new UnsafeUrlError("too_many_redirects");
}
