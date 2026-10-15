// One global nav, the language redirects, the global 404 and the homepage's search data (site critique 2026-10-14,
// docs/system/tests/1854-global-nav.md, rules 1854-1859 and 1873-1876). Static renders and source-reading checks.
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { dict, LANGS } from "@/lib/i18n";
import { HOME_FAQ, HOME_NAV } from "@/lib/home";
import { homeJsonLd, ldJson } from "@/lib/home-ld";
import { PLAN_PRICE_SAR, SELF_SERVE_PLANS } from "@/lib/pricing";
import Nav, { navItems } from "@/components/Nav";
import NavDrop from "@/components/NavDrop";
import LangToggle from "@/components/LangToggle";
import Footer from "@/components/Footer";
import SectionChips from "@/components/home/SectionChips";
import sitemap from "@/app/sitemap";
import { PUBLIC_SEGMENTS, ROOT_SEGMENTS, STRAY_TARGET, pickLang, proxy, strayPath, unprefixedPublic } from "@/proxy";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  usePathname: () => "/ar",
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
}));

const read = (f: string) => readFileSync(f, "utf8");
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
/** The `href`s of every `<a>` inside the first element that matches `open` up to its closing tag `close`. */
const hrefsIn = (html: string, open: RegExp, close: string) => {
  const at = html.search(open);
  const part = html.slice(at, html.indexOf(close, at));
  return [...part.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
};

describe("rule 1854: one site menu on every public page, at most five items", () => {
  for (const lang of LANGS) {
    it(`the desktop menu is team, how it works, pricing, help (${lang}), and the call to action is the dictionary's`, () => {
      const t = dict[lang];
      const html = renderToStaticMarkup(h(Nav, { t, lang }));
      const nav = hrefsIn(html, /<nav [^>]*aria-label=/, "</nav>");
      // The team tab's own link, then its dropdown (the agents and the whole team), then the three other links.
      expect(nav[0]).toBe(`/${lang}/agents`);
      expect([...new Set(nav.filter((u) => !u.startsWith(`/${lang}/agents/`)))]).toEqual([`/${lang}/agents`, `/${lang}#steps`, `/${lang}/pricing`, `/${lang}/help`]);
      expect(navItems(t, lang).map((i) => i.label)).toEqual([lang === "ar" ? "الفريق" : "Team", t.nav.how, lang === "ar" ? "الأسعار" : "Pricing", lang === "ar" ? "المساعدة" : "Help"]);
      expect(html).toContain(`href="/${lang}/app/signup"`);
      expect(html).toContain(`>${t.nav.cta}</a>`);
      expect(t.nav.cta).toBe(lang === "ar" ? "ابدأ مجاناً" : "Start free");
      // No in-page anchors and none of the menus that moved to the footer.
      expect(html).not.toMatch(/href="#(?!main)/);
      for (const gone of ["customers", "enterprise", "resources", "for/"]) expect(nav.some((u) => u.startsWith(`/${lang}/${gone}`)), gone).toBe(false);
    });
    it(`the footer still links everything the menu dropped (${lang})`, () => {
      const html = renderToStaticMarkup(h(Footer, { t: dict[lang], lang }));
      for (const p of ["customers", "enterprise", "help", "pricing", "compare", "for/", "agents/noor"]) expect(html, p).toContain(`href="/${lang}/${p}`);
    });
  }
  it("every public page renders the same Nav with no per-page sections", () => {
    expect(code("src/components/Nav.tsx")).not.toMatch(/sections/);
    const pages = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? pages(p) : p.endsWith("page.tsx") ? [p] : []; });
    for (const p of pages("src/app/[lang]").filter((p) => read(p).includes("<Nav "))) expect(read(p), p).not.toMatch(/<Nav [^>]*sections=/);
  });
  it("the homepage's anchors are chips under the cover: a list of 44px pills, not a second nav", () => {
    for (const lang of LANGS) {
      const html = renderToStaticMarkup(h(SectionChips, { lang }));
      expect(html).not.toContain("<nav");
      expect(html).toMatch(/^<ul [^>]*role="list"[^>]*aria-label="[^"]+"/);
      expect([...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1])).toEqual(HOME_NAV.map((n) => n.href));
      for (const n of HOME_NAV) expect(html).toContain(n.label[lang]);
    }
    const css = read("src/components/home/SectionChips.module.css");
    expect(css).toMatch(/\.chip \{[^}]*min-height: var\(--hit-min\)/);
    expect(css).toMatch(/\.chips \{[^}]*overflow-x: auto/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).not.toMatch(/\b(?:margin|padding)-(?:left|right)\b|\b(?:left|right):/);
  });
});

