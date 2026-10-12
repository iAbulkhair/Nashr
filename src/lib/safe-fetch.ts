import type { LookupAddress, LookupOptions } from "dns";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { Agent } from "undici";
import { providerTimeout } from "./fetch-timeout";

/**
 * fetch() for URLs that come from users (site to crawl, catalog or sitemap,
 * connector base URLs). Blocks SSRF: only http(s), no credentials in the URL,
 * no loopback / private / link-local / metadata / multicast targets, and every
 * redirect hop is validated again instead of followed blindly.
 *
 * DNS rebinding (rule 1342): the check in `assertPublicUrl` resolves the name, and the connection used to resolve it a
 * second time, so a name that answered a public address to the check and a private one to the connection reached the
 * private network. Every request now goes through `pinnedAgent`, whose connect-time lookup (`pinnedLookup`) resolves
 * once, refuses when any address is private, and hands the socket exactly the addresses it checked: there is no second
 * lookup left to rebind. `assertPublicUrl` still runs first, so a refused URL is refused before any request.
 *
 * Every call has a deadline (rule 1343): the caller's own `signal`, or `PROVIDER_TIMEOUT_MS` across the whole redirect
 * chain and the body.
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

/**
 * The connect-time lookup of `pinnedAgent` (the shape `net.connect` expects). Resolves the name once and answers only
 * when every address is public; the socket then connects to one of exactly those addresses.
 */
export function pinnedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  lookup(hostname, { all: true }).then(
    (addrs) => {
      if (!addrs.length || addrs.some((a) => blockedIp(a.address))) return callback(new UnsafeUrlError("private_ip"), "");
      if (options?.all) return callback(null, addrs);
      callback(null, addrs[0].address, addrs[0].family);
    },
    () => callback(new UnsafeUrlError("dns"), ""),
  );
}

let agent: Agent | null = null;
/** One connection pool for every user-supplied URL, made on first use. Its lookup is `pinnedLookup`. */
export function pinnedAgent(): Agent {
  agent ??= new Agent({ connect: { lookup: pinnedLookup } });
  return agent;
}

/** Headers that authenticate the caller. They belong to the origin they were issued for and to no other. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization", "x-shopify-access-token", "api-key"];

function stripCredentials(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  for (const h of CREDENTIAL_HEADERS) headers.delete(h);
  return { ...init, headers };
}

export type SafeFetchOptions = {
  /** Every hop, the first and each redirect, must be https: a download that must not travel in cleartext on any leg. */
  httpsOnly?: boolean;
};

/** Node's fetch takes undici's `dispatcher`; the DOM `RequestInit` type does not name it. */
type PinnedInit = RequestInit & { dispatcher: Agent };

/** fetch's signature plus options. Redirects are followed by hand (max 5), each hop re-validated. */
export async function safeFetch(input: string, init: RequestInit = {}, opts: SafeFetchOptions = {}): Promise<Response> {
  let url = input;
  let current = init;
  // One deadline for the whole chain and the body: the caller's, else the default (rule 1343).
  const signal = init.signal ?? providerTimeout();
  for (let hop = 0; hop < 5; hop++) {
    const u = await assertPublicUrl(url);
    if (opts.httpsOnly && u.protocol !== "https:") throw new UnsafeUrlError("not_https");
    const res = await fetch(url, { ...current, signal, redirect: "manual", dispatcher: pinnedAgent() } as PinnedInit);
    if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) return res;
    const next = new URL(res.headers.get("location")!, url);
    // A redirect must never carry credentials or a request body to another host. Connector calls pass the owner's
    // store credentials through here (WooCommerce, PrestaShop and WordPress all send Authorization), and a store that
    // redirects elsewhere — by misconfiguration or by an attacker who controls the configured URL — would otherwise
    // hand that credential to whatever host answered.
    if (init.method && init.method !== "GET") throw new UnsafeUrlError("redirect_on_write");
    if (new URL(url).origin !== next.origin) current = stripCredentials(current);
    url = next.toString();
  }
  throw new UnsafeUrlError("too_many_redirects");
}
