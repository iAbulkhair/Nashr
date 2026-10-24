import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { MULTI_ORG } from "@/lib/multi-org";
import { BRAND_SECTIONS, appHref as brandHref } from "@/lib/brand-path";
import { appHrefFor, appHrefIn } from "@/lib/ws-href";
import { wsHandle } from "@/lib/ws-handle";
import { WS_HEADER, appHref, oldAppTarget } from "@/lib/ws-path";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: false }));

/**
 * With `MULTI_ORG` off (as in production through M1-M3; on since the enable release, so this file turns it off, rule
 * 3814), the combined builders are exactly Part C's brand links (rules 889,
 * 2113, 2132): no handle is ever made, so every link equals brand-path's `appHref`, the proxy never copies `ws=` from a
 * query and a `/w/…` path is not rewritten. tests/multi-org-brand-url.test.ts covers the switch on.
 */

const h = wsHandle("a_bbbbbbbbbbbbbbbbbbbbbbbb");
const PATHS = ["", "/", "/tasks", "/tasks/t1?x=1#h", "/settings/brand", "/settings/billing", "/refer", "/workspaces", ...BRAND_SECTIONS.map((s) => `/${s}`)];

describe("rule 2132: MULTI_ORG off, every link is Part C's", () => {
  it("the switch is off in this file", () => expect(MULTI_ORG).toBe(false));

  it("server builders give brand-path's appHref for every path and brand", () => {
    for (const lang of ["ar", "en"] as const)
      for (const p of PATHS)
        for (const b of [undefined, null, "b1", "default"]) {
          const want = brandHref(lang, p === "/" ? "" : p, { brand: b });
          expect(appHrefFor({ email: "a@test.example" }, lang, p, b), `${lang} ${p} ${b}`).toBe(want);
          expect(appHrefIn("a@test.example", lang, p, b), `${lang} ${p} ${b}`).toBe(want);
          expect(appHref(lang, p, null, b), `${lang} ${p} ${b}`).toBe(want);
        }
  });

  it("the layout moves no old address without a handle: the [...legacy] page answers it as on main", () => {
    expect(oldAppTarget("ar", "/ar/app/tasks", "?id=1", null, "b1")).toBeNull();
  });

  it("the proxy copies no ws= query and does not rewrite a /w/ path", () => {
    const req = (path: string) => new NextRequest("https://thakeen.example" + path, { headers: { cookie: "thakeen_session=tok", "sec-fetch-site": "same-origin" } });
    const g = proxy(req(`/api/activity/export?brand=b1&ws=${h}`));
    expect(g.headers.get(`x-middleware-request-${WS_HEADER}`)).toBeNull();
    expect(g.headers.get("x-middleware-request-x-thakeen-brand")).toBe("b1");
    const p = proxy(req(`/ar/app/w/${h}/b/b1/tasks`));
    expect(p.headers.get("x-middleware-rewrite")).toBeNull();
  });
});
