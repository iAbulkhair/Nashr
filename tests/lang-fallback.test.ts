import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fallbackNotice, serve, servedPath, textAttrs } from "@/lib/lang-fallback";
import { LANGS } from "@/lib/i18n";
import { listIn, listPosts, postEntry, postIndex, postLangs, postProblems, servePost } from "@/lib/blog";
import { helpLangs, helpTopics, helpTopicsIn, HELP, serveTopic } from "@/lib/help";
import { pageMeta } from "@/lib/page-meta";

/**
 * Rule 3313: a post or a help topic that exists in only one language is shown on the other language's URL as the existing
 * version, with a notice in the visitor's language and a canonical pointing at the version that exists, and it is listed once.
 * No real post or topic is single-language today, so every case here uses a synthetic one.
 */
afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/blog");
});

const FM = (extra = "") => `---\ntitle_ar: عنوان\ndesc_ar: وصف\ntitle_en: Title\ndesc_en: Description\ndate: 2026-01-02\n${extra}---\n`;
const ONLY_AR = "---\ntitle_ar: عنوان فقط\ndesc_ar: وصف فقط\ndate: 2026-03-04\nlanguages: ar\n---\nنص عربي فقط\n";
const ONLY_EN = "---\ntitle_en: English only\ndesc_en: Only here\ndate: 2026-03-05\nlanguages: en\ntags_en: seo\n---\nEnglish text only\n";
const BOTH = `${FM()}نص\n---EN---\ntext\n`;

describe("rule 3313: which language a page is served in", () => {
  it("serves the requested language when the text exists in it", () => {
    expect(serve("ar", ["ar", "en"])).toEqual({ lang: "ar", fallback: false });
    expect(serve("en", ["ar", "en"])).toEqual({ lang: "en", fallback: false });
    expect(serve("en", ["en"])).toEqual({ lang: "en", fallback: false });
  });
  it("falls back to the language that exists, and marks it", () => {
    expect(serve("en", ["ar"])).toEqual({ lang: "ar", fallback: true });
    expect(serve("ar", ["en"])).toEqual({ lang: "en", fallback: true });
  });
  it("serves nothing when the text exists in no language", () => {
    expect(serve("ar", [])).toBeNull();
    expect(serve("en", [])).toBeNull();
  });
  it("prefers Arabic, the site's default, when more than one language could answer", () => {
    expect(serve("en", ["en", "ar"])).toEqual({ lang: "en", fallback: false });
    // The order of the available list never decides: the site's order does.
    expect(LANGS[0]).toBe("ar");
  });
  it("names the canonical address of the version that exists, and the text's language and direction", () => {
    expect(servedPath("ar", "/blog/x")).toBe("/ar/blog/x");
    expect(textAttrs("ar")).toEqual({ lang: "ar", dir: "rtl" });
    expect(textAttrs("en")).toEqual({ lang: "en", dir: "ltr" });
  });
  it("writes the notice in the visitor's language, names the version shown, and promises nothing", () => {
    const en = fallbackNotice("en", "ar");
    const ar = fallbackNotice("ar", "en");
    expect(en).toMatch(/not available in English/);
    expect(en).toMatch(/Arabic version/);
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toMatch(/[A-Za-z]/);
    for (const t of [en, ar]) {
      expect(t).not.toMatch(/\d/);
      expect(t).not.toMatch(/soon|قريبا|قريباً|will be|ستتوفر/i);
    }
  });
});

describe("rule 3313: a post written in one language", () => {
  it("passes the checks without the other language's fields or an ---EN--- line", () => {
    expect(postProblems("only-ar.md", ONLY_AR)).toEqual([]);
    expect(postProblems("only-en.md", ONLY_EN)).toEqual([]);
  });
  it("is a build error for any other value, so a typo cannot make a post vanish from a language", () => {
    const p = postProblems("x.md", ONLY_AR.replace("languages: ar", "languages: fr"));
    expect(p.join(" ")).toMatch(/languages "fr" must be ar or en/);
    expect(postProblems("x.md", ONLY_AR.replace("languages: ar", "languages: ar,en")).join(" ")).toMatch(/must be ar or en/);
  });
  it("still needs its own language's fields and text", () => {
    expect(postProblems("x.md", ONLY_AR.replace("title_ar: عنوان فقط\n", "")).join(" ")).toMatch(/title_ar is missing/);
    expect(postProblems("x.md", ONLY_AR.replace("date: 2026-03-04\n", "")).join(" ")).toMatch(/date is missing/);
    expect(postProblems("x.md", ONLY_AR.replace("نص عربي فقط", "")).join(" ")).toMatch(/text is empty/);
  });
  it("refuses the other language's fields, tags and ---EN--- line, which would be silently unused", () => {
    expect(postProblems("x.md", ONLY_AR.replace("languages: ar\n", "languages: ar\ntitle_en: Oops\n")).join(" ")).toMatch(/title_en is given but the post is only in Arabic/);
    expect(postProblems("x.md", ONLY_AR.replace("languages: ar\n", "languages: ar\ntags_en: seo\n")).join(" ")).toMatch(/tags_en is given/);
    expect(postProblems("x.md", `${ONLY_AR}---EN---\ntext\n`).join(" ")).toMatch(/no ---EN--- line/);
  });
  it("checks the tags it has in its own language", () => {
    expect(postProblems("x.md", ONLY_EN.replace("tags_en: seo", `tags_en: ${"a,".repeat(30)}`)).length).toBeGreaterThan(0);
  });
  it("never lets a forgotten translation through: without the languages line both languages are still required", () => {
    expect(postProblems("x.md", `${FM()}نص فقط\n`).join(" ")).toMatch(/no ---EN--- line/);
    expect(postProblems("x.md", "---\ntitle_ar: عنوان\ndesc_ar: وصف\ndate: 2026-01-02\n---\nنص\n---EN---\ntext\n").join(" ")).toMatch(/title_en is missing/);
    expect(postProblems("x.md", BOTH)).toEqual([]);
  });
  it("reads the languages from the front matter", () => {
    expect(postLangs({})).toEqual(["ar", "en"]);
    expect(postLangs({ languages: "ar" })).toEqual(["ar"]);
    expect(postLangs({ languages: " en " })).toEqual(["en"]);
    expect(postLangs({ languages: "fr" })).toEqual(["ar", "en"]);
  });
});

