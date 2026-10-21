import { NextResponse, type NextRequest } from "next/server";
import { BRAND_HEADER } from "@/lib/brand-path";
import { SESSION_COOKIE, readCookie } from "@/lib/cookie-names";
import { CROSS_SITE_METHODS } from "@/lib/csrf";
import { log } from "@/lib/log";

/**
 * The brand guard (rule 888, brand id in the URL "Part C", R-C2 and R-C4 in docs/superpowers/plans/2026-10-20-brand-url.md).
 *
 * A page under `/{lang}/app/b/{id}` makes its API calls with `x-thakeen-brand: {id}` (the `window.fetch` wrapper in src/lib/brand-fetch.ts),
 * and `resolveSession` takes that header as a selector among the session account's own active brands. A browser
 * mutation to a brand route that carries no header would act on the brand the session falls back to, which is how one
 * tab of a two-brand person writes to the other tab's brand. The guard notices exactly that request: a state-changing
 * method, to a route in `BRAND_API`, with a session cookie and no `BRAND_HEADER`.
 *
 * No cookie, no guard: MCP, the crons, the webhooks and a script with a bearer token hold no browser session and pick
 * their scope another way. A read is never guarded either; only the mutations are (reads fall back, they do not write).
 *
 * Release step (rule 679): this release is the EXPAND step. `BRAND_GUARD_MODE` is `"log"`: the request goes on to its
 * route and one `brand_missing` warning (the path only, never a header value, a cookie or a body) is logged, so a tab
 * opened before the deploy, whose script sends no header, keeps saving. The CONTRACT release changes the constant to
 * `"enforce"`, which answers 409 `{ ok: false, error: "brand_missing" }`; tests/brand-url-proxy.test.ts runs both modes now.
 *
 * Import-free of the server on purpose: the proxy runs it on every `/api` request, so it imports only the cookie names,
 * the header name, the method set and the logger (as src/lib/csrf.ts does) and never the database.
 */

export type BrandGuardMode = "log" | "enforce";
export const BRAND_GUARD_MODE: BrandGuardMode = "log";

/**
 * The routes whose state-changing handlers act on the caller's brand (`sc(u)`), written as the route files are on disk:
 * `[id]` matches one path segment. tests/brand-url-proxy.test.ts holds this list to `src/app/api`: a route file that
 * exports POST, PUT, PATCH or DELETE and calls `sc(` or uses `handler({ auth: "user" ... })` (which injects `sc(u)`) is
 * here or in `ACCOUNT_SC_API`, and every entry is a route on disk.
 */
export const BRAND_API: readonly string[] = [
  // Brand, instructions, governance, agent settings (the pages that move under `b/`).
  "/api/brand",
  "/api/brand/proposals/[id]",
  "/api/governance",
  "/api/governance/rollback",
  "/api/instructions",
  "/api/instructions/activate",
  "/api/instructions/discard",
  "/api/instructions/proposals/[id]",
  "/api/instructions/refs/import",
  "/api/instructions/refs/search",
  "/api/instructions/restore",
  "/api/instructions/test",
  "/api/models",
  // `profile` is mixed (R-C12): name, language and phone are the account's, but the brand fields and `emails` are the
  // brand's, so a save that carries no brand cannot say which brand it wrote to.
  "/api/profile",
  // Per-brand notification preferences (`profile:{sc(u)}`): the settings page moves under `b/` (R-C10).
  "/api/notifications/prefs",
  // Work: chat, conversations, tasks, files, generation, publishing, performance, schedule.
  "/api/chat",
  "/api/chat/feedback",
  "/api/chat/spend/[id]",
  "/api/conversations",
  "/api/files",
  "/api/files/proposals/[id]",
  "/api/generate",
  "/api/handoffs/[id]/decline",
  "/api/handoffs/[id]/run",
  "/api/media/upload",
  "/api/performance",
  "/api/publish/[id]",
  "/api/push",
  "/api/schedule",
  // `tasks` exports GET only today; it is listed so that a mutating export added later is guarded from the first day.
  "/api/tasks",
  "/api/tasks/[id]",
  "/api/tasks/[id]/revise",
  "/api/tasks/[id]/image",
  "/api/tasks/[id]/video",
  // Onboarding, catalog, connections, drives.
  "/api/catalog",
  "/api/connect/[provider]",
  "/api/connect/[provider]/key",
  "/api/drives",
  "/api/onboard",
  "/api/onboard/confirm",
  "/api/onboard/plan",
  // The secretary. `calendar-link` takes its scope through lib/secretary-cal-routes.ts (`calLimit`), not a literal `sc(`.
  "/api/secretary",
  "/api/secretary/[id]",
  "/api/secretary/away",
  "/api/secretary/away/proposals/[id]",
  "/api/secretary/booking",
  "/api/secretary/calendar",
  "/api/secretary/calendar-link",
  "/api/secretary/feed",
  "/api/secretary/meeting/[id]",
  "/api/secretary/meeting/[id]/approve",
  "/api/secretary/meeting/[id]/propose",
  "/api/secretary/series/[seriesId]/keep",
  "/api/secretary/walk",
];

/**
 * Routes that look brand-scoped to a scan but are the account's, each with its reason. The scan (R-C11) takes a route
 * file that calls `sc(` or uses `handler({ auth: "user" ... })`; these are the ones it takes that are not brand data.
 */
export const ACCOUNT_SC_API: Readonly<Record<string, string>> = {
  // Account-scoped on purpose: the privacy export is the whole ACCOUNT's copy and lists every brand the account holds,
  // whichever page asked, so a brand header would change nothing and a missing one is no mistake. It is reached by a
  // plain link from the account settings (DangerZone, a GET that can carry no header) and changes no state.
  "/api/account/export": "GET: exports every brand of the account; sc(u) only marks which one is active (src/lib/privacy-export.ts).",
  "/api/wishlist/suggest": "handler({ auth: \"user\" }) for the session only: a suggestion is keyed by the login's email, no brand data is read.",
  "/api/wishlist/vote": "handler({ auth: \"user\" }) for the session only: a vote is keyed by the voter's account, no brand data is read.",
};

/** A route written as on disk (`/api/tasks/[id]/image`) as a pattern over a request path: `[x]` is one segment, a final `/` is allowed. */
function pattern(route: string): RegExp {
  const body = route
    .split("/")
    .map((seg) => (/^\[[^\]/]+\]$/.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${body}/?$`);
}
const GUARDED = BRAND_API.map(pattern);

/** True when `pathname` is one of the `BRAND_API` routes. */
export function isBrandApi(pathname: string): boolean {
  return GUARDED.some((re) => re.test(pathname));
}

/**
 * The answer for a browser mutation to a brand route that names no brand: null when it may go on (the request is not a
 * mutation, carries no session cookie, is not a brand route, or carries the header), the 409 in `"enforce"` mode, and in
 * `"log"` mode a `brand_missing` warning with the path and null. Runs in the proxy after `crossSiteRefusal`.
 */
export function brandMissingRefusal(req: NextRequest, mode: BrandGuardMode = BRAND_GUARD_MODE): NextResponse | null {
  if (!CROSS_SITE_METHODS.has(req.method.toUpperCase())) return null;
  if (!readCookie(req.cookies, SESSION_COOKIE)) return null;
  const path = req.nextUrl.pathname;
  if (!isBrandApi(path)) return null;
  if (req.headers.get(BRAND_HEADER)) return null;
  if (mode === "log") {
    log.warn("brand_missing", { path });
    return null;
  }
  return NextResponse.json({ ok: false, error: "brand_missing" }, { status: 409, headers: { "cache-control": "no-store" } });
}
