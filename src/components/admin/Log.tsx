"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { adminFetch } from "@/lib/admin-fetch";
import { AUDIT_SECTIONS, auditDiff, auditText } from "@/lib/admin-audit-shape";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Time } from "@/components/ui/Time";
import { EndedNotice, useAdminEnded, type SectionProps } from "./shared";

/** The Log page's words (rule 1179), Arabic and English, Western digits in both. */
export const LOG_COPY = {
  en: {
    title: "Audit log", filters: "Filter the log", section: "Section", anySection: "All sections", actor: "Who", action: "Action", target: "On", apply: "Filter", clear: "Clear",
    when: "When", change: "Change", to: "to", reason: "Reason", legacy: "older entry", viaAccount: "inside", empty: "No entry matches these filters.", loading: "Loading…",
    older: "Older entries", scanned: (n: number) => `Filters look through the newest ${n} entries (the log keeps 5,000).`, failed: "The log did not load. Try again.",
    sections: { users: "Users", billing: "Billing", partners: "Partners", quality: "Quality", wishlist: "Wishlist", system: "System" },
  },
  ar: {
    title: "سجل التدقيق", filters: "تصفية السجل", section: "القسم", anySection: "كل الأقسام", actor: "من", action: "الإجراء", target: "على", apply: "تصفية", clear: "مسح",
    when: "متى", change: "التغيير", to: "إلى", reason: "السبب", legacy: "إدخال قديم", viaAccount: "من داخل", empty: "لا إدخال يطابق هذه المرشحات.", loading: "جارٍ التحميل…",
    older: "إدخالات أقدم", scanned: (n: number) => `تبحث المرشحات في أحدث ${n} إدخال (يحتفظ السجل بـ 5,000).`, failed: "لم يُحمَّل السجل. حاول مرة أخرى.",
    sections: { users: "المستخدمون", billing: "الفوترة", partners: "الشركاء", quality: "الجودة", wishlist: "قائمة الأمنيات", system: "النظام" },
  },
} as const;

/** A row as `GET /api/admin/log` answers it (rule 1175): the new fields, the legacy ones, and `legacy` for an old row. */
type Row = { id?: string; at: string; actor?: string; imp?: string; section?: string; action: string; target?: string; what?: string; before?: unknown; after?: unknown; reason?: string; legacy: boolean };
const TEXT_FILTERS = ["actor", "action", "target"] as const;
type Filter = { section: string; actor: string; action: string; target: string };
const filterOf = (p: URLSearchParams): Filter => ({ section: p.get("section") ?? "", actor: p.get("actor") ?? "", action: p.get("action") ?? "", target: p.get("target") ?? "" });
const paramsOf = (f: Filter) => {
  const p = new URLSearchParams();
  for (const k of ["section", ...TEXT_FILTERS] as const) if (f[k].trim()) p.set(k, f[k].trim().slice(0, 120));
  return p;
};

/**
 * Founder console, Audit log (/{lang}/admin/log, rule 1179): every founder change with who made it, on what, the values
 * before and after key by key, and the reason. The filters live in the address (a link or a reload keeps them) and the
 * server applies them (rule 1175); "Older entries" adds the next 50. A row written before 2026-10-11 shows with an
 * "older entry" badge and whatever it carried. Every value is text, never HTML: a target or a reason is what was typed.
 */
