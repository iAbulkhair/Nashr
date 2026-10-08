# Staging and smooth releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** staging.thakeen.com, locked and never indexed, builds from `main`; thakeen.com builds from a `production` branch that only the founder's merge of a release pull request moves; a health route and two scripts measure and verify each switch.

**Architecture:** Code tasks 1 to 9 land on one branch and one pull request into `main`. Ops tasks 10 to 15 change Hostinger and GitHub, each behind the founder's explicit yes. Task 11 (live auto-deploy on `production`) must be done before the code pull request merges, or the merge goes live.

**Tech Stack:** Next.js 16 app router (`src/proxy.ts` runs on Node.js, matcher must be a constant), vitest with the in-memory store, Node 22 on Hostinger, Hostinger API MCP (`hosting_*`), GitHub (`gh` needs the sandbox off).

**Spec:** `docs/superpowers/specs/2026-10-08-staging-smooth-releases-design.md`

## Global Constraints

- Rule numbers 674 to 679. Before the pull request, rerun the per-branch max check (`git show <branch>:docs/system/tests.md | grep -oE "^\| [0-9]+ \|"` over `git branch -r`) and renumber if 674+ got taken.
- `APP_ENV=staging` turns staging on. `isProductionDeploy()` stays unchanged (staging is production for rules 430 and 431).
- `APP_ENV` and `STAGING_ACCESS_KEY` are read at call time, never at module load (tests stub them per case).
- Cookie name `thakeen_staging`; token = HMAC-SHA256, key `STAGING_ACCESS_KEY`, message `staging-access-v1`, hex. The cookie never holds the code.
- Open paths on staging, exact match only: `/ar/staging-access`, `/en/staging-access`, `/api/staging-access`, `/robots.txt`.
- Access route rate limit `allow("stagingaccess:" + clientIp(req), 5, 900)`; health route `allow("health:" + clientIp(req), 60, 60)`.
- Health body exactly `{ ok: true, commit, built }`, `Cache-Control: no-store`.
- `X-Robots-Tag: noindex, nofollow` on every staging response.
- Secrets: compared with `sameSecret`, never read from a URL, never logged. The access code arrives only in a form body.
- `src/proxy.ts` and `src/lib/staging-access.ts` never import `db`, `rate` or `auth` (Redis must not load in the proxy).
- Redirects use `appOrigin()`, never `req.url` (behind Hostinger the request URL can be the internal host).
- Every page has Arabic and English; Arabic is the default.
- Docs change in the same commit as the route, permission or variable they describe (CLAUDE.md).
- Before every commit: `npx next typegen` once in a fresh worktree, then `npm run check`. Run `npx next build` before the pull request, outside the sandbox (Google Fonts needs network).
- Claude never merges a release pull request, never pushes to `production`, and never changes the live Hostinger app without the founder's yes for that step. Release pull requests merge with "Create a merge commit".

## Review Focus

1. Redirect host behind Hostinger: a POST whose `req.url` is `http://localhost:3000/...` must still redirect to `APP_ORIGIN`. Pinned in Task 4.
2. Look-alike open paths: `/ar/staging-access/`, `/AR/staging-access`, `/ar/staging-access/x`, `/en/staging-accessx` must stay locked. Pinned in Task 3.
3. Live regressions from the wider matcher:
   - `/` still 307.
   - `/ar/app/*` still gets `x-pathname`; other paths do not.
   - No `X-Robots-Tag` on live.
   Pinned in Task 3.
4. Health when the limiter's Redis call throws: still 200 with the body. Pinned in Task 6.
5. A cookie minted under an old key, or a cookie equal to the raw code: locked. Pinned in Task 2.

---

### Task 1: `sameSecret` in a dependency-free module

**Files:**
- Create: `src/lib/secret.ts`
- Modify: `src/lib/rate.ts:1` (drop `timingSafeEqual`) and `:140-144` (body moves out, re-export stays)
- Test: `tests/secret.test.ts`

