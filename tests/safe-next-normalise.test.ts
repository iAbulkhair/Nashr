/**
 * `safeNext` returns the path it checked (rule 694, docs/system/tests.md). The URL parser resolves dot segments, `%2e`
 * included, so a string that starts with a single `/` can still name the path `//host`; the function now returns the
 * parsed path, query and fragment and refuses one that starts with `//`. Rules 543-545 (security-auth-fixes.test.ts)
 * keep the refusals on the raw string; this file pins what is returned after them, for `?next=` and Markdown links.
 * Markdown hrefs reach `safeHref` HTML-escaped, and the browser decodes them before it parses the URL, so the link
 * checks here read the href the way a browser does (`hrefOf`), not as the escaped text.
 */
import { describe, expect, it } from "vitest";
import { safeHref, safeNext } from "@/lib/safe-next";
import { render } from "@/lib/md";

const SITE = "https://thakeen.com";

/** The href a browser follows: the first `href` attribute with its character references decoded in one pass. */
function hrefOf(html: string): string {
  const m = html.match(/href="([^"]*)"/);
  if (!m) throw new Error(`no href in ${html}`);
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return m[1].replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (e, r: string) => {
    if (r[0] !== "#") return named[r] ?? e;
    const hex = r[1] === "x" || r[1] === "X";
    return String.fromCodePoint(parseInt(r.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

describe("rule 694: safeNext returns the normalised path, query and fragment, and refuses it when normalisation yields //host", () => {
  const escapes = [
    "/.//evil.example",
    "/a/../..//evil.example",
    "/a/..//evil.example",
    "/..//evil.example",
    "/%2e%2e//evil.example",
    "/%2E%2e//evil.example",
    "/.%2e//evil.example",
    "/ar/app/%2e%2e/%2e%2e/.//evil.example",
    "/.//evil.example?x=1#y",
    // md.ts turns `'` into `&#39;`, whose `#` would hide the rest of the path from the parser if safeHref checked the
    // escaped text; the browser decodes it first and resolves these to //evil.example.
    "/'/..//evil.example",
    "/a'/../..//evil.example",
    "/x'/../..//evil.example",
    "/a'/%2e%2e//evil.example",
    "/'/%2e%2e//evil.example/path",
  ];

  it("refuses every dot-segment form that resolves to //host, in safeNext, safeHref and rendered Markdown", () => {
    for (const n of escapes) {
      expect(safeNext(n), JSON.stringify(n)).toBe("");
      expect(safeHref(n), JSON.stringify(n)).toBe("#");
      expect(render(`[x](${n})`), JSON.stringify(n)).toContain('href="#"');
    }
    // The escaped form md.ts hands over is refused too, not only the raw one.
    expect(safeHref("/&#39;/..//evil.example")).toBe("#");
    expect(safeHref("/a&#39;/%2e%2e//evil.example")).toBe("#");
  });

  it("keeps normal paths with a query and a fragment exactly as they were", () => {
    for (const p of [
      "/",
      "/ar/app/inbox",
      "/en/app?tab=plans#x",
      "/ar/app/login?next=%2Fen%2Fapp",
      "/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fx.example%2Fcb&state=s&code_challenge=Zx-_9",
    ]) expect(safeNext(p), p).toBe(p);
  });

  it("does not decode %2F, so an encoded // stays a path on this site", () => {
    expect(safeNext("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example");
    expect(safeNext("/%2f%2fevil.example")).toBe("/%2f%2fevil.example");
    expect(safeNext("/ar/%2F%2Fevil.example?x=%2F%2F")).toBe("/ar/%2F%2Fevil.example?x=%2F%2F");
    expect(new URL(safeNext("/%2F%2Fevil.example"), SITE).origin).toBe(SITE);
  });

  it("returns the parsed form, not the raw string: dot segments resolved, spaces and non-ASCII percent-encoded", () => {
    expect(safeNext("/ar/app/../updates")).toBe("/ar/updates");
    expect(safeNext("/./en/app")).toBe("/en/app");
    expect(safeNext("/ar/app/%2e%2e/inbox")).toBe("/ar/inbox");
    expect(safeNext("/a b?q=a b#c d")).toBe("/a%20b?q=a%20b#c%20d");
    expect(safeNext("/ar/مدونة")).toBe("/ar/%D9%85%D8%AF%D9%88%D9%86%D8%A9");
  });

  it("checks the decoded href and escapes the result again, so ordinary rendered links are unchanged", () => {
    // md.ts escapes the whole line before it finds links, so `&` and `'` reach safeHref as `&amp;` and `&#39;`, and the
    // result goes into the attribute as it is.
    expect(render("[x](/en/app?a=1&b=2)")).toContain('href="/en/app?a=1&amp;b=2"');
    expect(render("[x](/en/it's)")).toContain('href="/en/it&#39;s"');
    expect(render("[x](/ar/app/../updates)")).toContain('href="/ar/updates"');
    expect(render("[x](#it's)")).toContain('href="#it&#39;s"');
    expect(render("[x](https://x.example/?a=1&b=2)")).toContain('href="https://x.example/?a=1&amp;b=2"');
    expect(render("[x](mailto:a@b.co)")).toContain('href="mailto:a@b.co"');
    // A quote or angle bracket in a path is percent-encoded by the parser, so it can never close the attribute.
    expect(render('[x](/a"b<c>)')).toContain('href="/a%22b%3Cc%3E"');
    // Text that only looks like an entity stays text: `&#39;` typed in the Markdown is `&amp;#39;` after md.ts, the
    // browser reads `&#39;` back, and its `#` starts a fragment there as it does here.
    const typed = hrefOf(render("[x](/a&#39;/..//evil.example)"));
    expect(typed).toBe("/a&#39;/..//evil.example");
    expect(new URL(typed, SITE).pathname).toBe("/a&");
  });

  it("over every short mix of dot, encoded-dot and empty segments: never //, idempotent, and the same destination as the raw path", () => {
    const parts = [".", "..", "%2e", "%2E%2e", "", "a", "evil.example"];
    let inputs = [""];
    const all: string[] = [];
    for (let len = 0; len < 4; len++) {
      inputs = inputs.flatMap((p) => parts.map((s) => `${p}/${s}`));
      all.push(...inputs);
    }
    let refusedAfterParse = 0;
    for (const n of all) {
      const r = safeNext(n);
      if (!r) { if (!n.startsWith("//")) refusedAfterParse++; continue; }
      expect(r.startsWith("//"), n).toBe(false);
      expect(safeNext(r), n).toBe(r);
      expect(new URL(r, SITE).href, n).toBe(new URL(n, SITE).href);
    }
    // Inputs that start with a single `/` and are refused only after parsing: the generator reaches the case this rule
    // is about, or the loop above would prove nothing.
    expect(refusedAfterParse).toBeGreaterThan(50);
  });

  it("over every short mix of dot, empty, apostrophe, quote and ampersand segments: the href a browser decodes from rendered Markdown never names //host", () => {
    const parts = [".", "..", "%2e", "", "a", "evil.example", "'", "a'", '"', "&"];
    let inputs = [""];
    const all: string[] = [];
    for (let len = 0; len < 4; len++) {
      inputs = inputs.flatMap((p) => parts.map((s) => `${p}/${s}`));
      all.push(...inputs);
    }
    let refusedWithApostrophe = 0;
    for (const n of all) {
      const href = hrefOf(render(`[x](${n})`));
      if (href === "#") { if (n.includes("'") && !n.startsWith("//")) refusedWithApostrophe++; continue; }
      const u = new URL(href, SITE);
      expect(u.origin, n).toBe(SITE);
      expect(u.pathname.startsWith("//"), n).toBe(false);
      expect(u.href, n).toBe(new URL(n, SITE).href);
    }
    // Apostrophe inputs refused only after decoding and parsing: without them the loop would not reach the case the
    // escaped `&#39;` used to hide.
    expect(refusedWithApostrophe).toBeGreaterThan(20);
  });
});
