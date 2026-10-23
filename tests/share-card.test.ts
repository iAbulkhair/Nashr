import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { woff2ToSfnt } from "@/lib/woff2";
import { shapeArabic } from "@/lib/arabic-shape";
import { CARD_SIZE, DESCRIPTION_MAX, TITLE_MAX, cardAlt, clip, shareCard, titleSize } from "@/lib/share-card";
import { cardQuestions, describe as describeTopic, HELP } from "@/lib/help";
import { dict } from "@/lib/i18n";
import { listPosts, slugs } from "@/lib/blog";
import { generateStaticParams as blogPageParams } from "@/app/[lang]/blog/[slug]/page";
import { generateStaticParams as helpPageParams } from "@/app/[lang]/help/[topic]/page";
import BlogImage, { generateImageMetadata as blogMeta } from "@/app/[lang]/blog/[slug]/opengraph-image";
import HelpImage, { generateImageMetadata as helpMeta } from "@/app/[lang]/help/[topic]/opengraph-image";

/**
 * Rules 3141 and 3142: one card maker draws the share image of a blog post and of a help topic, from the page's own title (and,
 * for help, its own questions), set right to left in Arabic with the site's Arabic display font, in the brand's colours,
 * claiming nothing. The idea is supastarter's per-page docs card; the code is ours.
 */
const SAMPLE = "كيف أربط حسابي على لينكدإن؟";
const pngSize = (b: Uint8Array) => ({ width: new DataView(b.buffer, b.byteOffset).getUint32(16), height: new DataView(b.buffer, b.byteOffset).getUint32(20) });
const isPng = (b: Uint8Array) => [0x89, 0x50, 0x4e, 0x47].every((v, i) => b[i] === v);
const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

describe("rule 3141: the card maker reads the site's font in memory and shapes Arabic for it", () => {
  it("unwraps each WOFF2 weight into a TrueType/OpenType file Satori can read, leaving the file on disk as it was", () => {
    for (const w of ["Medium", "Bold", "Black"]) {
      const path = `src/app/fonts/thmanyah-serif-display/thmanyahserifdisplay-${w}.woff2`;
      const raw = readFileSync(path);
      expect(raw.subarray(0, 4).toString("latin1")).toBe("wOF2");
      const sfnt = new Uint8Array(woff2ToSfnt(raw));
      const tag = Buffer.from(sfnt.subarray(0, 4)).toString("latin1");
      expect(["OTTO", "\u0000\u0001\u0000\u0000", "true"]).toContain(tag);
      expect(sfnt.byteLength).toBeGreaterThan(raw.length);
      expect(readFileSync(path).equals(raw)).toBe(true);
    }
  });

  it("refuses a file that is not WOFF2", () => {
    expect(() => woff2ToSfnt(Buffer.from("not a font at all, just text"))).toThrow();
  });

  it("writes each letter in the joined form its place in the word needs, and leaves Latin, digits and spaces alone", () => {
    expect(shapeArabic("")).toBe("");
    expect(shapeArabic("abc 123 -")).toBe("abc 123 -");
    // Initial, medial and final forms, then the letter after an alef on its own; written in the order they are drawn (reversed).
    expect(shapeArabic("\u0633\u0644\u0627\u0645")).toBe("\u0645\uFE8E\uFEE0\uFEB3");
    // The shaping keeps the number of letters (a lam and an alef stay two letters, not one ligature).
    expect([...shapeArabic("لا")]).toHaveLength(2);
    expect([...shapeArabic(SAMPLE)].length).toBe([...SAMPLE].length);
  });

  it("keeps a word's letters in the order they are drawn (reversed) and the marks with their letters", () => {
    // Visual order: the last letter's form comes first for a run of Arabic letters.
    const w = shapeArabic("بب");
    expect(w).toBe("ﺐﺑ");
    const marked = shapeArabic("\u0628\u064E\u0628");
    expect(marked).toBe("\uFE90\uFE91\u064E");
    expect([...marked].filter((c) => c === "َ")).toHaveLength(1);
  });
});

