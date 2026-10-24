import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { wsHandle } from "@/lib/ws-handle";
import { WS_HEADER } from "@/lib/ws-path";


/**
 * Rule 2113 (multi-workspace M2, docs/specs/2026-10-18-multi-org.md section 7), proxy half, with `MULTI_ORG` on (the release switch since M2 enable): `/{lang}/app/w/{handle}/…` is served from the page folder at `/{lang}/app/…` with the handle in `x-thakeen-ws`
 * and the browser's address in `x-pathname`; a page path never keeps an `x-thakeen-ws` the browser sent; a state-changing
 * API request with the session cookie and no handle answers 409 `workspace_missing`. tests/multi-org-flag-off.test.ts
 * proves the same requests are untouched while the switch is off.
 */

const h = wsHandle("a_bbbbbbbbbbbbbbbbbbbbbbbb");
const req = (path: string, init: { method?: string; headers?: Record<string, string>; cookie?: boolean } = {}) =>
  new NextRequest("https://thakeen.example" + path, {
    method: init.method ?? "GET",
    headers: { ...(init.cookie ? { cookie: "thakeen_session=tok" } : {}), "sec-fetch-site": "same-origin", ...(init.headers ?? {}) },
  });
const fwd = (r: Response, name: string) => r.headers.get(`x-middleware-request-${name}`);
const rewrite = (r: Response) => {
  const v = r.headers.get("x-middleware-rewrite");
  return v ? new URL(v).pathname + new URL(v).search : null;
};

describe("rule 2113: the workspace segment is a rewrite with the handle in the header", () => {
  it("serves /{lang}/app/w/{h}/rest from /{lang}/app/rest, query kept, x-pathname the browser's address", () => {
    const r = proxy(req(`/ar/app/w/${h}/tasks/t1?tab=done`));
    expect(rewrite(r)).toBe("/ar/app/tasks/t1?tab=done");
    expect(fwd(r, WS_HEADER)).toBe(h);
    expect(fwd(r, "x-pathname")).toBe(`/ar/app/w/${h}/tasks/t1`);
    const root = proxy(req(`/en/app/w/${h}`));
    expect(rewrite(root)).toBe("/en/app");
    expect(fwd(root, WS_HEADER)).toBe(h);
  });

  it("the handle in the header is the one of the path, never the one the browser sent", () => {
    const other = wsHandle("a_cccccccccccccccccccccccc");
    const r = proxy(req(`/ar/app/w/${h}/files`, { headers: { [WS_HEADER]: other } }));
    expect(fwd(r, WS_HEADER)).toBe(h);
  });

  it("a page path without the segment drops any x-thakeen-ws the browser sent", () => {
    for (const p of ["/ar/app/tasks", "/ar/app", "/ar", "/en/pricing", "/ar/app/workspaces"]) {
      const r = proxy(req(p, { headers: { [WS_HEADER]: h } }));
      expect(fwd(r, WS_HEADER), p).toBeNull();
    }
  });

  it("a malformed handle is not rewritten (no page folder serves it: 404)", () => {
    const r = proxy(req("/ar/app/w/garbage/tasks"));
    expect(rewrite(r)).toBeNull();
    expect(fwd(r, WS_HEADER)).toBeNull();
  });

  it("an old settings path inside the segment moves as outside it, keeping the handle", () => {
    const r = proxy(req(`/ar/app/w/${h}/team?x=1`));
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get("location")!).pathname).toBe(`/ar/app/w/${h}/settings/members`);
    expect(new URL(r.headers.get("location")!).search).toBe("?x=1");
  });
});

describe("rule 2113: a state-changing API request names its workspace", () => {
  it("POST, PUT, PATCH and DELETE with the session cookie and no handle answer 409 workspace_missing", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = proxy(req("/api/tasks", { method, cookie: true }));
      expect(r.status, method).toBe(409);
      expect(await r.json()).toEqual({ ok: false, error: "workspace_missing" });
    }
    const bad = proxy(req("/api/brand", { method: "POST", cookie: true, headers: { [WS_HEADER]: "garbage" } }));
    expect(bad.status).toBe(409);
  });

  it("the same request with a handle passes on, the handle kept for the route", () => {
    const r = proxy(req("/api/tasks", { method: "POST", cookie: true, headers: { [WS_HEADER]: h } }));
    expect(r.status).toBe(200);
    expect(fwd(r, WS_HEADER)).toBe(h);
  });

  it("a GET, a request without the session cookie and the free paths pass", () => {
    expect(proxy(req("/api/tasks", { cookie: true })).status).toBe(200);
    expect(proxy(req("/api/tasks", { method: "POST" })).status).toBe(200);
    for (const p of ["/api/auth/login", "/api/workspaces", "/api/workspaces/switch", "/api/team/accept", "/api/account/2fa", "/api/admin/plan", "/api/cron/daily", "/api/mcp"]) {
      expect(proxy(req(p, { method: "POST", cookie: true })).status, p).toBe(200);
    }
  });

  it("the cross-site refusal still answers first", () => {
    const r = proxy(req("/api/tasks", { method: "POST", cookie: true, headers: { "sec-fetch-site": "cross-site" } }));
    expect(r.status).toBe(403);
  });
});
