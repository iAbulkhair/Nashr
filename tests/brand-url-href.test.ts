import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND_HEADER, BRAND_SECTIONS, appHref, brandFromPath, isBrandId, isBrandPath, switchBrandPath } from "@/lib/brand-path";
import { apiHref, brandHeaderFor, installBrandFetch, sessionBrandHeaders, withBrandQuery } from "@/lib/brand-fetch";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ActiveBrandId } from "@/lib/stored";

describe("rule 890: brand paths and appHref", () => {
  it("builds a brand section under /b/{id}, leaves other paths on the legacy prefix", () => {
    expect(appHref("ar", "/tasks?id=1", { brand: "b2" })).toBe("/ar/app/b/b2/tasks?id=1");
    expect(appHref("en", "", { brand: "default" })).toBe("/en/app/b/default");
    expect(appHref("en", "/", { brand: "default" })).toBe("/en/app/b/default");
    expect(appHref("en", "?x=1", { brand: "b2" })).toBe("/en/app/b/b2?x=1");
    expect(appHref("ar", "/settings/billing", { brand: "b2" })).toBe("/ar/app/settings/billing");
    expect(appHref("ar", "/settings/brand", { brand: "b2" })).toBe("/ar/app/b/b2/settings/brand");
    expect(appHref("ar", "/chat")).toBe("/ar/app/chat");
    expect(appHref("ar", "/chat", { brand: null })).toBe("/ar/app/chat");
    expect(appHref("ar", "/files/abc?x=1#h", { brand: "b2" })).toBe("/ar/app/b/b2/files/abc?x=1#h");
    expect(appHref("ar", "", )).toBe("/ar/app");
  });

  it("never puts an id that is not a brand id into a path", () => {
    expect(appHref("ar", "/tasks", { brand: "../x" })).toBe("/ar/app/tasks");
    expect(appHref("ar", "/tasks", { brand: "a/b" })).toBe("/ar/app/tasks");
    expect(appHref("ar", "/tasks", { brand: "" })).toBe("/ar/app/tasks");
  });

  it("isBrandId and ActiveBrandId share one shape", () => {
    for (const v of ["default", "ab12cd34", "b2", "x_y-z"]) {
      expect(isBrandId(v)).toBe(true);
      expect(ActiveBrandId.safeParse(v).success).toBe(true);
    }
    for (const v of ["", "a/b", "..%2f", "a b", "x".repeat(65), 5, null, undefined]) {
      expect(isBrandId(v)).toBe(false);
    }
    expect(ActiveBrandId.safeParse("a/b").success).toBe(false);
    expect(ActiveBrandId.parse(12345678)).toBe("12345678");
  });

  it("isBrandPath names a section or a path under one", () => {
    for (const s of BRAND_SECTIONS) {
      expect(isBrandPath(s === "" ? "" : `/${s}`)).toBe(true);
      if (s) expect(isBrandPath(`/${s}/x`)).toBe(true);
    }
    expect(isBrandPath("/")).toBe(true);
    expect(isBrandPath("/settings/billing")).toBe(false);
    // The four brand settings sections (R-C6, R-C10); the others stay on the account.
    for (const s of ["brand", "connections", "governance", "notifications"]) expect(isBrandPath(`/settings/${s}`), s).toBe(true);
    for (const s of ["account", "security", "brands", "members", "danger"]) expect(isBrandPath(`/settings/${s}`), s).toBe(false);
    expect(isBrandPath("/settings")).toBe(false);
    expect(isBrandPath("/chatter")).toBe(false);
    expect(isBrandPath("/b/x")).toBe(false);
  });

  it("brandFromPath reads the id only when it is one", () => {
    expect(brandFromPath("/ar/app/b/b2/tasks")).toBe("b2");
    expect(brandFromPath("/en/app/b/b2")).toBe("b2");
    expect(brandFromPath("/ar/app/tasks")).toBeNull();
    expect(brandFromPath("/ar/app/b/..%2f/x")).toBeNull();
    expect(brandFromPath("/ar/app/b/")).toBeNull();
    expect(brandFromPath("/ar/app/b")).toBeNull();
    expect(brandFromPath("/fr/app/b/b2")).toBeNull();
  });

  it("brandFromPath and switchBrandPath tolerate the /w/{handle} segment of draft #418 and keep it", () => {
    expect(brandFromPath("/ar/app/w/w_abcdefghijklmnop/b/b2/tasks")).toBe("b2");
    expect(brandFromPath("/en/app/w/w_abcdefghijklmnop/b/b2")).toBe("b2");
    expect(brandFromPath("/ar/app/w/w_abcdefghijklmnop/tasks")).toBeNull();
    expect(brandFromPath("/ar/app/w/w_abcdefghijklmnop/b/..%2f/x")).toBeNull();
    expect(brandFromPath("/ar/app/w/bad handle/b/b2")).toBeNull();
    expect(switchBrandPath("/ar/app/w/w_abcdefghijklmnop/b/x/tasks", "y")).toBe("/ar/app/w/w_abcdefghijklmnop/b/y/tasks");
    expect(switchBrandPath("/ar/app/w/w_abcdefghijklmnop/b/x/conversations/c_1", "y")).toBe("/ar/app/w/w_abcdefghijklmnop/b/y/conversations");
    expect(switchBrandPath("/en/app/w/w_abcdefghijklmnop/b/x", "y")).toBe("/en/app/w/w_abcdefghijklmnop/b/y");
    expect(switchBrandPath("/en/app/w/w_abcdefghijklmnop/settings/billing", "y")).toBe("/en/app/w/w_abcdefghijklmnop/b/y");
  });

  it("switchBrandPath keeps the section, drops a record id and the query", () => {
    expect(switchBrandPath("/ar/app/b/x/tasks", "y")).toBe("/ar/app/b/y/tasks");
    expect(switchBrandPath("/ar/app/b/x/conversations/c_1", "y")).toBe("/ar/app/b/y/conversations");
    expect(switchBrandPath("/ar/app/b/x/settings/brand", "y")).toBe("/ar/app/b/y/settings/brand");
    expect(switchBrandPath("/ar/app/b/x", "y")).toBe("/ar/app/b/y");
    expect(switchBrandPath("/ar/app/b/x/tasks?id=1", "y")).toBe("/ar/app/b/y/tasks");
    expect(switchBrandPath("/ar/app/settings/billing", "y")).toBe("/ar/app/b/y");
    expect(switchBrandPath("/en/app/tasks", "y")).toBe("/en/app/b/y");
  });
});

