"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import type { SiteSnapshot } from "@/lib/site-stats";
import type { SiteChoices } from "@/lib/report-sources";
import { dateFormat } from "@/lib/dates";
import { pctChange, type N } from "@/lib/figures";
import RefreshButton, { selectNote } from "./RefreshButton";

/**
 * The site card on Reports: GA4 and Search Console totals from the last read (src/lib/site-stats.ts). Read only, and the
 * same figures Dana's reports get. Search queries come from the public: React renders them as text, never as markup.
 * A figure Google did not return shows a dash, never 0; a change is shown only where the previous 28 days were read.
 * Any member may refresh it (`sync_site`, rule 735); the owner and an admin choose the GA4 property and the Search
 * Console site when more than one was listed at connect (`select_property`, rule 734). The route checks both roles.
 * With no read yet (`site` null: the first read has not landed, or both parts failed and nothing was written) the card
 * still shows, with both parts as not read, so the choice and the refresh that fix it stay reachable.
 */
const STR = {
  ar: {
    title: "الموقع: Google Analytics و Search Console", read: "آخر قراءة", sessions: "الجلسات", keyEvents: "الأحداث الرئيسية", revenue: "إيراد الشراء",
    clicks: "نقرات البحث", impressions: "مرات الظهور في البحث", position: "متوسط الترتيب", queries: "أكثر عبارات البحث", channels: "مصادر الزيارات",
    vsPrev: "مقارنة بالـ28 يوماً السابقة", chooseGa: "خاصية Google Analytics التي نقرأها", chooseGsc: "موقع Search Console الذي نقرأه",
    noGa: "Google Analytics لم يُقرأ بعد.", noGsc: "Search Console لم يُقرأ بعد.", note: "تُحدَّث يومياً. دانة تستخدم هذه الأرقام في تقاريرها، ولا تُضاف إلى أرقام المتجر أو الإعلانات.",
  },
  en: {
    title: "Site: Google Analytics and Search Console", read: "Last read", sessions: "Sessions", keyEvents: "Key events", revenue: "Purchase revenue",
    clicks: "Search clicks", impressions: "Search impressions", position: "Average position", queries: "Top search queries", channels: "Traffic sources",
    vsPrev: "vs the previous 28 days", chooseGa: "The Google Analytics property we read", chooseGsc: "The Search Console site we read",
    noGa: "Google Analytics has not been read yet.", noGsc: "Search Console has not been read yet.", note: "Refreshed daily. Dana uses these figures in her reports; they are never added to store or ad figures.",
  },
} as const;

const NUM = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const PCT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0, signDisplay: "exceptZero" });
/** A figure not read is a dash, never 0. */
const fmt = (n: N) => (n == null ? "—" : NUM.format(n));
/** The change against the previous period, only where both were read and the previous one is above 0. */
function change(cur: N, prev: N | undefined) {
  const p = prev != null && prev > 0 ? pctChange(cur, prev) : null;
  return p == null ? null : PCT.format(p / 100);
}

/** One selector: the listed properties or sites, the chosen one first selected; a choice is posted at once. */
function Choice({ lang, kind, label, options, current }: { lang: Lang; kind: "ga4" | "gsc"; label: string; options: { id: string; name: string }[]; current?: string }) {
  const r = useRouter();
  const [value, setValue] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  async function pick(id: string) {
    setValue(id);
    setBusy(true);
    setNote("");
    try {
      const res = await fetch("/api/connect/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select_property", kind, id }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; read?: boolean; error?: string };
      setNote(selectNote(lang, res.status, j));
      if (j.ok) r.refresh();
      else setValue(current ?? "");
    } catch {
      setNote(selectNote(lang, 0, {}));
      setValue(current ?? "");
    } finally {
      setBusy(false);
    }
  }
  return (
    <label className="grid gap-1 text-xs text-foreground-muted">
      <span>{label}</span>
      <select data-choose={kind} value={value} disabled={busy} onChange={(e) => pick(e.target.value)} className="rounded border border-border bg-surface px-2 py-1 text-xs" dir="auto">
        {!value && <option value="" disabled>—</option>}
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      {note && <span role="status" dir="auto">{note}</span>}
    </label>
  );
}

