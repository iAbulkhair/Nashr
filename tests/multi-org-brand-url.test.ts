import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { acct, currentUser, sc } from "@/lib/auth";
import { saveBrands, scopeFor, type BrandMeta } from "@/lib/brands";
import { BRAND_HEADER, appHref as brandHref } from "@/lib/brand-path";
import { withBrandQuery } from "@/lib/brand-fetch";
import { ownerOf } from "@/lib/membership";
import { wsHandle } from "@/lib/ws-handle";
import { WS_HEADER, appHref, oldAppTarget, switchTarget } from "@/lib/ws-path";
import { addShadowMembership, newUser, signIn, withHeaders } from "./helpers/session";


/**
 * The workspace and the brand in one link, `/{lang}/app/w/{handle}/b/{brand}/…` (multi-workspace M2 on top of Part C),
 * with `MULTI_ORG` on (the release switch since M2 enable). Rule 2113 (one builder carries both; one proxy rewrite strips `w/{handle}` and the
 * brand pages serve the rest), rule 889 (one fetch wrapper sends both headers), rule 2112 (the handle picks the account
 * first, then the brand is one of THAT account's brands). tests/multi-org-brand-url-off.test.ts proves that with the
 * switch off every link is Part C's.
 */

const h = wsHandle("a_bbbbbbbbbbbbbbbbbbbbbbbb");
const T0 = "2026-10-01T00:00:00.000Z";
const rows = (...ids: string[]): BrandMeta[] => [{ id: "default", name: "", createdAt: T0, status: "active" }, ...ids.map((id) => ({ id, name: id, createdAt: T0, status: "active" as const }))];

describe("rule 2113: one builder carries the workspace and the brand", () => {
  it("a brand section goes under w/{handle}/b/{brand}, an account page under w/{handle}, a person page under neither", () => {
    expect(appHref("ar", "/tasks?id=1", h, "b1")).toBe(`/ar/app/w/${h}/b/b1/tasks?id=1`);
    expect(appHref("en", "", h, "b1")).toBe(`/en/app/w/${h}/b/b1`);
    expect(appHref("ar", "/settings/brand", h, "b1")).toBe(`/ar/app/w/${h}/b/b1/settings/brand`);
    expect(appHref("ar", "/settings/billing", h, "b1")).toBe(`/ar/app/w/${h}/settings/billing`);
    expect(appHref("ar", "/workspaces", h, "b1")).toBe("/ar/app/workspaces");
    expect(appHref("ar", "/tasks", h)).toBe(`/ar/app/w/${h}/tasks`);
    // A malformed handle or brand is never put into a path.
    expect(appHref("ar", "/tasks", "w_bad", "../x")).toBe("/ar/app/tasks");
  });

  it("it is brand-path's appHref with the handle added: no second prefix anywhere", () => {
    for (const p of ["", "/tasks", "/chat?conv=c1", "/settings/brand", "/settings/billing", "/files/f1#x", "/refer"])
      for (const b of [null, "b1"]) expect(appHref("ar", p, h, b), `${p} ${b}`).toBe(brandHref("ar", p, { brand: b, handle: h }));
  });

  it("an old address moves to its brand page inside the session's workspace in one hop", () => {
    expect(oldAppTarget("ar", "/ar/app/tasks", "?id=1", h, "b1")).toBe(`/ar/app/w/${h}/b/b1/tasks?id=1`);
  });

  it("switching workspace drops the old workspace's brand: its section root, then the new workspace picks its own brand", () => {
    const other = wsHandle("a_cccccccccccccccccccccccc");
    const href = appHref("ar", "", other);
    expect(switchTarget(href, `/ar/app/w/${h}/b/b1/tasks/t1`)).toBe(`/ar/app/w/${other}/tasks`);
    expect(switchTarget(href, `/ar/app/w/${h}/b/b1`)).toBe(`/ar/app/w/${other}`);
    expect(switchTarget(href, `/ar/app/w/${h}/settings/billing`)).toBe(`/ar/app/w/${other}/settings/billing`);
  });
});

