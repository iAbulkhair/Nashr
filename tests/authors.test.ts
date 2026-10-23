import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { authorFileProblems, authorIn, authorProblems, authors, initials, parseAuthors, type Authors } from "@/lib/authors";
import { listPosts, postEntry, postIn, postProblems } from "@/lib/blog";
import { articleJsonLd } from "@/lib/home-ld";
import PostByline from "@/components/PostByline";

/**
 * Rule 3315: a post may name an author from `content/authors.json` (`author: abulkhair-hejazy`). Today the file holds the founder
 * only, with no photo and no link; no existing post names him; a post without the line keeps the organisation byline, and the
 * Article data names a Person only when the post sets `author`. Nobody is invented.
 */
const GOOD = { "a-b": { name: { ar: "اسم", en: "Name" }, role: { ar: "دور", en: "Role" } } };
const with_ = (patch: (o: Record<string, Record<string, unknown>>) => void) => {
  const o = JSON.parse(JSON.stringify(GOOD));
  patch(o);
  return JSON.stringify(o);
};
const problems = (patch: (o: Record<string, Record<string, unknown>>) => void) => authorFileProblems(with_(patch)).join(" | ");

describe("rule 3315: content/authors.json today", () => {
  const raw = readFileSync("content/authors.json", "utf8");
  it("passes its own checks", () => {
    expect(authorFileProblems(raw)).toEqual([]);
    expect(() => authors()).not.toThrow();
  });
  it("holds the founder and nobody else, with the names he gave and no photo or link", () => {
    const a = authors();
    expect(Object.keys(a)).toEqual(["abulkhair-hejazy"]);
    expect(a["abulkhair-hejazy"]).toEqual({
      name: { ar: "أبوالخير حجازي", en: "Abulkhair Hejazy" },
      role: { ar: "المؤسس", en: "Founder" },
    });
  });
});

describe("rule 3315: the file's checks", () => {
  it("accepts a person with the three fields, and one with a link", () => {
    expect(authorFileProblems(JSON.stringify(GOOD))).toEqual([]);
    expect(problems((o) => { o["a-b"].link = "https://example.com/me"; })).toBe("");
  });
  it("rejects text that is not JSON, not an object, or an author that is not an object", () => {
    expect(authorFileProblems("{")).toEqual(["content/authors.json is not valid JSON"]);
    expect(authorFileProblems("[]").join()).toMatch(/must be an object of authors by id/);
    expect(authorFileProblems("null").join()).toMatch(/must be an object/);
    expect(authorFileProblems('{"a":"x"}').join()).toMatch(/must be an object/);
  });
  it("rejects an id that is not lowercase words joined by hyphens", () => {
    for (const id of ["A", "a b", "a_b", "-a", "a--b", "../a", ""]) expect(authorFileProblems(JSON.stringify({ [id]: GOOD["a-b"] })).join(), id).toMatch(/id must be lowercase words/);
  });
  it("needs a name and a role in both languages, plain text on one line", () => {
    expect(problems((o) => { delete o["a-b"].name; })).toMatch(/name needs an Arabic and an English text/);
    expect(problems((o) => { o["a-b"].role = { ar: "دور" }; })).toMatch(/role\.en is missing/);
    expect(problems((o) => { o["a-b"].name = { ar: " ", en: "N" }; })).toMatch(/name\.ar is missing/);
    expect(problems((o) => { o["a-b"].name = { ar: "اسم", en: 5 }; })).toMatch(/name\.en is missing/);
    expect(problems((o) => { o["a-b"].name = { ar: "اسم", en: "x".repeat(81) }; })).toMatch(/name\.en is 81 characters/);
    expect(problems((o) => { o["a-b"].name = { ar: "اسم", en: "<b>N</b>" }; })).toMatch(/plain text on one line/);
    expect(problems((o) => { o["a-b"].name = { ar: "اسم", en: "N\nM" }; })).toMatch(/plain text on one line/);
    expect(problems((o) => { o["a-b"].name = { ar: "اسم", en: " N" }; })).toMatch(/plain text on one line/);
    expect(problems((o) => { o["a-b"].name = { ar: "اسم", en: "N", fr: "N" }; })).toMatch(/name\.fr is not a language/);
  });
  it("has no photo field, or any other field a page would silently ignore", () => {
    expect(problems((o) => { o["a-b"].photo = "/me.png"; })).toMatch(/"photo" is not a field .* there is no photo/);
    expect(problems((o) => { o["a-b"].bio = "x"; })).toMatch(/"bio" is not a field/);
  });
  it("takes a link only as an https address without a login in it", () => {
    for (const l of ["http://example.com", "javascript:alert(1)", "//example.com", "example.com", "https://u:p@example.com", "https://user@example.com", "mailto:a@b.c", "data:text/html,x", 5, "https://example.com/" + "x".repeat(200), ""]) {
      expect(problems((o) => { o["a-b"].link = l; }), String(l).slice(0, 30)).toMatch(/link must be an https address/);
    }
  });
  it("names every problem at once and makes the loader throw with them", () => {
    const raw = JSON.stringify({ A: { name: { ar: "x" }, role: 1, photo: "p" } });
    expect(authorFileProblems(raw).length).toBeGreaterThan(3);
    expect(() => parseAuthors(raw)).toThrow(/content\/authors\.json has \d+ problem/);
    expect(parseAuthors(JSON.stringify(GOOD))).toEqual(GOOD);
  });
});