export default function Log({ lang, keySession }: SectionProps) {
  const ended = useAdminEnded();
  const L = LOG_COPY[lang];
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const key = paramsOf(filterOf(new URLSearchParams(search.toString()))).toString();
  const [draft, setDraft] = useState<Filter>(() => filterOf(new URLSearchParams(search.toString())));
  const [rows, setRows] = useState<Row[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [scanned, setScanned] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  /** One page from `from`; the first page replaces the rows, a later one adds to them. A stale answer is dropped. */
  const fetchPage = useCallback(async (from: number) => {
    const n = ++seq.current;
    setBusy(true);
    const p = new URLSearchParams(key);
    if (from) p.set("from", String(from));
    try {
      const r = await adminFetch(`/api/admin/log${p.size ? `?${p.toString()}` : ""}`);
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; log?: Row[]; next?: number | null; scanned?: number };
      if (n !== seq.current) return;
      if (!j.ok) { setFailed(r.status !== 401); return; }
      setFailed(false);
      setRows((prev) => (from && prev ? [...prev, ...(j.log ?? [])] : j.log ?? []));
      setNext(j.next ?? null);
      setScanned(j.scanned ?? 0);
    } catch {
      if (n === seq.current) setFailed(true);
    } finally {
      if (n === seq.current) setBusy(false);
    }
  }, [key]);
  useEffect(() => { void Promise.resolve().then(() => fetchPage(0)); }, [fetchPage]);
  function go(f: Filter) {
    const p = paramsOf(f).toString();
    router.replace(p ? `${pathname}?${p}` : pathname, { scroll: false });
  }
  if (ended) return <EndedNotice lang={lang} keySession={keySession} />;
  const sectionName = (s?: string) => (s && s in L.sections ? L.sections[s as keyof typeof L.sections] : s ?? "");
  return (
    <section className="card card-sm grid gap-4" aria-labelledby="log-title" aria-busy={busy || undefined}>
      <h2 id="log-title" className="text-sm font-semibold text-foreground">{L.title}</h2>
      <form
        aria-label={L.filters}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => { e.preventDefault(); go(draft); }}
      >
        <label className="grid gap-1 text-xs text-foreground-muted">
          <span>{L.section}</span>
          <Select value={draft.section} onChange={(e) => { const f = { ...draft, section: e.target.value }; setDraft(f); go(f); }}>
            <option value="">{L.anySection}</option>
            {AUDIT_SECTIONS.map((s) => <option key={s} value={s}>{L.sections[s]}</option>)}
          </Select>
        </label>
        {TEXT_FILTERS.map((k) => (
          <label key={k} className="grid min-w-0 flex-1 basis-40 gap-1 text-xs text-foreground-muted">
            <span>{L[k]}</span>
            <Input value={draft[k]} maxLength={120} dir={k === "action" ? "auto" : "ltr"} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          </label>
        ))}
        <Button type="submit" variant="secondary">{L.apply}</Button>
        <Button variant="ghost" onClick={() => { const f = { section: "", actor: "", action: "", target: "" }; setDraft(f); go(f); }}>{L.clear}</Button>
      </form>
      {scanned > 0 && <p className="text-xs text-foreground-muted">{L.scanned(scanned)}</p>}
      {failed && <p role="alert" className="text-sm text-danger">{L.failed}</p>}
      {rows === null ? <p className="text-sm text-foreground-muted">{L.loading}</p> : rows.length === 0 ? <p className="text-sm text-foreground-muted">{L.empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">{L.title}</caption>
            <thead className="text-foreground-muted">
              <tr>
                <th scope="col" className="p-1 text-start">{L.when}</th>
                <th scope="col" className="p-1 text-start">{L.actor}</th>
                <th scope="col" className="p-1 text-start">{L.action}</th>
                <th scope="col" className="p-1 text-start">{L.target}</th>
                <th scope="col" className="p-1 text-start">{L.change}</th>
                <th scope="col" className="p-1 text-start">{L.reason}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l, i) => {
                const diff = auditDiff(l.before, l.after);
                return (
                  <tr key={l.id ?? `${l.at}-${i}`} className="border-t border-border align-top" data-legacy={l.legacy || undefined}>
                    <td className="whitespace-nowrap p-1"><Time value={l.at} lang={lang} style="datetime" /></td>
                    <td className="p-1">
                      <bdi dir="ltr">{l.actor ?? "—"}</bdi>
                      {l.imp && <span className="block text-foreground-muted">{L.viaAccount} <bdi dir="ltr">{l.imp}</bdi></span>}
                    </td>
                    <td className="p-1">
                      <span className="flex flex-wrap items-center gap-1">
                        {l.section && <Badge>{sectionName(l.section)}</Badge>}
                        <span className="font-mono" dir="ltr">{l.action}</span>
                        {l.legacy && <Badge tone="neutral">{L.legacy}</Badge>}
                      </span>
                      {l.what && l.what !== l.action && <span className="block text-foreground-muted" dir="auto">{l.what}</span>}
                    </td>
                    <td className="p-1"><bdi dir="ltr">{l.target ?? ""}</bdi></td>
                    <td className="p-1">
                      {diff.length === 0 ? "" : (
                        <ul className="grid gap-0.5 font-mono" dir="ltr">
                          {diff.map((d) => (
                            <li key={d.key || "value"} className="break-words">
                              {d.key && <span className="text-foreground-muted">{d.key}: </span>}
                              <span className="line-through decoration-1">{d.before || "∅"}</span>
                              <span aria-hidden> → </span><span className="sr-only"> {L.to} </span>
                              <span>{d.after || "∅"}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="p-1" dir="auto">{auditText(l.reason)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {next !== null && <Button variant="secondary" loading={busy} loadingText={L.loading} onClick={() => void fetchPage(next)} className="justify-self-start">{L.older}</Button>}
    </section>
  );
}
