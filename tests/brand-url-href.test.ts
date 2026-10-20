import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND_HEADER, BRAND_SECTIONS, appHref, brandFromPath, isBrandId, isBrandPath, switchBrandPath } from "@/lib/app-href";
import { api } from "@/lib/api-client";
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

describe("rule 889: api() carries the page's brand", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(pathname: string) {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("location", { pathname });
    return fetchSpy;
  }
  const sent = (spy: ReturnType<typeof stub>) => new Headers((spy.mock.calls[0] as unknown as [string, RequestInit])[1].headers);

  it("sends x-thakeen-brand on a brand page", async () => {
    const spy = stub("/ar/app/b/b2/chat");
    await api("/api/chat", { method: "POST", body: "{}" });
    expect(sent(spy).get(BRAND_HEADER)).toBe("b2");
    expect((spy.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("POST");
  });

  it("sends none off a brand page", async () => {
    const spy = stub("/ar/app/settings/billing");
    await api("/api/billing");
    expect(sent(spy).has(BRAND_HEADER)).toBe(false);
  });

  it("keeps a header the caller set", async () => {
    const spy = stub("/ar/app/b/b2/chat");
    await api("/api/chat", { headers: { [BRAND_HEADER]: "other", "content-type": "application/json" } });
    expect(sent(spy).get(BRAND_HEADER)).toBe("other");
    expect(sent(spy).get("content-type")).toBe("application/json");
  });

  it("refuses anything but a same-origin /api/ path", async () => {
    const spy = stub("/ar/app/b/b2/chat");
    await expect(api("https://evil.example/api/x")).rejects.toThrow();
    await expect(api("//evil.example/api/x")).rejects.toThrow();
    await expect(api("/other")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
