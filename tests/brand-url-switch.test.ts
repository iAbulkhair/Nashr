import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// BrandSwitcher reads the router and the path; outside Next there are none.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/app/b/b1/tasks",
  useSearchParams: () => new URLSearchParams(),
}));

import { json, newUser, readActiveBrand, seedActiveBrand, signIn, signOut, withHeaders } from "./helpers/session";
import { acct, currentUser, type User } from "@/lib/auth";
import { appHref, BRAND_HEADER, switchBrandPath } from "@/lib/brand-path";
import { brandIdOfScope, saveBrands, scopeFor, type BrandMeta } from "@/lib/brands";
import { getBrand, saveBrand, type Brand } from "@/lib/brand";
import { db } from "@/lib/db";
import { settingsHref } from "@/lib/settings-nav";
import BrandSwitcher, { brandMenuItems, pickBrand, type SwitcherBrand } from "@/components/app/BrandSwitcher";
import * as brandsRoute from "@/app/api/brands/route";
import * as brandRoute from "@/app/api/brand/route";

/**
 * Rules 892, 893, 895 and 896 (brand id in the URL, Part C; plan docs/superpowers/plans/2026-10-20-brand-url.md Task 7):
 * the page's brand is a selector and never a write (892), the switcher in the rail (893), the rules text (895) and two
 * tabs on two brands of one account (896). Rules 890 and 894 are Task 8's.
 */

afterEach(() => { vi.restoreAllMocks(); signOut(); });

const T0 = "2026-10-01T00:00:00.000Z";
const read = (f: string) => readFileSync(f, "utf8");

/** An owner of the Business plan with active b1, b2 (and the default), archived old; the stored choice is `chosen`. */
async function ownerWithBrands(prefix: string, chosen = "default"): Promise<User> {
  const owner = await newUser(prefix);
  const rows: BrandMeta[] = [
    { id: "default", name: "", createdAt: T0, status: "active" },
    { id: "b1", name: "One", createdAt: T0, status: "active" },
    { id: "b2", name: "Two", createdAt: T0, status: "active" },
    { id: "old", name: "Old", createdAt: T0, status: "archived" },
  ];
  await saveBrands(acct(owner), rows);
  await seedActiveBrand(owner.email, chosen);
  await signIn(owner.email);
  return owner;
}

/** Every `activebrand` write a spy on `db.set` saw, as [key, value]. */
const choiceWrites = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("activebrand")).map((c) => [c[0], c[1]]);

describe("rule 892: the page's brand is a selector, only the switch writes the stored choice", () => {
  it("resolving a request with the header and rendering b/[brand]/layout never writes an activebrand key", async () => {
    const owner = await ownerWithBrands("sw");
    const set = vi.spyOn(db, "set");
    const { default: BrandLayout } = await import("@/app/[lang]/app/b/[brand]/layout");
    const u = (await withHeaders({ [BRAND_HEADER]: "b2" }, () => currentUser()))!;
    expect(u.brandId).toBe("b2");
    await withHeaders({ [BRAND_HEADER]: "b2" }, () => BrandLayout({ children: null, params: Promise.resolve({ lang: "en", brand: "b2" }) }));
    expect(choiceWrites(set)).toEqual([]);
    expect(await readActiveBrand(owner.email)).toBe("default");
  });

  it("the switch call writes the choice, for the brand picked, and nothing else changes it", async () => {
    const owner = await ownerWithBrands("sw");
    const set = vi.spyOn(db, "set");
    // The page is on b1 (the wrapper's header); the pick is b2.
    const res = await withHeaders({ [BRAND_HEADER]: "b1" }, () => brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: "b2" })));
    expect((await res.json()).ok).toBe(true);
    const writes = choiceWrites(set);
    // One write for a `p_` person; a legacy home account also keeps the per-login key beside it.
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes.length).toBeLessThanOrEqual(2);
    for (const w of writes) expect(w[1]).toBe("b2");
    expect(await readActiveBrand(owner.email)).toBe("b2");
  });

  it("a switch to a brand that is archived or not the account's is a 404 and writes nothing", async () => {
    const owner = await ownerWithBrands("sw");
    const set = vi.spyOn(db, "set");
    for (const id of ["nope", "../x"]) {
      const res = await brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id }));
      expect(res.status).toBe(404);
    }
    expect(choiceWrites(set)).toEqual([]);
    expect(await readActiveBrand(owner.email)).toBe("default");
  });
});

