"use client";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { CalendarView, EidDay, SecCalendar } from "@/lib/secretary-calendar";
import { DEFAULT_RAMADAN_HOURS, addDays, zoneTimeLabel, type QuietWhy } from "@/lib/secretary-agenda";
import { fill } from "@/lib/fill";
import ReadOnlyNote from "./ReadOnlyNote";
import { localDay, useOneWrite } from "./useOneWrite";

/** The settings a save sends: the whole object (PUT /api/secretary/calendar replaces it); `v` and the stamps are the server's. */
export type CalBody = Pick<SecCalendar, "weekend" | "ramadanHours" | "hijriFix" | "holidays">;
type Window = { from: string; to: string };

/** Saved settings (or none: every default) as a body to change one thing in, every other field kept as it is. */
export function calBody(cal: CalBody | null): CalBody {
  return {
    weekend: cal?.weekend ? [...cal.weekend] : null,
    ramadanHours: cal?.ramadanHours ? cal.ramadanHours.map((w) => ({ from: w.from, to: w.to })) : null,
    hijriFix: Object.fromEntries(Object.entries(cal?.hijriFix ?? {}).map(([y, f]) => [y, { ...f }])),
    holidays: { add: [...(cal?.holidays?.add ?? [])], remove: [...(cal?.holidays?.remove ?? [])] },
  };
}
/** The weekend days chosen: the zone's own set saves as null, so the brand follows its country's default. */
export function withWeekend(cal: CalBody | null, days: readonly number[], defaultWeekend: readonly number[]): CalBody {
  const same = days.length === defaultWeekend.length && days.every((d) => defaultWeekend.includes(d));
  return { ...calBody(cal), weekend: same ? null : [...days].sort((a, b) => a - b) };
}
/** Ramadan's chasing hours: up to two windows, [] for no limit, null for the default. */
export function withHours(cal: CalBody | null, hours: readonly Window[] | null): CalBody {
  return { ...calBody(cal), ramadanHours: hours ? hours.map((w) => ({ from: w.from, to: w.to })) : null };
}
/** An Eid's month starting on `to` (`EidDay.earlier` / `later`): Umm al-Qura's own day removes the correction. */
export function withEid(cal: CalBody | null, e: EidDay, to: string): CalBody {
  const b = calBody(cal);
  const y = String(e.year);
  const fix = { ...(b.hijriFix[y] ?? {}) };
  if (to === e.uq) delete fix[e.field];
  else fix[e.field] = to;
  if (Object.keys(fix).length) b.hijriFix[y] = fix;
  else delete b.hijriFix[y];
  return b;
}
/** A default day off ("YYYY-MM-DD") turned off for that day only, or on again. */
export function withHolidayOff(cal: CalBody | null, day: string, off: boolean): CalBody {
  const b = calBody(cal);
  b.holidays.remove = off ? [...new Set([...b.holidays.remove, day])] : b.holidays.remove.filter((v) => v !== day);
  return b;
}
/** A day the owner adds ("YYYY-MM-DD" this year only, "MM-DD" or "H-MM-DD" every year), or takes back. */
export function withAdded(cal: CalBody | null, value: string, add: boolean): CalBody {
  const b = calBody(cal);
  b.holidays.add = add ? [...new Set([...b.holidays.add, value])] : b.holidays.add.filter((v) => v !== value);
  return b;
}
/** A day every year: "MM-DD" (Gregorian) or "H-MM-DD" (Hijri). */
export const yearlyValue = (kind: "greg" | "hijri", month: number, day: number) => `${kind === "hijri" ? "H-" : ""}${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/**
 * `label` is the switch's accessible name: a screen reader announces which day it turns off. It holds a formatted date,
 * which the server's and the browser's ICU may word differently (src/lib/dates.ts), hence `suppressHydrationWarning`.
 */
function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} suppressHydrationWarning onClick={() => onChange(!on)} className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${on ? "bg-ink" : "bg-ink/20"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${on ? "start-[22px]" : "start-0.5"}`} />
    </button>
  );
}

const WEEK = [0, 1, 2, 3, 4, 5, 6];
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/, MD = /^(\d{2})-(\d{2})$/, H_MD = /^H-(\d{2})-(\d{2})$/, H_YMD = /^H-(\d{4})-(\d{2})-(\d{2})$/;

