import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LINK_SEGMENTS, langPath, render, type CodeHighlighter } from "@/lib/md";
import { highlightCode, knowsLanguage } from "@/lib/md-highlight";
import { renderPost } from "@/lib/blog-render";
import { listPosts } from "@/lib/blog";
import { PUBLIC_SEGMENTS } from "@/proxy";

/**
 * Rules 3311 and 3312: a post is Markdown, never MDX, so it can neither run code nor load a component. It gets fenced code
 * with server-side syntax highlighting and links that know whether they stay on the site, and everything still passes
 * through the one `render` in src/lib/md.ts. The idea of both is supastarter's blog (its MDX and Shiki setup); the code is ours.
 */

/** Every tag and attribute `render` may write. Anything else in its output would be markup from the input. */
const TAGS = new Set(["p", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "strong", "code", "a", "pre", "span", "hr"]);
const ATTRS: Record<string, string[]> = { a: ["href", "target", "rel", "data-external"], pre: ["class", "dir", "tabindex", "data-lang"], code: ["class"], span: ["style", "class"] };

function markupProblems(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    const [, , tag, rest] = m;
    if (!TAGS.has(tag)) { out.push(`tag <${tag}>`); continue; }
    for (const a of rest.matchAll(/\s([a-zA-Z][\w:-]*)(?:="([^"]*)")?/g)) {
      if (!(ATTRS[tag] ?? []).includes(a[1])) out.push(`attribute ${a[1]} on <${tag}>`);
      if (a[1] === "style" && !/^color:#[0-9a-fA-F]{3,8}$/.test(a[2] ?? "")) out.push(`style ${a[2]}`);
    }
  }
  return out;
}
const codeOf = (html: string) => html.replace(/^[\s\S]*?<code[^>]*>/, "").replace(/<\/code>[\s\S]*$/, "");
const textOf = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

