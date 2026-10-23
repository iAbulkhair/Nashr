import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { postProblems, listPosts } from "@/lib/blog";
import { allTags, blogHref, filterByTag, isActiveTag, MAX_TAGS, MAX_TAG_LENGTH, splitTags, tagFromParam, tagKey, tagProblems } from "@/lib/blog-tags";
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

describe("rule 3140: edge cases of the tag helpers", () => {
  it("splitTags collapses inner whitespace and line breaks, keeps a stray leading or trailing comma as an empty piece, and never drops an Arabic comma", () => {
    expect(splitTags("  a   b ,\n c\t d ")).toEqual(["a b", "c d"]);
    expect(splitTags(",a")).toEqual(["", "a"]);
    expect(splitTags("a,")).toEqual(["a", ""]);
    expect(splitTags("،")).toEqual(["", ""]);
    expect(splitTags("تسويق،سناب, ads")).toEqual(["تسويق", "سناب", "ads"]);
  });

  it("tagKey ignores letter case, outer and inner spacing, and leaves Arabic letters alone", () => {
    expect(tagKey("  Email   MARKETING ")).toBe("email marketing");
    expect(tagKey("Email\tmarketing")).toBe(tagKey("email marketing"));
    expect(tagKey("واتساب")).toBe("واتساب");
    expect(tagKey("   ")).toBe("");
  });

  it("tagProblems accepts exactly MAX_TAGS tags of exactly MAX_TAG_LENGTH characters, and refuses one more of either", () => {
    const five = Array.from({ length: MAX_TAGS }, (_, i) => "t".repeat(MAX_TAG_LENGTH - 1) + i);
    expect(five.every((t) => t.length === MAX_TAG_LENGTH)).toBe(true);
    expect(tagProblems("f", "tags_en", five)).toEqual([]);
    expect(tagProblems("f", "tags_en", ["x".repeat(MAX_TAG_LENGTH)])).toEqual([]);
    expect(tagProblems("f", "tags_en", [])).toEqual([]);
  });

  it("tagProblems names every problem at once, and treats tags that differ only in spacing as a repeat but empty pieces as empty, not as a repeat", () => {
    const many = tagProblems("f", "tags_en", ["a", "A", "", "x".repeat(MAX_TAG_LENGTH + 1), "b", "c", "d"]);
    expect(many).toHaveLength(4);
    expect(many.join("|")).toMatch(/at most 5/);
    expect(many.join("|")).toMatch(/empty tag/);
    expect(many.join("|")).toMatch(/longer than 30/);
    expect(many.join("|")).toMatch(/repeats a tag/);
    expect(tagProblems("f", "tags_en", ["email  marketing", "Email marketing"]).join()).toMatch(/repeats a tag/);
    const twoEmpty = tagProblems("f", "tags_en", ["", ""]);
    expect(twoEmpty).toHaveLength(1);
    expect(twoEmpty[0]).toMatch(/empty tag/);
    expect(tagProblems("file.md", "tags_ar", ["", "b"])[0]).toMatch(/^file\.md: tags_ar /);
  });

  it("a front matter value that is only blanks counts as no tags, so it does not satisfy the other language's pair", () => {
    expect(post("tags_ar:    \ntags_en:\n")).toEqual([]);
    expect(post("tags_ar:\ntags_en: marketing\n")).toEqual(["a-post.md: tags_ar is missing (tags_en is given; tags come in both languages)"]);
    expect(post("tags_ar: ،\ntags_en: a\n").join()).toMatch(/tags_ar has an empty tag/);
  });

  it("a post checks each language's tags on their own: six English tags and a repeated Arabic tag give two problems that name their field", () => {
    const out = post("tags_ar: أ، أ\ntags_en: a, b, c, d, e, f\n");
    expect(out).toHaveLength(2);
    expect(out.some((p) => /tags_ar repeats a tag/.test(p))).toBe(true);
    expect(out.some((p) => /tags_en has 6 tags, at most 5/.test(p))).toBe(true);
  });

  it("tagFromParam takes the first value only, even when it is blank, and trims it", () => {
    expect(tagFromParam([])).toBeUndefined();
    expect(tagFromParam(["", "b"])).toBeUndefined();
    expect(tagFromParam(["  x  ", "y"])).toBe("x");
    expect(tagFromParam("  two words ")).toBe("two words");
    expect(tagFromParam("")).toBeUndefined();
  });

  it("filterByTag matches across spacing and case, handles Arabic tags, keeps the posts' order and returns a new array when filtering", () => {
    const posts = [
      { slug: "a", tags: ["Email  Marketing"] },
      { slug: "b", tags: [] as string[] },
      { slug: "c", tags: ["واتساب", "email marketing"] },
    ];
    const hit = filterByTag(posts, "  EMAIL marketing ");
    expect(hit.map((p) => p.slug)).toEqual(["a", "c"]);
    expect(hit).not.toBe(posts);
    expect(filterByTag(posts, "واتساب").map((p) => p.slug)).toEqual(["c"]);
    expect(filterByTag([], "x")).toEqual([]);
    expect(filterByTag(posts, "")).toBe(posts);
  });

  it("allTags is empty when no post is tagged, keeps the first spelling, and sorts Arabic tags by the Arabic collation", () => {
    expect(allTags([{ tags: [] }, { tags: [] }], "en")).toEqual([]);
    expect(allTags([{ tags: ["SEO"] }, { tags: ["seo", "Ads"] }], "en")).toEqual(["Ads", "SEO"]);
    expect(allTags([{ tags: ["ب", "أ"] }, { tags: ["ت", "ب"] }], "ar")).toEqual(["أ", "ب", "ت"]);
  });

  it("isActiveTag ignores case and spacing, and an empty or missing active tag matches nothing", () => {
    expect(isActiveTag("Email Marketing", " email  marketing ")).toBe(true);
    expect(isActiveTag("seo", "ads")).toBe(false);
    expect(isActiveTag("seo", "")).toBe(false);
  });

  it("blogHref encodes characters that would end the query or the path, and an empty tag gives the whole index", () => {
    expect(blogHref("en", "a#b?c/d")).toBe("/en/blog?tag=a%23b%3Fc%2Fd");
    expect(blogHref("en", "")).toBe("/en/blog");
    const href = blogHref("ar", "تسويق وإعلان");
    expect(new URL(href, "https://x.test").searchParams.get("tag")).toBe("تسويق وإعلان");
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