describe("rule 3313: serving and listing posts", () => {
  const entries = [postEntry("only-ar.md", ONLY_AR), postEntry("only-en.md", ONLY_EN), postEntry("both.md", BOTH)];

  it("serves an Arabic-only post on the English address as the Arabic version, marked as a fallback", () => {
    const r = servePost(entries, "en", "only-ar")!;
    expect(r.served).toEqual({ lang: "ar", fallback: true });
    expect(r.post.title).toBe("عنوان فقط");
    expect(r.post.body).toBe("نص عربي فقط");
    expect(r.post.langs).toEqual(["ar"]);
  });
  it("serves an English-only post on the Arabic address as the English version", () => {
    const r = servePost(entries, "ar", "only-en")!;
    expect(r.served).toEqual({ lang: "en", fallback: true });
    expect(r.post.title).toBe("English only");
    expect(r.post.tags).toEqual(["seo"]);
  });
  it("serves the post natively in the language it is written in, and a two-language post in each", () => {
    expect(servePost(entries, "ar", "only-ar")!.served.fallback).toBe(false);
    expect(servePost(entries, "en", "only-en")!.served.fallback).toBe(false);
    expect(servePost(entries, "ar", "both")!.post.body).toBe("نص");
    expect(servePost(entries, "en", "both")!.post.body).toBe("text");
    expect(servePost(entries, "en", "both")!.served.fallback).toBe(false);
  });
  it("answers null for a slug no post has", () => {
    expect(servePost(entries, "en", "nope")).toBeNull();
    expect(servePost([], "ar", "only-ar")).toBeNull();
  });
  it("lists a post once, in the language it is written in", () => {
    expect(listIn(entries, "ar").map((p) => p.slug)).toEqual(["only-ar", "both"]);
    expect(listIn(entries, "en").map((p) => p.slug)).toEqual(["only-en", "both"]);
  });
  it("changes nothing for the real posts: all are in both languages, listed in both, in the same order", () => {
    const idx = postIndex();
    expect(idx.length).toBeGreaterThan(5);
    for (const p of idx) expect(p.langs).toEqual(["ar", "en"]);
    expect(listPosts("ar").map((p) => p.slug)).toEqual(idx.map((p) => p.slug));
    expect(listPosts("en").map((p) => p.slug)).toEqual(idx.map((p) => p.slug));
  });
});

describe("rule 3313: the page's metadata", () => {
  it("is unchanged for a page in both languages: its own canonical and both alternates", () => {
    const m = pageMeta("en", "/blog/x", { title: "T" });
    expect(m.alternates).toEqual({ canonical: "/en/blog/x", languages: { ar: "/ar/blog/x", en: "/en/blog/x" } });
    expect(pageMeta("en", "/blog/x", { title: "T", served: "en" }).alternates).toEqual(m.alternates);
  });
  it("points the missing language's URL at the version that exists, and offers no alternate", () => {
    const m = pageMeta("en", "/blog/x", { title: "T", bilingual: false, served: "ar" });
    expect(m.alternates).toEqual({ canonical: "/ar/blog/x" });
    // Even a page that thinks it is bilingual cannot name the missing language's URL as an alternate while it is a fallback.
    expect(pageMeta("en", "/blog/x", { title: "T", served: "ar" }).alternates).toEqual({ canonical: "/ar/blog/x" });
  });
  it("keeps the native page of a one-language post canonical to itself, with no alternate", () => {
    expect(pageMeta("ar", "/blog/x", { title: "T", bilingual: false, served: "ar" }).alternates).toEqual({ canonical: "/ar/blog/x" });
  });
});