describe("rule 3311: fenced code in Markdown", () => {
  it("renders a fence as a left-to-right, keyboard-scrollable code block with the language, its text escaped and untouched by Markdown", () => {
    const html = render("before\n\n```ts\nconst a = 1 < 2 && \"x\";\n\n**not bold** # not a heading | not | a table\n- not a list\n```\n\nafter");
    expect(html).toContain('<pre class="code" dir="ltr" tabindex="0" data-lang="ts"><code class="language-ts">');
    expect(html).toContain("const a = 1 &lt; 2 &amp;&amp; &quot;x&quot;;\n\n**not bold** # not a heading | not | a table\n- not a list</code></pre>");
    expect(html).toContain("<p>before</p>");
    expect(html).toContain("<p>after</p>");
    expect(html).not.toMatch(/<(strong|h\d|table|ul|li)\b/);
  });

  it("keeps blank lines inside the block, takes a tilde fence, closes only on the same mark that is long enough, and closes at the end of the text", () => {
    expect(render("```\na\n\nb\n```")).toContain("<code>a\n\nb</code>");
    expect(render("~~~sh\nls\n~~~")).toContain('data-lang="sh"');
    const long = render("````\n```\nstill code\n````\nout");
    expect(long).toContain("<code>```\nstill code</code>");
    expect(long).toContain("<p>out</p>");
    expect(render("~~~\n```\nx\n~~~")).toContain("<code>```\nx</code>");
    const open = render("```js\nnever closed");
    expect(open).toContain("never closed</code></pre>");
  });

  it("a one-line triple-backtick span is still inline code, and a bare fence line opens a block rather than a paragraph", () => {
    expect(render("see ```x``` here")).not.toContain("<pre");
    expect(render("```js```")).not.toContain("<pre");
    expect(render("```\nx\n```")).toBe('<pre class="code" dir="ltr" tabindex="0"><code>x</code></pre>');
  });

  it("neutralises markup in the code and in the language name: nothing but escaped text, and a language with an attribute break is dropped", () => {
    const evil = render('```js" onclick="alert(1)\n</code></pre><script>alert(1)</script><img src=x onerror=alert(1)>\n```');
    expect(evil).not.toContain("<script");
    expect(evil).not.toContain("<img");
    expect(evil).not.toContain('onclick="');
    expect(evil).toContain("&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;");
    expect(markupProblems(evil)).toEqual([]);
    expect(render("```<b>\nx\n```")).not.toContain("<b>");
    expect(render("```a b c\nx\n```")).toContain('data-lang="a"');
  });

  it("highlights with Shiki on the server: coloured spans with the text escaped, the same text back, aliases known, other languages plain", () => {
    expect(knowsLanguage("ts")).toBe(true);
    expect(knowsLanguage("sh")).toBe(true);
    expect(knowsLanguage("yml")).toBe(true);
    expect(knowsLanguage("brainfuck")).toBe(false);
    const code = 'const s: string = "<b>x</b>"; // a & b';
    const html = render("```ts\n" + code + "\n```", { highlight: highlightCode });
    expect(html).toMatch(/<span style="color:#[0-9a-f]{6}">/i);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(markupProblems(html)).toEqual([]);
    expect(textOf(codeOf(html))).toBe(code);
    const plain = render("```brainfuck\n+++\n```", { highlight: highlightCode });
    expect(plain).not.toContain("<span");
    expect(plain).toContain("<code class=\"language-brainfuck\">+++</code>");
    expect(render("```ts\nlet a = 1\n```")).not.toContain("<span");
  });

  it("highlights every language the portal loads without losing a character", () => {
    const samples: Record<string, string> = {
      bash: "echo \"$HOME\" | grep x && ls -la", css: "a:hover { color: #fff; }", diff: "- old\n+ new", html: "<div class=\"a\">x</div>",
      js: "export const f = (a) => a + 1;", json: '{"a": [1, 2, null]}', jsx: "const x = <A b={1} />;", md: "# T\n\n- a",
      python: "def f(x):\n    return x * 2", sql: "select * from t where a = 1;", tsx: "const y = <div>{x}</div>;", ts: "type A = { b: number };", yaml: "a:\n  - b: 1",
    };
    for (const [lang, code] of Object.entries(samples)) {
      const html = render("```" + lang + "\n" + code + "\n```", { highlight: highlightCode });
      expect(html, lang).toContain("<span");
      expect(markupProblems(html), lang).toEqual([]);
      expect(textOf(codeOf(html)), lang).toBe(code);
    }
  });

  it("trusts nothing from a highlighter: text is escaped and a colour that is not #hex is dropped", () => {
    const bad: CodeHighlighter = () => [[
      { text: "<script>x</script>", color: "#ff0000" },
      { text: "a", color: 'red;background:url(//evil.example/x)' },
      { text: "b", color: '#fff" onmouseover="x' },
      { text: "c", color: "expression(alert(1))" },
      { text: "d" },
    ]];
    const html = render("```ts\nzzz\n```", { highlight: bad });
    expect(html).toContain('<span style="color:#ff0000">&lt;script&gt;x&lt;/script&gt;</span>abcd');
    expect(html).not.toMatch(/evil|onmouseover|expression/);
    expect(markupProblems(html)).toEqual([]);
    // A highlighter that does not know the language leaves the plain block, and one is never asked about a fence with no language.
    expect(render("```nope\nq\n```", { highlight: () => null })).toContain("<code class=\"language-nope\">q</code>");
    let asked = 0;
    render("```\nq\n```", { highlight: () => { asked++; return null; } });
    expect(asked).toBe(0);
  });

  it("the highlighter is not part of the browser bundle: render takes it as an option and md.ts imports no highlighter", () => {
    const md = readFileSync("src/lib/md.ts", "utf8");
    expect(md).not.toMatch(/^import .*(shiki|md-highlight)/m);
    expect(readFileSync("src/lib/md-highlight.ts", "utf8")).toMatch(/This file must not be imported by a client component/);
    for (const f of ["src/components/app/ChatPanel.tsx", "src/components/home/GalleryTabs.tsx", "src/components/app/Inbox.tsx"]) expect(readFileSync(f, "utf8")).not.toMatch(/md-highlight|blog-render/);
  });

  it("a post is Markdown, not MDX: no MDX package, and the blog page renders through renderPost only", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /mdx|content-collections|rehype|remark/i.test(d))).toEqual([]);
    expect(pkg.dependencies.shiki).toMatch(/^\d+\.\d+\.\d+$/);
    const page = readFileSync("src/app/[lang]/blog/[slug]/page.tsx", "utf8");
    expect(page).toContain("renderPost(lang, p.body)");
    expect(page).not.toMatch(/\brender\(/);
  });
});

