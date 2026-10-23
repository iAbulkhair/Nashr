import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createRequire } from "node:module";
import nextConfig from "../next.config";
import sitemap from "@/app/sitemap";
import { pagePath } from "@/lib/csp";
import { LANGS } from "@/lib/i18n";
import { HELP, helpTopics } from "@/lib/help";
import { listPosts, postEntry, postIn, slugs } from "@/lib/blog";
import { absoluteLinks, markdownHeaders, markdownUrl, pageUrl, postMarkdown, topicMarkdown } from "@/lib/page-markdown";
import { proxy } from "@/proxy";

/** Next's own matcher for a `source` in rewrites(), so the pattern is tried the way Next tries it. */
const { match } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as { match: (source: string) => (path: string) => false | { params: Record<string, string> } };

/**
 * Rule 3316: every blog post and help topic has a Markdown copy at `/{lang}/blog/{slug}.md` and `/{lang}/help/{topic}.md`:
 * static, `text/markdown`, public pages only, the fields the page shows and nothing else from the front matter, out of search
 * results. The idea is supastarter's (a `.mdx` twin of every docs page); the code is ours.
 */
afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/blog");
  vi.unstubAllEnvs();
});

const O = "https://o.test";
const post = (extra: Record<string, unknown> = {}) => ({
  slug: "hello", title: "Title", desc: "A description", date: "2026-01-02", body: "First paragraph.\n\nSecond.", tags: ["seo"],
  langs: ["ar", "en"] as ("ar" | "en")[], cover: null, author: null, ...extra,
});

describe("rule 3316: links in the body", () => {
  it("makes a site-relative link absolute, with the language of the text", () => {
    expect(absoluteLinks("See [pricing](/pricing) and [help](/help/start#how-to-start).", "en", O)).toBe(`See [pricing](${O}/en/pricing) and [help](${O}/en/help/start#how-to-start).`);
    expect(absoluteLinks("[تسعير](/pricing)", "ar", O)).toBe(`[تسعير](${O}/ar/pricing)`);
  });
  it("replaces a language written for the other text, as the page does, and keeps a title", () => {
    expect(absoluteLinks('[a](/en/pricing "Plans")', "ar", O)).toBe(`[a](${O}/ar/pricing "Plans")`);
  });
  it("makes an image of this site absolute and leaves a path no page claims as it is", () => {
    expect(absoluteLinks("![x](/blog/cover.png)", "en", O)).toBe(`![x](${O}/en/blog/cover.png)`);
    expect(absoluteLinks("[f](/p/abc)", "en", O)).toBe(`[f](${O}/p/abc)`);
  });
  it("does not touch another site, a protocol-relative address, an anchor or a relative one", () => {
    for (const s of ["[a](https://example.com/x)", "[a](//example.com/x)", "[a](#top)", "[a](x/y)", "[a](mailto:a@b.c)"]) expect(absoluteLinks(s, "en", O), s).toBe(s);
  });
  it("leaves a fenced block as written, and goes on after it closes", () => {
    const src = "[a](/pricing)\n```md\n[b](/pricing)\n```\n[c](/pricing)\n~~~\n[d](/pricing)\n~~~\n";
    const out = absoluteLinks(src, "en", O).split("\n");
    expect(out[0]).toBe(`[a](${O}/en/pricing)`);
    expect(out[2]).toBe("[b](/pricing)");
    expect(out[4]).toBe(`[c](${O}/en/pricing)`);
    expect(out[6]).toBe("[d](/pricing)");
  });
  it("is not closed by a shorter or different fence mark", () => {
    const out = absoluteLinks("````\n```\n[b](/pricing)\n````\n[c](/pricing)", "en", O).split("\n");
    expect(out[2]).toBe("[b](/pricing)");
    expect(out[4]).toBe(`[c](${O}/en/pricing)`);
  });
});