describe("rule 3313: a help topic written in one language", () => {
  const both = { only: undefined };
  it("lists its languages and is served like a post", () => {
    expect(helpLangs(both)).toEqual(["ar", "en"]);
    expect(helpLangs({ only: "ar" })).toEqual(["ar"]);
    expect(serveTopic({ only: "ar" }, "en")).toEqual({ lang: "ar", fallback: true });
    expect(serveTopic({ only: "en" }, "en")).toEqual({ lang: "en", fallback: false });
    expect(serveTopic(both, "en")).toEqual({ lang: "en", fallback: false });
  });
  it("changes nothing for the real topics: all in both languages, all listed in both", () => {
    for (const t of HELP) expect(helpLangs(t)).toEqual(["ar", "en"]);
    for (const l of LANGS) expect(helpTopicsIn("https://x.test", l).map((t) => t.id)).toEqual(helpTopics("https://x.test").map((t) => t.id));
  });
  it("keeps the opt-in out of the real data until a topic needs it", () => {
    expect(HELP.filter((t) => t.only)).toEqual([]);
  });
});

describe("rule 3313: the sitemap lists a one-language post once, with only its own language as alternate", () => {
  it("lists the Arabic URL only, with Arabic as the default alternate", async () => {
    vi.doMock("@/lib/blog", () => ({
      postIndex: () => [
        { slug: "only-ar", date: "2026-03-04", langs: ["ar"] },
        { slug: "only-en", date: "2026-03-05", langs: ["en"] },
        { slug: "both", date: "2026-01-02", langs: ["ar", "en"] },
      ],
    }));
    const { default: sitemap } = await import("@/app/sitemap");
    const rows = sitemap();
    const find = (u: string) => rows.find((r) => r.url.endsWith(u));
    expect(find("/ar/blog/only-ar")).toBeTruthy();
    expect(find("/en/blog/only-ar")).toBeUndefined();
    expect(find("/en/blog/only-en")).toBeTruthy();
    expect(find("/ar/blog/only-en")).toBeUndefined();
    expect(Object.keys(find("/ar/blog/only-ar")!.alternates!.languages!)).toEqual(["ar", "x-default"]);
    expect(find("/ar/blog/only-ar")!.alternates!.languages!["x-default"]).toMatch(/\/ar\/blog\/only-ar$/);
    expect(Object.keys(find("/en/blog/only-en")!.alternates!.languages!)).toEqual(["en", "x-default"]);
    expect(find("/en/blog/only-en")!.alternates!.languages!["x-default"]).toMatch(/\/en\/blog\/only-en$/);
    expect(Object.keys(find("/ar/blog/both")!.alternates!.languages!)).toEqual(["ar", "en", "x-default"]);
    expect(rows.filter((r) => /\/blog\/only-ar$/.test(r.url))).toHaveLength(1);
  });
  it("is unchanged for the real site: the same two alternates and a default on every page", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    for (const r of sitemap()) expect(Object.keys(r.alternates!.languages!)).toEqual(["ar", "en", "x-default"]);
  });
});

describe("rule 3313: the pages and the files that list content", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  it("the post page serves the fallback with a notice, the text's language, and the existing version's JSON-LD", () => {
    const s = src("src/app/[lang]/blog/[slug]/page.tsx");
    expect(s).toMatch(/getPostServed\(lang, slug\)/);
    expect(s).toMatch(/<LangFallbackNotice visitor=\{lang\} served=\{sl\}/);
    expect(s).toMatch(/articleJsonLd\(sl,/);
    expect(s).toMatch(/served: served\.lang/);
  });
  it("the topic page and both share cards read the served language", () => {
    expect(src("src/app/[lang]/help/[topic]/page.tsx")).toMatch(/serveTopic\(t, lang\)/);
    expect(src("src/app/[lang]/help/[topic]/page.tsx")).toMatch(/helpFaqJsonLd\(sl,/);
    expect(src("src/app/[lang]/help/[topic]/opengraph-image.tsx")).toMatch(/serveTopic/);
    expect(src("src/app/[lang]/blog/[slug]/opengraph-image.tsx")).toMatch(/getPostServed/);
  });
  it("the indexes, llms files, help index and chat prompt list native content only", () => {
    expect(src("src/app/llms-full.txt/route.ts")).toMatch(/helpTopicsIn\(base, lang\)/);
    expect(src("src/app/llms.txt/route.ts")).toMatch(/helpLangs\(h\)\.includes\(lang\)/);
    expect(src("src/components/HelpCenter.tsx")).toMatch(/helpTopicsIn\(origin, lang\)/);
    expect(src("src/lib/chat-prompt.ts")).toMatch(/helpTopicsIn\(appOrigin\(\), "en"\)/);
  });
});
