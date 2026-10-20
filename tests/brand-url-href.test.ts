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
    // A number is turned back into text and that text must be a brand id too (fix round item 2).
    for (const v of [1.5, -0.5, 1e21, 2 ** 70]) expect(ActiveBrandId.safeParse(v).success, String(v)).toBe(false);
  });

  it("appHref never lets a . or .. segment through, encoded or not (fix round item 3)", () => {
    expect(appHref("ar", "/tasks/../settings/billing", { brand: "b2" })).toBe("/ar/app/settings/billing");
    expect(appHref("ar", "/../../en/admin", { brand: "b2" })).toBe("/ar/app/en/admin");
    expect(appHref("ar", "/files/./x/%2e%2E/y?z=1#h", { brand: "b2" })).toBe("/ar/app/b/b2/files/y?z=1#h");
    expect(appHref("ar", "/tasks/..", { brand: "b2" })).toBe("/ar/app/b/b2");
    expect(appHref("en", "/chat/.%2E/./", { brand: "b2" })).toBe("/en/app/b/b2");
    expect(appHref("en", "tasks//x", { brand: "b2" })).toBe("/en/app/b/b2/tasks/x");
    for (const rest of ["/a/../../..", "/./tasks/.", "/%2e/%2E%2e/tasks", "/tasks/x/..%2f"]) {
      const h = appHref("ar", rest, { brand: "b2" });
      expect(h.split("?")[0].split("/").some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg)), `${rest} -> ${h}`).toBe(false);
    }
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

  it("switchBrandPath takes app and a handle only as whole segments (fix round item 1)", () => {
    // /apple and /appx are not the app: no handle or section is read from them.
    expect(switchBrandPath("/en/apple/b/x/tasks", "y")).toBe("/en/app/b/y");
    expect(switchBrandPath("/en/appx/w/w_abcdefghijklmnop/b/x/tasks", "y")).toBe("/en/app/b/y");
    // A handle with more characters after it is no handle, so it is not kept.
    expect(switchBrandPath("/en/app/w/w_abcdefghijklmnopq/b/x/tasks", "y")).toBe("/en/app/b/y");
    // The real ones still work, with a query or a hash right after the segment.
    expect(switchBrandPath("/en/app?x=1", "y")).toBe("/en/app/b/y");
    expect(switchBrandPath("/en/app/w/w_abcdefghijklmnop?x=1", "y")).toBe("/en/app/w/w_abcdefghijklmnop/b/y");
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

    const brandPage = async () => {
      vi.resetModules();
      const mod = await import("@/lib/brand-fetch");
      const real = vi.fn(async (..._a: unknown[]) => new Response("{}"));
      const win = { fetch: real as unknown as typeof fetch, location: { pathname: "/ar/app/b/b2/chat", origin: "https://thakeen.com" } };
      vi.stubGlobal("window", win);
      return { mod, real, win };
    };

    it("a Request with POST and a body and no brand header keeps its method and body and gets the header (fix round item 15)", async () => {
      const { mod, real, win } = await brandPage();
      mod.installBrandFetch();
      await win.fetch(new Request("https://thakeen.com/api/chat", { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } }));
      const [input, init] = real.mock.calls[0] as unknown as [Request, RequestInit];
      // What the real fetch does with (Request, init): the init's headers replace the Request's, the rest is the Request's.
      const merged = new Request(input, init);
      expect(merged.method).toBe("POST");
      expect(await merged.text()).toBe('{"a":1}');
      expect(merged.headers.get(BRAND_HEADER)).toBe("b2");
      expect(merged.headers.get("content-type")).toBe("application/json");
    });

    it("init.headers as a Headers instance and as array pairs are kept, and the header is added (fix round item 15)", async () => {
      const { mod, real, win } = await brandPage();
      mod.installBrandFetch();
      await win.fetch("/api/chat", { method: "PUT", headers: new Headers({ "content-type": "application/json", "x-a": "1" }) });
      await win.fetch("/api/chat", { headers: [["content-type", "text/plain"], ["x-b", "2"]] });
      const h0 = new Headers((real.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
      const h1 = new Headers((real.mock.calls[1] as unknown as [string, RequestInit])[1].headers);
      expect([h0.get(BRAND_HEADER), h0.get("content-type"), h0.get("x-a")]).toEqual(["b2", "application/json", "1"]);
      expect((real.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("PUT");
      expect([h1.get(BRAND_HEADER), h1.get("content-type"), h1.get("x-b")]).toEqual(["b2", "text/plain", "2"]);
    });

    it("an empty brand header the caller set counts as none: the page's brand replaces it (fix round item 11)", async () => {
      const { mod, real, win } = await brandPage();
      mod.installBrandFetch();
      await win.fetch("/api/chat", { headers: { [BRAND_HEADER]: "" } });
      expect(sent(real).get(BRAND_HEADER)).toBe("b2");
    });

    it("wraps once across module instances (HMR) and under another wrapper installed after it (fix round item 17)", async () => {
      const { mod, real, win } = await brandPage();
      mod.installBrandFetch();
      const ours = win.fetch;
      // A second copy of the module (hot reload): the mark on the function, not a module flag, stops a second wrap.
      vi.resetModules();
      const again = await import("@/lib/brand-fetch");
      again.installBrandFetch();
      expect(win.fetch).toBe(ours);
      // Another wrapper (#418's installWorkspaceFetch) wraps ours; a fresh module copy still does not wrap a third time.
      const other = vi.fn((input: RequestInfo | URL, init?: RequestInit) => ours(input, init));
      win.fetch = other as unknown as typeof fetch;
      vi.resetModules();
      const third = await import("@/lib/brand-fetch");
      third.installBrandFetch();
      expect(win.fetch).toBe(other);
      await win.fetch("/api/chat");
      expect(real).toHaveBeenCalledTimes(1);
      expect(sent(real).get(BRAND_HEADER)).toBe("b2");
    });

    it("wraps another wrapper that was installed before it (the mark is ours only)", async () => {
      const { mod, real, win } = await brandPage();
      const other = vi.fn((input: RequestInfo | URL, init?: RequestInit) => (real as unknown as typeof fetch)(input, init));
      win.fetch = other as unknown as typeof fetch;
      mod.installBrandFetch();
      expect(win.fetch).not.toBe(other);
      await win.fetch("/api/chat");
      expect(other).toHaveBeenCalledTimes(1);
      expect(sent(real).get(BRAND_HEADER)).toBe("b2");
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

    it("no navigation names an /api/ route by a bare literal unless it is an account, admin, auth or staging route (fix round item 16)", () => {
      // A link, a download, `location.assign`, `location.href =` or `window.open` cannot carry the header: a brand GET route
      // goes through apiHref / useApiHref / withBrandQuery (R-C13). Only these routes may be named bare.
      const ALLOWED = ["/api/account/", "/api/admin/", "/api/auth/", "/api/staging"];
      const NAV = /(?:\bhref\s*=\s*\{?|location\.assign\(|location\.href\s*=|window\.open\()\s*(["'`])(\/api\/[^"'`?$#]*)/g;
      const files: string[] = [];
      const walk = (d: string) => { for (const n of readdirSync(d)) { const f = join(d, n); if (f === join("src", "app", "api")) continue; statSync(f).isDirectory() ? walk(f) : /\.tsx?$/.test(n) && files.push(f); } };
      walk("src/components");
      walk("src/app");
      const bare: string[] = [];
      for (const f of files) for (const m of read(f).matchAll(NAV)) bare.push(`${f}: ${m[2]}`);
      // The scan sees the bare account and admin links that exist today, so it is not matching nothing.
      expect(bare.some((b) => b.endsWith("/api/account/export"))).toBe(true);
      expect(bare.some((b) => b.includes("/api/admin/"))).toBe(true);
      expect(bare.filter((b) => !ALLOWED.some((a) => b.split(": ")[1].startsWith(a)))).toEqual([]);
    });

    it("CalendarLinkView reads only its props; the card builds the start link with useApiHref (fix round item 19)", () => {
      const src = read("src/components/app/CalendarLinkCard.tsx");
      const view = src.slice(src.indexOf("export function CalendarLinkView("), src.indexOf("export default function CalendarLinkCard("));
      expect(view.length).toBeGreaterThan(100);
      expect(view).not.toMatch(/\buse[A-Z]\w*\(/);
      expect(view).toMatch(/href=\{startHref\(p\)\}/);
      const card = src.slice(src.indexOf("export default function CalendarLinkCard("));
      expect(card).toMatch(/const apiHref = useApiHref\(\)/);
      expect(card).toMatch(/startHref=\{\(p\) => apiHref\(startPath\(p, lang\)\)\}/);
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