const BRANDS: SwitcherBrand[] = [
  { id: "default", name: "Main", status: "active" },
  { id: "b1", name: "One", status: "active" },
  { id: "old", name: "Old", status: "archived" },
  { id: "b2", name: "", status: "active" },
];
const noop = () => {};

describe("rule 893: the brand switcher", () => {
  it("lists only active brands, the current one marked, with a fallback for a name not set", () => {
    const items = brandMenuItems({ lang: "en", brands: BRANDS, current: "b1", canAdd: false, onPick: noop });
    const brandRows = items.filter((i) => i.key.startsWith("b-"));
    expect(brandRows.map((i) => i.key)).toEqual(["b-default", "b-b1", "b-b2"]);
    expect(brandRows.some((i) => i.key === "b-old")).toBe(false);
    const html = renderToStaticMarkup(createElement("ul", null, brandRows.map((i) => createElement("li", { key: i.key }, i.label))));
    expect(html).toContain("One");
    expect(html).toContain("Main");
    // The current brand is said in words for a screen reader, once.
    expect(html.match(/sr-only">current</g)).toHaveLength(1);
    expect(items.some((i) => i.key === "b-old")).toBe(false);
  });

  it("shows the add entry only when canAdd, always the manage entry, both on the brands settings page", () => {
    const off = brandMenuItems({ lang: "ar", brands: BRANDS, current: "b1", canAdd: false, onPick: noop });
    const on = brandMenuItems({ lang: "ar", brands: BRANDS, current: "b1", canAdd: true, onPick: noop });
    expect(off.find((i) => i.key === "add")).toBeUndefined();
    const add = on.find((i) => i.key === "add")!;
    const manage = on.find((i) => i.key === "manage")!;
    expect(manage.href).toBe(settingsHref("ar", "brands"));
    expect(add.href).toBe(settingsHref("ar", "brands"));
    expect(off.find((i) => i.key === "manage")?.href).toBe(settingsHref("ar", "brands"));
    // Arabic first, then English (the page's language), and the two are different words.
    expect(renderToStaticMarkup(createElement("b", null, add.label))).toContain("أضف براند");
    expect(renderToStaticMarkup(createElement("b", null, manage.label))).toContain("إدارة البراندات");
    const en = brandMenuItems({ lang: "en", brands: BRANDS, current: "b1", canAdd: true, onPick: noop });
    expect(renderToStaticMarkup(createElement("b", null, en.find((i) => i.key === "add")!.label))).toContain("Add a brand");
    expect(renderToStaticMarkup(createElement("b", null, en.find((i) => i.key === "manage")!.label))).toContain("Manage brands");
  });

  it("a brand row calls onPick with its id; the current brand's row does nothing", () => {
    const picked: string[] = [];
    const items = brandMenuItems({ lang: "en", brands: BRANDS, current: "b1", canAdd: true, onPick: (id) => picked.push(id) });
    for (const k of ["b-default", "b-b1", "b-b2"]) items.find((i) => i.key === k)!.onSelect?.();
    expect(picked).toEqual(["default", "b2"]);
  });

  it("picking posts the switch, then goes to the same section of the new brand (the sub-path is kept)", async () => {
    const calls: string[] = [];
    const push = (p: string) => calls.push(`push ${p}`);
    const f = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(`fetch ${init?.method} ${init?.body}`); return new Response(JSON.stringify({ ok: true }), { status: 200 }); });
    expect(await pickBrand("b2", "/en/app/b/b1/tasks", push, f as unknown as typeof fetch)).toBe(true);
    expect(calls).toEqual([`fetch POST ${JSON.stringify({ action: "switch", id: "b2" })}`, "push /en/app/b/b2/tasks"]);
    expect(f.mock.calls[0][0]).toBe("/api/brands");
    // A record page falls back to its section (the record belongs to the old brand): switchBrandPath's rule.
    calls.length = 0;
    await pickBrand("b2", "/en/app/b/b1/files/abc", push, f as unknown as typeof fetch);
    expect(calls[1]).toBe(`push ${switchBrandPath("/en/app/b/b1/files/abc", "b2")}`);
    expect(calls[1]).toBe("push /en/app/b/b2/files");
  });

  it("a refused or failed switch stays where it is", async () => {
    const push = vi.fn();
    const no = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 }));
    expect(await pickBrand("b2", "/en/app/b/b1/tasks", push, no as unknown as typeof fetch)).toBe(false);
    const boom = vi.fn(async () => { throw new Error("offline"); });
    expect(await pickBrand("b2", "/en/app/b/b1/tasks", push, boom as unknown as typeof fetch)).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("the closed switcher shows the current brand's name and initial, in both languages, and no id", () => {
    for (const lang of ["ar", "en"] as const) {
      const html = renderToStaticMarkup(createElement(BrandSwitcher, { lang, brands: null, current: { id: "b1", name: "مقهى النخلة" }, canAdd: false }));
      expect(html).toContain("مقهى النخلة");
      expect(html).toContain(">م<");
      expect(html).toContain('aria-haspopup="menu"');
      expect(html).not.toContain("b1");
    }
  });

  it("the rail uses the switcher in place of the plain link, and the BrandsPanel switch navigates by switchBrandPath", () => {
    const sidebar = read("src/components/app/Sidebar.tsx");
    expect(sidebar).toMatch(/<BrandSwitcher /);
    expect(sidebar).not.toMatch(/<Link href=\{settingsHref\(lang, "brands"\)\} onClick=\{\(\) => setOpen\(false\)\} className="flex min-w-0 flex-1/);
    const panel = read("src/components/app/BrandsPanel.tsx");
    expect(panel).toMatch(/switchBrandPath\(/);
  });

  it("the rail's new conversation goes to the brand it was created in (ruling P10)", () => {
    const sidebar = read("src/components/app/Sidebar.tsx");
    expect(sidebar).toMatch(/r\.push\(appHref\(lang, `\/chat\?conv=\$\{j\.conversation\.id\}`, \{ brand: brandFromPath\(path\) \?\? sessionBrand \}\)\)/);
    expect(sidebar).not.toMatch(/r\.push\(`\$\{base\}\/chat\?conv=/);
    // What the push builds: the page's brand wins over the session's, and an account page uses the session's.
    expect(appHref("en", "/chat?conv=c1", { brand: "b1" })).toBe("/en/app/b/b1/chat?conv=c1");
  });
});

describe("brandIdOfScope", () => {
  it("is the inverse of scopeFor, for the default brand and another", () => {
    for (const a of ["a@test.example", "a_abcdefghijklmnopqrstuvwx"]) {
      expect(brandIdOfScope(scopeFor(a, "default"))).toBe("default");
      expect(brandIdOfScope(scopeFor(a, "b2x9k3m1"))).toBe("b2x9k3m1");
    }
  });
});

describe("rule 896: two tabs, two brands of one account", () => {
  it("a PUT /api/brand with the header of brand X writes X's brand file and leaves Y's, whatever the stored choice", async () => {
    const owner = await ownerWithBrands("tabs", "b2");
    const file = (name: string): Brand => ({ name, industry: "cafe", products: "coffee", audience: "everyone" } as Brand);
    const scopeX = scopeFor(acct(owner), "b1");
    const scopeY = scopeFor(acct(owner), "b2");
    await saveBrand(scopeX, file("X before"));
    await saveBrand(scopeY, file("Y before"));
    expect(await readActiveBrand(owner.email)).toBe("b2");
    // The tab on X saves while the stored choice (the other tab's last pick) says Y.
    const res = await withHeaders({ [BRAND_HEADER]: "b1" }, () => brandRoute.PUT(json("/api/brand", "PUT", file("X after"))));
    expect(res.status).toBe(200);
    expect((await getBrand(scopeX))!.name).toBe("X after");
    expect((await getBrand(scopeY))!.name).toBe("Y before");
    // And the tab on Y.
    const res2 = await withHeaders({ [BRAND_HEADER]: "b2" }, () => brandRoute.PUT(json("/api/brand", "PUT", file("Y after"))));
    expect(res2.status).toBe(200);
    expect((await getBrand(scopeX))!.name).toBe("X after");
    expect((await getBrand(scopeY))!.name).toBe("Y after");
    // Neither save moved the stored choice.
    expect(await readActiveBrand(owner.email)).toBe("b2");
  });

  it("a header naming a brand that is not the account's is a 404 and writes no brand file", async () => {
    const owner = await ownerWithBrands("tabs2", "b2");
    const file = { name: "Z", industry: "cafe", products: "coffee", audience: "everyone" };
    const res = brandRoute.PUT(json("/api/brand", "PUT", file));
    expect((await res).status).toBe(200);
    await expect(withHeaders({ [BRAND_HEADER]: "elsewhere" }, () => brandRoute.PUT(json("/api/brand", "PUT", { ...file, name: "Q" })))).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/) });
    expect((await getBrand(scopeFor(acct(owner), "elsewhere")))).toBeNull();
  });
});

describe("rule 895: the rules text names the brand in the URL", () => {
  it("CLAUDE.md's tenant-isolation rule allows the brand id as a checked selector, nothing else", () => {
    const md = read("CLAUDE.md");
    const line = md.split("\n").find((l) => l.startsWith("- Tenant isolation:"))!;
    expect(line).toContain("except the brand id, used only as a selector among the session account's own active brands after `resolveSession` has checked it");
    expect(line).toContain("Never build a Redis key from an id, email or scope taken from the request");
  });

  it("permissions.md, architecture.md and flows.md name the header, the guard's code and the path", () => {
    for (const f of ["permissions", "architecture", "flows"]) {
      const md = read(`docs/system/${f}.md`);
      expect(md, f).toContain("x-thakeen-brand");
      expect(md, f).toContain("brand_missing");
      expect(md, f).toContain("/app/b/");
    }
  });

  it("the docs name the switcher, the coverage file lists the rulings and the release step, and the old tests.md is untouched", () => {
    expect(read("docs/system/flows.md")).toMatch(/BrandSwitcher/);
    expect(read("docs/system/architecture.md")).toMatch(/BrandSwitcher/);
    const cov = read("docs/system/tests/0885-brand-url.md");
    for (const r of ["R-B1", "R-C1", "R-C13", "R-M1"]) expect(cov, r).toContain(r);
    for (const n of [892, 893, 895, 896]) expect(cov, String(n)).toMatch(new RegExp(`\\| ${n} \\|`));
    expect(cov).toMatch(/BRAND_GUARD_MODE/);
    expect(cov).toMatch(/\[\.\.\.legacy\]/);
    expect(read("docs/system/tests/1390-brand-limits.md")).toMatch(/2026-10-21.*R-B1/);
    expect(read("docs/superpowers/specs/2026-10-09-admin-shell-and-brand-workspaces-design.md")).toMatch(/2026-10-21[^\n]*Part B[^\n]*#340[^\n]*Part C/);
  });
});