describe("rule 3311: script and HTML injection in a post stays neutralised", () => {
  const ATTACKS = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<iframe src=//evil.example></iframe>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "<svg onload=alert(1)>",
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD4=)",
    "[x](vbscript:msgbox(1))",
    "[x](//evil.example/path)",
    "[x](/\\evil.example)",
    "[x](https://a.example/\" onmouseover=\"alert(1))",
    "[x](https://a.example/'><script>alert(1)</script>)",
    "**<b onclick=alert(1)>x</b>**",
    "`<script>`",
    "| <script> | b |\n|---|---|\n| <img src=x onerror=1> | d |",
    "# <script>alert(1)</script>",
    "- <script>alert(1)</script>",
    "1. <img src=x onerror=1>",
    "```html\n<script>alert(1)</script>\n```",
    "```\n</pre><script>alert(1)</script>\n```",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
  ];

  it.each(["ar", "en"] as const)("every attack, rendered the way the blog renders a post (%s), writes only the tags and attributes render writes", (lang) => {
    for (const a of ATTACKS) {
      const html = renderPost(lang, a);
      expect(markupProblems(html), a).toEqual([]);
      expect(html, a).not.toMatch(/<script|<img|<iframe|<svg|<b[ >]/i);
      expect(html, a).not.toMatch(/href="(?:javascript|data|vbscript):/i);
    }
  });

  it("an entity written in a post is shown as text, never decoded into markup", () => {
    expect(renderPost("en", "&lt;script&gt;")).toBe("<p>&amp;lt;script&amp;gt;</p>");
  });

  it("every real post, in both languages, renders to nothing but the allowed markup", () => {
    for (const lang of ["ar", "en"] as const) for (const p of listPosts(lang)) expect(markupProblems(renderPost(lang, p.body)), `${lang}/${p.slug}`).toEqual([]);
  });
});