describe("rule 1855: the dropdown closes on Escape and gives focus back; its tab announces no popup", () => {
  it("no aria-haspopup on the tab, in the source or the markup", () => {
    for (const f of ["src/components/Nav.tsx", "src/components/NavDrop.tsx"]) expect(code(f), f).not.toContain("aria-haspopup");
    const html = renderToStaticMarkup(h(NavDrop, { label: "Team", href: "/en/agents", items: [{ href: "/en/agents/noor", label: "Noor" }], rtl: false }));
    expect(html).not.toContain("aria-haspopup");
    expect(html).toMatch(/<a [^>]*href="\/en\/agents"/);
  });
  it("Escape shuts the panel and focuses the tab; leaving the menu opens it to hover and focus again", () => {
    const src = code("src/components/NavDrop.tsx");
    expect(src).toMatch(/e\.key !== "Escape"/);
    expect(src).toMatch(/setShut\(true\);\s*if \(focusIn\) tab\.current\?\.focus\(\);/);
    expect(src).toMatch(/onMouseLeave=\{\(\) => setShut\(false\)\}/);
    expect(src).toMatch(/const open = shut \? "" : "group-focus-within:visible/);
  });
});

describe("rule 1856: the mobile menu button and its rows are 44px targets", () => {
  it("the <summary> and each row reach --hit-min", () => {
    const html = renderToStaticMarkup(h(Nav, { t: dict.ar, lang: "ar" }));
    expect(html).toMatch(/<summary class="[^"]*min-h-\[var\(--hit-min\)\][^"]*min-w-\[var\(--hit-min\)\]/);
    const menu = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    for (const a of menu.match(/<a [^>]*class="[^"]*"/g)!.filter((a) => !a.includes("hrefLang"))) expect(a).toContain("min-h-[var(--hit-min)]");
  });
});

describe("rule 1857: the language toggle is two 44px targets and no text under 12px", () => {
  it("both sizes", () => {
    for (const size of ["sm", "md"] as const) {
      const html = renderToStaticMarkup(h(LangToggle, { lang: "ar", size }));
      const segs = html.match(/<a [^>]*>/g)!;
      expect(segs).toHaveLength(2);
      for (const s of segs) expect(s).toMatch(/min-h-\[var\(--hit-min\)\] min-w-\[var\(--hit-min\)\]/);
      expect(html).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
    }
    expect(read("src/components/LangToggle.tsx")).not.toMatch(/text-\[11px\]/);
  });
});

describe("rule 1858: a skip link to #main comes first, and the homepage's <main> is #main", () => {
  it("the skip link is the first thing Nav renders, visible on focus", () => {
    const html = renderToStaticMarkup(h(Nav, { t: dict.en, lang: "en" }));
    expect(html).toMatch(/^<a href="#main" class="skip-link">Skip to content<\/a><header/);
    expect(read("src/app/globals.css")).toMatch(/\.skip-link:focus \{ top: 1rem; \}/);
  });
  it("the homepage's main carries the id", () => {
    expect(read("src/app/[lang]/page.tsx")).toMatch(/<main id="main" tabIndex=\{-1\} className=\{styles\.home\}>/);
  });
});

describe("rule 1859: the homepage's canonical and structured data", () => {
  it("each home page names itself as canonical, both languages and Arabic as the default", async () => {
    const { generateMetadata } = await import("@/app/[lang]/page");
    for (const lang of LANGS) {
      const m = await generateMetadata({ params: Promise.resolve({ lang }) });
      expect(m.alternates).toEqual({ canonical: `/${lang}`, languages: { ar: "/ar", en: "/en", "x-default": "/ar" } });
      expect(m).not.toHaveProperty("openGraph");
    }
  });
  it("Organization, SoftwareApplication with the real plan prices in SAR, FAQPage from the home questions; no ratings", () => {
    for (const lang of LANGS) {
      const ld = homeJsonLd(lang, "https://thakeen.example");
      expect(ld.map((x) => x["@type"])).toEqual(["Organization", "SoftwareApplication", "FAQPage"]);
      const app = ld[1] as { offers: { name: string; price: string; priceCurrency: string }[]; name: string };
      expect(app.name).toBe(dict[lang].brand);
      expect(app.offers.map((o) => [o.price, o.priceCurrency])).toEqual(SELF_SERVE_PLANS.map((id) => [String(PLAN_PRICE_SAR[id]), "SAR"]));
      expect(app.offers.map((o) => o.name)).toEqual(SELF_SERVE_PLANS.map((id) => dict[lang].pricing.plans.find((p) => p.id === id)!.name));
      const faq = ld[2] as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
      expect(faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(HOME_FAQ.map((f) => [f.q[lang], f.a[lang]]));
      expect(JSON.stringify(ld)).not.toMatch(/aggregateRating|"review|ratingValue|reviewCount/);
    }
    expect(read("src/app/[lang]/page.tsx")).toMatch(/type="application\/ld\+json" dangerouslySetInnerHTML=\{\{ __html: ldJson\(ld\) \}\}/);
  });
  it("the script body cannot close its own element", () => {
    expect(ldJson({ a: "</script><b>" })).toBe('{"a":"\\u003c/script>\\u003cb>"}');
  });
});

describe("rule 1873: pickLang", () => {
  const r = (al?: string, cookie?: string) => new NextRequest("https://x.example/", { headers: { ...(al ? { "accept-language": al } : {}), ...(cookie ? { cookie } : {}) } });
  it("Arabic by default, English for an English browser", () => {
    expect(pickLang(r())).toBe("ar");
    expect(pickLang(r("en-US,en;q=0.9"))).toBe("en");
    expect(pickLang(r("en-GB"))).toBe("en");
    expect(pickLang(r("en"))).toBe("en");
    expect(pickLang(r("ar-SA,en;q=0.8"))).toBe("ar");
    expect(pickLang(r("fr-FR,en;q=0.5"))).toBe("ar");
  });
  it("Gulf English locales pick Arabic, with or without a weight", () => {
    for (const l of ["en-SA", "en-AE", "en-KW", "en-QA", "en-BH", "en-OM", "en-sa;q=1.0", "EN-AE,en;q=0.9"]) expect(pickLang(r(l)), l).toBe("ar");
  });
  it("a cookie choice still wins, the new name and the old", () => {
    expect(pickLang(r("en-SA", "thakeen_lang=en"))).toBe("en");
    expect(pickLang(r("en-US", "thakeen_lang=ar"))).toBe("ar");
    expect(pickLang(r("en-AE", "nashr_lang=en"))).toBe("en");
  });
});

describe("rule 1874: an unprefixed public address is sent to its language", () => {
  it("the list is exactly the public folders under src/app/[lang]", () => {
    const dirs = readdirSync("src/app/[lang]").filter((f) => statSync(join("src/app/[lang]", f)).isDirectory() && !f.startsWith("["));
    const notPublic = ["admin", "app", "staging-access"];
    expect([...PUBLIC_SEGMENTS].sort()).toEqual(dirs.filter((d) => !notPublic.includes(d)).sort());
  });
  it("redirects 307 to the picked language, keeping the path and the query", () => {
    const go = (path: string, headers?: Record<string, string>) => proxy(new NextRequest(`https://thakeen.example${path}`, headers ? { headers } : undefined));
    const a = go("/pricing?plan=pro&utm_source=x");
    expect(a.status).toBe(307);
    expect(a.headers.get("location")).toBe("https://thakeen.example/ar/pricing?plan=pro&utm_source=x");
    expect(a.headers.get("vary")).toBe("Cookie, Accept-Language");
    expect(go("/for/clinics", { "accept-language": "en-US" }).headers.get("location")).toBe("https://thakeen.example/en/for/clinics");
    expect(go("/agents/noor", { "accept-language": "en-SA" }).headers.get("location")).toBe("https://thakeen.example/ar/agents/noor");
    expect(go("/blog", { cookie: "thakeen_lang=en" }).headers.get("location")).toBe("https://thakeen.example/en/blog");
    for (const s of PUBLIC_SEGMENTS) expect(unprefixedPublic(`/${s}`), s).toBe(true);
  });
  it("never touches reserved root paths, prefixed pages or look-alikes", () => {
    for (const p of ["/api/health", "/m/abc", "/p/xyz", "/oauth/authorize", "/llms.txt", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest", "/icons/icon-192.png", "/_next/data/x.json", "/.well-known/oauth-authorization-server", "/ar/pricing", "/en/help", "/pricingx", "/helpme", "/xyz"]) {
      expect(unprefixedPublic(p), p).toBe(false);
    }
    const res = proxy(new NextRequest("https://thakeen.example/ar/pricing"));
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("rule 1875: a branded bilingual 404 outside the language tree", () => {
  const src = read("src/app/global-not-found.tsx");
  it("is switched on and renders a whole Arabic right-to-left document with the global styles", () => {
    expect(read("next.config.ts")).toMatch(/experimental: \{[^}]*globalNotFound: true/);
    expect(src).toMatch(/^import "\.\/globals\.css";$/m);
    expect(src).toMatch(/<html lang="ar" dir="rtl"/);
    expect(src).toMatch(/<body>/);
    expect(src).toContain("export const metadata");
  });
  it("Arabic first, English beside it in its own block, a link home in each language", () => {
    expect(src.indexOf("الصفحة غير موجودة")).toBeLessThan(src.indexOf("Page not found"));
    expect(src).toMatch(/lang="en" dir="ltr"/);
    expect(src).toMatch(/href="\/ar"/);
    expect(src).toMatch(/href="\/en"/);
    expect(code("src/app/global-not-found.tsx")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("rule 1891: an address outside the language tree gets the branded 404", () => {
  const go = (path: string, headers?: Record<string, string>) => proxy(new NextRequest(`https://thakeen.example${path}`, headers ? { headers } : undefined));
  it("knows every folder beside [lang] and under public, and serves strays from a segment no folder claims", () => {
    // A folder with a dot (`.well-known`, `llms.txt`) is left alone by the dot rule, so the list holds only the others.
    const folders = (d: string) => readdirSync(d).filter((f) => statSync(join(d, f)).isDirectory() && !f.startsWith("[") && !f.includes("."));
    expect([...ROOT_SEGMENTS].sort()).toEqual([...folders("src/app"), ...folders("public")].sort());
    expect(folders("src/app/[lang]")).not.toContain(STRAY_TARGET);
  });
  it("marks unknown first segments as stray and leaves languages, root routes and files alone", () => {
    for (const p of ["/xyz", "/xyz/abc", "/ar-sa/pricing", "/admin", "/xyz/app", "/AR", "/login"]) expect(strayPath(p), p).toBe(true);
    for (const p of ["/", "/ar", "/en/help", "/ar/xyz", "/api", "/api/health", "/m/abc", "/p/x", "/oauth/authorize", "/robots.txt", "/sitemap.xml", "/llms.txt", "/favicon.ico", "/manifest.webmanifest", "/apple-icon.png", "/icons/icon-192.png", "/_next/data/x.json", "/.well-known/oauth-authorization-server"]) {
      expect(strayPath(p), p).toBe(false);
    }
  });
  it("rewrites a stray to the picked language's catch-all, without a redirect and without the query", () => {
    const a = go("/xyz?q=1");
    expect(a.headers.get("location")).toBeNull();
    expect(a.headers.get("x-middleware-rewrite")).toBe(`https://thakeen.example/ar/${STRAY_TARGET}`);
    expect(a.headers.get("vary")).toBe("Cookie, Accept-Language");
    expect(go("/xyz", { "accept-language": "en-US" }).headers.get("x-middleware-rewrite")).toBe(`https://thakeen.example/en/${STRAY_TARGET}`);
    // The public redirects and the root still win.
    expect(go("/pricing").status).toBe(307);
    expect(go("/").status).toBe(307);
    expect(go("/ar/xyz").headers.get("x-middleware-rewrite")).toBeNull();
  });
});

describe("rule 1876: hreflang alternates in the sitemap", () => {
  it("every URL names its Arabic and English twins and Arabic as x-default", () => {
    const entries = sitemap();
    const urls = new Set(entries.map((e) => e.url));
    for (const e of entries) {
      const langs = e.alternates?.languages as Record<string, string>;
      expect(Object.keys(langs).sort(), e.url).toEqual(["ar", "en", "x-default"]);
      expect(langs["x-default"]).toBe(langs.ar);
      expect([langs.ar, langs.en]).toContain(e.url);
      for (const u of [langs.ar, langs.en]) expect(urls.has(u), u).toBe(true);
    }
  });
});
