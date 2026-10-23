import { safeHref, safeNext } from "./safe-next";
import type { Lang } from "./i18n";

/** A piece of a highlighted line: its text (never trusted as HTML) and, optionally, a `#rgb`/`#rrggbb[aa]` colour. */
export type CodeToken = { text: string; color?: string };
/**
 * Turns code in a named language into tokens, one array per line, or `null` when it does not know the language. It lives
 * outside this file (src/lib/md-highlight.ts, server only) so a client component importing `render` never loads a
 * highlighter. Its result is only ever read as text and a colour: `render` escapes every token and checks every colour.
 */
export type CodeHighlighter = (code: string, lang: string) => CodeToken[][] | null;
/**
 * `lang`: the page's language, which gives an internal link its prefix and an external link its screen-reader hint.
 * `origin`: this site's address; an absolute link to it is read as an internal one. `highlight`: see `CodeHighlighter`.
 * Without options the output is the plain one every model-output caller gets.
 */
export type RenderOptions = { lang?: Lang; origin?: string; highlight?: CodeHighlighter };

/**
 * The first path segments of the pages under `src/app/[lang]` that a post or an answer links to, and `app`. A link to
 * `/pricing` becomes `/ar/pricing` on an Arabic page. tests/md-links.test.ts holds this list to PUBLIC_SEGMENTS in src/proxy.ts.
 */
export const LINK_SEGMENTS = [
  "affiliates", "agents", "ai-marketing-agent", "app", "blog", "compare", "customers", "enterprise", "for", "help", "pricing",
  "privacy", "resources", "terms", "tools", "updates",
] as const;
const LINKABLE = new Set<string>(LINK_SEGMENTS);

