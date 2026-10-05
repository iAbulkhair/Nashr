import type { Lang } from "@/lib/i18n";
import type { SiteSnapshot } from "@/lib/site-stats";
import { dateFormat } from "@/lib/dates";

/**
 * The site card on Reports: GA4 and Search Console totals from the last read (src/lib/site-stats.ts). Read only, and the
 * same figures Dana's reports get. Search queries come from the public: React renders them as text, never as markup.
 */
const STR = {
  ar: {
    title: "الموقع: Google Analytics و Search Console", read: "آخر قراءة", sessions: "الجلسات", keyEvents: "الأحداث الرئيسية", revenue: "إيراد الشراء",
    clicks: "نقرات البحث", impressions: "مرات الظهور في البحث", position: "متوسط الترتيب", queries: "أكثر عبارات البحث", channels: "مصادر الزيارات",
    noGa: "Google Analytics لم يُقرأ بعد.", noGsc: "Search Console لم يُقرأ بعد.", note: "تُحدَّث يومياً. دانة تستخدم هذه الأرقام في تقاريرها، ولا تُضاف إلى أرقام المتجر أو الإعلانات.",
  },
  en: {
    title: "Site: Google Analytics and Search Console", read: "Last read", sessions: "Sessions", keyEvents: "Key events", revenue: "Purchase revenue",
    clicks: "Search clicks", impressions: "Search impressions", position: "Average position", queries: "Top search queries", channels: "Traffic sources",
    noGa: "Google Analytics has not been read yet.", noGsc: "Search Console has not been read yet.", note: "Refreshed daily. Dana uses these figures in her reports; they are never added to store or ad figures.",
  },
} as const;

const NUM = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const fmt = (n: number) => NUM.format(n);

export default function SiteStats({ lang, site }: { lang: Lang; site: SiteSnapshot }) {
  const S = STR[lang];
  const when = dateFormat(lang, { day: "numeric", month: "short", year: "numeric" }).format(new Date(site.at));
  const tile = (label: string, value: string, sub?: string) => (
    <div className="rounded-lg border border-ink/10 p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold" dir="ltr">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted" dir="ltr">{sub}</p>}
    </div>
  );
  return (
    <div id="site-stats" className="card mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-bold">{S.title}</h2>
        <p className="text-xs text-muted">{S.read}: {when}</p>
      </div>
      {site.ga ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {tile(S.sessions, fmt(site.ga.sessions), `${site.ga.range.from} → ${site.ga.range.to}`)}
            {tile(S.keyEvents, fmt(site.ga.keyEvents))}
            {site.ga.revenue > 0 && tile(S.revenue, fmt(site.ga.revenue))}
          </div>
          {site.ga.channels.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">{S.channels}</p>
              <ul className="mt-1 grid gap-1 text-sm">
                {site.ga.channels.slice(0, 5).map((c) => <li key={c.name} className="flex justify-between gap-2"><span dir="auto">{c.name}</span><span dir="ltr" className="text-muted">{fmt(c.sessions)}</span></li>)}
              </ul>
            </div>
          )}
        </>
      ) : <p className="mt-3 text-sm text-muted">{S.noGa}</p>}
      {site.gsc ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {tile(S.clicks, fmt(site.gsc.clicks), `${site.gsc.range.from} → ${site.gsc.range.to}`)}
            {tile(S.impressions, fmt(site.gsc.impressions))}
            {site.gsc.position != null && tile(S.position, fmt(site.gsc.position))}
          </div>
          {site.gsc.queries.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">{S.queries}</p>
              <ul className="mt-1 grid gap-1 text-sm">
                {site.gsc.queries.slice(0, 8).map((q) => <li key={q.query} className="flex justify-between gap-2"><span dir="auto">{q.query}</span><span dir="ltr" className="text-muted">{fmt(q.clicks)} / {fmt(q.impressions)}</span></li>)}
              </ul>
            </div>
          )}
        </>
      ) : <p className="mt-3 text-sm text-muted">{S.noGsc}</p>}
      <p className="mt-3 text-xs text-muted">{S.note}</p>
    </div>
  );
}
