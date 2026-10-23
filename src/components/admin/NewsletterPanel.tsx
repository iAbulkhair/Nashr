"use client";
import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import type { NewsletterStatus, SubscriberRow } from "@/lib/newsletter";
// Rules 2002 empty state, 2003 skeleton while the panel loads.
import { PanelSkeleton } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";

/** GET /api/admin/newsletter. */
type Page = { rows: SubscriberRow[]; total: number; counts: Record<NewsletterStatus, number> };

const PAGE = 50;
const S = {
  en: {
    title: "Newsletter", note: "Only confirmed addresses are subscribers: a pending address has not pressed the link in its confirm mail, and an unsubscribed one stays here so it is never mailed again. Nothing is sent from this tab.",
    all: "All", confirmed: "Confirmed", pending: "Pending", unsubscribed: "Unsubscribed", email: "Email", status: "Status", lang: "Language", source: "From", at: "Signed up", confirmedAt: "Confirmed", unsubscribedAt: "Unsubscribed",
    none: "No sign-ups yet.", loading: "Loading…", failed: "Could not load the subscribers", prev: "Newer", next: "Older", export: "Export CSV", of: "of",
  },
  ar: {
    title: "النشرة البريدية", note: "المشتركون هم العناوين المؤكَّدة فقط: العنوان المعلَّق لم يضغط رابط رسالة التأكيد، والملغى يبقى هنا حتى لا تصله رسالة بعد اليوم. لا يُرسل شيء من هذا التبويب.",
    all: "الكل", confirmed: "مؤكَّد", pending: "معلَّق", unsubscribed: "ملغى", email: "البريد", status: "الحالة", lang: "اللغة", source: "المصدر", at: "تاريخ التسجيل", confirmedAt: "تاريخ التأكيد", unsubscribedAt: "تاريخ الإلغاء",
    none: "لا اشتراكات بعد.", loading: "جارٍ التحميل…", failed: "تعذّر تحميل المشتركين", prev: "الأحدث", next: "الأقدم", export: "تصدير CSV", of: "من",
  },
} as const;

/**
 * Founder console, Newsletter section (rules 3600-3609). A read-only list of the newsletter's addresses with their status
 * and a CSV export. Every value is visitor-typed and rendered as text only; nothing here writes.
 */
export default function NewsletterPanel({ lang }: { lang: "ar" | "en" }) {
  const L = S[lang];
  const [status, setStatus] = useState<NewsletterStatus | "">("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async (s: NewsletterStatus | "", o: number) => {
    setErr("");
    const r = await adminFetch(`/api/admin/newsletter?limit=${PAGE}&offset=${o}${s ? `&status=${s}` : ""}`).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    if (!j?.ok) { setErr(`${L.failed}${r ? ` (HTTP ${r.status})` : ""}`); return; }
    setPage(j as Page);
  }, [L.failed]);

  useEffect(() => { void Promise.resolve().then(() => load("", 0)); }, [load]);

  const go = (s: NewsletterStatus | "", o: number) => { setStatus(s); setOffset(o); void load(s, o); };
  const day = (v: string) => (v ? v.slice(0, 10) : "—");
  const tabs: [NewsletterStatus | "", string][] = [["", L.all], ["confirmed", L.confirmed], ["pending", L.pending], ["unsubscribed", L.unsubscribed]];
  const count = (k: NewsletterStatus | "") => (page ? (k ? page.counts[k] : page.counts.confirmed + page.counts.pending + page.counts.unsubscribed) : null);

  return (
    <section className="card card-sm" data-testid="newsletter-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-foreground">{L.title}</h2>
        <div className="flex flex-wrap gap-2 text-sm">
          {tabs.map(([k, label]) => (
            <button key={k || "all"} type="button" onClick={() => go(k, 0)} aria-pressed={status === k} className={`rounded-full px-3 py-1 ${status === k ? "bg-inverse text-inverse-muted" : "bg-background-muted"}`}>
              {label}{count(k) !== null && <span className="tnum ms-1" dir="ltr">{count(k)}</span>}
            </button>
          ))}
          <button type="button" onClick={() => window.open(`/api/admin/newsletter?format=csv${status ? `&status=${status}` : ""}`, "_blank")} className="btn btn-secondary btn-xs">{L.export}</button>
        </div>
      </div>
      <p className="mt-1 text-xs text-foreground-muted">{L.note}</p>
      {err && <p className="mt-3 text-sm text-danger">{err}</p>}
      {!page && !err ? <PanelSkeleton label={L.loading} shape="rows" className="mt-3" /> : page && page.rows.length === 0 ? <EmptyState compact title={L.none} className="mt-3" /> : page && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-background-muted text-start text-xs uppercase tracking-wide text-foreground-muted">
              <tr><th className="p-2 text-start">{L.email}</th><th className="text-start">{L.status}</th><th className="text-start">{L.lang}</th><th className="text-start">{L.source}</th><th className="text-start">{L.at}</th><th className="text-start">{L.confirmedAt}</th><th className="text-start">{L.unsubscribedAt}</th></tr>
            </thead>
            <tbody>
              {page.rows.map((r) => (
                <tr key={r.email} className="border-t border-foreground/5 align-top">
                  <td className="p-2 text-xs" dir="ltr">{r.email}</td>
                  <td className="whitespace-nowrap text-xs">{L[r.status]}</td>
                  <td className="text-xs">{r.lang}</td>
                  <td className="text-xs">{r.source}</td>
                  <td className="whitespace-nowrap font-mono text-xs" dir="ltr">{day(r.at)}</td>
                  <td className="whitespace-nowrap font-mono text-xs" dir="ltr">{day(r.confirmedAt)}</td>
                  <td className="whitespace-nowrap font-mono text-xs" dir="ltr">{day(r.unsubscribedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex items-center gap-2 text-xs text-foreground-muted">
            <button type="button" disabled={offset === 0} onClick={() => go(status, Math.max(0, offset - PAGE))} className="btn btn-secondary btn-xs">{L.prev}</button>
            <span className="tnum">{offset + 1}–{Math.min(offset + PAGE, page.total)} {L.of} {page.total}</span>
            <button type="button" disabled={offset + PAGE >= page.total} onClick={() => go(status, offset + PAGE)} className="btn btn-secondary btn-xs">{L.next}</button>
          </div>
        </div>
      )}
    </section>
  );
}