const ENTITY: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unesc = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITY[e]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const SR_NEW_TAB: Record<Lang, string> = { ar: " (يفتح في تبويب جديد)", en: " (opens in a new tab)" };
const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FENCE_LANG = /^[A-Za-z0-9_+#.-]{1,24}$/;

/**
 * An internal path with the page's language: a language already there is replaced by `lang` (a link written for the other
 * language's text still lands on this one's page), a page segment without one gets it, and anything else (`/p/abc`,
 * `/api/...`) is left alone. The path is already same-site, from `safeNext`.
 */
export function langPath(path: string, lang: Lang): string {
  const m = path.match(/^\/([^/?#]*)([\s\S]*)$/);
  if (!m) return path;
  const [, seg, rest] = m;
  if (seg === "ar" || seg === "en") return `/${lang}${rest}`;
  if (seg === "") return `/${lang}${rest}`;
  return LINKABLE.has(seg) ? `/${lang}/${seg}${rest}` : path;
}

/** One link, from the Markdown target as written (already escaped by the caller's line escape) and the escaped link text. */
function link(text: string, rawHref: string, o: RenderOptions): string {
  let href = safeHref(rawHref);
  if (href === "#") return `<a href="#">${text}</a>`;
  let plain = unesc(href);
  // This site's own absolute address is an internal link. The path of the parsed URL is checked again as a path: `https://site//evil.com` parses to `//evil.com`.
  if (o.origin && /^https?:\/\//i.test(plain)) {
    try {
      const u = new URL(plain);
      if (u.origin === new URL(o.origin).origin) {
        const p = safeNext(u.pathname + u.search + u.hash);
        if (p) plain = p;
      }
    } catch { /* not a URL: it stays external, or "#" below */ }
  }
  if (plain.startsWith("#")) return `<a href="${esc(plain)}">${text}</a>`;
  if (plain.startsWith("/")) {
    href = esc(o.lang ? langPath(plain, o.lang) : plain);
    return `<a href="${href}">${text}</a>`;
  }
  if (/^mailto:/i.test(plain)) return `<a href="${esc(plain)}" rel="noopener noreferrer">${text}</a>`;
  // http(s) to another site: a new tab that cannot reach back (`noopener`) or send the referrer, marked for the eye by CSS
  // (`a[data-external]::after`, src/app/globals.css) and, when the page's language is known, for a screen reader by text.
  const sr = o.lang ? `<span class="sr-only">${SR_NEW_TAB[o.lang]}</span>` : "";
  return `<a href="${esc(plain)}" target="_blank" rel="noopener noreferrer" data-external="">${text}${sr}</a>`;
}

/** The inside of a `<code>` for a fenced block: highlighted tokens when the highlighter knows the language, else the escaped text. */
function codeBody(code: string, lang: string, highlight?: CodeHighlighter): string {
  const lines = lang && highlight ? highlight(code, lang) : null;
  if (!lines) return esc(code);
  return lines
    .map((line) => line.map((t) => (t.color && COLOR.test(t.color) ? `<span style="color:${t.color}">${esc(t.text)}</span>` : esc(t.text))).join(""))
    .join("\n");
}

/**
 * Tiny Markdown → HTML renderer (headings, bold, links, lists, tables, hr, fenced code). Escapes HTML; pure, safe for client
 * components. Text is escaped before anything else is looked at, so no input can write a tag or an attribute; the only
 * attributes written are `href` (checked by `safeHref`), `target`, `rel`, `class`, `dir`, `data-*` and a checked colour.
 */
export function render(md: string, opts: RenderOptions = {}) {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\[(.+?)\]\(([^)]+)\)/g, (_m, t, h) => link(t, h, opts));
  const lines = md.split("\n");
  const out: string[] = [];
  let list: string[] = [], ol: string[] = [], table: string[][] = [];
  let fence: { mark: string; lang: string; lines: string[] } | null = null;
  const flush = () => {
    if (list.length) { out.push("<ul>" + list.map((l) => `<li>${l}</li>`).join("") + "</ul>"); list = []; }
    if (ol.length) { out.push("<ol>" + ol.map((l) => `<li>${l}</li>`).join("") + "</ol>"); ol = []; }
    if (table.length) {
      const [h, ...rows] = table.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
      if (h) out.push(`<table><thead><tr>${h.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      table = [];
    }
  };
  const closeFence = () => {
    if (!fence) return;
    const code = fence.lines.join("\n");
    const lang = FENCE_LANG.test(fence.lang) ? fence.lang.toLowerCase() : "";
    // Code is always left to right, even inside an Arabic page; `tabindex` lets a keyboard user scroll a wide block.
    out.push(`<pre class="code" dir="ltr" tabindex="0"${lang ? ` data-lang="${lang}"` : ""}><code${lang ? ` class="language-${lang}"` : ""}>${codeBody(code, lang, opts.highlight)}</code></pre>`);
    fence = null;
  };
  for (const raw of lines) {
    // Inside a fence every line is code, a blank one included, until a line of at least as many of the same mark closes it.
    if (fence) {
      const l = raw.replace(/\r$/, "");
      const close = l.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.mark[0] && close[1].length >= fence.mark.length) closeFence();
      else fence.lines.push(l);
      continue;
    }
    const open = raw.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/);
    if (open) { flush(); fence = { mark: open[1], lang: open[2], lines: [] }; continue; }
    const l = raw.trimEnd();
    // The outer pipes are cut before the split, so a row without a closing pipe keeps its last cell (rule 1481).
    if (/^\|/.test(l)) { table.push(l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(l.trim())) { flush(); out.push("<hr>"); }
    else if (/^#{1,6}\s/.test(l)) { flush(); const n = Math.min(l.match(/^#+/)![0].length + 1, 6); out.push(`<h${n}>${inline(l.replace(/^#+\s*/, ""))}</h${n}>`); }
    else if (/^\s*[-*•]\s+/.test(l)) { if (table.length) flush(); list.push(inline(l.replace(/^\s*[-*•]\s+/, ""))); }
    else if (/^\s*\d+[.)]\s+/.test(l)) { if (table.length) flush(); ol.push(inline(l.replace(/^\s*\d+[.)]\s+/, ""))); }
    else if (!l.trim()) flush();
    else { flush(); out.push(`<p>${inline(l)}</p>`); }
  }
  closeFence();
  flush();
  return out.join("\n");
}