describe("rule 3316: what a post's copy holds", () => {
  it("has the title, description, date, page address and body, and no YAML front matter", () => {
    const md = postMarkdown(O, "en", post());
    expect(md.startsWith("# Title\n\n> A description\n\n")).toBe(true);
    expect(md).toContain("Date: 2026-01-02");
    expect(md).toContain(`Page: ${O}/en/blog/hello`);
    expect(md).toContain("First paragraph.\n\nSecond.");
    expect(md).not.toMatch(/^---$/m);
    expect(md.endsWith("\n")).toBe(true);
  });
  it("is written in the language it is given, labels included", () => {
    const md = postMarkdown(O, "ar", post({ title: "عنوان", desc: "وصف" }));
    expect(md).toContain("التاريخ: 2026-01-02");
    expect(md).toContain(`الصفحة: ${O}/ar/blog/hello`);
  });
  it("names the author only when the post has one, by name and role, never by id", () => {
    expect(postMarkdown(O, "en", post())).not.toMatch(/Author/);
    const md = postMarkdown(O, "en", post({ author: { id: "secret-id", name: "Full Name", role: "Founder", link: "https://example.com/me" } }));
    expect(md).toContain("Author: Full Name, Founder");
    expect(md).not.toContain("secret-id");
  });
  it("prints no other front-matter field: not the cover, the languages, the tags or the author id", () => {
    const raw = "---\ntitle_ar: ع\ndesc_ar: و\ntitle_en: T\ndesc_en: D\ndate: 2026-01-02\ncover: /blog/x.png\ncover_alt_en: Alt text\ntags_en: topsecret\nauthor: abulkhair-hejazy\n---\nمتن\n---EN---\nbody text\n";
    const p = postIn(postEntry("p.md", raw), "en", { "abulkhair-hejazy": { name: { ar: "ا", en: "Founder Name" }, role: { ar: "م", en: "Founder" } } });
    const md = postMarkdown(O, "en", p);
    expect(md).toContain("body text");
    for (const leak of ["cover", "Alt text", "topsecret", "abulkhair-hejazy", "languages", "tags"]) expect(md, leak).not.toContain(leak);
  });
  it("keeps a title or description with a line break on one line", () => {
    const md = postMarkdown(O, "en", post({ title: "A\nB", desc: "C\n\nD" }));
    expect(md.split("\n").slice(0, 3)).toEqual(["# A B", "", "> C D"]);
  });
  it("keeps markup in the body as text: nothing here is HTML and nothing runs", () => {
    const md = postMarkdown(O, "en", post({ body: "<script>alert(1)</script>\n\n[x](javascript:alert(1))" }));
    expect(md).toContain("<script>alert(1)</script>");
    expect(markdownHeaders("en", O)["X-Content-Type-Options"]).toBe("nosniff");
    expect(markdownHeaders("en", O)["Content-Type"]).toBe("text/markdown; charset=utf-8");
  });
});

