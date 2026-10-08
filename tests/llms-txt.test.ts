import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { tryToParsePath } from "next/dist/lib/try-to-parse-path";
import { GET, dynamic } from "@/app/llms.txt/route";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import { config } from "@/proxy";
import { appOrigin } from "@/lib/origin";
import { dict } from "@/lib/i18n";
import { AGENTS } from "@/lib/agents";
import { AGENT_PAGES, SITE } from "@/lib/site";
import { TOOLS } from "@/lib/tools";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { VS_PAGES } from "@/lib/pages-vs";
import { listPosts } from "@/lib/blog";
import { LEGAL } from "@/lib/legal";
import { PARTNER_TERMS } from "@/lib/partner-terms";
import { SITE_DEFAULT } from "@/lib/page-meta";

/**
 * Rule 698 (docs/superpowers/specs/2026-10-08-supastarter-adoption-design.md, item 5). `/llms.txt` is an index of the
 * public site for language models: built once at build time, from copy the site already shows, linking only the pages
 * the sitemap lists, on the sitemap's origin, and never the app, the API, the founder console, OAuth or the partner
 * dashboard. Arabic comes first.
 *
 * The checks read the whole body, not only its list items, so a link in a heading, in the summary or on a bare line is
 * held to the same rules, and the copy check reads the words the body carries rather than how the route's source quotes
 * them.
 */

const SRC = readFileSync("src/app/llms.txt/route.ts", "utf8");
/** `- [name](url)` or `- [name](url): note`; a bracket inside the name must be escaped. */
const LINK = /^- \[((?:[^[\]\\]|\\.)+)\]\((\S+)\)(?:: (\S.*))?$/;

/** On one line, as the route's own `line` writes dictionary strings. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Every string the site's copy modules hold. The list is fixed here, not taken from the route's imports, so a route that
 * starts importing words from somewhere else fails the copy check instead of widening it.
 */
const COPY = (() => {
  const out = new Set<string>(), seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.add(oneLine(v));
    else if (v && typeof v === "object" && !seen.has(v)) {
      seen.add(v);
      Object.values(v).forEach(walk);
    }
  };
  walk([dict, SITE, SITE_DEFAULT, AGENTS, AGENT_PAGES, INDUSTRY_PAGES, VS_PAGES, TOOLS, LEGAL, PARTNER_TERMS, listPosts("ar"), listPosts("en")]);
  out.delete("");
  return out;
})();

/** Site copy whole, or two pieces of it joined the only two ways the route joins them: « · » and a space. */
function fromCopy(s: string) {
  if (COPY.has(s)) return true;
  for (const sep of [" · ", " "]) {
    for (let i = s.indexOf(sep); i > 0; i = s.indexOf(sep, i + 1)) {
      if (COPY.has(s.slice(0, i)) && COPY.has(s.slice(i + sep.length))) return true;
    }
  }
  return false;
}

/**
 * Every literal the route's code spells out, read with the TypeScript parser so the quoting style does not matter:
 * single, double and backtick strings, each piece of a template, regular expressions and numbers. Imports are skipped.
 */
