"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { TaskLite } from "@/lib/brand";
import type { Lang } from "@/lib/i18n";
import { dateFormat } from "@/lib/dates";
import { Icon, channelIcon } from "./Icons";
import Scribble from "@/components/Scribble";

const DEFAULT_ROWS = ["instagram", "snapchat", "tiktok", "x", "whatsapp", "gbp", "blog"];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Exactly what the calendar draws, and nothing else. A TaskLite carries sixteen fields; this view reads seven, and
 * the rest — the judge's score and notes, the edit percentage, the decision timestamp, the publish count — were
 * being serialised into the RSC payload for thirteen months of history and then dropped on the floor by the browser.
 */
export type CalendarRow = Pick<TaskLite, "id" | "title" | "channel" | "status" | "scheduledFor" | "createdAt" | "preview">;

/** Marketing calendar: week view with one row per channel (Enrich-style) plus the month view. */
export default function CalendarPanel({ t, tasks, lang, channels = [] }: { t: AppDict; tasks: CalendarRow[]; lang: Lang; channels?: string[] }) {
  const c = t.calendar;
  const today = iso(new Date());
  const [view, setView] = useState<"week" | "month">("week");
  const [anchor, setAnchor] = useState(() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d; });
  const [ym, setYm] = useState(() => ({ y: new Date().getUTCFullYear(), m: new Date().getUTCMonth() }));
  const [sel, setSel] = useState<string>(today);

  const scheduled = tasks.filter((x) => x.status !== "rejected" && (x.scheduledFor || x.status === "approved"));
  const byDay = new Map<string, CalendarRow[]>();
  for (const x of scheduled) { const d = x.scheduledFor ?? x.createdAt.slice(0, 10); byDay.set(d, [...(byDay.get(d) ?? []), x]); }
  const rows = [...new Set([...channels, ...DEFAULT_ROWS, ...scheduled.map((x) => x.channel)])].filter((ch) => ch !== "plan" && ch !== "general").slice(0, 10);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(anchor); d.setUTCDate(anchor.getUTCDate() + i); return d; });
  const fmt = dateFormat(lang, { month: "short", day: "numeric" });
  const range = `${fmt.format(days[0])} – ${fmt.format(days[6])}`;

  function shift(n: number) {
    if (view === "week") { const d = new Date(anchor); d.setUTCDate(d.getUTCDate() + 7 * n); setAnchor(d); }
    else setYm(({ y, m }) => { const mm = m + n; return { y: y + Math.floor(mm / 12), m: ((mm % 12) + 12) % 12 }; });
  }
  function goToday() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); setAnchor(d); setYm({ y: new Date().getUTCFullYear(), m: new Date().getUTCMonth() }); setSel(today); }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") shift(lang === "ar" ? 1 : -1);
      else if (e.key === "ArrowRight") shift(lang === "ar" ? -1 : 1);
      else if (e.key.toLowerCase() === "t") goToday();
      else if (e.key.toLowerCase() === "v") setView((v) => (v === "week" ? "month" : "week"));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const first = new Date(Date.UTC(ym.y, ym.m, 1));
  const daysIn = new Date(Date.UTC(ym.y, ym.m + 1, 0)).getUTCDate();
  const startDow = first.getUTCDay();
  const key = (d: number) => `${ym.y}-${String(ym.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const monthName = dateFormat(lang, { month: "long", year: "numeric" }).format(first);
  const selected = byDay.get(sel) ?? [];
  const unscheduled = tasks.filter((x) => x.status === "approved" && !x.scheduledFor);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="calendarpanel-t1" />{c.title}</span></h1><p className="mt-1 text-ink/70">{c.sub}</p>
          <p className="mt-1 flex flex-wrap gap-4 text-xs text-muted"><span><kbd className="rounded border border-ink/20 px-1">←/→</kbd> {c.navigate}</span><span><kbd className="rounded border border-ink/20 px-1">T</kbd> {c.today}</span><span><kbd className="rounded border border-ink/20 px-1">V</kbd> {c.toggleView}</span></p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={goToday} className="btn btn-secondary btn-xs">{c.today}</button>
          <span className="inline-flex rounded-full border border-ink/15 p-0.5">
            {(["month", "week"] as const).map((v) => <button key={v} onClick={() => setView(v)} className={`rounded-full px-3 py-1 text-xs ${view === v ? "bg-ink text-lilac" : "text-muted"}`}>{v === "week" ? c.week : c.month}</button>)}
          </span>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-center gap-3">
        <button onClick={() => shift(-1)} className="btn btn-secondary btn-xs" aria-label={c.prev}>‹</button>
        <span className="font-display text-lg font-semibold" dir="auto" suppressHydrationWarning>{view === "week" ? range : monthName}</span>
        <button onClick={() => shift(1)} className="btn btn-secondary btn-xs" aria-label={c.next}>›</button>
      </div>

      {view === "week" ? (
        <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 bg-white">
          <table className="w-full min-w-[860px] table-fixed text-xs">
            <thead>
              <tr>
                <th className="w-28 border-b border-ink/10 p-2 text-start text-xs font-semibold uppercase tracking-wide text-muted">{c.channel}</th>
                {days.map((d) => { const k = iso(d); const isT = k === today; return (
                  <th key={k} className={`border-b border-ink/10 p-2 text-center ${isT ? "bg-ink/5" : ""}`}>
                    <span className={`font-display text-xl font-bold ${isT ? "text-ink" : "text-ink/70"}`} dir="ltr">{d.getUTCDate()}</span>
                    <span className="block text-xs uppercase tracking-wide text-muted">{c.days[d.getUTCDay()]}</span>
                  </th>
                ); })}
              </tr>
            </thead>
            <tbody>
              {rows.map((ch) => (
                <tr key={ch} className="border-t border-ink/5">
                  <td className="p-2 align-top text-ink/80"><span className="flex items-center gap-1.5"><Icon name={channelIcon(ch)} className="h-4 w-4 text-ink" />{(t.channelNames as Record<string, string>)[ch] ?? ch}</span></td>
                  {days.map((d) => { const k = iso(d); const items = (byDay.get(k) ?? []).filter((x) => x.channel === ch); return (
                    <td key={k} className={`h-16 p-1 align-top ${k === today ? "bg-ink/5" : ""}`}>
                      {items.length === 0 ? (
                        <Link href={`/${lang}/app`} className="flex h-full min-h-14 items-center justify-center rounded-lg border border-dashed border-ink/10 text-muted hover:border-ink hover:text-ink" aria-label={c.addContent}><Icon name={channelIcon(ch)} className="h-4 w-4" /></Link>
                      ) : items.map((x) => (
                        <button key={x.id} onClick={() => setSel(k)} className={`clip mb-1 block w-full rounded-md px-2 py-1 text-start ${x.status === "approved" ? "bg-ink text-lilac" : "bg-lemon/30 text-ink"}`} dir="auto" title={x.title}>{x.title}</button>
                      ))}
                    </td>
                  ); })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-ink/10 bg-white p-3" dir="ltr">
          <div className="grid grid-cols-7 text-center text-xs text-muted">{c.days.map((d) => <div key={d} className="py-1">{d}</div>)}</div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: startDow }).map((_, i) => <div key={"e" + i} />)}
            {Array.from({ length: daysIn }, (_, i) => i + 1).map((d) => { const k = key(d); const n = byDay.get(k)?.length ?? 0; const isSel = k === sel; const isToday = k === today; return (
              <button key={k} onClick={() => setSel(k)} className={`flex aspect-square flex-col items-center justify-center rounded-lg border text-sm ${isSel ? "border-ink bg-ink text-lilac" : isToday ? "border-lemon" : "border-ink/5 hover:bg-lilac"}`}>
                <span>{d}</span>{n > 0 && <span className={`mt-0.5 rounded-full px-1.5 text-xs ${isSel ? "bg-lemon text-ink" : "bg-ink/10 text-ink"}`}>{n}</span>}
              </button>
            ); })}
          </div>
        </div>
      )}

      <aside className="card mt-4">
        <div className="flex items-center justify-between">
          <button onClick={() => { const d = new Date(sel); d.setUTCDate(d.getUTCDate() - 1); setSel(iso(d)); }} className="grid h-10 w-10 place-items-center rounded-full border border-ink text-ink hover:bg-ink hover:text-lilac" aria-label={c.prev}>‹</button>
          <h2 className="font-display text-lg font-semibold" dir="auto" suppressHydrationWarning>{dateFormat(lang, { weekday: "short", month: "short", day: "numeric" }).format(new Date(sel))}</h2>
          <button onClick={() => { const d = new Date(sel); d.setUTCDate(d.getUTCDate() + 1); setSel(iso(d)); }} className="grid h-10 w-10 place-items-center rounded-full border border-ink text-ink hover:bg-ink hover:text-lilac" aria-label={c.next}>›</button>
        </div>
        {selected.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-muted">{c.none}</p>
            <Link href={`/${lang}/app/chat?prompt=${encodeURIComponent((lang === "ar" ? "جهّزي محتوى ليوم " : "Prepare content for ") + sel)}`} className="btn btn-primary mt-4">{c.addContent}</Link>
          </div>
        ) : (
          <ul className="mt-2 grid gap-2 md:grid-cols-2">{selected.map((x) => <li key={x.id} className="rounded border border-ink/10 p-2 text-xs"><span className="inline-flex items-center gap-1 text-ink"><Icon name={channelIcon(x.channel)} className="h-3.5 w-3.5" />{(t.channelNames as Record<string, string>)[x.channel] ?? x.channel}</span> · {x.title} <span className={`badge ${x.status === "approved" ? "badge-primary" : "badge-accent"}`}>{x.status === "approved" ? t.inbox.approved : t.inbox.pending}</span><p className="mt-1 line-clamp-3 whitespace-pre-wrap text-ink/70" dir="auto">{x.preview}</p></li>)}</ul>
        )}
        {unscheduled.length > 0 && <p className="mt-3 text-xs text-muted">{c.unscheduled}: {unscheduled.length} · <Link href={`/${lang}/app`} className="text-ink underline">{c.setDates}</Link></p>}
      </aside>
    </div>
  );
}