describe("rule 889: one fetch wrapper, both headers; navigations carry both in the query", () => {
  const origWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    vi.unstubAllGlobals();
    (globalThis as { window?: unknown }).window = origWindow;
  });
  const sent = (real: { mock: { calls: unknown[][] } }) => new Headers((real.mock.calls[0] as unknown as [string, RequestInit])[1].headers);

  async function wrapAt(pathname: string, workspace: boolean) {
    vi.resetModules();
    const mod = await import("@/lib/brand-fetch");
    const real = vi.fn(async (..._a: unknown[]) => new Response("{}"));
    const win = { fetch: real, location: { pathname, origin: "https://thakeen.com" } };
    vi.stubGlobal("window", win);
    mod.installBrandFetch({ workspace });
    return { win, real };
  }

  it("with the workspace half on, a page under w/{h}/b/{id} sends both headers", async () => {
    const { win, real } = await wrapAt(`/ar/app/w/${h}/b/b1/chat`, true);
    await win.fetch("/api/chat", { method: "POST", body: "{}" });
    expect(sent(real).get(BRAND_HEADER)).toBe("b1");
    expect(sent(real).get(WS_HEADER)).toBe(h);
  });

  it("with it off (MULTI_ORG false in the provider) only the brand header is sent, as in Part C", async () => {
    const { win, real } = await wrapAt(`/ar/app/w/${h}/b/b1/chat`, false);
    await win.fetch("/api/chat", { method: "POST", body: "{}" });
    expect(sent(real).get(BRAND_HEADER)).toBe("b1");
    expect(sent(real).get(WS_HEADER)).toBeNull();
  });

  it("an account page under w/{h} sends the handle only; a caller's own header is kept", async () => {
    const { win, real } = await wrapAt(`/ar/app/w/${h}/settings/billing`, true);
    await win.fetch("/api/account", { method: "PATCH", headers: { [WS_HEADER]: "w_aaaaaaaaaaaaaaaa" } });
    expect(sent(real).get(WS_HEADER)).toBe("w_aaaaaaaaaaaaaaaa");
    expect(sent(real).get(BRAND_HEADER)).toBeNull();
  });

  it("withBrandQuery adds brand= and ws=, each once and only when valid", () => {
    expect(withBrandQuery("/api/activity/export", "b1", h)).toBe(`/api/activity/export?brand=b1&ws=${h}`);
    expect(withBrandQuery("/api/x?lang=ar", null, h)).toBe(`/api/x?lang=ar&ws=${h}`);
    expect(withBrandQuery(`/api/x?ws=${h}`, "b1", "w_aaaaaaaaaaaaaaaa")).toBe(`/api/x?ws=${h}&brand=b1`);
    expect(withBrandQuery("/api/x", "b1", "garbage")).toBe("/api/x?brand=b1");
  });
});

describe("rule 2113: one proxy rewrite serves the brand pages", () => {
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

  it("/{lang}/app/w/{h}/b/{id}/rest is served from /{lang}/app/b/{id}/rest with both headers from the path", () => {
    const r = proxy(req(`/ar/app/w/${h}/b/b1/tasks/t1?tab=done`, { headers: { [BRAND_HEADER]: "b9", [WS_HEADER]: "w_aaaaaaaaaaaaaaaa" } }));
    expect(rewrite(r)).toBe("/ar/app/b/b1/tasks/t1?tab=done");
    expect(fwd(r, WS_HEADER)).toBe(h);
    expect(fwd(r, BRAND_HEADER)).toBe("b1");
    expect(fwd(r, "x-pathname")).toBe(`/ar/app/w/${h}/b/b1/tasks/t1`);
  });

  it("a GET to /api/ without the header takes the handle and the brand from the query; a mutation never does", () => {
    const g = proxy(req(`/api/activity/export?brand=b1&ws=${h}`, { cookie: true }));
    expect(fwd(g, WS_HEADER)).toBe(h);
    expect(fwd(g, BRAND_HEADER)).toBe("b1");
    const bad = proxy(req("/api/activity/export?ws=garbage", { cookie: true }));
    expect(fwd(bad, WS_HEADER)).toBeNull();
    const post = proxy(req(`/api/brand?ws=${h}`, { method: "POST", cookie: true }));
    expect(post.status).toBe(409);
  });
});

describe("rule 2112: the handle picks the account, then the brand is one of that account's brands", () => {
  const is404 = (e: unknown) => typeof (e as { digest?: unknown })?.digest === "string" && (e as { digest: string }).digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404");
  const at = <T>(handle: string, brand: string, fn: () => Promise<T>) => withHeaders({ [WS_HEADER]: handle, [BRAND_HEADER]: brand }, fn);

  it("handle B with a brand of B resolves to B's brand scope; handle B with a brand only A has is a 404", async () => {
    const u = await newUser("wsb", { shadow: false });
    const shadow = await addShadowMembership(ownerOf(u), u.createdAt);
    await Promise.all([saveBrands(acct(u), rows("onlya")), saveBrands(shadow.aid, rows("onlyb"))]);
    await signIn(u.email);
    const inB = await at(wsHandle(shadow.aid), "onlyb", () => currentUser());
    expect(acct(inB!)).toBe(shadow.aid);
    expect(sc(inB!)).toBe(scopeFor(shadow.aid, "onlyb"));
    const inA = await at(wsHandle(acct(u)), "onlya", () => currentUser());
    expect(sc(inA!)).toBe(scopeFor(acct(u), "onlya"));
    const e = await at(wsHandle(shadow.aid), "onlya", () => currentUser()).then(() => null, (x: unknown) => x);
    expect(is404(e), String(e)).toBe(true);
  });
});