function literals(src: string) {
  const file = ts.createSourceFile("route.ts", src, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    else if (ts.isRegularExpressionLiteral(n) || ts.isNumericLiteral(n) || ts.isBigIntLiteral(n)) out.push(n.getText(file));
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
}

/**
 * The only literals the route may write: its caching mode, its one header, the llms.txt markup and separators, and the
 * two regular expressions of `line` and `linkText`. None holds a word of copy, and the only digit is the 8 of utf-8, so a
 * number written into the route fails as surely as a phrase. Any new literal fails the test until it is added here on
 * purpose.
 */
const STRUCTURE = new Set(["force-static", "Content-Type", "text/plain; charset=utf-8", "", " ", "\n", "# ", " · ", "> ", ">", "## ", "- [", "](", ")", ": ", "\\$&", "/\\s+/g", "/[[\\]\\\\]/g"]);
/** A site path: lowercase letters, slashes and hyphens only, so no word of copy and no number fits. */
const PATH = /^\/[a-z/-]*$/;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function read(get: () => Response = GET) {
  const res = get();
  const text = await res.text();
  const lines = text.split("\n");
  const items = lines.filter((l) => l.startsWith("- "));
  const urls = items.map((l) => l.match(LINK)?.[2] ?? "");
  // Every absolute URL anywhere in the body, so the origin, sitemap and private-path checks see links outside the list.
  const anyUrls = text.match(/[a-z][a-z\d+.-]*:\/\/[^\s<>()[\]]+/gi) ?? [];
  return { res, text, lines, items, urls, anyUrls };
}

describe("rule 698: /llms.txt is a static plain-text index of the sitemap's public pages, built only from existing site copy, Arabic first, linking nothing private", () => {
  it("GET answers 200 text/plain in UTF-8, and the body opens with an H1 and the Arabic summary before the English one", async () => {
    const { res, text } = await read();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text.startsWith("# ")).toBe(true);
    const quote = text.split("\n").filter((l) => l.startsWith(">"));
    expect(quote[0]).toBe(`> ${SITE_DEFAULT.ar.description}`);
    expect(quote).toContain(`> ${SITE_DEFAULT.en.description}`);
    expect(quote.indexOf(`> ${SITE_DEFAULT.en.description}`)).toBeGreaterThan(0);
  });

  it("the body is one H1, the summary blockquote, then `## ` sections of well-formed link items, and no other kind of line", async () => {
    const { text, lines, items } = await read();
    expect(text.endsWith("\n")).toBe(true);
    const body = lines.slice(0, -1);
    expect(body[0]).toMatch(/^# \S/);
    const rest = body.slice(1);
    expect(rest.filter((l) => !(l === "" || l === ">" || /^> \S/.test(l) || /^## \S/.test(l) || LINK.test(l)))).toEqual([]);
    const firstHead = rest.findIndex((l) => l.startsWith("## "));
    expect(firstHead).toBeGreaterThan(0);
    expect(rest.slice(0, firstHead).some((l) => l.startsWith("> "))).toBe(true);
    expect(rest.slice(0, firstHead).some((l) => l.startsWith("- "))).toBe(false);
    expect(rest.slice(firstHead).some((l) => l.startsWith(">"))).toBe(false);
    expect(items.length).toBeGreaterThan(50);
  });

  it("every link anywhere in the body is a list item's, absolute on the sitemap's origin, and names a path the sitemap lists", async () => {
    const { text, items, urls, anyUrls } = await read();
    // No markdown link, relative or absolute, outside the list items, and no bare URL either.
    expect(text.split("](").length - 1).toBe(items.length);
    expect([...anyUrls].sort()).toEqual([...urls].sort());
    const map = sitemap();
    const origin = new URL(map[0].url).origin;
    expect(origin).toBe(appOrigin());
    const listed = new Set(map.map((e) => new URL(e.url).pathname));
    for (const u of anyUrls) {
      expect(u.startsWith(`${origin}/`), u).toBe(true);
      const url = new URL(u);
      expect(url.origin, u).toBe(origin);
      expect(url.search + url.hash, u).toBe("");
      expect(listed.has(url.pathname), `${u} is not in the sitemap`).toBe(true);
    }
  });

  it("lists every sitemap page exactly once, Arabic pages before English ones", async () => {
    const { urls } = await read();
    expect(new Set(urls).size).toBe(urls.length);
    expect([...urls].sort()).toEqual(sitemap().map((e) => e.url).sort());
    const firstEn = urls.findIndex((u) => new URL(u).pathname.startsWith("/en"));
    expect(firstEn).toBeGreaterThan(0);
    expect(urls.slice(0, firstEn).every((u) => new URL(u).pathname.startsWith("/ar"))).toBe(true);
    expect(urls.slice(firstEn).every((u) => new URL(u).pathname.startsWith("/en"))).toBe(true);
  });

  it("no link anywhere in the body reaches the app, the API, the founder console, OAuth or the partner dashboard", async () => {
    const { anyUrls } = await read();
    expect(anyUrls.length).toBeGreaterThan(50);
    for (const u of anyUrls) {
      expect(new URL(u).pathname, u).not.toMatch(/\/(?:app|api|admin|oauth|partner|p)(?:\/|$)/);
      expect(u, u).not.toMatch(/\/app\/|\/api\/|\/admin/);
    }
  });

  it("the sections are the footer's columns in each language, Arabic first", async () => {
    const { text } = await read();
    const heads = text.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
    expect(heads[0]).toBe(SITE.ar.footer.company);
    for (const f of [SITE.ar.footer, SITE.en.footer]) for (const h of [f.company, f.agents, f.industries, f.resources]) expect(heads).toContain(h);
    expect(heads.indexOf(SITE.ar.footer.agents)).toBeLessThan(heads.indexOf(SITE.en.footer.company));
  });

  it("every title, summary, heading, link name and note in the body is existing site copy, whole or two pieces joined", async () => {
    const { lines } = await read();
    const fields: string[] = [];
    for (const l of lines) {
      const link = l.match(LINK);
      if (link) fields.push(link[1].replace(/\\(.)/g, "$1"), ...(link[3] ? [link[3]] : []));
      else if (/^(?:#|##|>) /.test(l)) fields.push(l.slice(l.indexOf(" ") + 1));
    }
    expect(fields.length).toBeGreaterThan(100);
    expect(fields.filter((f) => !fromCopy(f))).toEqual([]);
    // The check can fail: real copy with one word or one number added to it is not copy.
    expect(fromCopy(SITE_DEFAULT.en.description)).toBe(true);
    expect(fromCopy(`${SITE_DEFAULT.en.description} 10x`)).toBe(false);
    expect(fromCopy(`${SITE.en.footer.company} index`)).toBe(false);
  });

  it("the route's own code spells out no copy: every literal in it, however quoted, is markup, its header or a path", () => {
    const lits = literals(SRC);
    expect(lits.length).toBeGreaterThan(20);
    expect(lits.filter((s) => !STRUCTURE.has(s) && !PATH.test(s))).toEqual([]);
    // The parser sees what a quote-matching regular expression would miss.
    expect(literals(`const a = 'one two'; const b = 500; const c = \`x\${a}y\`;`)).toEqual(["one two", "500", "x", "y"]);
  });

  it("is prerendered once (force-static) and reads nothing from the request, the session or Redis, so no rate limiter applies", () => {
    expect(dynamic).toBe("force-static");
    expect(GET.length).toBe(0);
    expect(SRC).not.toMatch(/\b(?:headers|cookies|currentUser|allow)\(|\bdb\.|@\/lib\/db|next\/headers/);
    expect(SRC).toMatch(/no rate limit from src\/lib\/rate\.ts/);
  });

  it("follows APP_ORIGIN exactly like the sitemap", async () => {
    vi.stubEnv("APP_ORIGIN", "https://example.test");
    vi.resetModules();
    const route = await import("@/app/llms.txt/route");
    const map = (await import("@/app/sitemap")).default();
    const { urls, anyUrls } = await read(route.GET);
    expect(urls.length).toBeGreaterThan(0);
    expect(anyUrls.every((u) => u.startsWith("https://example.test/"))).toBe(true);
    expect([...urls].sort()).toEqual(map.map((e) => e.url).sort());
  });

  it("robots does not disallow it and the proxy's matcher does not intercept it", () => {
    const rules = robots().rules;
    const disallow = (Array.isArray(rules) ? rules : [rules]).flatMap((r) => r.disallow ?? []);
    expect(disallow.length).toBeGreaterThan(0);
    for (const d of disallow) expect("/llms.txt".startsWith(d), d).toBe(false);
    const matchers = (Array.isArray(config.matcher) ? config.matcher : [config.matcher]) as string[];
    expect(matchers.length).toBeGreaterThan(0);
    for (const m of matchers) {
      const re = tryToParsePath(m).regexStr;
      expect(re, m).toBeDefined();
      expect(new RegExp(re!).test("/llms.txt"), m).toBe(false);
    }
    // The check itself still sees the paths the proxy is for.
    expect(matchers.some((m) => new RegExp(tryToParsePath(m).regexStr!).test("/ar/app/chat"))).toBe(true);
  });
});