**Interfaces:**
- Produces: `sameSecret(a: string | null | undefined, b: string | null | undefined): boolean`, exported from `@/lib/secret` and still from `@/lib/rate` (same function object).

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("sameSecret lives in a module with no store behind it", () => {
  it("is the same function from secret.ts and rate.ts", async () => {
    const a = await import("@/lib/secret"), b = await import("@/lib/rate");
    expect(a.sameSecret).toBe(b.sameSecret);
    expect(a.sameSecret("k1", "k1")).toBe(true);
    expect(a.sameSecret("k1", "k2")).toBe(false);
    expect(a.sameSecret("", "")).toBe(false);
    expect(a.sameSecret(undefined, undefined)).toBe(false);
  });
  it("secret.ts imports only crypto", () => {
    const src = readFileSync("src/lib/secret.ts", "utf8");
    expect(src.match(/from\s+["'][^"']+["']/g)).toEqual(['from "crypto"']);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/secret.test.ts`. Expected: FAIL, cannot resolve `@/lib/secret`.
- [ ] **Step 3:** Move the function unchanged, with its doc comment, to `src/lib/secret.ts`. In `rate.ts`, add `export { sameSecret } from "./secret";` and drop the `timingSafeEqual` import.
- [ ] **Step 4:** Run `npx vitest run tests/secret.test.ts tests/oauth-server.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `refactor: move sameSecret to a dependency-free module`.

### Task 2: `isStaging()` and the access token

**Files:**
- Modify: `src/lib/deploy-env.ts` (add `isStaging`, extend the header comment)
- Create: `src/lib/staging-access.ts`
- Test: `tests/staging.test.ts`. New file; Tasks 3 to 5 add to it. Header imports:
  - `readFileSync` from `node:fs`
  - `afterEach, beforeEach, describe, expect, it, vi` from `vitest`
  - `NextRequest` from `next/server`
  - `afterEach(() => vi.unstubAllEnvs())` at file level.
- Docs:
  - `docs/system/variables.md`: add the `staging` value to the `APP_ENV` row, add a new `STAGING_ACCESS_KEY` row, update the count line.
  - `docs/system/architecture.md`: lib table rows for both modules.

**Interfaces:**
- Consumes: `sameSecret` from `@/lib/secret` (Task 1).
- Produces, all from `@/lib/staging-access` unless noted:
  - `isStaging(): boolean` from `@/lib/deploy-env`: `process.env.APP_ENV === "staging"`.
  - `STAGING_COOKIE = "thakeen_staging"`.
  - `STAGING_OPEN_PATHS: ReadonlySet<string>`, the four paths of Global Constraints.
  - `accessToken(key: string | undefined): string | null`: `null` for a missing or empty key.
  - `hasAccess(cookie: string | undefined): boolean`: reads `STAGING_ACCESS_KEY` at call time.

- [ ] **Step 1: Write the failing tests**

```ts
describe("the staging access token (rules 674-675)", () => {
  it("isStaging is APP_ENV=staging only", async () => {
    const { isStaging } = await import("@/lib/deploy-env");
    for (const [v, want] of [["staging", true], ["", false], ["production", false], ["preview", false], ["Staging", false]] as const) {
      vi.stubEnv("APP_ENV", v); expect(isStaging(), v).toBe(want);
    }
  });
  it("token is the HMAC of the fixed label, never the key, and null without a key", async () => {
    const { accessToken } = await import("@/lib/staging-access");
    const { createHmac } = await import("node:crypto");
    expect(accessToken("k".repeat(40))).toBe(createHmac("sha256", "k".repeat(40)).update("staging-access-v1").digest("hex"));
    expect(accessToken("")).toBeNull();
    expect(accessToken(undefined)).toBeNull();
  });
  it("hasAccess: right token yes; raw code, old-key token, empty and missing key no", async () => {
    const { accessToken, hasAccess } = await import("@/lib/staging-access");
    const key = "staging-key-" + "x".repeat(30);
    vi.stubEnv("STAGING_ACCESS_KEY", key);
    expect(hasAccess(accessToken(key)!)).toBe(true);
    expect(hasAccess(key)).toBe(false);
    expect(hasAccess(accessToken("old-" + key)!)).toBe(false);
    expect(hasAccess(undefined)).toBe(false);
    vi.stubEnv("STAGING_ACCESS_KEY", "");
    expect(hasAccess(accessToken(key)!)).toBe(false);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/staging.test.ts`. Expected: FAIL, missing exports.
- [ ] **Step 3:** Implement the five exports. `staging-access.ts` imports only `createHmac` from `node:crypto`, `@/lib/secret`, and (if needed) `@/lib/deploy-env`. Spell these specifiers exactly (`"node:crypto"`, `"@/lib/secret"`, `"@/lib/deploy-env"`, no `.ts` suffix): Task 3 pins the file's import list and rejects any other specifier.
- [ ] **Step 4:** Run `npx vitest run tests/staging.test.ts tests/launch-security.test.ts`. Expected: PASS. launch-security already treats `{ APP_ENV: "staging" }` as production; that case is rule 678.
- [ ] **Step 5:** Update the two docs, run `npm run check`, commit `feat(staging): isStaging and the access token`.

### Task 3: The lock in `src/proxy.ts`

**Files:**
- Modify: `src/proxy.ts` (the whole file is 40 lines)
- Test: `tests/staging.test.ts`
- Docs:
  - `docs/system/architecture.md`: proxy row (wider matcher, the lock).
  - `docs/system/permissions.md`: section 0 actors, the staging cookie.

**Interfaces:**
- Consumes: `isStaging`, `STAGING_COOKIE`, `STAGING_OPEN_PATHS`, `hasAccess` (Task 2).
- Produces: `proxy(req: NextRequest): NextResponse` with `config.matcher = ["/((?!_next/static|_next/image|favicon.ico).*)"]`.

Behaviour, in order:
1. On staging, a path not in `STAGING_OPEN_PATHS` and without `hasAccess(cookie)` gets `new NextResponse(null, { status: 404, headers: { "x-robots-tag": "noindex, nofollow" } })`.
2. `/` gets today's 307 to the picked language.
3. A path matching `^/[^/]+/app(/|$)` gets today's `x-pathname` forward.
4. Anything else gets `NextResponse.next()`.

On staging, every response from steps 2 to 4 also gets `x-robots-tag: noindex, nofollow`.

- [ ] **Step 1: Write the failing tests**

```ts
const req = (path: string, cookie?: string) =>
  new NextRequest("https://staging.example" + path, cookie ? { headers: { cookie: `thakeen_staging=${cookie}` } } : undefined);

describe("the proxy off staging behaves as before (rule 674)", () => {
  it("/ redirects, app paths get x-pathname, others pass untouched, no robots header", async () => {
    vi.stubEnv("APP_ENV", "");
    const { proxy } = await import("@/proxy");
    expect(proxy(req("/")).status).toBe(307);
    expect(proxy(req("/ar/app/tasks")).headers.get("x-middleware-request-x-pathname")).toBe("/ar/app/tasks");
    const page = proxy(req("/ar/pricing"));
    expect(page.headers.get("x-middleware-next")).toBe("1");
    expect(page.headers.get("x-middleware-request-x-pathname")).toBeNull();
    for (const p of ["/", "/ar/pricing", "/api/health"]) expect(proxy(req(p)).headers.get("x-robots-tag")).toBeNull();
  });
});

describe("the staging lock (rules 674, 677)", () => {
  const key = "staging-key-" + "y".repeat(30);
  it("no cookie: 404 everywhere but the four open paths, all noindex", async () => {
    vi.stubEnv("APP_ENV", "staging"); vi.stubEnv("STAGING_ACCESS_KEY", key);
    const { proxy } = await import("@/proxy");
    for (const p of ["/", "/ar", "/ar/app/tasks", "/api/health", "/api/cron/weekly", "/sitemap.xml",
      "/ar/staging-access/", "/AR/staging-access", "/ar/staging-access/x", "/en/staging-accessx", "/robots.txt/x"]) {
      const r = proxy(req(p)); expect(r.status, p).toBe(404); expect(r.headers.get("x-robots-tag"), p).toBe("noindex, nofollow");
    }
    for (const p of ["/ar/staging-access", "/en/staging-access", "/api/staging-access", "/robots.txt"]) {
      const r = proxy(req(p)); expect(r.status, p).not.toBe(404); expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });
  it("valid cookie passes with noindex; a wrong cookie or a missing key stays locked", async () => {
    vi.stubEnv("APP_ENV", "staging"); vi.stubEnv("STAGING_ACCESS_KEY", key);
    const { proxy } = await import("@/proxy");
    const { accessToken } = await import("@/lib/staging-access");
    const ok = proxy(req("/ar/pricing", accessToken(key)!));
    expect(ok.status).not.toBe(404); expect(ok.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(proxy(req("/", accessToken(key)!)).status).toBe(307);
    expect(proxy(req("/ar", "deadbeef")).status).toBe(404);
    vi.stubEnv("STAGING_ACCESS_KEY", "");
    expect(proxy(req("/ar", accessToken(key)!)).status).toBe(404);
  });
  it("the proxy and its lock never load the store", () => {
    // Every module a file names, however it spells the path: static and side-effect imports, re-exports, import() and
    // require(). Comments are not stripped on purpose: a comment that looks like an import fails, the safe direction.
    const specs = (src: string) =>
      [...new Set([...src.matchAll(/\b(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]))].sort();
    // A closed list: proxy -> {deploy-env, staging-access}; staging-access -> {secret, deploy-env}; secret -> crypto;
    // deploy-env -> nothing. Anything else fails, so "./lib/rate", "@/lib/rate.ts" and import("@/lib/db") cannot slip by.
    const allowed: Record<string, string[]> = {
      "src/proxy.ts": ["@/lib/deploy-env", "@/lib/staging-access", "next/server"],
      "src/lib/staging-access.ts": ["@/lib/deploy-env", "@/lib/secret", "node:crypto"],
      "src/lib/deploy-env.ts": [],
      "src/lib/secret.ts": ["crypto"],
    };
    for (const [f, ok] of Object.entries(allowed))
      expect(specs(readFileSync(f, "utf8")).filter((s) => !ok.includes(s)), f).toEqual([]);
    // And the lock gets sameSecret from the module with no store behind it, through no other path.
    expect(specs(readFileSync("src/lib/staging-access.ts", "utf8"))).toContain("@/lib/secret");
    expect(specs(readFileSync("src/proxy.ts", "utf8"))).toContain("@/lib/staging-access");
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/staging.test.ts`. Expected: FAIL (staging paths answer 200; matcher unchanged).
- [ ] **Step 3:** Rewrite `proxy` as described; keep `pickLang` as it is.
- [ ] **Step 4:** Run `npx vitest run tests/staging.test.ts`. Expected: PASS. Then run `npm run check`.
- [ ] **Step 5:** Docs, commit `feat(staging): lock every path behind the access cookie on staging`.

### Task 4: The access page and `POST /api/staging-access`

**Files:**
- Create: `src/app/api/staging-access/route.ts`, `src/app/[lang]/staging-access/page.tsx`
- Test: `tests/staging.test.ts`
- Docs:
  - `docs/system/permissions.md`: section 1 route row; update the route and handler counts.
  - `docs/system/flows.md`: new section "Staging access".

**Interfaces:**
- Consumes:
  - `isStaging`, `accessToken`, `STAGING_COOKIE` (Task 2).
  - `allow`, `clientIp` from `@/lib/rate`; `sameSecret` from `@/lib/secret`.
  - `sessionCookie(maxAge)` from `@/lib/auth`, for the cookie options.
  - `appOrigin()` from `@/lib/origin`; `isLang` from `@/lib/i18n`.
- Produces: `POST(req: Request): Promise<Response>`.
  - Form fields: `code`, and `lang` (`ar` unless `en`).
  - Off staging: 404.
  - Over the limit: 429 `{ ok: false, error: "slow_down" }`.
  - Right code: 303 with `Location: ${appOrigin()}/${lang}`, plus `Set-Cookie` via `res.cookies.set(STAGING_COOKIE, token, await sessionCookie(2592000))`.
  - Anything else: 303 to `${appOrigin()}/${lang}/staging-access?e=1`, no cookie. A missing key counts as a wrong code.
- Page:
  - Signature: `export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ e?: string }> })`.
  - Calls `notFound()` unless `isStaging()` and `isLang(lang)`.
  - Form: a plain `<form method="post" action="/api/staging-access">` with a hidden `lang`, `<input name="code" type="password" autoComplete="off" required>` and one button.
  - Copy (Arabic / English):
    - Heading: «موقع التجربة» / "Staging".
    - Label: «رمز الدخول» / "Access code".
    - Button: «دخول» / "Enter".
    - When `e=1`: «الرمز غير صحيح» / "Wrong code".
  - `generateMetadata` returns `robots: { index: false, follow: false }`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("the staging access route (rule 675)", () => {
  const key = "staging-key-" + "z".repeat(30);
  const post = async (code: string | null, ip: string, url = "http://localhost:3000/api/staging-access") => {
    const { POST } = await import("@/app/api/staging-access/route");
    const body = new URLSearchParams(code === null ? { lang: "ar" } : { code, lang: "ar" });
    return POST(new Request(url, { method: "POST", body, headers: { "x-real-ip": ip, "content-type": "application/x-www-form-urlencoded" } }));
  };
  beforeEach(() => { vi.stubEnv("APP_ENV", "staging"); vi.stubEnv("STAGING_ACCESS_KEY", key); vi.stubEnv("APP_ORIGIN", "https://staging.example"); });

  it("right code: 303 to APP_ORIGIN (never req.url's host) with the token cookie, flags set, code absent", async () => {
    const { accessToken } = await import("@/lib/staging-access");
    const r = await post(key, "10.0.0.1");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://staging.example/ar");
    const c = r.headers.get("set-cookie") ?? "";
    expect(c).toContain(`thakeen_staging=${accessToken(key)}`);
    expect(c).toMatch(/HttpOnly/i); expect(c).toMatch(/Secure/i); expect(c).toMatch(/SameSite=lax/i);
    expect(c).not.toContain(key);
  });
  it("wrong code, a code only in the URL, and a missing key: back to the page with e=1, no cookie", async () => {
    for (const [code, url] of [["nope", undefined], [null, `http://localhost:3000/api/staging-access?code=${key}`]] as const) {
      const r = await post(code, "10.0.0.2", url);
      expect(r.headers.get("location")).toBe("https://staging.example/ar/staging-access?e=1");
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    vi.stubEnv("STAGING_ACCESS_KEY", "");
    expect((await post("", "10.0.0.3")).headers.get("set-cookie")).toBeNull();
  });
  it("five tries per IP per 15 minutes, then 429 even with the right code", async () => {
    for (let i = 0; i < 5; i++) await post("nope", "10.0.0.4");
    expect((await post(key, "10.0.0.4")).status).toBe(429);
  });
  it("off staging the route and the page are 404", async () => {
    vi.stubEnv("APP_ENV", "");
    expect((await post(key, "10.0.0.5")).status).toBe(404);
    const Page = (await import("@/app/[lang]/staging-access/page")).default;
    await expect(Page({ params: Promise.resolve({ lang: "ar" }), searchParams: Promise.resolve({}) })).rejects.toThrow();
  });
  it("never logs the code", () => {
    expect(readFileSync("src/app/api/staging-access/route.ts", "utf8")).not.toMatch(/console\.\w+\([^)]*code/);
  });
});
```

The five-try loop awaits inside a loop against the memory store. That is test code, not product code, so it is fine.

- [ ] **Step 2:** Run `npx vitest run tests/staging.test.ts`. Expected: FAIL, route missing.
- [ ] **Step 3:** Implement route and page as in Interfaces. Read the form with `await req.formData()`; ignore `new URL(req.url).searchParams` entirely.
- [ ] **Step 4:** Run `npx vitest run tests/staging.test.ts tests/route-exports.test.ts`. Expected: PASS.
- [ ] **Step 5:** Docs, `npm run check`, commit `feat(staging): access page and route`.

### Task 5: Robots and sitemap on staging

**Files:**
- Modify: `src/app/robots.ts`, `src/app/sitemap.ts`
- Test: `tests/staging.test.ts`
- Docs: `docs/system/tests.md` rows 674, 675, 677 and 678 (678 points at the existing `launch-security.test.ts` case), status "done".

**Interfaces:**
- Consumes: `isStaging` (Task 2). Both files are built statically, so `APP_ENV` must be set in hPanel before the staging build; Task 12 does that.

- [ ] **Step 1: Write the failing test**

```ts
describe("staging is never indexed (rule 677)", () => {
  it("robots disallows everything with no sitemap line; the sitemap is empty", async () => {
    vi.stubEnv("APP_ENV", "staging");
    expect((await import("@/app/robots")).default()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
    expect((await import("@/app/sitemap")).default()).toEqual([]);
  });
  it("off staging robots is unchanged", async () => {
    vi.stubEnv("APP_ENV", "");
    expect((await import("@/app/robots")).default().rules).toEqual([{ userAgent: "*", allow: "/", disallow: ["/api/", "/ar/app/", "/en/app/"] }]);
  });
});
```

- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Early return on `isStaging()` in each function.
- [ ] **Step 4:** Run `npx vitest run tests/staging.test.ts`. Expected: PASS.
- [ ] **Step 5:** tests.md rows, `npm run check`, commit `feat(staging): robots and sitemap refuse indexing`.

### Task 6: Build identity and `GET /api/health`

**Files:**
- Modify: `next.config.ts` (add `env`)
- Create: `src/app/api/health/route.ts`
- Test: `tests/health.test.ts`
- Docs:
  - `docs/system/variables.md`: `BUILD_COMMIT` and `BUILD_TIME` (set at build time, never secret).
  - `docs/system/permissions.md`: route row and counts.
  - `docs/system/tests.md`: row 676.

**Interfaces:**
- Produces: `nextConfig.env = { BUILD_COMMIT: string, BUILD_TIME: string }`.
  - `BUILD_COMMIT`: `process.env.BUILD_COMMIT` if set; else `execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })` trimmed, inside `try`; else `"unknown"`.
  - `BUILD_TIME`: `new Date().toISOString()` at config load.
- Produces: `GET(req: Request): Promise<Response>`.
  - 200 `{ ok: true, commit: process.env.BUILD_COMMIT ?? "unknown", built: process.env.BUILD_TIME ?? "unknown" }`, header `Cache-Control: no-store`.
  - 429 `{ ok: false, error: "slow_down" }` over 60 per minute per IP.
  - A throw from `allow` counts as allowed.

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

describe("the health route (rule 676)", () => {
  const get = async (ip: string) => (await import("@/app/api/health/route")).GET(new Request("https://x.example/api/health", { headers: { "x-real-ip": ip } }));
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("answers without a session with exactly ok, commit, built and no-store", async () => {
    vi.stubEnv("BUILD_COMMIT", "a".repeat(40)); vi.stubEnv("BUILD_TIME", "2026-10-08T00:00:00.000Z");
    const r = await get("10.1.0.1");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ ok: true, commit: "a".repeat(40), built: "2026-10-08T00:00:00.000Z" });
  });
  it("61st call in a minute from one IP is 429", async () => {
    for (let i = 0; i < 60; i++) await get("10.1.0.2");
    expect((await get("10.1.0.2")).status).toBe(429);
  });
  it("still 200 when the limiter's store throws", async () => {
    const { db } = await import("@/lib/db");
    vi.spyOn(db, "incrby").mockRejectedValue(new Error("down"));
    expect((await get("10.1.0.3")).status).toBe(200);
  });
  it("next.config sets a commit sha or unknown, and a build time", async () => {
    const env = (await import("../next.config")).default.env!;
    expect(env.BUILD_COMMIT).toMatch(/^([0-9a-f]{40}|unknown)$/);
    expect(Number.isNaN(Date.parse(env.BUILD_TIME!))).toBe(false);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/health.test.ts`. Expected: FAIL, route missing.
- [ ] **Step 3:** Implement both.
- [ ] **Step 4:** Run `npx vitest run tests/health.test.ts tests/route-exports.test.ts`. Expected: PASS.
- [ ] **Step 5:** Docs, `npm run check`, commit `feat: health route with build identity`.

### Task 7: `scripts/probe.mjs` and `scripts/smoke.mjs`

**Files:**
- Create: `scripts/probe.mjs`, `scripts/smoke.mjs`, and `scripts/staging-cookie.mjs` (shared helper that gets the cookie)
- Test: `tests/scripts.test.ts`
- Modify: `.gitignore` (add `.smoke.local`)

**Interfaces:**
- `staging-cookie.mjs`: `export async function stagingCookie(origin: string, code: string | undefined): Promise<string | null>`. It POSTs the form with `redirect: "manual"` and returns the `thakeen_staging=...` pair, or `null`. It never prints the code.
- `probe.mjs`:
  - `export function summarize(samples: { t: number; status: number; ms: number; commit: string | null }[]): { longestFailRun: number; slowestMs: number; commitChangedAt: number | null }`. A failure is any status other than 200, including 0 for a network error.
  - The main block runs only when the file is invoked directly. Usage: `node scripts/probe.mjs <origin> <seconds>`.
  - Reads `STAGING_ACCESS_CODE`; prints one line per status or commit change, then the summary.
- `smoke.mjs`: usage `node scripts/smoke.mjs <origin>`; exit 0 or 1; one `PASS <name>` or `FAIL <name>` line per check.
  - Anonymous checks, always:
    - `/` 307 to `/ar`.
    - `/ar` and `/en` 200.
    - `/api/tasks` 401.
    - `/api/cron/weekly` without bearer 401.
    - `/api/health` 200.
  - Staging only (any origin other than `https://thakeen.com`). Values come from `.smoke.local` (gitignored, `KEY=value` lines):
    - `/robots.txt` contains `Disallow: /`.
    - Sign in with `POST /api/auth/login` using `SMOKE_EMAIL` and `SMOKE_PASSWORD`.
    - `/ar/app` 200 with that session.
    - `POST /api/chat` with `{ text: "مرحبا" }` returns `ok: true`.
    - `GET /api/cron/evening` with `Authorization: Bearer $SMOKE_CRON_SECRET` returns 200.
  - Before relying on `evening`, read its route and confirm it makes no model call on an empty database. If it does, pick another cron that doesn't and name it in the script.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

describe("probe summary", () => {
  it("counts the longest failure run, the slowest answer and the commit switch", async () => {
    const { summarize } = await import("../scripts/probe.mjs");
    const s = [
      { t: 0, status: 200, ms: 40, commit: "a" }, { t: 1, status: 502, ms: 900, commit: null },
      { t: 2, status: 0, ms: 3000, commit: null }, { t: 3, status: 200, ms: 1200, commit: "b" },
      { t: 4, status: 503, ms: 50, commit: null }, { t: 5, status: 200, ms: 30, commit: "b" },
    ];
    expect(summarize(s)).toEqual({ longestFailRun: 2, slowestMs: 3000, commitChangedAt: 3 });
    expect(summarize([{ t: 0, status: 200, ms: 5, commit: "a" }]).commitChangedAt).toBeNull();
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/scripts.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3:** Write the three scripts (Node 22 global `fetch`, no dependencies).
- [ ] **Step 4:** Run the test. Expected: PASS. Then run `node scripts/smoke.mjs https://thakeen.com` (anonymous, read-only checks against live). Expected: only `/api/health` fails, because it is not deployed yet. Keep the output.
- [ ] **Step 5:** `npm run check`, commit `feat(scripts): probe and smoke checks for releases`.

### Task 8: Release flow documentation

**Files:**
- Modify:
  - `docs/system/flows.md`: new section "Releases: staging, release pull request, rollback".
  - `docs/system/architecture.md`: new "Environments" section (two Hostinger apps, their branches, what each has).
  - `docs/system/tests.md`: row 679, "not pinned".
  - `CLAUDE.md`: one rule line, stored-shape changes go expand then contract (spec section 6.3).

- [ ] **Step 1:** Write the flows section from spec sections 3, 6 and 7. It covers:
  - The release pull request's description fields.
  - The window: 22:00 to 00:50 UTC, at minutes :05-:10, :20-:25, :35-:40 or :50-:55, and 10 minutes clear of the `vercel.json` crons.
  - The warm-up calls, then verify, then tag `live-YYYY-MM-DD-N`.
  - Rollback: a revert pull request into `production`, then the same revert into `main`; the fix starts by reverting that revert.
- [ ] **Step 2:** Run the duplicate-number check `grep -o "^| [0-9]* |" docs/system/tests.md | sort | uniq -d`. Expected: no output.
- [ ] **Step 3:** `npm run check`, commit `docs: release flow, environments, expand and contract rule`.

### Task 9: What a cut chat stream does today (investigation, no code)

**Files (read only):**
- `src/components/app/ChatPanel.tsx:589-610`: the `stream: true` fetch and its reader.
- `src/lib/chat-allowance.ts:76-131`: `reserveChatTurn`, `settleChatTurn`, `runChatTurn`.

- [ ] **Step 1:** Answer three questions, each with `file:line`:
  1. What does the user see when the stream ends without a `message` event?
  2. Is the typed text still in the input?
  3. What does a turn killed between `reserveChatTurn` and `settleChatTurn` leave behind: a counted message with no reply, a held overflow amount, or nothing?
- [ ] **Step 2:** Put the answers in the code pull request's description under "Chat during a switch". If something is broken, propose the fix as a separate small change for the founder to approve. This plan does not change chat.

### Task 10: Confirm the Hostinger facts (read-only)

- [ ] **Step 1:** Find the subdomain and website-list operations with the Hostinger `search` tool and read them for order 1009870060. Question: can `staging.thakeen.com` be its own Node.js web app, with its own build settings, environment variables and Git settings? Or must it be a separate website added in hPanel? Write down the answer.
- [ ] **Step 2:** Read the build log of the latest thakeen.com build (`hosting_nodejs_list-builds`, then `hosting_nodejs_build-logs`). Does it show a `.git` directory or a `git` call? That decides whether `BUILD_COMMIT` falls back to `unknown`. If the log doesn't say, Task 14 settles it.
- [ ] **Step 3:** Report to the founder. This task changes nothing.

### Task 11: `production` branch and the live auto-deploy (founder's yes required)

- [ ] **Step 1:** Ask: "May I create `production` at the commit thakeen.com runs now (`02934d2` unless `main` moved and was rebuilt), and switch thakeen.com's auto-deploy from `main` to `production`? No rebuild happens. After this, merging to `main` no longer reaches the live site." Wait for a yes that names this step.
- [ ] **Step 2:** `git push origin <live sha>:refs/heads/production` (sandbox off if the push needs it).
- [ ] **Step 3:** Read `hosting_git_auto-deployment-settings` and note the installation and directory. Then call `hosting_git_update-auto-deployment-settings` with the same values plus `branch: "production"` and `is_enabled: true`.
- [ ] **Step 4:** Check the result:
  - Reading the settings back shows `branch` is `production`.
  - `hosting_nodejs_list-builds` shows no new build.
  - `curl -sI https://thakeen.com/ar` is still 200.
- [ ] **Step 5:** Ask the founder for two GitHub settings:
  - A branch rule on `production`, if the GitHub plan allows it: pull requests only, no force push, no deletion.
  - The merge button default set to "Create a merge commit".

### Task 12: Create the staging app (founder's yes required)

- [ ] **Step 1:** Ask for a yes naming this step, with the shape decided in Task 10.
- [ ] **Step 2:** Create the app: `app_type` next, `build_script` `build:hostinger`, Node 22, npm, output `.next`, Git auto-deploy on `main`. Do not start a build yet.
- [ ] **Step 3:** The founder enters the environment variables of spec section 4.2 in hPanel, never in chat; they include `APP_ENV=staging` and `STAGING_ACCESS_KEY`. The founder also fills `.smoke.local` on their machine, then says "done".
- [ ] **Step 4:** No build before Task 13 merges: today's `main` has no lock, so an early build would put an open copy of the site on staging. The merge's auto-deploy builds staging. If no build starts within 3 minutes of the merge, start one with `hosting_nodejs_start-build` (`source_type` git, branch `main`). Poll `hosting_nodejs_build` until `completed`.

### Task 13: The code pull request into `main`

- [ ] **Step 1:** Rule-number check (Global Constraints), `npx next build` outside the sandbox, `npm run check`.
- [ ] **Step 2:** Confirm Task 11 is done (auto-deploy on `production`). If not, stop.
- [ ] **Step 3:** Open the pull request with the Task 9 findings in its description and bind it with `ccd_pr`. The founder reviews and merges. Only staging builds.
- [ ] **Step 4:** Check staging once its build completes:
  - `curl -s -o /dev/null -w "%{http_code}" https://staging.thakeen.com/ar` is 404 without the cookie.
  - The access page works in a browser.
  - `/api/health` shows the merge commit.
  - The two host facts of `docs/system/flows.md` section 49, item 7, last, because they use up a network's access tries for 15 minutes:
    - The right code's `Set-Cookie` lists `HttpOnly`, `Secure`, `SameSite=lax` and `Max-Age` (the `curl` there prints flag names only).
    - The tries are per client: six tries from one network end in 429, and one try from a second network is still 303. If it is 429, stop: Hostinger forwards no client address and `clientIp` needs fixing before staging is relied on.

### Task 14: Step 0 measurement on staging

- [ ] **Step 1:** Run `node scripts/probe.mjs https://staging.thakeen.com 300` in the background, then trigger a staging rebuild (`hosting_nodejs_start-build`, branch `main`). Record the summary.
- [ ] **Step 2:** Test a failed build, then delete the branch:
  - Push a throwaway branch `claude/staging-build-fail-probe` with one commit that breaks the build (a type error).
  - Start a staging build of that branch through the API.
  - Confirm it fails and `/api/health` still shows the previous commit.
- [ ] **Step 3:** Confirm `/api/health`'s `commit` is a real sha. If it is `unknown`, add `BUILD_COMMIT` handling to the follow-ups.
- [ ] **Step 4:** `node scripts/smoke.mjs https://staging.thakeen.com`; every check PASS.
- [ ] **Step 5:** Report to the founder: the gap, the failed-build behaviour, the smoke output. If the gap is more than a couple of seconds, the founder decides between the night window and approach C.

### Task 15: The first release

- [ ] **Step 1:** Open the release pull request `main` → `production` with the fields of spec section 3. Then confirm a tag push does not start a build:
  - Push a test tag `probe-tag-test` on `main`'s head.
  - Watch `hosting_nodejs_list-builds` on the live app for 3 minutes.
  - Delete the tag.
- [ ] **Step 2:** The founder merges in the window, with "Create a merge commit".
- [ ] **Step 3:** Verify live:
  - Poll `https://thakeen.com/api/health` until `commit` is the release merge.
  - Warm `/ar`, `/en`, `/ar/app`.
  - `node scripts/smoke.mjs https://thakeen.com`; every check PASS.
- [ ] **Step 4:** Tag `live-YYYY-MM-DD-1` on the `production` commit and push the tag. Update the memory file `thakeen-staging-release-flow.md` with the outcome.
