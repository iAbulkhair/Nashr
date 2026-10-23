import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { COVER_ALT_MAX, COVER_MAX_BYTES, coverProblems, imageKind, postCover, readCoverFile, type CoverReader } from "@/lib/blog-cover";
import { listPosts, postEntry, postIn, postProblems } from "@/lib/blog";
import { articleJsonLd } from "@/lib/home-ld";
import { proxy, strayPath, unprefixedPublic } from "@/proxy";
import { NextRequest } from "next/server";

/**
 * Rule 3314: an optional `cover` names an image file the repository holds under `public/blog/`, checked at build time (it exists,
 * is an image by name and by its first bytes, is small, has alternative text in each language of the post); with no cover the
 * post shows its own generated share card. Nothing is downloaded, and no image ships with this change: every file here is made
 * of a few bytes in the test.
 */
const bytes = (...b: number[]) => Uint8Array.from(b);
const asc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const PNG = bytes(0x89, ...asc("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, ...asc("JFIF"));
const WEBP = bytes(...asc("RIFF"), 1, 2, 3, 4, ...asc("WEBP"));
const AVIF = bytes(0, 0, 0, 0x1c, ...asc("ftyp"), ...asc("avif"));
const GIF = bytes(...asc("GIF89a"), 0, 0);
const HTML = bytes(...asc("<!doctype html><html>"));

const files = (m: Record<string, { head: Uint8Array; size?: number }>): CoverReader => (c) => (m[c] ? { head: m[c].head, size: m[c].size ?? 1000 } : null);
const META = { cover: "/blog/a.webp", cover_alt_ar: "وصف الصورة", cover_alt_en: "Image description" };
const BOTH = ["ar", "en"] as const;

describe("rule 3314: what an image file's first bytes say", () => {
  it("knows PNG, JPEG, WebP, AVIF and GIF", () => {
    expect(imageKind(PNG)).toBe("png");
    expect(imageKind(JPEG)).toBe("jpeg");
    expect(imageKind(WEBP)).toBe("webp");
    expect(imageKind(AVIF)).toBe("avif");
    expect(imageKind(GIF)).toBe("gif");
  });
  it("does not take a page, a script, an SVG or nothing for an image", () => {
    expect(imageKind(HTML)).toBeNull();
    expect(imageKind(bytes(...asc("<svg xmlns=")))).toBeNull();
    expect(imageKind(bytes(...asc("#!/bin/sh\n")))).toBeNull();
    expect(imageKind(bytes())).toBeNull();
    expect(imageKind(bytes(0xff, 0xd8))).toBeNull();
    expect(imageKind(bytes(...asc("RIFF"), 0, 0, 0, 0, ...asc("WAVE")))).toBeNull();
  });
});

describe("rule 3314: the cover fields of a post", () => {
  const read = files({ "/blog/a.webp": { head: WEBP } });
  it("accepts a real image with alternative text in both languages, and a post with no cover", () => {
    expect(coverProblems("p.md", META, BOTH, read)).toEqual([]);
    expect(coverProblems("p.md", {}, BOTH, read)).toEqual([]);
  });
  it("fails the build when the file is not in public/blog", () => {
    expect(coverProblems("p.md", { ...META, cover: "/blog/missing.webp" }, BOTH, read).join(" ")).toMatch(/\/blog\/missing\.webp is not a file in public\/blog/);
  });
  it("fails when the file is not an image, or is another kind than its name says", () => {
    expect(coverProblems("p.md", META, BOTH, files({ "/blog/a.webp": { head: HTML } })).join(" ")).toMatch(/is not an image/);
    expect(coverProblems("p.md", META, BOTH, files({ "/blog/a.webp": { head: PNG } })).join(" ")).toMatch(/is a png image under a \.webp name/);
  });
  it("fails when the file is too large", () => {
    expect(coverProblems("p.md", META, BOTH, files({ "/blog/a.webp": { head: WEBP, size: COVER_MAX_BYTES + 1 } })).join(" ")).toMatch(/most is 1500000/);
    expect(coverProblems("p.md", META, BOTH, files({ "/blog/a.webp": { head: WEBP, size: COVER_MAX_BYTES } }))).toEqual([]);
  });
  it("accepts only a file name directly under /blog/ with an image extension: no folder, no .., no URL, no SVG", () => {
    const never: CoverReader = () => { throw new Error("must not be read"); };
    for (const c of ["/blog/../secret.png", "/blog/a/b.png", "blog/a.png", "/a.png", "https://example.com/a.png", "//example.com/a.png", "/blog/a.svg", "/blog/a.png?x=1", "/blog/A.png", "/blog/.png", "/blog/a.php", "/blog/a.png/", "/blog/a b.png", "/blog/", "/blog/a.png%00.exe", ""]) {
      const p = coverProblems("p.md", { ...META, cover: c }, BOTH, never);
      expect(p.join(" "), c).toMatch(/cover ".*" must be \/blog\/ plus one file name/);
    }
    for (const c of ["/blog/a.png", "/blog/a-b.jpg", "/blog/a.b-2026.jpeg", "/blog/x.avif", "/blog/x.gif"]) {
      expect(coverProblems("p.md", { ...META, cover: c }, BOTH, files({ [c]: { head: PNG } })).join(" "), c).not.toMatch(/must be \/blog\//);
    }
  });
  it("needs alternative text in each language of the post, not blank and not longer than a sentence", () => {
    expect(coverProblems("p.md", { cover: "/blog/a.webp", cover_alt_en: "x" }, BOTH, read).join(" ")).toMatch(/cover_alt_ar is missing/);
    expect(coverProblems("p.md", { cover: "/blog/a.webp", cover_alt_ar: "x" }, BOTH, read).join(" ")).toMatch(/cover_alt_en is missing/);
    expect(coverProblems("p.md", { ...META, cover_alt_en: "" }, BOTH, read).join(" ")).toMatch(/cover_alt_en is missing/);
    expect(coverProblems("p.md", { ...META, cover_alt_en: "x".repeat(COVER_ALT_MAX + 1) }, BOTH, read).join(" ")).toMatch(/cover_alt_en is 201 characters/);
    expect(coverProblems("p.md", { ...META, cover_alt_en: "x".repeat(COVER_ALT_MAX) }, BOTH, read)).toEqual([]);
  });
  it("needs the text of a one-language post in its language only", () => {
    expect(coverProblems("p.md", { cover: "/blog/a.webp", cover_alt_ar: "وصف" }, ["ar"], read)).toEqual([]);
    expect(coverProblems("p.md", META, ["ar"], read).join(" ")).toMatch(/cover_alt_en is given but the post is not in English/);
    expect(coverProblems("p.md", { cover: "/blog/a.webp", cover_alt_en: "d" }, ["ar"], read).join(" ")).toMatch(/cover_alt_ar is missing/);
  });
  it("refuses alternative text with no cover", () => {
    expect(coverProblems("p.md", { cover_alt_en: "d" }, BOTH, read).join(" ")).toMatch(/cover_alt_en is given without a cover/);
  });
  it("names every problem at once, with the file", () => {
    const p = coverProblems("p.md", { cover: "/blog/missing.png" }, BOTH, read);
    expect(p).toHaveLength(3);
    for (const x of p) expect(x.startsWith("p.md: ")).toBe(true);
  });
});

describe("rule 3314: through postProblems and the post", () => {
  const RAW = "---\ntitle_ar: عنوان\ndesc_ar: وصف\ntitle_en: Title\ndesc_en: Description\ndate: 2026-01-02\ncover: /blog/a.webp\ncover_alt_ar: صورة\ncover_alt_en: Picture\n---\nنص\n---EN---\ntext\n";
  it("passes a cover that is there and fails one that is not", () => {
    expect(postProblems("p.md", RAW, files({ "/blog/a.webp": { head: WEBP } }))).toEqual([]);
    expect(postProblems("p.md", RAW, files({})).join(" ")).toMatch(/not a file in public\/blog/);
  });
  it("checks the cover of a one-language post too", () => {
    const one = "---\ntitle_ar: عنوان\ndesc_ar: وصف\ndate: 2026-01-02\nlanguages: ar\ncover: /blog/a.webp\ncover_alt_ar: صورة\n---\nنص\n";
    expect(postProblems("p.md", one, files({ "/blog/a.webp": { head: WEBP } }))).toEqual([]);
    expect(postProblems("p.md", one, files({})).join(" ")).toMatch(/not a file/);
  });
  it("gives each language its own alternative text, and null with no cover", () => {
    const e = postEntry("p.md", RAW);
    expect(postIn(e, "ar").cover).toEqual({ src: "/blog/a.webp", alt: "صورة" });
    expect(postIn(e, "en").cover).toEqual({ src: "/blog/a.webp", alt: "Picture" });
    expect(postIn(postEntry("p.md", RAW.replace(/cover.*\n/g, "")), "en").cover).toBeNull();
  });
  it("reads real files: the checker finds nothing in a missing path or in a folder", () => {
    expect(readCoverFile("/blog/does-not-exist.png")).toBeNull();
    expect(readCoverFile("/blog")).toBeNull();
  });
  it("changes nothing for the real posts: none names a cover, and every file in public/blog is an image the posts may name", () => {
    for (const l of ["ar", "en"] as const) for (const p of listPosts(l)) expect(p.cover, p.slug).toBeNull();
    const dir = "public/blog";
    for (const f of readdirSync(dir).filter((x) => !x.startsWith("."))) {
      expect(statSync(join(dir, f)).isFile(), f).toBe(true);
      expect(imageKind(readCoverFile(`/blog/${f}`)?.head ?? bytes()), f).not.toBeNull();
    }
  });
});

describe("rule 3314: what the page draws", () => {
  it("draws the post's own cover with its alternative text", () => {
    expect(postCover("en", "x", { src: "/blog/a.webp", alt: "Picture" })).toEqual({ src: "/blog/a.webp", alt: "Picture", generated: false });
  });
  it("draws the generated share card when there is no cover, with an empty alternative text because the title is next to it", () => {
    expect(postCover("ar", "my-post", null)).toEqual({ src: "/ar/blog/my-post/opengraph-image/card", alt: "", generated: true });
  });
  it("points at the card the post's opengraph-image serves: its id is `card`", () => {
    const og = readFileSync("src/app/[lang]/blog/[slug]/opengraph-image.tsx", "utf8");
    expect(og).toMatch(/id: "card"/);
  });
  it("names the cover as the Article image only when the post has one", () => {
    const base = { slug: "x", title: "T", desc: "D", date: "2026-01-02" };
    expect(articleJsonLd("en", "https://o.test", { ...base, cover: { src: "/blog/a.webp" } }).image).toBe("https://o.test/blog/a.webp");
    expect(articleJsonLd("en", "https://o.test", { ...base, cover: null })).not.toHaveProperty("image");
    expect(articleJsonLd("en", "https://o.test", base)).not.toHaveProperty("image");
  });
  it("the page renders PostCover from postCover and the component has no stock-photo or remote source", () => {
    const page = readFileSync("src/app/[lang]/blog/[slug]/page.tsx", "utf8");
    expect(page).toMatch(/<PostCover cover=\{postCover\(sl, p\.slug, p\.cover\)\} \/>/);
    const c = readFileSync("src/components/PostCover.tsx", "utf8");
    expect(c).not.toMatch(/https?:\/\//);
  });
});

describe("rule 3314: the proxy serves a cover file and still redirects the pages under /blog", () => {
  it("leaves /blog/{image file} alone and sends /blog and /blog/{slug} to the language tree", () => {
    for (const p of ["/blog/a.webp", "/blog/a.png", "/blog/a-b.JPG", "/blog/x.avif", "/blog/x.gif", "/blog/x.jpeg"]) {
      expect(unprefixedPublic(p), p).toBe(false);
      expect(strayPath(p), p).toBe(false);
    }
    for (const p of ["/blog", "/blog/", "/blog/my-post", "/blog/a.svg", "/blog/a/b.png", "/blog/a.webp/x", "/blog/a.html"]) expect(unprefixedPublic(p), p).toBe(true);
  });
  it("lets a cover request through without a redirect or a rewrite", () => {
    const res = proxy(new NextRequest("https://thakeen.test/blog/a.webp"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
  it("still redirects an unprefixed post to the visitor's language", () => {
    const res = proxy(new NextRequest("https://thakeen.test/blog/my-post"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/\/(ar|en)\/blog\/my-post$/);
  });
});
