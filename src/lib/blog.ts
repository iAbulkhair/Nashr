import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Lang } from "./i18n";

export type Post = { slug: string; title: string; desc: string; date: string; body: string };

const DIR = join(process.cwd(), "content", "blog");

function parse(raw: string) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const body = m ? m[2] : raw;
  const [ar, en] = body.split(/\n---EN---\n/);
  return { meta, ar: ar.trim(), en: (en ?? ar).trim() };
}

export function listPosts(lang: Lang): Post[] {
  return readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => {
    const { meta, ar, en } = parse(readFileSync(join(DIR, f), "utf8"));
    return { slug: f.replace(/\.md$/, ""), title: meta[`title_${lang}`] ?? meta.title_en ?? f, desc: meta[`desc_${lang}`] ?? "", date: meta.date ?? "", body: lang === "ar" ? ar : en };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));
}
export function getPost(lang: Lang, slug: string) {
  return listPosts(lang).find((p) => p.slug === slug) ?? null;
}
export function slugs() {
  return readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
}

/** Small markdown → HTML: headings, paragraphs, lists, tables, bold, links. */
export function render(md: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\[(.+?)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const lines = md.split("\n");
  const out: string[] = [];
  let list: string[] = [], ol: string[] = [], table: string[][] = [];
  const flush = () => {
    if (list.length) { out.push("<ul>" + list.map((l) => `<li>${l}</li>`).join("") + "</ul>"); list = []; }
    if (ol.length) { out.push("<ol>" + ol.map((l) => `<li>${l}</li>`).join("") + "</ol>"); ol = []; }
    if (table.length) {
      const [h, ...rows] = table.filter((r) => !r.every((c) => /^-+$/.test(c)));
      out.push(`<table><thead><tr>${h.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      table = [];
    }
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^\|/.test(l)) { table.push(l.split("|").slice(1, -1).map((c) => c.trim())); continue; }
    if (/^#{1,6}\s/.test(l)) { flush(); const n = l.match(/^#+/)![0].length; out.push(`<h${n + 1}>${inline(l.replace(/^#+\s*/, ""))}</h${n + 1}>`); }
    else if (/^\s*[-*]\s+/.test(l)) { if (table.length) flush(); list.push(inline(l.replace(/^\s*[-*]\s+/, ""))); }
    else if (/^\s*\d+\.\s+/.test(l)) { if (table.length) flush(); ol.push(inline(l.replace(/^\s*\d+\.\s+/, ""))); }
    else if (!l.trim()) flush();
    else { flush(); out.push(`<p>${inline(l)}</p>`); }
  }
  flush();
  return out.join("\n");
}