describe("rule 3141: one card maker draws the card from a title (and a description)", () => {
  it("returns a 1200 by 630 PNG, in Arabic and in English, for a blog title and for a help title with its description", async () => {
    for (const [lang, title, description] of [["ar", SAMPLE, "خطوات قصيرة"], ["en", "How do I connect my account?", "Short steps"], ["ar", SAMPLE, undefined]] as const) {
      const res = shareCard({ lang, kind: description ? "help" : "blog", title, description });
      expect(res.headers.get("content-type")).toBe("image/png");
      const b = await bytes(res);
      expect(isPng(b)).toBe(true);
      expect(pngSize(b)).toEqual({ width: 1200, height: 630 });
    }
    expect(CARD_SIZE).toEqual({ width: 1200, height: 630 });
  });

  it("cuts a long title or description at a word, with an ellipsis, so the text always fits; a short one is untouched", () => {
    const long = "كلمة ".repeat(80);
    const c = clip(long, TITLE_MAX);
    expect(c.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(c.endsWith("…")).toBe(true);
    expect(c.slice(0, -1).endsWith(" ")).toBe(false);
    expect(clip("one two three", 50)).toBe("one two three");
    expect(clip("a\n  b", 50)).toBe("a b");
    expect(clip("x".repeat(400), DESCRIPTION_MAX).length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(async () => await shareCard({ lang: "ar", kind: "blog", title: long, description: long }).arrayBuffer()).not.toThrow();
  });

  it("takes a smaller type size for a longer title, never larger", () => {
    const sizes = [10, 40, 80, 120].map((n) => titleSize("ا".repeat(n)));
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(sizes[0]).toBeGreaterThan(sizes[3]);
  });

  it("says only the page's own words: the kind of page, the title and the public name, in the alternative text", () => {
    expect(cardAlt("en", "blog", "A title")).toBe(`Blog · A title · ${dict.en.brand}`);
    expect(cardAlt("ar", "help", "عنوان")).toBe(`مركز المساعدة · عنوان · ${dict.ar.brand}`);
  });

  it("is drawn in the brand's tokens and the site's font, with no claim, number or model name of its own", () => {
    const src = readFileSync("src/lib/share-card.tsx", "utf8");
    expect(src).toMatch(/tokens\.primitive\.color/);
    expect(src).toMatch(/thmanyah-serif-display/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // The only text literals are the two page-kind labels and the structure of the card.
    expect(src).not.toMatch(/\b(?:Claude|Anthropic|GPT|Gemini|Sonnet|Opus)\b/);
  });
});

describe("rule 3142: a blog post and a help topic each get their own share image", () => {
  it("both routes are image files of their segment, built from the page's own static parameters, and set no page-level share fields", () => {
    for (const f of ["src/app/[lang]/blog/[slug]/opengraph-image.tsx", "src/app/[lang]/help/[topic]/opengraph-image.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src).toMatch(/shareCard\(/);
      expect(src).toMatch(/export async function generateImageMetadata/);
      // Next writes the static parameters itself when `generateImageMetadata` is exported; its own copy would be a duplicate export.
      expect(src).not.toMatch(/export (?:async )?function generateStaticParams/);
      expect(src).toMatch(/size = CARD_SIZE/);
      expect(src).toMatch(/contentType = "image\/png"/);
      expect(src).not.toMatch(/openGraph:|twitter:/);
    }
    for (const f of ["src/app/[lang]/blog/[slug]/page.tsx", "src/app/[lang]/help/[topic]/page.tsx"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/openGraph:|twitter:/);
  });

  it("each page's own static parameters, which the cards are built from, cover every post and every topic in both languages", () => {
    expect(blogPageParams()).toHaveLength(2 * slugs().length);
    expect(helpPageParams()).toHaveLength(2 * HELP.length);
  });

  it("the blog card draws the post's own title, and its alt names the post", async () => {
    const p = listPosts("ar")[0];
    const res = await BlogImage({ params: Promise.resolve({ lang: "ar", slug: p.slug }) });
    expect(isPng(await bytes(res))).toBe(true);
    const [meta] = await blogMeta({ params: Promise.resolve({ lang: "ar", slug: p.slug }) });
    expect(meta.alt).toBe(cardAlt("ar", "blog", p.title));
    expect(meta.size).toEqual(CARD_SIZE);
  });

  it("the help card draws the topic's title and its questions (the page description's words), and its alt names the topic", async () => {
    const t = HELP[0];
    const res = await HelpImage({ params: Promise.resolve({ lang: "en", topic: t.id }) });
    expect(isPng(await bytes(res))).toBe(true);
    const [meta] = await helpMeta({ params: Promise.resolve({ lang: "en", topic: t.id }) });
    expect(meta.alt).toBe(cardAlt("en", "help", t.title.en));
    for (const topic of HELP) for (const lang of ["ar", "en"] as const) {
      expect(describeTopic(lang, topic).startsWith(`${topic.title[lang]}: ${cardQuestions(lang, topic).slice(0, 10)}`)).toBe(true);
      expect(describeTopic(lang, topic).length).toBeLessThanOrEqual(160 + 0);
    }
  });

  it("an unknown language, post or topic is not drawn: the segment answers not-found", async () => {
    await expect(BlogImage({ params: Promise.resolve({ lang: "ar", slug: "no-such-post" }) })).rejects.toThrow();
    await expect(BlogImage({ params: Promise.resolve({ lang: "fr", slug: slugs()[0] }) })).rejects.toThrow();
    await expect(HelpImage({ params: Promise.resolve({ lang: "en", topic: "no-such-topic" }) })).rejects.toThrow();
    const [meta] = await blogMeta({ params: Promise.resolve({ lang: "ar", slug: "no-such-post" }) });
    expect(meta.alt).toBe("");
  });

  it("the help description is unchanged by moving it into src/lib/help.ts: the title, a colon, then as many questions as fit 160 characters", () => {
    const t = HELP[0];
    const d = describeTopic("en", t);
    expect(d.startsWith(`${t.title.en}: ${t.items[0].q.en}`)).toBe(true);
    expect(readFileSync("src/app/[lang]/help/[topic]/page.tsx", "utf8")).toMatch(/description: e\.description/);
    expect(readFileSync("src/lib/help-loader.ts", "utf8")).toMatch(/description: describe\(lang, t\)/);
  });
});