describe("rule 3312: links in a post", () => {
  const a = (md: string, opts = {}) => render(md, opts);

  it("an external link opens in a new tab that cannot reach back, is marked for a screen reader in the page's language, and carries the attribute the arrow is drawn from", () => {
    expect(a("[docs](https://example.com/a?b=1&c=2)")).toBe('<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer" data-external="">docs</a></p>');
    expect(a("[docs](https://example.com)", { lang: "en" })).toContain('<span class="sr-only"> (opens in a new tab)</span></a>');
    expect(a("[docs](https://example.com)", { lang: "ar" })).toContain('<span class="sr-only"> (يفتح في تبويب جديد)</span></a>');
    expect(a("[docs](http://example.com)")).toContain('rel="noopener noreferrer"');
    expect(readFileSync("src/app/globals.css", "utf8")).toMatch(/\.prose-nashr a\[data-external\]::after \{ content: "\\2197"/);
  });

  it("an internal link stays in the tab, with no target and no rel, and gets the page's language prefix", () => {
    expect(a("[p](/pricing)", { lang: "ar" })).toBe('<p><a href="/ar/pricing">p</a></p>');
    expect(a("[p](/pricing#plans)", { lang: "en" })).toBe('<p><a href="/en/pricing#plans">p</a></p>');
    expect(a("[p](/for/clinics?x=1)", { lang: "en" })).toContain('href="/en/for/clinics?x=1"');
    expect(a("[p](/app/signup)", { lang: "ar" })).toContain('href="/ar/app/signup"');
    expect(a("[p](/pricing)")).toContain('href="/pricing"');
    expect(a("[p](/ar/pricing)", { lang: "ar" })).not.toMatch(/target|rel=/);
  });

  it("a link written for the other language lands on this language's page, and a path that is not a page is left alone", () => {
    expect(a("[p](/en/pricing)", { lang: "ar" })).toContain('href="/ar/pricing"');
    expect(a("[p](/ar)", { lang: "en" })).toContain('href="/en"');
    expect(a("[p](/)", { lang: "en" })).toContain('href="/en"');
    expect(a("[p](/p/abc)", { lang: "ar" })).toContain('href="/p/abc"');
    expect(a("[p](/api/health)", { lang: "ar" })).toContain('href="/api/health"');
    expect(a("[p](/robots.txt)", { lang: "ar" })).toContain('href="/robots.txt"');
    expect(langPath("/en/blog/x?y=1#z", "ar")).toBe("/ar/blog/x?y=1#z");
    expect(langPath("/blog/x", "en")).toBe("/en/blog/x");
    expect(langPath("/blogger", "en")).toBe("/blogger");
  });

  it("this site's own absolute address is an internal link, another host or a look-alike is external", () => {
    const o = { lang: "ar", origin: "https://thakeen.com" } as const;
    expect(a("[p](https://thakeen.com/en/pricing?x=1#a)", o)).toBe('<p><a href="/ar/pricing?x=1#a">p</a></p>');
    expect(a("[p](https://thakeen.com)", o)).toContain('href="/ar"');
    expect(a("[p](https://thakeen.com.evil.example/pricing)", o)).toContain("data-external");
    expect(a("[p](https://evil.example/https://thakeen.com/x)", o)).toContain("data-external");
    // A path that parses to `//host` is never turned into a protocol-relative link: it stays an absolute address.
    const odd = a("[p](https://thakeen.com//evil.example/x)", o);
    expect(odd).not.toMatch(/href="\/\//);
    expect(odd).toContain("data-external");
    expect(a("[p](https://thakeen.com/pricing)", { lang: "en" })).toContain("data-external");
  });

  it("an anchor, a mail link and an unsafe target keep their old behaviour", () => {
    expect(a("[t](#top)", { lang: "en" })).toBe('<p><a href="#top">t</a></p>');
    expect(a("[m](mailto:hello@example.com)")).toContain('href="mailto:hello@example.com" rel="noopener noreferrer"');
    for (const bad of ["javascript:alert", "//evil.example", "/\\evil.example", "data:text/html,x", "ftp://example.com", "relative/path"]) {
      expect(a(`[x](${bad})`, { lang: "en", origin: "https://thakeen.com" }), bad).toBe('<p><a href="#">x</a></p>');
    }
  });

  it("a link's text is escaped and cannot add an attribute, in any option", () => {
    const html = a('[<b onclick="x">t</b>](https://example.com/"q")', { lang: "en", origin: "https://thakeen.com" });
    expect(markupProblems(html)).toEqual([]);
    expect(html).not.toContain("<b");
  });

  it("the page segments a link may carry the language on are the proxy's public segments and the app", () => {
    expect([...LINK_SEGMENTS].sort()).toEqual([...PUBLIC_SEGMENTS, "app"].sort());
  });

  it("every internal link in every real post, rendered for its page, is under that page's language", () => {
    for (const lang of ["ar", "en"] as const) {
      for (const p of listPosts(lang)) {
        const hrefs = [...renderPost(lang, p.body).matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);
        expect(hrefs.length, `${lang}/${p.slug}`).toBeGreaterThan(0);
        for (const h of hrefs) expect(h.startsWith(`/${lang}/`) || h === `/${lang}`, `${lang}/${p.slug} ${h}`).toBe(true);
      }
    }
  });

  it("the plain output other callers get (chat, inbox) changes only in its external links", () => {
    expect(render("**a** [b](/ar/c) `d`")).toBe('<p><strong>a</strong> <a href="/ar/c">b</a> <code>d</code></p>');
  });
});
