import { execSync } from "node:child_process";
import type { NextConfig } from "next";
import { BASE_CSP } from "./src/lib/csp";

// The Content-Security-Policy is no longer here (rules 2320-2329): src/proxy.ts sends it, because a page's policy names
// that request's nonce. Pages get the enforced nonce-based script policy and its report-only twin (src/lib/csp.ts);
// the API, the media files and the short links get the four directives of rule 428 below, as before. The proxy never
// sees Next's static files, which run no script of their own.
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];
const NO_PAGE_HEADERS = [{ key: "Content-Security-Policy", value: BASE_CSP }];

// The commit this build was made from: BUILD_COMMIT when the host sets it, else the checkout's HEAD, else "unknown". A
// host without git, or a build outside a checkout, must never fail the build over it. /api/health reports it (rule 676).
const buildCommit = () => {
  if (process.env.BUILD_COMMIT) return process.env.BUILD_COMMIT;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
};

const nextConfig: NextConfig = {
  // No `X-Powered-By: Next.js` on any answer (rule 1340, 360 study F-019): it names the framework to a scanner for nothing.
  poweredByHeader: false,
  // Inlined into the server bundle at build time (process.env.BUILD_COMMIT and BUILD_TIME, read as written, never
  // destructured). Neither is a secret. BUILD_TIME alone tells two builds apart when the commit is unknown.
  env: { BUILD_COMMIT: buildCommit(), BUILD_TIME: new Date().toISOString() },
  // The most request body the proxy buffers (rule 774). The proxy runs on every path, `/api/*` included (rule 674), and
  // Next clones and holds each non-GET body up to this size before the route's own size check, auth or rate limit
  // runs; past it the route gets the body cut short, never an error. The largest legitimate body is POST
  // /api/performance: a CSV of at most 2,000,000 characters (MAX_CSV_CHARS in src/lib/perf-import.ts; the page refuses
  // files over 2,000,000 bytes) sent as JSON, at most 3 bytes a character (a byte that is not UTF-8, as in a
  // Windows-1256 export, becomes U+FFFD), so 6,000,000 bytes and the file name. Every other route takes far less.
  // `globalNotFound` (rule 1875): src/app/global-not-found.tsx, a full Arabic right-to-left document, for an address
  // that matches no route at all. `[lang]` takes any first segment, so `/xyz` and `/ar-sa/x` never reach it: the proxy
  // serves those from the language tree's own 404 (rule 1891, `strayPath` in src/proxy.ts). This stays as the fallback.
  // `cpus` (rule 2290): build workers are capped at 4. Without it Next starts one worker per CPU less one, and the shared
  // Hostinger build machine reports 64 CPUs: build 01a152f2 of 2026-10-19 started 63 workers to collect page data, hit
  // the account's process limit ("OS can't spawn worker thread: Resource temporarily unavailable") and aborted, so the
  // release never went live. Four is what a CI runner has anyway.
  experimental: { proxyClientMaxBodySize: 6 * 1024 * 1024, globalNotFound: true, cpus: 4 },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/api/:path*", headers: NO_PAGE_HEADERS },
      { source: "/m/:path*", headers: NO_PAGE_HEADERS },
      { source: "/p/:path*", headers: NO_PAGE_HEADERS },
    ];
  },
  // The comparison pages that named competitors are gone (rules 1740-1742, founder's decision of 2026-10-13): every old
  // `/vs/...` address and the blog post about one vendor answer 308 to the comparison by kind, so links and search results
  // land on a page instead of a 404. Next answers these before the proxy runs.
  async redirects() {
    return [
      { source: "/:lang(ar|en)/vs/:slug*", destination: "/:lang/compare", permanent: true },
      { source: "/:lang(ar|en)/blog/nashr-vs-enrich-labs", destination: "/:lang/compare", permanent: true },
    ];
  },
  async rewrites() {
    return [
      { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/meta" },
      { source: "/.well-known/oauth-authorization-server/:path*", destination: "/api/oauth/meta" },
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/resource" },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth/resource" },
    ];
  },
};

export default nextConfig;
