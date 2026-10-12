"use client";
import Link from "next/link";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { TaskLite } from "@/lib/brand";
import type { Lang } from "@/lib/i18n";
import { dateFormat } from "@/lib/dates";
import { BRAND_TZ } from "@/lib/format";
import { Icon, channelIcon } from "./Icons";
import Scribble from "@/components/Scribble";
import Tabs, { TabPanel } from "@/components/ui/Tabs";
import EmptyState from "@/components/ui/EmptyState";

const DEFAULT_ROWS = ["instagram", "snapchat", "tiktok", "x", "whatsapp", "gbp", "blog"];

/** "YYYY-MM-DD" of a UTC-midnight date (the grid's own days). */
const keyOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
/** The UTC-midnight date of a "YYYY-MM-DD" key. */
const dateOf = (k: string) => { const [y, m, d] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (k: string, n: number) => { const d = dateOf(k); d.setUTCDate(d.getUTCDate() + n); return keyOf(d); };
/** The Sunday that starts the week holding `k`. */
const weekStart = (k: string) => addDays(k, -dateOf(k).getUTCDay());

/**
 * The calendar day of a moment in a zone, "YYYY-MM-DD" (rule 1128). The calendar's "today" and an undated item's day are
 * the brand's (Riyadh), not UTC's: between midnight and 03:00 in Riyadh the UTC date is still yesterday, so "today" was
 * drawn on the wrong column. Pure, for the tests.
 */
export function dayIn(moment: Date, timeZone: string = BRAND_TZ): string {
  const p = Object.fromEntries(dateFormat("en", { year: "numeric", month: "2-digit", day: "2-digit" }, timeZone).formatToParts(moment).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Which way an arrow key moves through time: the arrow pointing along the reading direction goes forward. Pure. */
export function arrowShift(key: string, rtl: boolean): -1 | 1 | 0 {
  if (key === "ArrowRight") return rtl ? -1 : 1;
  if (key === "ArrowLeft") return rtl ? 1 : -1;
  return 0;
}

/**
 * Exactly what the calendar draws, and nothing else. A TaskLite carries sixteen fields; this view reads seven, and
 * the rest — the judge's score and notes, the edit percentage, the decision timestamp, the publish count — were
 * being serialised into the RSC payload for thirteen months of history and then dropped on the floor by the browser.
 */
export type CalendarRow = Pick<TaskLite, "id" | "title" | "channel" | "status" | "scheduledFor" | "createdAt" | "preview">;

type View = "week" | "month" | "agenda";

/**
 * Marketing calendar: week view with one row per channel (Enrich-style), the month view, and (phase 2, rule 1128) an
 * agenda: the month's days that have something, as a list that reads on a phone without sideways scrolling. The views
 * are Tabs. The month grid follows the page's direction (Sunday at the start: on the right in Arabic) instead of being
 * forced left-to-right, the arrows are icons that mirror, the keys (arrows, T, V) work while focus is in the calendar
 * rather than anywhere on the page, and an empty day or cell asks Noor for content for that day.
 */
export default function CalendarPanel({ t, tasks, lang, channels = [] }: { t: AppDict; tasks: CalendarRow[]; lang: Lang; channels?: string[] }) {
  const c = t.calendar;
  const U = t.ux.calendar;
  const rtl = lang === "ar";
  const [today] = useState(() => dayIn(new Date()));
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(() => weekStart(today));
  const [ym, setYm] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }));
  const [sel, setSel] = useState<string>(today);

  const scheduled = tasks.filter((x) => x.status !== "rejected" && (x.scheduledFor || x.status === "approved"));
  const byDay = new Map<string, CalendarRow[]>();
  for (const x of scheduled) { const d = x.scheduledFor ?? dayIn(new Date(x.createdAt)); byDay.set(d, [...(byDay.get(d) ?? []), x]); }
  const rows = [...new Set([...channels, ...DEFAULT_ROWS, ...scheduled.map((x) => x.channel)])].filter((ch) => ch !== "plan" && ch !== "general").slice(0, 10);
  const days = Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
  const fmt = dateFormat(lang, { month: "short", day: "numeric" });
  const dayLong = dateFormat(lang, { weekday: "long", month: "long", day: "numeric" });
  const range = `${fmt.format(dateOf(days[0]))} – ${fmt.format(dateOf(days[6]))}`;
  const chName = (ch: string) => (t.channelNames as Record<string, string>)[ch] ?? ch;
  const askFor = (day: string, ch?: string) => `/${lang}/app/chat?prompt=${encodeURIComponent(U.prompt.replace("{date}", day) + (ch ? ` (${chName(ch)})` : ""))}`;

  function shift(n: number) {
    if (view === "week") setAnchor((a) => addDays(a, 7 * n));
    else setYm(({ y, m }) => { const mm = m + n; return { y: y + Math.floor(mm / 12), m: ((mm % 12) + 12) % 12 }; });
  }
  function goToday() { setAnchor(weekStart(today)); setYm({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }); setSel(today); }
  // Keys work while focus is inside the calendar; a key another control already handled (the tabs' arrows) is left alone.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const tag = (e.target as HTMLElement).tagName;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const n = arrowShift(e.key, rtl);
    if (n) { e.preventDefault(); shift(n); }
    else if (e.key.toLowerCase() === "t") goToday();
    else if (e.key.toLowerCase() === "v") setView((v) => (v === "week" ? "month" : v === "month" ? "agenda" : "week"));
  }

  const first = new Date(Date.UTC(ym.y, ym.m, 1));
  const daysIn = new Date(Date.UTC(ym.y, ym.m + 1, 0)).getUTCDate();
  const startDow = first.getUTCDay();
  const key = (d: number) => `${ym.y}-${String(ym.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const monthName = dateFormat(lang, { month: "long", year: "numeric" }).format(first);
  const selected = byDay.get(sel) ?? [];
  const unscheduled = tasks.filter((x) => x.status === "approved" && !x.scheduledFor);
  const agenda = Array.from({ length: daysIn }, (_, i) => key(i + 1)).filter((k) => (byDay.get(k)?.length ?? 0) > 0);
  const kbd = "rounded border border-border px-1";
  const badge = (x: CalendarRow) => <span className={`badge ${x.status === "approved" ? "badge-primary" : "badge-accent"}`}>{x.status === "approved" ? t.inbox.approved : t.inbox.pending}</span>;
  const item = (x: CalendarRow) => (
    <li key={x.id} className="rounded-lg border border-border p-2 text-xs">
      <span className="flex flex-wrap items-center gap-1.5 text-ink"><Icon name={channelIcon(x.channel)} className="h-3.5 w-3.5" />{chName(x.channel)} · <span dir="auto">{x.title}</span> {badge(x)}</span>
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-foreground-muted" dir="auto">{x.preview}</p>
    </li>
  );

  return (
    <div onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="calendarpanel-t1" />{c.title}</span></h1><p className="mt-1 text-foreground-muted">{c.sub}</p>
          <p className="mt-1 hidden flex-wrap gap-4 text-xs text-foreground-muted pointer-fine:flex"><span><kbd className={kbd} dir="ltr">←/→</kbd> {c.navigate}</span><span><kbd className={kbd}>T</kbd> {c.today}</span><span><kbd className={kbd}>V</kbd> {c.toggleView}</span></p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button type="button" onClick={goToday} className="btn btn-secondary btn-xs">{c.today}</button>
          <Tabs idBase="cal" label={U.views} value={view} onChange={setView} items={[{ id: "week", label: c.week }, { id: "month", label: c.month }, { id: "agenda", label: U.agenda }]} />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-center gap-3">
        <button type="button" onClick={() => shift(-1)} className="icon-btn border border-border" aria-label={c.prev}><Icon name="next" mirror className="h-4 w-4 rotate-180" /></button>
        <span className="min-w-40 text-center font-display text-lg font-semibold" aria-live="polite" dir="auto" suppressHydrationWarning>{view === "week" ? range : monthName}</span>
        <button type="button" onClick={() => shift(1)} className="icon-btn border border-border" aria-label={c.next}><Icon name="next" mirror className="h-4 w-4" /></button>
      </div>

      <TabPanel idBase="cal" id="week" value={view} className="mt-4 overflow-x-auto rounded-card border border-border bg-paper">
        <table className="w-full min-w-[860px] table-fixed text-xs">
          <caption className="sr-only">{range}</caption>
          <thead>
            <tr>
              <th scope="col" className="w-28 border-b border-border p-2 text-start text-xs font-semibold text-foreground-muted">{c.channel}</th>
              {days.map((k) => { const d = dateOf(k); const isT = k === today; return (
                <th key={k} scope="col" aria-current={isT ? "date" : undefined} className={`border-b border-border p-2 text-center ${isT ? "bg-surface-muted" : ""}`}>
                  <span className={`tnum font-display text-xl font-bold ${isT ? "text-ink" : "text-foreground-muted"}`}>{d.getUTCDate()}</span>
                  <span className="block text-xs text-foreground-muted">{c.days[d.getUTCDay()]}</span>
                </th>
              ); })}
            </tr>
          </thead>
          <tbody>
            {rows.map((ch) => (
              <tr key={ch} className="border-t border-border">
                <th scope="row" className="p-2 text-start align-top font-normal text-ink"><span className="flex items-center gap-1.5"><Icon name={channelIcon(ch)} className="h-4 w-4 text-ink" />{chName(ch)}</span></th>
                {days.map((k) => { const items = (byDay.get(k) ?? []).filter((x) => x.channel === ch); return (
                  <td key={k} className={`h-16 p-1 align-top ${k === today ? "bg-surface-muted" : ""}`}>
                    {items.length === 0 ? (
                      <Link href={askFor(k, ch)} className="flex h-full min-h-14 items-center justify-center rounded-lg border border-dashed border-border text-foreground-muted hover:border-ink hover:text-ink" aria-label={`${c.addContent}: ${chName(ch)}, ${dayLong.format(dateOf(k))}`}><Icon name="plus" className="h-4 w-4" /></Link>
                    ) : items.map((x) => (
                      <button type="button" key={x.id} onClick={() => setSel(k)} className={`clip mb-1 block w-full rounded-md px-2 py-1 text-start ${x.status === "approved" ? "bg-ink text-lilac" : "bg-lilac text-ink"}`} dir="auto" title={x.title}>{x.title}</button>
                    ))}
                  </td>
                ); })}
              </tr>
            ))}
          </tbody>
        </table>
      </TabPanel>

      <TabPanel idBase="cal" id="month" value={view} className="mt-4 rounded-card border border-border bg-paper p-3">
        <div className="grid grid-cols-7 text-center text-xs text-foreground-muted" aria-hidden>{c.days.map((d) => <div key={d} className="py-1">{d}</div>)}</div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: startDow }).map((_, i) => <div key={"e" + i} />)}
          {Array.from({ length: daysIn }, (_, i) => i + 1).map((d) => { const k = key(d); const n = byDay.get(k)?.length ?? 0; const isSel = k === sel; const isToday = k === today; return (
            <button type="button" key={k} onClick={() => setSel(k)} aria-pressed={isSel} aria-current={isToday ? "date" : undefined} aria-label={`${dayLong.format(dateOf(k))}${n ? `, ${n}` : ""}`} className={`flex aspect-square flex-col items-center justify-center rounded-lg border text-sm ${isSel ? "border-ink bg-ink text-lilac" : isToday ? "border-ink font-bold" : "border-border hover:bg-lilac"}`} suppressHydrationWarning>
              <span className="tnum">{d}</span>{n > 0 && <span className={`tnum mt-0.5 rounded-full px-1.5 text-xs ${isSel ? "bg-lemon text-ink" : "bg-surface-muted text-ink"}`}>{n}</span>}
            </button>
          ); })}
        </div>
      </TabPanel>

      <TabPanel idBase="cal" id="agenda" value={view} className="mt-4">
        {agenda.length === 0 ? (
          <EmptyState icon="calendar" title={U.agendaEmpty} action={<Link href={askFor(today)} className="btn btn-primary">{U.addForDay}</Link>} />
        ) : (
          <ol className="grid gap-4">
            {agenda.map((k) => (
              <li key={k}>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink" suppressHydrationWarning>{dayLong.format(dateOf(k))}{k === today && <span className="badge badge-primary">{c.today}</span>}</h2>
                <ul className="mt-2 grid gap-2 md:grid-cols-2">{(byDay.get(k) ?? []).map(item)}</ul>
              </li>
            ))}
          </ol>
        )}
      </TabPanel>

      {view !== "agenda" && (
        <aside className="card mt-4" aria-label={dayLong.format(dateOf(sel))}>
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setSel(addDays(sel, -1))} className="icon-btn border border-ink text-ink" aria-label={c.prev}><Icon name="next" mirror className="h-4 w-4 rotate-180" /></button>
            <h2 className="font-display text-lg font-semibold" dir="auto" suppressHydrationWarning>{dateFormat(lang, { weekday: "short", month: "short", day: "numeric" }).format(dateOf(sel))}</h2>
            <button type="button" onClick={() => setSel(addDays(sel, 1))} className="icon-btn border border-ink text-ink" aria-label={c.next}><Icon name="next" mirror className="h-4 w-4" /></button>
          </div>
          {selected.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-foreground-muted">{c.none}</p>
              <Link href={askFor(sel)} className="btn btn-primary mt-4">{U.addForDay}</Link>
            </div>
          ) : (
            <ul className="mt-2 grid gap-2 md:grid-cols-2">{selected.map(item)}</ul>
          )}
          {unscheduled.length > 0 && <p className="mt-3 text-xs text-foreground-muted">{c.unscheduled}: <span className="tnum">{unscheduled.length}</span> · <Link href={`/${lang}/app`} className="text-ink underline">{c.setDates}</Link></p>}
        </aside>
      )}
    </div>
  );
}
