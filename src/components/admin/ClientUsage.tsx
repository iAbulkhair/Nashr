"use client";
import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import type { Lang } from "./shared";

type Row = { account: string; email: string; name: string; plan: string; calls: number; modelUsd: number; mediaUsd: number; usd: number; marginPct: number | null };

const CU = {
  en: { title: "Clients by AI cost", note: "Every account's model calls and renders this month, highest cost first (at most 100). Open an account in Users for its split by person, brand, model and day.", month: "Month", account: "Account", plan: "Plan", calls: "Calls", model: "Models ($)", media: "Media ($)", total: "Total ($)", margin: "Margin", none: "No AI cost recorded for this month.", failed: "Could not load the ranking.", loading: "Loading…" },
  ar: { title: "العملاء حسب تكلفة الذكاء الاصطناعي", note: "طلبات النماذج والصور والمقاطع لكل حساب هذا الشهر، الأعلى تكلفة أولاً (100 حساب كحد أقصى). افتح الحساب في المستخدمين لتفصيله حسب الشخص والعلامة والنموذج واليوم.", month: "الشهر", account: "الحساب", plan: "الباقة", calls: "الطلبات", model: "النماذج ($)", media: "الوسائط ($)", total: "الإجمالي ($)", margin: "الهامش", none: "لا تكلفة مسجلة لهذا الشهر.", failed: "تعذر تحميل الترتيب.", loading: "جارٍ التحميل…" },
};

/** The founder console's ranking of clients by what their AI cost us (GET /api/admin/usage/clients, rule 2905). */
export default function ClientUsage({ lang }: { lang: Lang }) {
  const T = CU[lang];
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  // A new month clears the table in the handler, not the effect, so the effect only subscribes to the fetch.
  const pick = (m: string) => { if (!m || m === month) return; setRows(null); setFailed(false); setMonth(m); };
  useEffect(() => {
    let live = true;
    adminFetch(`/api/admin/usage/clients?month=${encodeURIComponent(month)}`)
      .then((r) => r.json())
      .then((j: { ok?: boolean; rows?: Row[] }) => { if (live) { if (j.ok && Array.isArray(j.rows)) setRows(j.rows); else setFailed(true); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [month]);
  return (
    <section id="clients" className="card card-sm" data-testid="admin-client-usage">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{T.title}</h2>
        <label className="flex items-center gap-2 text-xs">{T.month}<input type="month" className="input w-40" dir="ltr" value={month} onChange={(e) => pick(e.target.value)} /></label>
      </div>
      <p className="mt-1 text-xs text-foreground-muted">{T.note}</p>
      {failed ? <p className="mt-2 text-sm text-foreground-muted" role="status">{T.failed}</p> : !rows ? <p className="mt-2 text-sm text-foreground-muted">{T.loading}</p> : rows.length === 0 ? <p className="mt-2 text-sm">{T.none}</p> : (
        <div className="overflow-x-auto"><table className="mt-2 w-full text-xs">
          <thead className="text-foreground-muted"><tr>{[T.account, T.plan, T.calls, T.model, T.media, T.total, T.margin].map((h) => <th key={h} className="p-1 text-start">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.account} className="border-t border-foreground/5">
              <td className="p-1"><span className="block">{r.name}</span><span className="block text-foreground-muted" dir="ltr">{r.email}</span></td>
              <td className="p-1">{r.plan}</td>
              <td className="tnum p-1" dir="ltr">{r.calls}</td>
              <td className="tnum p-1" dir="ltr">{r.modelUsd.toFixed(2)}</td>
              <td className="tnum p-1" dir="ltr">{r.mediaUsd.toFixed(2)}</td>
              <td className="tnum p-1 font-semibold" dir="ltr">{r.usd.toFixed(2)}</td>
              <td className="tnum p-1" dir="ltr">{r.marginPct === null ? "—" : `${r.marginPct}%`}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}
