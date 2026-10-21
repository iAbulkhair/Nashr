import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CROSS_SITE_EXEMPT } from "@/lib/csrf";
import { WORKSPACE_FREE, workspaceFree } from "@/lib/ws-path";

/**
 * Rule 2113, coverage half (multi-workspace M2, docs/specs/2026-10-18-multi-org.md section 7 "Second guard"): every
 * route that serves a state-changing handler and keys a workspace (`sc(`) is inside the second guard, which the proxy
 * applies to every `/api/` path (src/proxy.ts) and the route wrapper applies again (src/lib/api-handler.ts). A route on
 * the free list that reads the session is one of the listed person-level routes, and the free list repeats every path
 * the cross-site check exempts.
 */

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n === "route.ts" ? [p] : [];
  });
}
const STATE_CHANGING = /export (async )?(function|const) (POST|PUT|PATCH|DELETE)\b/;
/** The request path a route file serves, a dynamic segment filled with `x`. */
const pathOf = (f: string) => "/" + f.replace(/\\/g, "/").replace(/^src\/app\//, "").replace(/\/route\.ts$/, "").replace(/\[[^\]]+\]/g, "x");
const routes = walk("src/app/api")
  .map((f) => ({ f, src: readFileSync(f, "utf8") }))
  .filter((r) => STATE_CHANGING.test(r.src))
  .map((r) => ({ ...r, path: pathOf(r.f) }));

/**
 * The free routes with a state-changing handler that read the session, and why each is outside the guard: none keys a
 * workspace record (`sc(`), and each is the person's own (sign-in, the address check, the person's security), the
 * workspace choice itself, or a native form post that cannot carry a header.
 */
const PERSON_LEVEL = new Set([
  "/api/auth/verify/send", // the owner proves their own address (rule 751)
  "/api/auth/verify/check",
  "/api/auth/verify/email",
  "/api/account/2fa", // the person's two-step
  "/api/account/sessions", // the person's devices
  "/api/account/email", // the person's sign-in address
  "/api/account/google", // the person's Google sign-in link
  "/api/oauth/approve", // the consent form (a native post, rule 2305); the grant names the session's account
  "/api/team/accept", // currentPerson(): joins the invite's account (rule 2116)
  "/api/workspaces", // currentPerson(): list and create (rule 2123)
  "/api/workspaces/switch", // currentPerson(): the switch (rule 2112)
]);

describe("rule 2113: every workspace route is inside the second guard", () => {
  it("finds the routes (the scan reads the tree)", () => {
    expect(routes.length).toBeGreaterThan(60);
    expect(routes.some((r) => r.path === "/api/tasks/x")).toBe(true);
  });

  it("no state-changing route that keys a workspace (sc) is on the free list", () => {
    const free = routes.filter((r) => /\bsc\(/.test(r.src) && workspaceFree(r.path)).map((r) => r.path);
    expect(free).toEqual([]);
  });

  it("a free route that reads the session is one of the listed person-level routes", () => {
    const reads = routes
      .filter((r) => workspaceFree(r.path) && /\b(currentUser|currentUserUnverified|currentPerson)\(/.test(r.src))
      .map((r) => r.path)
      .filter((p) => !PERSON_LEVEL.has(p));
    expect(reads).toEqual([]);
  });

  it("the wrapper checks it too, for the routes behind handler()", () => {
    const src = readFileSync("src/lib/api-handler.ts", "utf8");
    expect(src).toMatch(/MULTI_ORG && workspaceMissing\(req\.method/);
    expect(src).toContain('fail("workspace_missing", 409)');
    expect(readFileSync("src/proxy.ts", "utf8")).toMatch(/MULTI_ORG && workspaceMissing\(req\.method, pathname/);
  });

  it("the free list repeats every path the cross-site check exempts", () => {
    for (const e of CROSS_SITE_EXEMPT) expect(WORKSPACE_FREE, e).toContain(e);
  });
});