/**
 * «أيام العمل» / "Working days" on My to-dos (spec §1.5): what decides when Reem suggests chasing someone. The weekend
 * (the country's default marked, and a hint to add Friday for a brand in Sharjah), Ramadan's chasing hours (at most two
 * windows), this and next Hijri year's Eid with its days off and "a day earlier / later" (`hijriFix`; a Saudi brand is
 * told why Eid al-Fitr's days off may not move, ruling R26), and the days off of the next 12
 * months with a switch each, the days the owner added or turned off, and forms to add a day for this year only or every
 * year. Default days are labelled expected: the official announcement decides. Every date comes from the server's
 * calendar (`calendarView`); nothing here computes a holiday.
 *
 * Admins and the owner edit (`canEdit` = `brand.write`); a member sees it read-only, inputs disabled and no buttons (the
 * route refuses the same). A save sends the whole settings object with one change (PUT /api/secretary/calendar), one at
 * a time (`useOneWrite`), then shows what the server answered and refreshes the list, whose chase times follow the
 * calendar.
 */
export default function WorkingDaysPanel({ t, lang, calendar, effective, upcoming, eids, canEdit, cityHint, today }: {
  t: AppDict; lang: "ar" | "en"; calendar: CalendarView["calendar"]; effective: CalendarView["effective"]; upcoming: CalendarView["upcoming"]; eids: EidDay[];
  canEdit: boolean;
  /** The brand's city names Sharjah: the hint to add Friday shows while Friday is not in the weekend. */
  cityHint: boolean;
  /** The brand's local day, "YYYY-MM-DD": a date in another year shows its year, and a day added is today or later. */
  today: string;
}) {
  const C = t.todo.cal;
  const [v, setV] = useState<CalendarView>({ calendar, effective, upcoming, eids });
  const [days, setDays] = useState<number[]>(effective.weekend);
  const [hours, setHours] = useState<Window[]>(effective.ramadanHours);
  const [once, setOnce] = useState("");
  const [yearly, setYearly] = useState<{ kind: "greg" | "hijri"; month: number; day: number }>({ kind: "greg", month: 1, day: 1 });
  const { busy, error, send } = useOneWrite(t);

  const day = localDay(lang, today);
  const dayNames = (ds: readonly number[]) => (ds.length ? ds.map((d) => C.weekdays[d]).join(C.sep) : C.noWeekend);
  // Every Eid and holiday carries its own name from the server; only an added day or a day in lieu of no name falls back.
  const nameOf = (why: QuietWhy) => why.name?.[lang] ?? (why.kind === "added" ? C.kinds.added : why.kind === "weekend" ? C.kinds.weekend : C.kinds.holiday);
  /** A holiday value as the owner reads it: a date, or a day and month with "every year". */
  const valueText = (value: string) => {
    let m: RegExpExecArray | null;
    if (DAY.test(value)) return day(value);
    if ((m = MD.exec(value))) return fill(C.yearly, { day: `${+m[2]} ${C.months[+m[1] - 1] ?? m[1]}` });
    if ((m = H_MD.exec(value))) return fill(C.yearly, { day: `${+m[2]} ${C.hijriMonths[+m[1] - 1] ?? m[1]}` });
    if ((m = H_YMD.exec(value))) return fill(C.hijriOnce, { day: `${+m[3]} ${C.hijriMonths[+m[2] - 1] ?? m[2]}`, year: m[1] });
    return value;
  };
  /** Save the whole settings object, then show what the server answered (the PUT answers GET's view). */
  async function save(key: string, body: CalBody): Promise<boolean> {
    const j = (await send(key, "/api/secretary/calendar", "PUT", body)) as (CalendarView & { ok: true }) | null;
    if (!j) return false;
    setV({ calendar: j.calendar, effective: j.effective, upcoming: j.upcoming, eids: j.eids });
    setDays(j.effective.weekend);
    setHours(j.effective.ramadanHours);
    return true;
  }
  const errorOf = (key: string) => error?.key === key && <p role="alert" className="mt-2 text-sm text-danger">{error.text}</p>;

  const eff = v.effective;
  const weekendChanged = days.length !== eff.weekend.length || days.some((d) => !eff.weekend.includes(d));
  const hoursChanged = JSON.stringify(hours) !== JSON.stringify(eff.ramadanHours);
  const defaultHours = DEFAULT_RAMADAN_HOURS.map((w) => `${w.from}-${w.to}`).join(", ");
  const years = [...new Set(v.eids.map((e) => e.year))];
  // A stored record may lack a field the calendar does not need (`usableCalendar` keeps it): read every one guarded.
  const added = v.calendar?.holidays?.add ?? [];
  const removed = v.calendar?.holidays?.remove ?? [];
  const locked = !canEdit || !!busy;

  return (
    <section id="todo-working-days" aria-labelledby="todo-cal-title" className="card mt-8">
      <h2 id="todo-cal-title" className="card-title">{C.title}</h2>
      <p className="mt-1 text-sm text-ink/60">{C.sub}</p>
      {!canEdit && <ReadOnlyNote text={t.readOnly.admin} />}

      <fieldset className="mt-5">
        <legend className="text-sm font-semibold">{C.weekend}</legend>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {WEEK.map((d) => (
            <label key={d} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="weekend" value={d} checked={days.includes(d)} disabled={locked} onChange={(e) => setDays(e.target.checked ? [...days, d] : days.filter((x) => x !== d))} />
              <span>{C.weekdays[d]}</span>
              {eff.defaultWeekend.includes(d) && <span className="badge badge-accent">{C.defaultMark}</span>}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink/60">{fill(C.defaultLine, { country: C.countries[eff.country], days: dayNames(eff.defaultWeekend) })}</p>
        {cityHint && !eff.weekend.includes(5) && <p className="mt-2 text-xs text-danger">{C.sharjahHint}</p>}
        {canEdit && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button disabled={!!busy || !weekendChanged} onClick={() => save("weekend", withWeekend(v.calendar, days, eff.defaultWeekend))} className="btn btn-primary btn-xs">{C.saveWeekend}</button>
            {v.calendar?.weekend != null && <button disabled={!!busy} onClick={() => save("weekend", withWeekend(v.calendar, eff.defaultWeekend, eff.defaultWeekend))} className="btn btn-secondary btn-xs">{C.useDefault}</button>}
          </div>
        )}
        {errorOf("weekend")}
      </fieldset>

      <fieldset className="mt-6">
        <legend className="text-sm font-semibold">{C.ramadan} {v.calendar?.ramadanHours == null && <span className="text-xs font-normal text-ink/50">{C.isDefault}</span>}</legend>
        <p className="mt-1 text-xs text-ink/60">{fill(C.ramadanSub, { zone: zoneTimeLabel(eff.zone, lang) })}</p>
        {hours.length === 0 && <p className="mt-2 text-sm text-ink/70">{C.noHours}</p>}
        {hours.map((w, i) => (
          <div key={i} className="mt-2 flex flex-wrap items-end gap-2">
            <label className="text-xs text-ink/70">{C.from}
              <input type="time" step={900} value={w.from} disabled={locked} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} dir="ltr" className="input mt-1 w-32" />
            </label>
            <label className="text-xs text-ink/70">{C.to}
              <input type="time" step={900} value={w.to} disabled={locked} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} dir="ltr" className="input mt-1 w-32" />
            </label>
            {canEdit && <button type="button" disabled={!!busy} onClick={() => setHours(hours.filter((_, j) => j !== i))} className="btn btn-secondary btn-xs">{C.removeWindow}</button>}
          </div>
        ))}
        {canEdit && (
          <div className="mt-3 flex flex-wrap gap-2">
            {hours.length < 2 && <button type="button" disabled={!!busy} onClick={() => setHours([...hours, { from: "", to: "" }])} className="btn btn-secondary btn-xs">{hours.length ? C.addWindow : C.addOneWindow}</button>}
            <button disabled={!!busy || !hoursChanged} onClick={() => save("hours", withHours(v.calendar, hours))} className="btn btn-primary btn-xs">{C.saveHours}</button>
            {v.calendar?.ramadanHours != null && <button disabled={!!busy} onClick={() => save("hours", withHours(v.calendar, null))} className="btn btn-secondary btn-xs">{fill(C.useDefaultHours, { hours: defaultHours })}</button>}
          </div>
        )}
        {errorOf("hours")}
      </fieldset>

      <div className="mt-6">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">{C.eid} <span className="badge badge-accent">{C.expected}</span></h3>
        <p className="mt-1 text-xs text-ink/60">{C.eidSub}</p>
        {eff.country === "SA" && <p className="mt-1 text-xs text-danger">{C.eidNoteSA}</p>}
        {years.map((y) => (
          <div key={y} className="mt-3">
            <p className="tnum text-xs font-semibold text-ink/70">{fill(C.eidYear, { year: String(y) })}</p>
            <ul className="mt-1 space-y-2">
              {v.eids.filter((e) => e.year === y).map((e) => (
                <li key={e.field} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{e.name[lang]}</span>
                    {" · "}
                    <span suppressHydrationWarning>{fill(C.eidDay, { date: day(e.day) })}</span>
                    {e.start !== e.uq && <span className="text-xs text-ink/50" suppressHydrationWarning> ({fill(C.eidMoved, { date: day(e.kind === "eid_fitr" ? e.uq : addDays(e.uq, 9)) })})</span>}
                    <span className="block text-xs text-ink/60" suppressHydrationWarning>
                      {!e.off ? C.eidOffNone : e.off.first === e.off.last ? fill(C.eidOffOne, { day: day(e.off.first) }) : fill(C.eidOff, { from: day(e.off.first), to: day(e.off.last) })}
                    </span>
                  </span>
                  {canEdit && (e.earlier || e.later) && (
                    <span className="flex flex-wrap gap-2">
                      {e.earlier && <button disabled={!!busy} onClick={() => save("eid", withEid(v.calendar, e, e.earlier!))} className="btn btn-secondary btn-xs">{C.eidEarlier}</button>}
                      {e.later && <button disabled={!!busy} onClick={() => save("eid", withEid(v.calendar, e, e.later!))} className="btn btn-secondary btn-xs">{C.eidLater}</button>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {errorOf("eid")}
      </div>

      <div className="mt-6">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">{C.holidays} <span className="badge badge-accent">{C.expected}</span></h3>
        {v.upcoming.ramadan && <p className="mt-1 text-xs text-ink/60" suppressHydrationWarning>{fill(C.ramadanLine, { start: day(v.upcoming.ramadan.start), end: day(v.upcoming.ramadan.end) })}</p>}
        {v.upcoming.days.length === 0 ? (
          <p className="mt-2 text-sm text-ink/60">{C.holidaysNone}</p>
        ) : (
          <ul className="mt-2 divide-y divide-ink/10 rounded-xl border border-ink/10">
            {v.upcoming.days.map(({ day: d, why }) => (
              <li key={d} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span suppressHydrationWarning>{day(d)}</span>
                  {" · "}
                  <span>{nameOf(why)}</span>
                  {why.kind === "added" && <span className="badge badge-primary ms-2">{C.added}</span>}
                </span>
                {why.kind !== "added" && <Toggle on label={`${nameOf(why)}: ${day(d)}`} disabled={locked} onChange={() => save("holidays", withHolidayOff(v.calendar, d, true))} />}
              </li>
            ))}
          </ul>
        )}
        {removed.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-semibold text-ink/70">{C.offList}</p>
            <ul className="mt-1 space-y-1 text-sm">
              {removed.map((r) => (
                <li key={r} className="flex flex-wrap items-center justify-between gap-2">
                  <span suppressHydrationWarning>{valueText(r)}</span>
                  {canEdit && <button disabled={!!busy} onClick={() => save("holidays", withHolidayOff(v.calendar, r, false))} className="btn btn-secondary btn-xs">{C.turnOn}</button>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {added.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-semibold text-ink/70">{C.addedList}</p>
            <ul className="mt-1 space-y-1 text-sm">
              {added.map((a) => (
                <li key={a} className="flex flex-wrap items-center justify-between gap-2">
                  <span suppressHydrationWarning>{valueText(a)}</span>
                  {canEdit && <button disabled={!!busy} onClick={() => save("holidays", withAdded(v.calendar, a, false))} className="btn btn-secondary btn-xs">{C.removeAdded}</button>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {canEdit && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <form onSubmit={async (e) => { e.preventDefault(); if (once && (await save("holidays", withAdded(v.calendar, once, true)))) setOnce(""); }} className="min-w-0">
              <p className="text-xs font-semibold text-ink/70">{C.addOnce}</p>
              <div className="mt-1 flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1 text-xs text-ink/70">{C.date}
                  <input type="date" value={once} min={today} onChange={(e) => setOnce(e.target.value)} required dir="ltr" className="input mt-1" />
                </label>
                <button disabled={!!busy || !once} className="btn btn-secondary btn-sm">{C.add}</button>
              </div>
            </form>
            <form onSubmit={(e) => { e.preventDefault(); void save("holidays", withAdded(v.calendar, yearlyValue(yearly.kind, yearly.month, yearly.day), true)); }} className="min-w-0">
              <p className="text-xs font-semibold text-ink/70">{C.addYearly}</p>
              <div className="mt-1 grid grid-cols-2 items-end gap-2">
                <label className="block min-w-0 text-xs text-ink/70">{C.calendar}
                  <select value={yearly.kind} onChange={(e) => setYearly({ ...yearly, kind: e.target.value === "hijri" ? "hijri" : "greg" })} className="input mt-1">
                    <option value="greg">{C.gregorian}</option>
                    <option value="hijri">{C.hijri}</option>
                  </select>
                </label>
                <label className="block min-w-0 text-xs text-ink/70">{C.month}
                  <select value={yearly.month} onChange={(e) => setYearly({ ...yearly, month: +e.target.value })} className="input mt-1">
                    {(yearly.kind === "hijri" ? C.hijriMonths : C.months).map((name, i) => <option key={i} value={i + 1}>{name}</option>)}
                  </select>
                </label>
                <label className="block min-w-0 text-xs text-ink/70">{C.day}
                  <input type="number" min={1} max={yearly.kind === "hijri" ? 30 : 31} value={yearly.day} onChange={(e) => setYearly({ ...yearly, day: Math.trunc(+e.target.value) || 1 })} required dir="ltr" className="input mt-1" />
                </label>
                <div><button disabled={!!busy} className="btn btn-secondary btn-sm">{C.add}</button></div>
              </div>
            </form>
          </div>
        )}
        {errorOf("holidays")}
      </div>
    </section>
  );
}
