"use client";
import Button from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";

type Lang = "ar" | "en";

/** The table's own words (column headers come from the section's dictionary). */
export const TABLE_COPY = {
  en: { sortAsc: "sorted ascending", sortDesc: "sorted descending", sortBy: "Sort by", prev: "Previous page", next: "Next page", page: (p: number, n: number) => `Page ${p} of ${n}`, per: "Rows per page", empty: "Nothing matches these filters.", loading: "Loading…" },
  ar: { sortAsc: "مرتّب تصاعدياً", sortDesc: "مرتّب تنازلياً", sortBy: "رتّب حسب", prev: "الصفحة السابقة", next: "الصفحة التالية", page: (p: number, n: number) => `صفحة ${p} من ${n}`, per: "صفوف في الصفحة", empty: "لا شيء يطابق هذه المرشحات.", loading: "جارٍ التحميل…" },
} as const;

export type Column<R, K extends string> = {
  id: string;
  header: React.ReactNode;
  /** A column the server sorts by: its header is a button that sets this key (and flips the direction when it is set). */
  sort?: K;
  cell: (row: R) => React.ReactNode;
  className?: string;
};

/**
 * The founder console's table (rule 1178): rows the server already filtered, sorted and paged, so the table only shows
 * them and reports what the founder asks for. A sortable header is a real button inside the `<th>` (44px on touch), the
 * `<th>` carries `aria-sort`, and the header names the direction in words, not with the arrow alone. The table scrolls
 * inside its own box, so a wide table never widens the page on a phone. Text alignment is logical (`text-start`).
 */
export function DataTable<R, K extends string>({ lang, caption, columns, rows, rowKey, sort, dir, onSort, loading = false, rowClassName }: {
  lang: Lang;
  /** The table's name for screen readers (visually hidden). */
  caption: string;
  columns: Column<R, K>[];
  rows: R[] | null;
  rowKey: (r: R) => string;
  sort?: K;
  dir?: "asc" | "desc";
  onSort?: (k: K) => void;
  loading?: boolean;
  rowClassName?: (r: R) => string;
}) {
  const T = TABLE_COPY[lang];
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface" aria-busy={loading || undefined}>
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-lilac text-start text-xs text-muted">
          <tr>
            {columns.map((c) => {
              const on = !!c.sort && c.sort === sort;
              return (
                <th key={c.id} scope="col" aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : undefined} className={`p-2 text-start font-semibold ${c.className ?? ""}`}>
                  {c.sort && onSort ? (
                    <button type="button" onClick={() => onSort(c.sort!)} className="inline-flex min-h-[var(--hit-min)] items-center gap-1 rounded px-1 text-start underline-offset-2 hover:underline pointer-fine:min-h-8">
                      <span>{c.header}</span>
                      <span aria-hidden className="text-[10px]">{on ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
                      <span className="sr-only">{on ? `, ${dir === "asc" ? T.sortAsc : T.sortDesc}` : `, ${T.sortBy}`}</span>
                    </button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows === null ? (
            <tr><td colSpan={columns.length} className="p-4 text-muted">{T.loading}</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="p-4 text-muted">{T.empty}</td></tr>
          ) : rows.map((r) => (
            <tr key={rowKey(r)} className={`border-t border-border align-top ${rowClassName?.(r) ?? ""}`}>
              {columns.map((c) => <td key={c.id} className={`p-2 ${c.className ?? ""}`}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Previous, "Page p of n" (Western digits) and next, plus the page size. Each control is 44px on touch. */
export function Pager({ lang, page, pages, per, sizes, onPage, onPer }: { lang: Lang; page: number; pages: number; per: number; sizes: readonly number[]; onPage: (p: number) => void; onPer: (n: number) => void }) {
  const T = TABLE_COPY[lang];
  return (
    <nav aria-label={T.page(page, pages)} className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="md" aria-disabled={page <= 1 || undefined} onClick={() => { if (page > 1) onPage(page - 1); }}>{T.prev}</Button>
        <span aria-live="polite" dir="auto" className="tabular-nums">{T.page(page, pages)}</span>
        <Button variant="secondary" size="md" aria-disabled={page >= pages || undefined} onClick={() => { if (page < pages) onPage(page + 1); }}>{T.next}</Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted">
        <span>{T.per}</span>
        <Select value={String(per)} onChange={(e) => onPer(Number(e.target.value))} className="w-auto">
          {sizes.map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
      </label>
    </nav>
  );
}
