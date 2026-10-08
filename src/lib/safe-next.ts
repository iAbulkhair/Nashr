/**
 * Same-site paths only, for a `?next=` after login or signup and for links in rendered model output (src/lib/md.ts).
 * Pure and client-safe.
 *
 * Browsers drop tab, CR and LF anywhere in a URL and treat `\` as `/`, so `/\t/evil.com` and `/\evil.com` both become
 * `//evil.com`, another site. A path is accepted only when it has no control character and no backslash, starts with a
 * single `/`, and still resolves to the same origin once parsed. Rules 543-545.
 *
 * The parser also resolves dot segments, `%2e` included, so `/.//evil.com` and `/%2e%2e//evil.com` pass the checks on
 * the raw string yet name the path `//evil.com`. Returning the raw string would hand the caller something other than
 * what was checked, and anything that normalises it again (a router, a `Location` header built from a pathname) gets a
 * protocol-relative URL. So the result is the parsed path, query and fragment, and it is refused when that starts with
 * `//`. `%2F` is never decoded, so `/%2F%2Fevil.com` stays a path on this site. Rule 694.
 */
const BASE = "https://same-site.invalid";

/** The normalised path when it stays on this site, otherwise "". */
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || !next) return "";
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return "";
  if (!/^\/(?!\/)/.test(next)) return "";
  try {
    const u = new URL(next, BASE);
    const path = u.pathname + u.search + u.hash;
    return u.origin === BASE && !path.startsWith("//") ? path : "";
  } catch {
    return "";
  }
}

/** The five entities `esc` in src/lib/md.ts writes, decoded in one pass so `&amp;#39;` stays the text `&#39;`. */
const ENTITY: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unescapeHtml = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITY[e]);
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * A link target for rendered Markdown: a same-site path, an in-page `#anchor`, or an absolute http(s) or mailto link.
 * Else "#".
 *
 * md.ts escapes the whole line before it finds links, so the href arrives HTML-escaped and the result goes into a
 * double-quoted attribute as it is. The browser decodes that attribute before it parses the URL, so the checks run on
 * the decoded string and the result is escaped again. Checked as written, the `#` inside `&#39;` would turn everything
 * after an apostrophe into a fragment the parser never resolves, and `/'/..//evil.com` would pass yet name the path
 * `//evil.com`. Rule 694.
 */
export function safeHref(href: string): string {
  const h = unescapeHtml(href.trim());
  if (/[\u0000-\u001f\u007f]/.test(h)) return "#";
  if (h.startsWith("#")) return escapeHtml(h);
  if (h.startsWith("/")) return escapeHtml(safeNext(h)) || "#";
  return /^(https?:\/\/|mailto:)/i.test(h) && !h.includes("\\") ? escapeHtml(h) : "#";
}
