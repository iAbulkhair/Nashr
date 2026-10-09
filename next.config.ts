import { execSync } from "node:child_process";
import type { NextConfig } from "next";

// The CSP sets no default-src, script-src, frame-src or connect-src, so the Cloudflare Turnstile widget on signup and
// forgot-password (script and iframe from https://challenges.cloudflare.com, src/components/app/Turnstile.tsx) loads.
// Adding any of those directives means allowing that origin too: rule 428, tests/launch-security.test.ts.
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
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
  // Inlined into the server bundle at build time (process.env.BUILD_COMMIT and BUILD_TIME, read as written, never
  // destructured). Neither is a secret. BUILD_TIME alone tells two builds apart when the commit is unknown.
  env: { BUILD_COMMIT: buildCommit(), BUILD_TIME: new Date().toISOString() },
  // The most request body the proxy buffers (rule 774). The proxy runs on every path, `/api/*` included (rule 674), and
  // Next clones and holds each non-GET body up to this size before the route's own size check, auth or rate limit
  // runs; past it the route gets the body cut short, never an error. The largest legitimate body is POST
  // /api/performance: a CSV of at most 2,000,000 characters (MAX_CSV_CHARS in src/lib/perf-import.ts; the page refuses
  // files over 2,000,000 bytes) sent as JSON, at most 3 bytes a character (a byte that is not UTF-8, as in a
  // Windows-1256 export, becomes U+FFFD), so 6,000,000 bytes and the file name. Every other route takes far less.
  experimental: { proxyClientMaxBodySize: 6 * 1024 * 1024 },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
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
