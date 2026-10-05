/**
 * Same-site paths only, for a `?next=` after login or signup and for links in rendered model output (src/lib/md.ts).
 * Pure and client-safe.
 *
 * Browsers drop tab, CR and LF anywhere in a URL and treat `\` as `/`, so `/\t/evil.com` and `/\evil.com` both become
 * `//evil.com`, another site. A path is accepted only when it has no control character and no backslash, starts with a
 * single `/`, and still resolves to the same origin once parsed. Rules 543-545.
 */
const BASE = "https://same-site.invalid";

/** The path itself when it stays on this site, otherwise "". */
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || !next) return "";
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return "";
  if (!/^\/(?!\/)/.test(next)) return "";
  try {
    return new URL(next, BASE).origin === BASE ? next : "";
  } catch {
    return "";
  }
}

/** A link target for rendered Markdown: a same-site path, an in-page `#anchor`, or an absolute http(s) or mailto link. Else "#". */
export function safeHref(href: string): string {
  const h = href.trim();
  if (/[\u0000-\u001f\u007f]/.test(h)) return "#";
  if (h.startsWith("#")) return h;
  if (h.startsWith("/")) return safeNext(h) || "#";
  return /^(https?:\/\/|mailto:)/i.test(h) && !h.includes("\\") ? h : "#";
}