describe("rule 889: the fetch wrapper carries the page's brand", () => {
  const O = "https://thakeen.com";

  it("brandHeaderFor: same-origin /api/ from a brand page names that brand", () => {
    expect(brandHeaderFor("/api/x", "/ar/app/b/b2/chat", O)).toBe("b2");
    expect(brandHeaderFor(new URL("/api/x", O), "/en/app/b/b2", O)).toBe("b2");
    expect(brandHeaderFor(`${O}/api/x?y=1`, "/ar/app/b/b2/chat", O)).toBe("b2");
    expect(brandHeaderFor(new Request(`${O}/api/x`), "/ar/app/b/b2/chat", O)).toBe("b2");
  });

  it("brandHeaderFor: the /w/{handle} segment of draft #418 does not hide the brand", () => {
    expect(brandHeaderFor("/api/x", "/ar/app/w/w_abcdefghijklmnop/b/b2/chat", O)).toBe("b2");
  });

  it("brandHeaderFor: null off a brand page, for another site, and for a path that is not /api/", () => {
    expect(brandHeaderFor("/api/x", "/ar/app/settings/billing", O)).toBeNull();
    expect(brandHeaderFor("/api/x", "/ar/app/w/w_abcdefghijklmnop/settings/billing", O)).toBeNull();
    expect(brandHeaderFor("https://evil.example/api/x", "/ar/app/b/b2/chat", O)).toBeNull();
    expect(brandHeaderFor("//evil.example/api/x", "/ar/app/b/b2/chat", O)).toBeNull();
    expect(brandHeaderFor("/other", "/ar/app/b/b2/chat", O)).toBeNull();
    expect(brandHeaderFor("/apix", "/ar/app/b/b2/chat", O)).toBeNull();
    expect(brandHeaderFor("http://[bad", "/ar/app/b/b2/chat", O)).toBeNull();
  });

  describe("installBrandFetch", () => {
    const origWindow = (globalThis as { window?: unknown }).window;
    afterEach(() => {
      vi.unstubAllGlobals();
      (globalThis as { window?: unknown }).window = origWindow;
    });

    const sent = (real: { mock: { calls: unknown[][] } }) => new Headers((real.mock.calls[0] as unknown as [string, RequestInit])[1].headers);

    it("is a no-op on the server", () => {
      vi.stubGlobal("window", undefined);
      expect(() => installBrandFetch()).not.toThrow();
    });

    it("wraps once (a second call does not wrap again) and sends the header from a brand page", async () => {
      vi.resetModules();
      const mod = await import("@/lib/brand-fetch");
      const real = vi.fn(async (..._a: unknown[]) => new Response("{}"));
      const win = { fetch: real, location: { pathname: "/ar/app/b/b2/chat", origin: "https://thakeen.com" } };
      vi.stubGlobal("window", win);
      mod.installBrandFetch();
      const wrapped = win.fetch;
      expect(wrapped).not.toBe(real);
      mod.installBrandFetch();
      expect(win.fetch).toBe(wrapped);
      await win.fetch("/api/chat", { method: "POST", body: "{}" });
      expect(real).toHaveBeenCalledTimes(1);
      expect(sent(real).get(BRAND_HEADER)).toBe("b2");
      expect((real.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("POST");
    });

    it("sends none off a brand page and leaves a call to another site alone", async () => {
      vi.resetModules();
      const mod = await import("@/lib/brand-fetch");
      const real = vi.fn(async (..._a: unknown[]) => new Response("{}"));
      const win = { fetch: real, location: { pathname: "/ar/app/settings/billing", origin: "https://thakeen.com" } };
      vi.stubGlobal("window", win);
      mod.installBrandFetch();
      await win.fetch("/api/billing");
      await win.fetch("https://evil.example/api/x");
      expect(real.mock.calls[0][1]).toBeUndefined();
      expect(real.mock.calls[1][1]).toBeUndefined();
    });

    it("keeps a header the caller set, on init and on a Request", async () => {
      vi.resetModules();
      const mod = await import("@/lib/brand-fetch");
      const real = vi.fn(async (..._a: unknown[]) => new Response("{}"));
      const win = { fetch: real, location: { pathname: "/ar/app/b/b2/chat", origin: "https://thakeen.com" } };
      vi.stubGlobal("window", win);
      mod.installBrandFetch();
      await win.fetch("/api/chat", { headers: { [BRAND_HEADER]: "other", "content-type": "application/json" } });
      expect(sent(real).get(BRAND_HEADER)).toBe("other");
      expect(sent(real).get("content-type")).toBe("application/json");
      real.mockClear();
      await win.fetch(new Request("https://thakeen.com/api/chat", { headers: { [BRAND_HEADER]: "viaReq" } }));
      expect(sent(real).get(BRAND_HEADER)).toBe("viaReq");
    });
  });

  describe("withBrandQuery and apiHref (R-C13: navigations cannot carry a header)", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("withBrandQuery appends brand= with ? or &, before a hash, once, and only for a brand id", () => {
      expect(withBrandQuery("/api/activity/export", "b2")).toBe("/api/activity/export?brand=b2");
      expect(withBrandQuery("/api/x?lang=ar", "b2")).toBe("/api/x?lang=ar&brand=b2");
      expect(withBrandQuery("/api/x#h", "b2")).toBe("/api/x?brand=b2#h");
      expect(withBrandQuery("/api/x?brand=b3", "b2")).toBe("/api/x?brand=b3");
      expect(withBrandQuery("/api/x", null)).toBe("/api/x");
      expect(withBrandQuery("/api/x", "../x")).toBe("/api/x");
      expect(withBrandQuery("/api/x", undefined)).toBe("/api/x");
    });

    it("apiHref reads the brand from the page path", () => {
      vi.stubGlobal("location", { pathname: "/ar/app/b/b2/activity" });
      expect(apiHref("/api/activity/export")).toBe("/api/activity/export?brand=b2");
      expect(apiHref("/api/tasks/t1/pptx?lang=ar")).toBe("/api/tasks/t1/pptx?lang=ar&brand=b2");
      vi.stubGlobal("location", { pathname: "/ar/app/w/w_abcdefghijklmnop/b/b2/activity" });
      expect(apiHref("/api/activity/export")).toBe("/api/activity/export?brand=b2");
    });

    it("apiHref leaves the path alone on an account page and on the server", () => {
      vi.stubGlobal("location", { pathname: "/ar/app/settings/billing" });
      expect(apiHref("/api/account/export")).toBe("/api/account/export");
      vi.stubGlobal("location", undefined);
      expect(apiHref("/api/activity/export")).toBe("/api/activity/export");
    });
  });

  describe("sessionBrandHeaders (R-C12)", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("names the session's brand on an account page", () => {
      vi.stubGlobal("location", { pathname: "/ar/app/settings/account" });
      expect(sessionBrandHeaders("b2")).toEqual({ [BRAND_HEADER]: "b2" });
    });

    it("adds nothing on a brand page (the wrapper sends the page's brand, which wins), without a brand, or for a value that is no brand id", () => {
      vi.stubGlobal("location", { pathname: "/ar/app/b/b3/chat" });
      expect(sessionBrandHeaders("b2")).toEqual({});
      vi.stubGlobal("location", { pathname: "/ar/app/w/w_abcdefghijklmnop/b/b3/chat" });
      expect(sessionBrandHeaders("b2")).toEqual({});
      vi.stubGlobal("location", { pathname: "/ar/app/settings/account" });
      expect(sessionBrandHeaders(null)).toEqual({});
      expect(sessionBrandHeaders(undefined)).toEqual({});
      expect(sessionBrandHeaders("../x")).toEqual({});
    });
  });

  describe("scan", () => {
    const read = (p: string) => readFileSync(p, "utf8");
    it("WorkspaceContext installs the wrapper and exposes useBrandId", () => {
      const src = read("src/components/app/WorkspaceContext.tsx");
      expect(src).toMatch(/installBrandFetch\(\)/);
      expect(src).toMatch(/export function useBrandId\(\): string \| null/);
    });

    it("the app layout hands the session's brand to the provider", () => {
      expect(read("src/app/[lang]/app/layout.tsx")).toMatch(/brandId=\{user\.brandId \?\? null\}/);
    });

    it("every navigation to a brand GET route goes through apiHref / withBrandQuery", () => {
      const nav: [string, RegExp][] = [
        ["src/components/app/IntegrationsPanel.tsx", /apiHref\(`\/api\/connect\//],
        ["src/components/app/Inbox.tsx", /apiHref\(`\/api\/tasks\/\$\{[^}]+\}\/pptx/],
        ["src/components/app/ReportsPanel.tsx", /apiHref\(`\/api\/tasks\/\$\{[^}]+\}\/pptx/],
        ["src/components/app/ActivityPanel.tsx", /apiHref\("\/api\/activity\/export"\)/],
        ["src/app/[lang]/app/b/[brand]/todo/page.tsx", /withBrandQuery\(`\/api\/secretary\/series\//],
        ["src/components/app/CalendarLinkCard.tsx", /apiHref\(/],
      ];
      for (const [file, re] of nav) expect(read(file), file).toMatch(re);
      // Account navigations stay unchanged.
      expect(read("src/components/app/settings/DangerZone.tsx")).not.toMatch(/apiHref/);
      expect(read("src/components/app/AuthForm.tsx")).not.toMatch(/apiHref/);
    });

    it("the shell sends the session's brand on the two account-page mutations (R-C12)", () => {
      const sidebar = read("src/components/app/Sidebar.tsx");
      expect(sidebar).toMatch(/useBrandId\(\)/);
      expect(sidebar).toMatch(/\.\.\.sessionBrandHeaders\(sessionBrand\)[^]*?body: JSON\.stringify\(\{ title/);
      expect(read("src/components/app/settings/AccountSettings.tsx")).toMatch(/saveProfile\(\{ \[k\]: value \}, lang, forbidden, sessionBrand\)/);
      expect(read("src/components/app/settings/profileSave.ts")).toMatch(/\.\.\.sessionBrandHeaders\(sessionBrand\)/);
    });

    it("api() and the old file names are gone", () => {
      const files: string[] = [];
      const walk = (d: string) => { for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? walk(f) : /\.tsx?$/.test(n) && files.push(f); } };
      walk("src");
      for (const f of files) {
        const src = read(f);
        expect(src, f).not.toMatch(/from "(?:@\/lib|\.)\/(?:app-href|api-client)"/);
        expect(src, f).not.toMatch(/useAppHref/);
      }
    });
  });
});
