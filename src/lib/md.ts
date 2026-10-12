import { safeHref } from "./safe-next";

/** Tiny Markdown → HTML renderer (headings, bold, links, lists, tables, hr). Escapes HTML; pure, safe for client components. */
export function render(md: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\[(.+?)\]\(([^)]+)\)/g, (_m, t, h) => `<a href="${safeHref(h)}" rel="noreferrer">${t}</a>`);
  const lines = md.split("\n");
  const out: string[] = [];
  let list: string[] = [], ol: string[] = [], table: string[][] = [];
  const flush = () => {
    if (list.length) { out.push("<ul>" + list.map((l) => `<li>${l}</li>`).join("") + "</ul>"); list = []; }
    if (ol.length) { out.push("<ol>" + ol.map((l) => `<li>${l}</li>`).join("") + "</ol>"); ol = []; }
    if (table.length) {
      const [h, ...rows] = table.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
      if (h) out.push(`<table><thead><tr>${h.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      table = [];
    }
  };
  for (const raw of lines) {
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
  flush();
  return out.join("\n");
}