describe("rule 3316: what a help topic's copy holds", () => {
  it("is the title, then each question as a heading with its answer, with the origin filled in", () => {
    const t = helpTopics(O).find((x) => x.items.some((i) => i.a.en.includes(O)))!;
    expect(t, "a topic that names the origin").toBeTruthy();
    const md = topicMarkdown(O, "en", t);
    expect(md.startsWith(`# ${t.title.en}\n`)).toBe(true);
    expect(md).toContain(`Page: ${O}/en/help/${t.id}`);
    for (const i of t.items) {
      expect(md).toContain(`## ${i.q.en}\n\n${i.a.en.trim()}`);
    }
    expect(md).not.toContain("{origin}");
    expect((md.match(/^## /gm) ?? []).length).toBe(t.items.length);
  });
  it("is written in Arabic with Arabic labels", () => {
    const t = helpTopics(O)[0];
    const md = topicMarkdown(O, "ar", t);
    expect(md).toContain(`# ${t.title.ar}`);
    expect(md).toContain(`الصفحة: ${O}/ar/help/${t.id}`);
  });
});

describe("rule 3316: headers and addresses", () => {
  it("sends the type, nosniff, noindex, the language and the page as canonical", () => {
    const h = markdownHeaders("ar", `${O}/ar/blog/x`);
    expect(h).toEqual({
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      "Content-Language": "ar",
      Link: `<${O}/ar/blog/x>; rel="canonical"`,
    });
  });
  it("builds the page and the copy address from the origin, the language and the path", () => {
    expect(pageUrl(O, "en", "/blog/x")).toBe(`${O}/en/blog/x`);
    expect(markdownUrl(O, "ar", "/help/start")).toBe(`${O}/ar/help/start.md`);
  });
});

describe("rule 3316: the blog route", () => {
  it("is static and limited to the posts and languages that exist", async () => {
    const mod = await import("@/app/[lang]/blog/[slug]/md/route");
    expect(mod.dynamic).toBe("force-static");
    expect(mod.dynamicParams).toBe(false);
    expect(mod.generateStaticParams()).toEqual(LANGS.flatMap((lang) => slugs().map((slug) => ({ lang, slug }))));
  });
  it("serves every real post in both languages as UTF-8 Markdown, noindex, with the page as canonical", async () => {
    const { GET } = await import("@/app/[lang]/blog/[slug]/md/route");
    for (const lang of LANGS) {
      for (const p of listPosts(lang)) {
        const res = await GET(new Request(`${O}/${lang}/blog/${p.slug}.md`), { params: Promise.resolve({ lang, slug: p.slug }) });
        expect(res.status, p.slug).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
        expect(res.headers.get("x-robots-tag")).toBe("noindex");
        expect(res.headers.get("content-language")).toBe(lang);
        expect(res.headers.get("link")).toContain(`/${lang}/blog/${p.slug}>; rel="canonical"`);
        const text = await res.text();
        expect(text.startsWith(`# ${p.title.replace(/\s+/g, " ").trim()}`)).toBe(true);
        expect(text).not.toMatch(/^(?:cover|languages|author|tags_?\w*|title_\w+|desc_\w+):/m);
      }
    }
  });
  it("answers 404, not a page, for a slug that is no post or a language that is no language", async () => {
    const { GET } = await import("@/app/[lang]/blog/[slug]/md/route");
    for (const params of [{ lang: "ar", slug: "no-such-post" }, { lang: "fr", slug: slugs()[0] }, { lang: "ar", slug: "../../etc/passwd" }, { lang: "ar", slug: "x.md" }]) {
      const res = await GET(new Request(O), { params: Promise.resolve(params) });
      expect(res.status, JSON.stringify(params)).toBe(404);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    }
  });
  it("serves a post written in one language on the other's address, in the language it exists in, canonical to that page", async () => {
    const only = postEntry("only.md", "---\ntitle_ar: عنوان فقط\ndesc_ar: وصف فقط\ndate: 2026-03-04\nlanguages: ar\n---\nنص عربي فقط\n");
    vi.resetModules();
    vi.doMock("@/lib/blog", async (orig) => {
      const real = await orig<typeof import("@/lib/blog")>();
      return { ...real, getPostServed: (lang: "ar" | "en", slug: string) => real.servePost([only], lang, slug), slugs: () => [only.slug] };
    });
    const { GET } = await import("@/app/[lang]/blog/[slug]/md/route");
    const res = await GET(new Request(O), { params: Promise.resolve({ lang: "en", slug: only.slug }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-language")).toBe("ar");
    expect(res.headers.get("link")).toContain(`/ar/blog/${only.slug}>; rel="canonical"`);
    const text = await res.text();
    expect(text).toContain("# عنوان فقط");
    expect(text).toContain("نص عربي فقط");
  });
});

describe("rule 3316: the help route", () => {
  it("is static and limited to the topics and languages that exist", async () => {
    const mod = await import("@/app/[lang]/help/[topic]/md/route");
    expect(mod.dynamic).toBe("force-static");
    expect(mod.dynamicParams).toBe(false);
    expect(mod.generateStaticParams()).toEqual(LANGS.flatMap((lang) => HELP.map((t) => ({ lang, topic: t.id }))));
  });
  it("serves every topic in both languages as UTF-8 Markdown, noindex", async () => {
    const { GET } = await import("@/app/[lang]/help/[topic]/md/route");
    for (const lang of LANGS) {
      for (const t of HELP) {
        const res = await GET(new Request(O), { params: Promise.resolve({ lang, topic: t.id }) });
        expect(res.status, t.id).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
        expect(res.headers.get("x-robots-tag")).toBe("noindex");
        const text = await res.text();
        expect(text).toContain(`# ${t.title[lang]}`);
        expect(text).not.toContain("{origin}");
      }
    }
  });
  it("answers 404 for a topic that does not exist or a language that is not one", async () => {
    const { GET } = await import("@/app/[lang]/help/[topic]/md/route");
    for (const params of [{ lang: "ar", topic: "nope" }, { lang: "xx", topic: HELP[0].id }]) {
      expect((await GET(new Request(O), { params: Promise.resolve(params) })).status).toBe(404);
    }
  });
});

describe("rule 3316: the public address reaches the route", () => {
  type Rewrite = { source: string; destination: string };
  const rewrites = async () => (await nextConfig.rewrites!()) as Rewrite[];
  it("rewrites /{lang}/blog/{slug}.md and /{lang}/help/{topic}.md to the folder of the route, for the two languages only", async () => {
    const list = await rewrites();
    const blog = list.find((r) => r.destination === "/:lang/blog/:slug/md")!;
    const help = list.find((r) => r.destination === "/:lang/help/:topic/md")!;
    expect(blog && help).toBeTruthy();
    const b = match(blog.source), h = match(help.source);
    expect(b("/ar/blog/hello.md")).toMatchObject({ params: { lang: "ar", slug: "hello" } });
    expect(b("/en/blog/a-b-c.md")).toMatchObject({ params: { lang: "en", slug: "a-b-c" } });
    expect(h("/en/help/start.md")).toMatchObject({ params: { lang: "en", topic: "start" } });
    for (const p of ["/fr/blog/x.md", "/ar/blog/x", "/ar/blog/x/y.md", "/ar/blog/x.html", "/ar/pricing.md", "/ar/app/x.md"]) {
      expect(b(p), p).toBe(false);
      expect(h(p), p).toBe(false);
    }
  });
  it("keeps the old rewrites", async () => {
    const list = await rewrites();
    expect(list.filter((r) => r.source.startsWith("/.well-known/")).length).toBe(4);
  });
  it("is not in the sitemap: the page is what search lists", () => {
    for (const e of sitemap()) expect(e.url, e.url).not.toMatch(/\.md$/);
  });
  it("gets no page policy with a nonce from the proxy: it is a text file", () => {
    for (const p of ["/ar/blog/x.md", "/en/help/start.md"]) {
      expect(pagePath(p), p).toBe(false);
      const res = proxy(new NextRequest(`https://thakeen.example${p}`));
      expect(res.headers.get("content-security-policy"), p).toBeNull();
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
    for (const p of ["/ar/blog/x", "/en/help/start", "/ar/blog/x.mdx", "/ar/blog/a/b.md"]) expect(pagePath(p), p).toBe(true);
  });
  it("reads nothing from a request, a session, a store or the environment but the public origin", () => {
    for (const f of ["src/app/[lang]/blog/[slug]/md/route.ts", "src/app/[lang]/help/[topic]/md/route.ts"]) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, f).not.toMatch(/currentUser|resolveSession|@\/lib\/db|process\.env|headers\(\)|cookies\(|searchParams/);
      expect(code, f).toMatch(/force-static/);
    }
  });
});
