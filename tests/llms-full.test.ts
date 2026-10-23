import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { GET, dynamic } from "@/app/llms-full.txt/route";
import { GET as llmsIndex } from "@/app/llms.txt/route";
import sitemap from "@/app/sitemap";
import { appOrigin } from "@/lib/origin";
import { dict } from "@/lib/i18n";
import { helpTopics, ORIGIN_SLOT } from "@/lib/help";
import { listPosts } from "@/lib/blog";
import { SITE_DEFAULT } from "@/lib/page-meta";

/**
 * Rule 3143: `/llms-full.txt` prints the help answers and the blog posts as plain text, copy only, built once at build time
 * like `/llms.txt` (rule 698), on the sitemap's origin, with nothing private in it. The idea is supastarter's llms-full.txt;
 * the code is ours.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

const read = async () => {
  const res = GET();
  return { res, text: await res.text() };
};

describe("rule 3143: /llms-full.txt is a static plain-text file of the help answers and the blog posts", () => {
  it("is built once at build time and answers 200 text/plain in UTF-8, like llms.txt", async () => {
    expect(dynamic).toBe("force-static");
    const { res, text } = await read();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect((await llmsIndex().text()).length).toBeGreaterThan(0);
    expect(res.headers.get("content-type")).toBe(llmsIndex().headers.get("content-type"));
    expect(text.endsWith("\n")).toBe(true);
  });

  it("opens with the Arabic name and summary, and the English ones come after", async () => {
    const { text } = await read();
    expect(text.startsWith(`# ${dict.ar.brand} (ar)\n\n> ${SITE_DEFAULT.ar.description}`)).toBe(true);
    expect(text.indexOf(`# ${dict.en.brand} (en)`)).toBeGreaterThan(text.indexOf(SITE_DEFAULT.ar.description));
  });

  it("holds every help answer in both languages, with the origin slot filled and none left over", async () => {
    const { text } = await read();
    const origin = appOrigin();
    let n = 0;
    for (const t of helpTopics(origin)) for (const i of t.items) for (const lang of ["ar", "en"] as const) {
      expect(text, `${t.id}/${i.slug}/${lang}`).toContain(i.a[lang].trim());
      expect(text).toContain(`### ${i.q[lang].replace(/\s+/g, " ").trim()}`);
      n++;
    }
    expect(n).toBeGreaterThan(80);
    expect(text).not.toContain(ORIGIN_SLOT);
  });

  it("holds every blog post's title, date, description and body in its language", async () => {
    const { text } = await read();
    for (const lang of ["ar", "en"] as const) {
      const posts = listPosts(lang);
      expect(posts.length).toBeGreaterThan(5);
      for (const p of posts) {
        expect(text, p.slug).toContain(`## ${p.title.replace(/\s+/g, " ").trim()}`);
        expect(text).toContain(p.body.trim());
        expect(text).toContain(p.date);
      }
    }
  });

  it("every address in it is a page the sitemap lists, on the sitemap's origin", async () => {
    const { text } = await read();
    const urls = [...text.matchAll(/^<(\S+)>$/gm)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(30);
    const listed = new Set(sitemap().map((e) => e.url));
    for (const u of urls) {
      expect(u.startsWith(`${appOrigin()}/`), u).toBe(true);
      expect(listed.has(u), `${u} is not in the sitemap`).toBe(true);
    }
  });

  it("carries nothing private: no app, API, admin, OAuth or partner address, and no secret-shaped value", async () => {
    const { text } = await read();
    // The one non-page address is the MCP endpoint the help answers already print on the help pages (with a closing full stop at most).
    for (const u of text.match(/https?:\/\/[^\s<>()[\]"']+/g) ?? []) {
      const path = new URL(u).pathname.replace(/[.,;:]+$/, "");
      if (path === "/api/mcp") continue;
      expect(path, u).not.toMatch(/\/(?:app|api|admin|oauth|partner|p)(?:\/|$)/);
    }
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN/);
    // Nothing is read from a request, a session, a store or the environment but the public origin.
    const code = readFileSync("src/app/llms-full.txt/route.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/currentUser|resolveSession|@\/lib\/db|process\.env|headers\(|NextRequest|request/i);
    expect(code.match(/^import .* from "(.*)";$/gm)?.map((l) => l.match(/"(.*)"/)?.[1]).sort()).toEqual(["@/lib/blog", "@/lib/help", "@/lib/i18n", "@/lib/origin", "@/lib/page-meta"]);
  });

  it("names the origin APP_ORIGIN has, as the sitemap does", async () => {
    vi.stubEnv("APP_ORIGIN", "https://example.test");
    const { text } = await read();
    expect(text).toContain("<https://example.test/ar/help/");
    expect(text).not.toContain(ORIGIN_SLOT);
  });

  it("is reached by the proxy as a file (the dot rule), not as a language-less page", async () => {
    const src = readFileSync("src/proxy.ts", "utf8");
    expect(src).toMatch(/\[\^\/\]\*\\\./);
  });
});
