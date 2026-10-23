import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { postProblems, listPosts } from "@/lib/blog";
import { allTags, blogHref, filterByTag, isActiveTag, MAX_TAGS, MAX_TAG_LENGTH, splitTags, tagFromParam, tagProblems } from "@/lib/blog-tags";
import { PostTags } from "@/components/PostTags";
import BlogPage from "@/app/[lang]/blog/page";

// The page's nav holds client components that read the router; as in tests/reskin-marketing.test.ts, a static render needs it stubbed.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/blog",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * Rule 3140: a blog post may carry tags in its front matter (`tags_ar`, `tags_en`, comma separated, both languages or
 * neither), the blog index lists them as plain links that filter with `?tag=` on the server, and a tag nobody carries
 * shows an empty state. The idea is supastarter's tag filter; the code is ours.
 */
const BASE = "---\ntitle_ar: ع\ntitle_en: T\ndesc_ar: و\ndesc_en: D\ndate: 2026-01-02\n";
const BODY = "---\nنص\n---EN---\ntext\n";
const post = (extra: string) => postProblems("a-post.md", BASE + extra + BODY);

describe("rule 3140: tags in a post's front matter", () => {
  it("splits on the Latin and the Arabic comma, trims, and gives no tags for an empty value", () => {
    expect(splitTags("seo, Ads ،  واتساب")).toEqual(["seo", "Ads", "واتساب"]);
    expect(splitTags("")).toEqual([]);
    expect(splitTags(undefined)).toEqual([]);
    expect(splitTags("   ")).toEqual([]);
    expect(splitTags("a,,b")).toEqual(["a", "", "b"]);
  });

  it("a post with no tags, or with tags in both languages, is valid", () => {
    expect(post("")).toEqual([]);
    expect(post("tags_ar: تسويق، واتساب\ntags_en: marketing, whatsapp\n")).toEqual([]);
  });

  it("tags come in both languages: one language alone is a problem that names the missing field", () => {
    expect(post("tags_en: marketing\n")).toEqual(["a-post.md: tags_ar is missing (tags_en is given; tags come in both languages)"]);
    expect(post("tags_ar: تسويق\n")).toEqual(["a-post.md: tags_en is missing (tags_ar is given; tags come in both languages)"]);
  });

  it("an empty tag, a repeated tag in any letter case, a long tag and too many tags are each a problem", () => {
    expect(tagProblems("f", "tags_en", ["a", "", "b"]).join()).toMatch(/empty tag/);
    expect(tagProblems("f", "tags_en", ["Seo", "seo"]).join()).toMatch(/repeats a tag/);
    expect(tagProblems("f", "tags_en", ["x".repeat(MAX_TAG_LENGTH + 1)]).join()).toMatch(/longer than/);
    expect(tagProblems("f", "tags_en", Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`)).join()).toMatch(/at most/);
    expect(tagProblems("f", "tags_en", ["a", "b"])).toEqual([]);
    expect(post("tags_ar: أ، ،ب\ntags_en: a, b\n").join()).toMatch(/tags_ar has an empty tag/);
  });

  it("every post in content/blog passes the check, and its tags are the two languages' counts", () => {
    for (const f of readdirSync("content/blog").filter((x) => x.endsWith(".md"))) expect(postProblems(f, readFileSync(`content/blog/${f}`, "utf8")), f).toEqual([]);
    const ar = listPosts("ar"), en = listPosts("en");
    expect(ar.some((p) => p.tags.length > 0)).toBe(true);
    for (const p of ar) expect(en.find((q) => q.slug === p.slug)?.tags.length, p.slug).toBe(p.tags.length);
  });
});

describe("rule 3140: the filter, the tag list and the addresses", () => {
  const posts = [
    { slug: "a", tags: ["Ads", "seo"] },
    { slug: "b", tags: ["SEO"] },
    { slug: "c", tags: [] as string[] },
  ];

  it("filters without regard to letter case and returns every post when there is no tag", () => {
    expect(filterByTag(posts, "seo").map((p) => p.slug)).toEqual(["a", "b"]);
    expect(filterByTag(posts, "ADS").map((p) => p.slug)).toEqual(["a"]);
    expect(filterByTag(posts, undefined)).toBe(posts);
    expect(filterByTag(posts, "nobody")).toEqual([]);
  });

  it("lists each tag once, in the first spelling met, sorted", () => {
    expect(allTags(posts, "en")).toEqual(["Ads", "seo"]);
  });

  it("reads the query as the first non-blank value", () => {
    expect(tagFromParam("seo")).toBe("seo");
    expect(tagFromParam(["a", "b"])).toBe("a");
    expect(tagFromParam("  ")).toBeUndefined();
    expect(tagFromParam(undefined)).toBeUndefined();
  });

  it("builds `/lang/blog` or `/lang/blog?tag=` with the tag percent-encoded", () => {
    expect(blogHref("ar")).toBe("/ar/blog");
    expect(blogHref("en", "a b&c")).toBe("/en/blog?tag=a%20b%26c");
    expect(blogHref("ar", "واتساب")).toBe(`/ar/blog?tag=${encodeURIComponent("واتساب")}`);
    expect(isActiveTag("SEO", "seo")).toBe(true);
    expect(isActiveTag("seo", undefined)).toBe(false);
  });
});

describe("rule 3140: the tag links are plain server-rendered links, with no script of ours", () => {
  const html = renderToStaticMarkup(h(PostTags, { lang: "en", tags: ["Ads", "seo"], active: "SEO", label: "Filter by tag", allLabel: "All posts" }));

  it("renders an all-posts link and one link per tag to `?tag=`, the active one marked as the current page", () => {
    expect(html).toContain('aria-label="Filter by tag"');
    expect(html).toContain('href="/en/blog"');
    expect(html).toContain('href="/en/blog?tag=Ads"');
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    const current = anchors.filter((a) => a.includes('aria-current="page"'));
    expect(anchors).toHaveLength(3);
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/en/blog?tag=seo"');
  });

  it("renders nothing for a post without tags, and the filter component holds no client code", () => {
    expect(renderToStaticMarkup(h(PostTags, { lang: "en", tags: [], label: "x" }))).toBe("");
    expect(readFileSync("src/components/PostTags.tsx", "utf8")).not.toMatch(/use client|useState|useEffect|onClick/);
  });
});

describe("rule 3140: the blog index filters on the server and says so when a tag matches nothing", () => {
  const SRC = readFileSync("src/app/[lang]/blog/page.tsx", "utf8");

  it("reads the tag from `searchParams`, filters the posts, and shows an empty state with a way back", () => {
    expect(SRC).toMatch(/searchParams/);
    expect(SRC).toMatch(/filterByTag\(all, tag\)/);
    expect(SRC).toMatch(/data-testid="blog-empty"/);
    expect(SRC).not.toMatch(/use client/);
  });

  it("renders the filtered list, every post when no tag, and the empty state for a tag nobody carries", async () => {
    const all = listPosts("en");
    const tag = all.find((p) => p.tags.length)!.tags[0];
    const carry = all.filter((p) => p.tags.some((t) => t.toLowerCase() === tag.toLowerCase()));
    const page = async (q: { tag?: string | string[] }) => renderToStaticMarkup(await BlogPage({ params: Promise.resolve({ lang: "en" }), searchParams: Promise.resolve(q) }));
    const cards = (html: string) => (html.match(/class="s-card/g) ?? []).length;
    expect(cards(await page({}))).toBe(all.length);
    const filtered = await page({ tag: tag.toUpperCase() });
    expect(cards(filtered)).toBe(carry.length);
    expect(carry.length).toBeLessThanOrEqual(all.length);
    for (const p of carry) expect(filtered).toContain(`/en/blog/${p.slug}"`);
    const none = await page({ tag: "no-such-tag" });
    expect(cards(none)).toBe(0);
    expect(none).toContain('data-testid="blog-empty"');
    expect(none).toContain('href="/en/blog"');
    expect(await page({ tag: "  " })).not.toContain("blog-empty");
  });

  it("keeps a filtered view out of search results and points its canonical at the whole index", () => {
    expect(SRC).toMatch(/canonical: `\/\$\{lang\}\/blog`/);
    expect(SRC).toMatch(/robots: \{ index: false, follow: true \}/);
  });
});