describe("rule 3315: reading an author", () => {
  const A = GOOD as Authors;
  it("gives the name and role in the page's language, and the link when there is one", () => {
    expect(authorIn(A, "a-b", "ar")).toEqual({ id: "a-b", name: "اسم", role: "دور" });
    expect(authorIn(A, "a-b", "en")).toEqual({ id: "a-b", name: "Name", role: "Role" });
    expect(authorIn({ x: { ...A["a-b"], link: "https://example.com/x" } }, "x", "en")).toMatchObject({ link: "https://example.com/x" });
  });
  it("gives nobody for no author, an empty one or one that is not listed, including names an object inherits", () => {
    expect(authorIn(A, undefined, "en")).toBeNull();
    expect(authorIn(A, "", "en")).toBeNull();
    expect(authorIn(A, "nobody", "en")).toBeNull();
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(authorIn(A, k, "en"), k).toBeNull();
      expect(authorProblems("p.md", { author: k }, A).join(), k).toMatch(/is not in content\/authors\.json/);
    }
  });
  it("makes initials from the first letters of the first two words", () => {
    expect(initials("Abulkhair Hejazy")).toBe("AH");
    expect(initials("أبوالخير حجازي")).toBe("أح");
    expect(initials("  Single ")).toBe("S");
    expect(initials("A B C")).toBe("AB");
    expect(initials("")).toBe("");
    expect(initials("😀 Smile")).toBe("😀S");
  });
});

describe("rule 3315: the author line of a post", () => {
  const FM = (extra: string) => `---\ntitle_ar: عنوان\ndesc_ar: وصف\ntitle_en: Title\ndesc_en: Description\ndate: 2026-01-02\n${extra}---\nنص\n---EN---\ntext\n`;
  const none = () => null;
  it("passes with no line, and with a listed person", () => {
    expect(postProblems("p.md", FM(""), none, GOOD as Authors)).toEqual([]);
    expect(postProblems("p.md", FM("author: a-b\n"), none, GOOD as Authors)).toEqual([]);
  });
  it("fails for a person who is not listed or an empty line, naming who is", () => {
    expect(postProblems("p.md", FM("author: someone\n"), none, GOOD as Authors).join()).toMatch(/author "someone" is not in content\/authors\.json \(a-b\)/);
    expect(postProblems("p.md", FM("author:\n"), none, GOOD as Authors).join()).toMatch(/author is empty/);
  });
  it("shows the author in the page's language, and none when the post names none", () => {
    const e = postEntry("p.md", FM("author: a-b\n"));
    expect(postIn(e, "ar", GOOD as Authors).author).toEqual({ id: "a-b", name: "اسم", role: "دور" });
    expect(postIn(e, "en", GOOD as Authors).author?.name).toBe("Name");
    expect(postIn(postEntry("p.md", FM("")), "en", GOOD as Authors).author).toBeNull();
  });
  it("is not given to any existing post: none of the real posts names an author", () => {
    for (const f of readdirSync("content/blog")) expect(readFileSync(`content/blog/${f}`, "utf8"), f).not.toMatch(/^author:/m);
    for (const l of ["ar", "en"] as const) for (const p of listPosts(l)) expect(p.author, p.slug).toBeNull();
  });
});

describe("rule 3315: the Article data", () => {
  const base = { slug: "x", title: "T", desc: "D", date: "2026-01-02" };
  it("keeps the organisation as author when the post sets none", () => {
    for (const p of [base, { ...base, author: null }]) {
      const ld = articleJsonLd("en", "https://o.test", p) as { author: { "@type": string }; publisher: { "@type": string } };
      expect(ld.author["@type"]).toBe("Organization");
      expect(ld.publisher["@type"]).toBe("Organization");
    }
  });
  it("names a Person, with only the name and role the file holds, when the post sets one; the publisher stays the organisation", () => {
    const ld = articleJsonLd("en", "https://o.test", { ...base, author: { id: "a-b", name: "Name", role: "Role" } }) as { author: Record<string, unknown>; publisher: { "@type": string } };
    expect(ld.author).toEqual({ "@type": "Person", name: "Name", jobTitle: "Role" });
    expect(ld.publisher["@type"]).toBe("Organization");
  });
  it("adds the person's own address only when the file gives one", () => {
    const ld = articleJsonLd("en", "https://o.test", { ...base, author: { id: "a-b", name: "Name", role: "Role", link: "https://example.com/me" } }) as { author: Record<string, unknown> };
    expect(ld.author.url).toBe("https://example.com/me");
    expect(ld.author).not.toHaveProperty("sameAs");
  });
});

describe("rule 3315: the byline on the page", () => {
  const html = (link?: string, lang: "ar" | "en" = "en") => renderToStaticMarkup(PostByline({ lang, author: { id: "a-b", name: lang === "ar" ? "اسم كامل" : "Full Name", role: "Role", ...(link ? { link } : {}) } }));
  it("draws initials, name and role, and never a photo", () => {
    const h = html();
    expect(h).toContain(">FN<");
    expect(h).toContain("Full Name");
    expect(h).toContain("Role");
    expect(h).not.toMatch(/<img|<a /);
    expect(html(undefined, "ar")).toContain(">اك<");
  });
  it("links the name to the person's own page, in a new tab that cannot reach back, when the file gives one", () => {
    const h = html("https://example.com/me");
    expect(h).toContain('href="https://example.com/me"');
    expect(h).toContain('rel="noopener noreferrer"');
    expect(h).toContain("opens in a new tab");
  });
  it("is drawn by the post page only for a post that names an author", () => {
    const page = readFileSync("src/app/[lang]/blog/[slug]/page.tsx", "utf8");
    expect(page).toMatch(/\{p\.author && <PostByline lang=\{sl\} author=\{p\.author\} \/>\}/);
  });
});
