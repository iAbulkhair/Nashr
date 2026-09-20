import { describe, expect, it } from "vitest";
import { listPosts, postIndex, slugs } from "@/lib/blog";
import sitemap from "@/app/sitemap";

describe("blog ordering", () => {
  it("is a valid comparator: total, and stable when every post shares a date", () => {
    const posts = listPosts("en");
    expect(posts.length).toBeGreaterThan(1);
    // Every post currently carries the same date, which is exactly the case the old comparator got wrong.
    const dates = new Set(posts.map((p) => p.date));
    for (let i = 1; i < posts.length; i++) {
      const prev = posts[i - 1], cur = posts[i];
      expect(prev.date >= cur.date, `${prev.slug} must not be older than ${cur.slug}`).toBe(true);
      if (prev.date === cur.date) expect(prev.slug.localeCompare(cur.slug), "ties break by slug").toBeLessThan(0);
    }
    expect(dates.size, "if this fails the tie case above stopped being exercised — keep a tie in the fixture").toBe(1);
  });

  it("both languages and slugs() agree on that order", () => {
    expect(listPosts("ar").map((p) => p.slug)).toEqual(listPosts("en").map((p) => p.slug));
    expect(slugs()).toEqual(listPosts("en").map((p) => p.slug));
  });
});

describe("sitemap", () => {
  const entries = sitemap();

  it("dates a blog URL from its own front matter, not from the build", () => {
    const dates = new Map(postIndex().map((p) => [p.slug, p.date]));
    const posts = entries.filter((e) => e.url.includes("/blog/"));
    expect(posts.length).toBe(dates.size * 2); // both languages
    for (const e of posts) {
      const slug = e.url.split("/blog/")[1];
      expect(e.lastModified, `${slug} must carry a date`).toBeDefined();
      expect((e.lastModified as Date).toISOString().slice(0, 10)).toBe(dates.get(slug));
    }
  });

  it("does not stamp every other URL with the build time", () => {
    const others = entries.filter((e) => !e.url.includes("/blog/"));
    expect(others.length).toBeGreaterThan(50);
    expect(others.every((e) => e.lastModified === undefined), "a build timestamp is not a modification date").toBe(true);
  });
});
