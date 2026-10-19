import { execSync } from "node:child_process";
import type { NextConfig } from "next";

// The full policy the app should end up enforcing, sent REPORT-ONLY for now (rule 1341, 360 study C-006/F-019): the
// browser logs what it would block in the console and blocks nothing, so customers see no change. The enforced header
// below stays as it was. Allowed beyond 'self':
//  - Cloudflare Turnstile: its script, iframe and calls (https://challenges.cloudflare.com, rule 428).
//  - 'unsafe-inline' scripts and styles: Next writes inline bootstrap scripts and style tags, and a nonce would make
//    every page render per request. The JSON-LD blocks are data, not script.
//  - Images and video from any https host: rendered replies and catalogue images name outside hosts; media plays from
//    blob: and the storage host. The inbox downloads a finished video from Vercel Blob to share it.
// Moving a directive into the enforced header means checking the console on every page first, Turnstile on.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://challenges.cloudflare.com https://*.public.blob.vercel-storage.com",
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

// The enforced CSP sets no default-src, script-src, frame-src or connect-src, so the Cloudflare Turnstile widget on signup and
// forgot-password (script and iframe from https://challenges.cloudflare.com, src/components/app/Turnstile.tsx) loads.
// Adding any of those directives means allowing that origin too: rule 428, tests/launch-security.test.ts.
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
];

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
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
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