type Props = {
  lang: Lang;
  /** `getSiteSnapshot`; null when nothing was read yet. */
  site: SiteSnapshot | null;
  /** `siteChoices`: the properties and sites listed at connect on the Composio Google record, with the ones chosen. */
  properties?: SiteChoices;
  /** `can(u, "connectors")`: the owner and an admin choose what is read (rule 734). */
  canChoose?: boolean;
  /** `can(u, "read")`: any member may refresh, free (rule 735). */
  canRefresh?: boolean;
};

export default function SiteStats({ lang, site, properties, canChoose = false, canRefresh = false }: Props) {
  const S = STR[lang];
  const ga4 = canChoose && properties && properties.ga.length >= 2 ? properties.ga : null;
  const sites = canChoose && properties && properties.gsc.length >= 2 ? properties.gsc : null;
  const at = site ? new Date(site.at) : null;
  const when = at && !Number.isNaN(at.getTime()) ? dateFormat(lang, { day: "numeric", month: "short", year: "numeric" }).format(at) : null;
  const tile = (label: string, value: string, sub?: string, delta?: string | null) => (
    <div className="rounded-lg border border-foreground/10 p-3">
      <p className="text-xs text-foreground-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold" dir="ltr">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-foreground-muted" dir="ltr">{sub}</p>}
      {delta && <p className="mt-0.5 text-xs text-foreground-muted"><span dir="ltr">{delta}</span> {S.vsPrev}</p>}
    </div>
  );
  const ga = site?.ga;
  const gsc = site?.gsc;
  return (
    <div id="site-stats" className="card mt-6" dir={lang === "ar" ? "rtl" : "ltr"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-bold">{S.title}</h2>
        {when && <p className="text-xs text-foreground-muted">{S.read}: {when}</p>}
      </div>
      {canRefresh && <div className="mt-2"><RefreshButton lang={lang} kind="site" path="google" /></div>}
      {(ga4 || sites) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {ga4 && <Choice lang={lang} kind="ga4" label={S.chooseGa} options={ga4} current={properties?.gaCurrent} />}
          {sites && <Choice lang={lang} kind="gsc" label={S.chooseGsc} options={sites.map((s) => ({ id: s, name: s }))} current={properties?.gscCurrent} />}
        </div>
      )}
      {ga ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {tile(S.sessions, fmt(ga.sessions), `${ga.range.from} → ${ga.range.to}`, change(ga.sessions, ga.prev?.sessions))}
            {tile(S.keyEvents, fmt(ga.keyEvents), undefined, change(ga.keyEvents, ga.prev?.keyEvents))}
            {ga.revenue != null && ga.revenue > 0 && tile(S.revenue, fmt(ga.revenue), undefined, change(ga.revenue, ga.prev?.revenue))}
          </div>
          {ga.channels.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{S.channels}</p>
              <ul className="mt-1 grid gap-1 text-sm">
                {ga.channels.slice(0, 5).map((c) => <li key={c.name} className="flex justify-between gap-2"><span dir="auto">{c.name}</span><span dir="ltr" className="text-foreground-muted">{fmt(c.sessions)}</span></li>)}
              </ul>
            </div>
          )}
        </>
      ) : <p className="mt-3 text-sm text-foreground-muted">{S.noGa}</p>}
      {gsc ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {tile(S.clicks, fmt(gsc.clicks), `${gsc.range.from} → ${gsc.range.to}`, change(gsc.clicks, gsc.prev?.clicks))}
            {tile(S.impressions, fmt(gsc.impressions), undefined, change(gsc.impressions, gsc.prev?.impressions))}
            {tile(S.position, fmt(gsc.position))}
          </div>
          {gsc.queries.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{S.queries}</p>
              <ul className="mt-1 grid gap-1 text-sm">
                {gsc.queries.slice(0, 8).map((q) => <li key={q.query} className="flex justify-between gap-2"><span dir="auto">{q.query}</span><span dir="ltr" className="text-foreground-muted">{fmt(q.clicks)} / {fmt(q.impressions)}</span></li>)}
              </ul>
            </div>
          )}
        </>
      ) : <p className="mt-3 text-sm text-foreground-muted">{S.noGsc}</p>}
      <p className="mt-3 text-xs text-foreground-muted">{S.note}</p>
    </div>
  );
}
