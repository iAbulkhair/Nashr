/**
 * The brand's work calendar: the local days on which Reem does not suggest chasing anyone, built from the brand's own
 * settings (`sec:cal:{scope}`, a `SecCalendar`) and the official private-sector holidays of its country (`COUNTRY_CAL`).
 * The result, `CalData`, is plain data that the browser-safe agenda module (`./secretary-agenda`) reads.
 *
 * Server only. Hijri dates come from `hijriDate` (`./seasons`), the one Umm al-Qura lookup rule 37 allows: this file
 * never builds a date formatter of its own. Settings are hashed with node:crypto for the memo key.
 *
 * The country rows were checked on 2026-10-02 against the sources each one cites. Where a source and spec §1.2 disagreed,
 * the source won and the row says so: Saudi Arabia compensates Eid days that fall on the weekly rest too, Bahrain's
 * private sector has no Arafah day and compensates a Friday only, and Oman compensates an Eid only when its first day
 * is a Friday. They are defaults: the owner can move an Eid (`hijriFix`) and add or remove days (`holidays`).
 */
import { createHash } from "node:crypto";
import { hijriDate } from "./seasons";
import { DEFAULT_RAMADAN_HOURS, addDays, daysBetween, defaultCal, zoneDay, zoneTime, type CalData, type QuietWhy } from "./secretary-agenda";
import { ZONES, weekStartDay, type Zone } from "./zones";
import type { SecFail } from "./secretary";

/** The brand's calendar settings, stored as one JSON value at `sec:cal:{scope}` (absent: every default). Spec §1.1. */
export type SecCalendar = {
  v: 1;
  /** Weekend weekdays, 0 Sunday … 6 Saturday: 0 to 3 days, unique and contiguous (Saturday → Sunday wraps). null: the zone's. */
  weekend: number[] | null;
  /** Ramadan chasing hours, local "HH:mm" on a 15-minute step, at most 2 windows. null: 10:00-15:00. []: no restriction. */
  ramadanHours: { from: string; to: string }[] | null;
  /** Per Hijri year ("1448"), the owner's moon-sighting corrections: the local day each month starts, ±1 day of Umm al-Qura. */
  hijriFix: Record<string, { ramadan1?: string; shawwal1?: string; dhulhijja1?: string }>;
  /** "MM-DD" (every year), "YYYY-MM-DD" (that day), "H-MM-DD" (Hijri, every year), "H-YYYY-MM-DD" (that Hijri day). */
  holidays: { add: string[]; remove: string[] };
  updatedAt: string;
  /** The login of the admin who saved. */
  updatedBy: string;
};

export type Country = "SA" | "AE" | "KW" | "QA" | "BH" | "OM";
const ZONE_COUNTRY: Record<Zone, Country> = { "Asia/Riyadh": "SA", "Asia/Kuwait": "KW", "Asia/Qatar": "QA", "Asia/Bahrain": "BH", "Asia/Dubai": "AE", "Asia/Muscat": "OM" };
/** Each zone is one country (zones.ts): its holidays and its rule for days in lieu follow the zone. */
export const countryOf = (z: Zone): Country => ZONE_COUNTRY[z];

type Name = { ar: string; en: string };
/** A day of the effective Hijri calendar: month (1 Muharram … 12 Dhu al-Hijjah) and day, then `after` days later. */
type HijriPoint = { m: number; d: number; after?: number };
/**
 * Which days of a holiday earn a day in lieu, in the words of each country's law. Only days on the brand's own weekend
 * count: a holiday on a day the brand works was not lost.
 * - weekend: each day of it on the weekend (Saudi art. 24; Qatar's "working days");
 * - friday: each Friday (Bahrain);
 * - eid_day_friday: one day when the Eid's first day, 1 Shawwal or 10 Dhu al-Hijjah, is a Friday (Oman's Eids);
 * - weekend_once: one day when one or more of its days are on the weekend (Oman's other holidays);
 * - none.
 */
type Trigger = "weekend" | "friday" | "eid_day_friday" | "weekend_once" | "none";
/** An Eid: from `from` to `to` (both included, same Hijri year), or `days` calendar days from `from`. */
type EidRule = { from: HijriPoint; to?: HijriPoint; days?: number; comp: Trigger };
/** Any other official holiday: Gregorian "MM-DD" days, Hijri "MM-DD" days, or the n-th weekday of a month. Several days are one occasion. */
type HolidayRule = { id: string; name: Name; greg?: string[]; hijri?: string[]; nth?: { month: number; weekday: number; n: number }; comp: Trigger };
type CountryCal = {
  fitr: EidRule;
  adha: EidRule;
  holidays: HolidayRule[];
  /**
   * Where a day in lieu goes. "sa": a one-day holiday on the first weekend day moves to the day before (Friday →
   * Thursday), on a later one to the day after the weekend (Saturday → Sunday); an Eid's days go after it.
   * "next_working": the first days after the holiday that are neither weekend nor quiet. "none": no day in lieu.
   */
  compensation: "sa" | "next_working" | "none";
  /** The law also gives a day for a holiday that falls on another official holiday (Bahrain; Qatar's "working days"). */
  overlap?: boolean;
  /** The days Oman announced for a Gregorian year (MM-DD and the holiday they stand for); they replace the decree's non-Eid dates that year. */
  omanYear?: Record<number, { day: string; id: string }[]>;
  source: string;
};

const NAMES = {
  fitr: { ar: "إجازة عيد الفطر", en: "Eid al-Fitr holiday" },
  adha: { ar: "إجازة عيد الأضحى", en: "Eid al-Adha holiday" },
  foundingDay: { ar: "يوم التأسيس", en: "Founding Day" },
  nationalDay: { ar: "اليوم الوطني", en: "National Day" },
  nationalFeast: { ar: "العيد الوطني", en: "National Day" },
  newYear: { ar: "رأس السنة الميلادية", en: "New Year's Day" },
  hijriNewYear: { ar: "رأس السنة الهجرية", en: "Hijri New Year" },
  mawlid: { ar: "المولد النبوي الشريف", en: "The Prophet's Birthday" },
  israMiraj: { ar: "الإسراء والمعراج", en: "Isra and Mi'raj" },
  liberationDay: { ar: "يوم التحرير", en: "Liberation Day" },
  labourDay: { ar: "يوم العمال", en: "Labour Day" },
  ashura: { ar: "عاشوراء", en: "Ashura" },
  sportDay: { ar: "اليوم الرياضي للدولة", en: "National Sport Day" },
  accessionDay: { ar: "يوم تولي السلطان مقاليد الحكم", en: "Accession Day" },
} as const satisfies Record<string, Name>;

/** The day after 29 Ramadan: 30 Ramadan in a 30-day month, else 1 Shawwal. */
const AFTER_29_RAMADAN: HijriPoint = { m: 9, d: 29, after: 1 };

/** Each country's official private-sector holidays (spec §1.2), as checked against the source in `source`. */
export const COUNTRY_CAL: Record<Country, CountryCal> = {
  SA: {
    fitr: { from: AFTER_29_RAMADAN, days: 4, comp: "weekend" },
    adha: { from: { m: 12, d: 9 }, days: 4, comp: "weekend" },
    holidays: [
      { id: "founding_day", name: NAMES.foundingDay, greg: ["02-22"], comp: "weekend" },
      { id: "national_day", name: NAMES.nationalDay, greg: ["09-23"], comp: "weekend" },
    ],
    compensation: "sa",
    source:
      "Labour Law Implementing Regulations art. 24 (HRSD, «اللائحة التنفيذية لنظام العمل وملحقاتها», hrsd.gov.sa, read 2026-10-02): " +
      "Eid al-Fitr four days from the day after 29 Ramadan (Umm al-Qura); Eid al-Adha four days from Arafah; National Day " +
      "one day, 1 Libra (23 September); Founding Day 22 February. II.1: holiday days that fall on the weekly rest, Eid " +
      "days included, are compensated before or after them (the employer's choice; an Eid's days go after it here, as in " +
      "HRSD's 2024 Eid al-Adha; unverified against an HRSD page). II.4: National or Founding Day inside an Eid earns nothing.",
  },
  AE: {
    fitr: { from: AFTER_29_RAMADAN, to: { m: 10, d: 3 }, comp: "none" },
    adha: { from: { m: 12, d: 9 }, to: { m: 12, d: 12 }, comp: "none" },
    holidays: [
      { id: "new_year", name: NAMES.newYear, greg: ["01-01"], comp: "none" },
      { id: "hijri_new_year", name: NAMES.hijriNewYear, hijri: ["01-01"], comp: "none" },
      { id: "mawlid", name: NAMES.mawlid, hijri: ["03-12"], comp: "none" },
      { id: "national_day", name: NAMES.nationalDay, greg: ["12-02", "12-03"], comp: "none" },
    ],
    compensation: "none",
    source:
      "Cabinet Resolution 27/2024 on public holidays, public and private sectors (u.ae «Public holidays», read 2026-10-02): " +
      "Eid al-Fitr 1-3 Shawwal, and 30 Ramadan when Ramadan has 30 days; Arafah 9 and Eid al-Adha 10-12 Dhu al-Hijjah; " +
      "1 January, 1 Muharram, 12 Rabi al-Awwal, National Day 2-3 December (Commemoration Day is not listed). A holiday on " +
      "the weekend or on another holiday is not moved.",
  },
  KW: {
    fitr: { from: { m: 10, d: 1 }, to: { m: 10, d: 3 }, comp: "none" },
    adha: { from: { m: 12, d: 9 }, to: { m: 12, d: 12 }, comp: "none" },
    holidays: [
      { id: "new_year", name: NAMES.newYear, greg: ["01-01"], comp: "none" },
      { id: "hijri_new_year", name: NAMES.hijriNewYear, hijri: ["01-01"], comp: "none" },
      { id: "isra_miraj", name: NAMES.israMiraj, hijri: ["07-27"], comp: "none" },
      { id: "mawlid", name: NAMES.mawlid, hijri: ["03-12"], comp: "none" },
      { id: "national_day", name: NAMES.nationalFeast, greg: ["02-25"], comp: "none" },
      { id: "liberation_day", name: NAMES.liberationDay, greg: ["02-26"], comp: "none" },
    ],
    compensation: "none",
    source:
      "Law 6/2010 on labour in the private sector, art. 68 (text read on lawskw.com on 2026-10-02; PAM's manpower.gov.kw " +
      "did not answer): Hijri New Year, Isra and Mi'raj, Eid al-Fitr three days, Arafah, Eid al-Adha three days, the " +
      "Prophet's Birthday, National Day 25 February, Liberation Day 26 February, 1 January. Only a holiday worked earns a " +
      "day in lieu; one on the weekend does not.",
  },
  QA: {
    fitr: { from: { m: 10, d: 1 }, days: 3, comp: "weekend" },
    adha: { from: { m: 12, d: 10 }, days: 3, comp: "weekend" },
    holidays: [
      { id: "sport_day", name: NAMES.sportDay, nth: { month: 2, weekday: 2, n: 2 }, comp: "weekend" },
      { id: "national_day", name: NAMES.nationalDay, greg: ["12-18"], comp: "weekend" },
    ],
    compensation: "next_working",
    overlap: true,
    source:
      "Labour Law 14/2004 art. 78 (almeezan.qa, read 2026-10-02): three working days for Eid al-Fitr, three working days " +
      "for Eid al-Adha, one working day for Independence (National) Day, 18 December; a day on the weekend therefore moves " +
      "to the next working day. National Sport Day, the second Tuesday of February (Emiri Decision 80/2011), announced by " +
      "the Ministry of Labour as a private-sector holiday (press, 2026). The employer's three days are not known here.",
  },
  BH: {
    fitr: { from: { m: 10, d: 1 }, to: { m: 10, d: 3 }, comp: "friday" },
    adha: { from: { m: 12, d: 10 }, to: { m: 12, d: 12 }, comp: "friday" },
    holidays: [
      { id: "new_year", name: NAMES.newYear, greg: ["01-01"], comp: "friday" },
      { id: "labour_day", name: NAMES.labourDay, greg: ["05-01"], comp: "friday" },
      { id: "hijri_new_year", name: NAMES.hijriNewYear, hijri: ["01-01"], comp: "friday" },
      { id: "ashura", name: NAMES.ashura, hijri: ["01-09", "01-10"], comp: "friday" },
      { id: "mawlid", name: NAMES.mawlid, hijri: ["03-12"], comp: "friday" },
      { id: "national_day", name: NAMES.nationalFeast, greg: ["12-16", "12-17"], comp: "friday" },
    ],
    compensation: "next_working",
    overlap: true,
    source:
      "Labour Law 36/2012 art. 64 and Cabinet Resolution 1/2013 on private-sector holidays (lloc.gov.bh, read 2026-10-02): " +
      "1 Muharram, Ashura 9-10 Muharram, 12 Rabi al-Awwal, Eid al-Fitr 1-3 Shawwal, Eid al-Adha 10-12 Dhu al-Hijjah (no " +
      "Arafah, unlike spec §1.2), 1 January, 1 May, National Day 16-17 December. Art. 2: a holiday on a Friday or on " +
      "another official holiday earns another day; a Saturday does not (the government's circulars, which also give one " +
      "for a Saturday, are not the private-sector rule).",
  },
  OM: {
    fitr: { from: { m: 9, d: 29 }, to: { m: 10, d: 3 }, comp: "eid_day_friday" },
    adha: { from: { m: 12, d: 9 }, to: { m: 12, d: 12 }, comp: "eid_day_friday" },
    holidays: [
      { id: "accession_day", name: NAMES.accessionDay, greg: ["01-11"], comp: "weekend_once" },
      { id: "hijri_new_year", name: NAMES.hijriNewYear, hijri: ["01-01"], comp: "weekend_once" },
      { id: "mawlid", name: NAMES.mawlid, hijri: ["03-12"], comp: "weekend_once" },
      { id: "isra_miraj", name: NAMES.israMiraj, hijri: ["07-27"], comp: "weekend_once" },
      { id: "national_day", name: NAMES.nationalDay, greg: ["11-20", "11-21"], comp: "weekend_once" },
    ],
    compensation: "next_working",
    omanYear: {
      2026: [
        { day: "01-15", id: "accession_day" }, { day: "01-18", id: "isra_miraj" }, { day: "06-18", id: "hijri_new_year" },
        { day: "08-27", id: "mawlid" }, { day: "11-25", id: "national_day" }, { day: "11-26", id: "national_day" },
      ],
    },
    source:
      "Royal Decree 88/2022 as amended by RD 15/2025 (qanoon.om, read 2026-10-02), public and private sectors: 1 Muharram, " +
      "12 Rabi al-Awwal, 27 Rajab, National Day 20-21 November, Accession Day (11 January; the decree names no date); one " +
      "or both weekend days inside these earn one day. Eid al-Fitr 29 Ramadan to 3 Shawwal, Eid al-Adha 9-12 Dhu " +
      "al-Hijjah; a Friday is compensated when it is the first day of either Eid. 2026: the Council of Ministers' list " +
      "(01-15, 01-18, 06-18, 08-27, 11-25, 11-26) replaces those dates; update `omanYear` each January (flows.md §39).",
  },
};

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MD_RE = /^(\d{2})-(\d{2})$/;
const H_MD_RE = /^H-(\d{2})-(\d{2})$/;
const H_YMD_RE = /^H-(\d{4})-(\d{2})-(\d{2})$/;
const validDay = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const isDay = (v: unknown): v is string => typeof v === "string" && DAY_RE.test(v) && validDay(+v.slice(0, 4), +v.slice(5, 7), +v.slice(8, 10));
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const FRIDAY = 5;

type Hijri = { y: number; m: number; d: number };
/** Whether a holiday value ("MM-DD", "YYYY-MM-DD", "H-MM-DD", "H-YYYY-MM-DD") names a local day with that Hijri date. */
function matchesValue(v: string, day: string, h: Hijri | undefined): boolean {
  if (DAY_RE.test(v)) return v === day;
  if (MD_RE.test(v)) return day.slice(5) === v;
  let m: RegExpExecArray | null;
  if ((m = H_MD_RE.exec(v))) return !!h && h.m === +m[1] && h.d === +m[2];
  if ((m = H_YMD_RE.exec(v))) return !!h && h.y === +m[1] && h.m === +m[2] && h.d === +m[3];
  return false;
}

/** The first day the calendar covers (today-14) and its Umm al-Qura date: a dated value before it is stale. */
function windowStart(now: number, zone: Zone): { day: string; h: Hijri } {
  const day = addDays(zoneDay(now, zone), -BACK);
  const h = hijriDate(new Date(zoneTime(day, 12, 0, zone)), zone);
  return { day, h: { y: h.y, m: h.m, d: h.day } };
}
/**
 * A dated holiday value ("YYYY-MM-DD", "H-YYYY-MM-DD") for a day before the calendar's first day (ruling R8): nothing it
 * names can still be shown, so saving settings back unchanged drops it, and the calendar ignores it.
 */
function isStale(v: string, from: { day: string; h: Hijri }): boolean {
  if (DAY_RE.test(v)) return v < from.day;
  const m = H_YMD_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  return y !== from.h.y ? y < from.h.y : mo !== from.h.m ? mo < from.h.m : d < from.h.d;
}

/** The calendar covers today-14 … today+400 (spec §1.3); it is computed over a month more on each side, so an Eid or a day in lieu at an edge comes out whole. */
const BACK = 14, AHEAD = 400, MARGIN = 35;

type Built = { data: CalData; ramadanSpans: { start: string; end: string }[]; produced: { day: string; h: Hijri | undefined }[] };

const inLieu = (n: Name | undefined): QuietWhy => ({ kind: "holiday", ...(n ? { name: { ar: `بدل ${n.ar}`, en: `Day in lieu of ${n.en}` } } : {}) });

function build(cal: SecCalendar | null, zone: Zone, now: number): Built {
  const rules = COUNTRY_CAL[countryOf(zone)];
  // Stored settings were checked on save; a weekend that is not 0-3 contiguous days (an old or hand-edited record) is
  // ignored for the zone's own, so no walk below can run over an all-weekend week.
  const own = parseWeekend(cal?.weekend), ownHours = cal?.ramadanHours;
  const weekend = Array.isArray(own) ? own : [...ZONES[zone].weekend];
  const wk = new Set(weekend);
  const isWk = (day: string) => wk.has(weekday(day));
  const today = zoneDay(now, zone);
  const w0 = addDays(today, -BACK), w1 = addDays(today, AHEAD);
  const r0 = addDays(w0, -MARGIN), r1 = addDays(w1, MARGIN);
  const inWindow = (day: string) => day >= w0 && day <= w1;

  // 1. Umm al-Qura, once per local day (its noon), and the local day each Hijri month starts on.
  const days: string[] = [];
  const starts = new Map<string, string>();
  for (let day = r0; day <= r1; day = addDays(day, 1)) {
    days.push(day);
    const h = hijriDate(new Date(zoneTime(day, 12, 0, zone)), zone);
    const key = `${h.y}-${h.m}`;
    if (!starts.has(key)) starts.set(key, addDays(day, 1 - h.day));
  }
  // 2. The owner's sighting corrections move a whole month: Ramadan, Shawwal, Dhu al-Hijjah (±1 day, checked on save).
  const thisYear = hijriDate(new Date(now), zone).y;
  for (const [y, fix] of Object.entries(cal?.hijriFix ?? {})) {
    if (+y < thisYear) continue; // a past year's correction (ruling R8)
    for (const [field, m] of [["ramadan1", 9], ["shawwal1", 10], ["dhulhijja1", 12]] as const) {
      const v = fix?.[field], key = `${y}-${m}`, uq = starts.get(key);
      if (uq && isDay(v) && Math.abs(daysBetween(uq, v)) <= 1) starts.set(key, v);
    }
  }
  const start = (y: number, m: number) => starts.get(`${y}-${m}`);
  const next = (y: number, m: number) => (m === 12 ? start(y + 1, 1) : start(y, m + 1));
  const monthLen = (y: number, m: number) => { const s = start(y, m), n = next(y, m); return s && n ? daysBetween(s, n) : 30; };
  /** A Hijri day of the effective calendar as a local day; a day past the month's end is its last day. */
  const hDay = (y: number, p: HijriPoint) => { const s = start(y, p.m); return s ? addDays(s, Math.min(p.d, monthLen(y, p.m)) - 1 + (p.after ?? 0)) : undefined; };

  // 3. The effective Hijri date of every day: the latest month start on or before it.
  const months = [...starts.entries()].map(([k, s]) => ({ y: +k.split("-")[0], m: +k.split("-")[1], s })).sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  const hijriOf = new Map<string, Hijri>();
  for (let i = 0, j = -1; i < days.length; i++) {
    while (j + 1 < months.length && months[j + 1].s <= days[i]) j++;
    if (j >= 0) hijriOf.set(days[i], { y: months[j].y, m: months[j].m, d: daysBetween(months[j].s, days[i]) + 1 });
  }
  const hijriYears = [...new Set(months.map((x) => x.y))];
  const ramadanSpans = months.filter((x) => x.m === 9).map((x) => ({ start: x.s, end: addDays(next(x.y, 9) ?? addDays(x.s, 30), -1) }));

  // 4. The occasions: each Eid and each official holiday, one entry per year, as a run of local days.
  type Occasion = { days: string[]; why: QuietWhy; comp: Trigger; eidDay?: string };
  const occasions: Occasion[] = [];
  const span = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
  for (const y of hijriYears) {
    for (const [rule, kind, eidDay] of [[rules.fitr, "eid_fitr", hDay(y, { m: 10, d: 1 })], [rules.adha, "eid_adha", hDay(y, { m: 12, d: 10 })]] as const) {
      const from = hDay(y, rule.from);
      const to = rule.to ? hDay(y, rule.to) : from && addDays(from, (rule.days ?? 1) - 1);
      if (!from || !to || from > to) continue;
      occasions.push({ days: span(from, to), why: { kind, name: kind === "eid_fitr" ? NAMES.fitr : NAMES.adha }, comp: rule.comp, eidDay });
    }
  }
  const gregYears: number[] = [];
  for (let Y = +r0.slice(0, 4); Y <= +r1.slice(0, 4); Y++) gregYears.push(Y);
  const announced = rules.omanYear ?? {};
  for (const rule of rules.holidays) {
    const runs: string[][] = [];
    for (const Y of gregYears) {
      if (rule.greg) runs.push(rule.greg.filter((md) => validDay(Y, +md.slice(0, 2), +md.slice(3, 5))).map((md) => `${Y}-${md}`));
      if (rule.nth) {
        const first = `${Y}-${String(rule.nth.month).padStart(2, "0")}-01`;
        runs.push([addDays(first, ((rule.nth.weekday - weekday(first) + 7) % 7) + 7 * (rule.nth.n - 1))]);
      }
    }
    if (rule.hijri) for (const y of hijriYears) runs.push(rule.hijri.map((md) => hDay(y, { m: +md.slice(0, 2), d: +md.slice(3, 5) })).filter((d): d is string => !!d));
    for (const run of runs) {
      // Oman: a year with an announced list keeps only the announced days for its non-Eid holidays.
      const kept = run.filter((d) => d >= r0 && d <= r1 && !announced[+d.slice(0, 4)]);
      if (kept.length) occasions.push({ days: kept, why: { kind: "holiday", name: rule.name }, comp: rule.comp });
    }
  }
  for (const [Y, list] of Object.entries(announced)) {
    for (const { day, id } of list) {
      const name = rules.holidays.find((h) => h.id === id)?.name;
      if (`${Y}-${day}` >= r0 && `${Y}-${day}` <= r1) occasions.push({ days: [`${Y}-${day}`], why: { kind: "holiday", ...(name ? { name } : {}) }, comp: "none" });
    }
  }

  // 5. The owner's removals take a default day out, before it can earn a day in lieu.
  const first = windowStart(now, zone);
  const removals = (cal?.holidays?.remove ?? []).filter((v) => !isStale(v, first));
  const removed = (day: string) => removals.some((v) => matchesValue(v, day, hijriOf.get(day)));
  // Eids first, then the other holidays, each by date: a holiday inside an Eid is the one that overlaps.
  const rank = (o: Occasion) => (o.why.kind === "holiday" ? 1 : 0);
  occasions.sort((a, b) => rank(a) - rank(b) || (a.days[0] < b.days[0] ? -1 : a.days[0] > b.days[0] ? 1 : 0));
  const holidayAt = new Map<string, QuietWhy>();
  const produced = new Set<string>();
  const owed: { occ: Occasion; n: number }[] = [];
  for (const occ of occasions) {
    occ.days.forEach((d) => produced.add(d));
    occ.days = occ.days.filter((d) => !removed(d));
    let n = 0;
    for (const d of occ.days) {
      if (holidayAt.has(d)) { if (rules.overlap) n++; continue; }
      holidayAt.set(d, occ.why);
      if (isWk(d) && (occ.comp === "weekend" || (occ.comp === "friday" && weekday(d) === FRIDAY))) n++;
    }
    if (occ.comp === "weekend_once" && occ.days.some(isWk)) n = 1;
    if (occ.comp === "eid_day_friday" && occ.eidDay && occ.days.includes(occ.eidDay) && weekday(occ.eidDay) === FRIDAY && isWk(occ.eidDay)) n = 1;
    if (n > 0 && rules.compensation !== "none") owed.push({ occ, n });
  }

  // 6. The days in lieu, once every holiday is known, so none lands on another holiday.
  const lieu = new Map<string, QuietWhy>();
  // Never a day the owner removed: removing one Eid day must not also cost the day in lieu.
  const free = (d: string) => !isWk(d) && !holidayAt.has(d) && !lieu.has(d) && !removed(d);
  for (const { occ, n } of owed) {
    const why = inLieu(occ.why.name);
    const last = occ.days[occ.days.length - 1];
    let left = n;
    if (rules.compensation === "sa" && occ.days.length === 1 && n === 1) {
      const d = occ.days[0];
      let target = addDays(d, -1);
      if (isWk(target)) { target = d; for (let k = 0; k < 7 && isWk(target); k++) target = addDays(target, 1); }
      if (free(target)) { lieu.set(target, why); left = 0; }
    }
    // A run of at most a few weeks: the walk stops at the end of the computed range.
    for (let d = addDays(last, 1); left > 0 && d <= r1; d = addDays(d, 1)) if (free(d)) { lieu.set(d, why); left--; }
  }
  for (const d of lieu.keys()) produced.add(d);

  // 7. Together: holidays, days in lieu (unless removed), then the owner's added days. Weekend days stay out.
  const quiet: Record<string, QuietWhy> = {};
  const ramadan: string[] = [];
  const add = (cal?.holidays?.add ?? []).filter((v) => !isStale(v, first));
  for (const day of days) {
    if (!inWindow(day)) continue;
    const h = hijriOf.get(day);
    if (h?.m === 9) ramadan.push(day);
    if (isWk(day)) continue;
    const why = holidayAt.get(day) ?? lieu.get(day) ?? (add.some((v) => matchesValue(v, day, h)) ? { kind: "added" as const } : undefined);
    if (why) quiet[day] = why;
  }
  const data: CalData = {
    zone,
    weekend,
    weekStart: weekStartDay(weekend),
    quiet,
    ramadan,
    ramadanHours: (Array.isArray(ownHours) ? ownHours : DEFAULT_RAMADAN_HOURS).map((w) => ({ from: w.from, to: w.to })),
    briefAt: defaultCal(zone).briefAt,
  };
  return { data, ramadanSpans, produced: [...produced].filter(inWindow).sort().map((day) => ({ day, h: hijriOf.get(day) })) };
}

const freeze = <T>(v: T): T => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) freeze(x); }
  return v;
};
/** Object keys in order at every level, so the same settings always hash the same. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
const calHash = (cal: SecCalendar | null) =>
  cal ? createHash("sha256").update(JSON.stringify(canonical({ weekend: cal.weekend, ramadanHours: cal.ramadanHours, hijriFix: cal.hijriFix, holidays: cal.holidays }))).digest("base64url").slice(0, 22) : "-";

/** CalData memo (spec §1.3): at most this many entries, least recently used out first. */
const CAL_MEMO_MAX = 200;
const memo = new Map<string, { data: CalData; ramadanSpans: { start: string; end: string }[] }>();
function memoised(cal: SecCalendar | null, zone: Zone, now: number) {
  const key = `${zone}|${zoneDay(now, zone)}|${calHash(cal)}`;
  const hit = memo.get(key);
  if (hit) {
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const { data, ramadanSpans } = build(cal, zone, now);
  const entry = freeze({ data, ramadanSpans });
  memo.set(key, entry);
  if (memo.size > CAL_MEMO_MAX) memo.delete(memo.keys().next().value!);
  return entry;
}

/**
 * The brand's calendar at `now`: its effective weekend and week start, the quiet days (Eid, official holidays, days in
 * lieu and days the owner added; weekend days are left out) and the Ramadan days from today-14 to today+400, the Ramadan
 * hours and the morning brief's time. Memoised per zone, local day and settings (not `updatedAt`/`updatedBy`), so a
 * saved change applies at once. The object is frozen and shared: copy it to change it.
 */
export function workCalendar(cal: SecCalendar | null, zone: Zone, now: number): CalData {
  return memoised(cal, zone, now).data;
}

/** The quiet days of the next 365 days (today included), in order and with their reasons, and the next (or current) Ramadan. */
export function upcomingQuiet(cal: SecCalendar | null, zone: Zone, now: number): { days: { day: string; why: QuietWhy }[]; ramadan: { start: string; end: string } | null } {
  const { data, ramadanSpans } = memoised(cal, zone, now);
  const today = zoneDay(now, zone), last = addDays(today, 364);
  const days = Object.keys(data.quiet).filter((d) => d >= today && d <= last).sort().map((day) => ({ day, why: data.quiet[day] }));
  const r = ramadanSpans.find((s) => s.end >= today && s.start <= last);
  return { days, ramadan: r ? { start: r.start, end: r.end } : null };
}

export type CalError = "weekend_invalid" | "ramadan_hours_invalid" | "bad_year" | "hijri_fix_range" | "holidays_invalid" | "bad_request";
/** A refusal in the shape of `SecFail` (secretary.ts), with the calendar's own error codes. */
export type CalFail = Omit<SecFail, "error" | "item"> & { error: CalError };
const calFail = (error: CalError, field?: string): CalFail => ({ ok: false, error, status: 400, ...(field ? { field } : {}) });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 0 to 3 weekdays in one run (Saturday → Sunday wraps), in run order; null when not. */
function parseWeekend(v: unknown): number[] | null | false {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > 3 || !v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) || new Set(v).size !== v.length) return false;
  if (v.length === 0) return [];
  for (const s of v as number[]) {
    const run = v.map((_, i) => (s + i) % 7);
    if (run.every((d) => v.includes(d))) return run;
  }
  return false;
}

/** "HH:mm", hours 00-23, minutes on the quarter hour, as minutes of the day. */
const clock = (v: unknown) => {
  const m = typeof v === "string" ? /^(\d{2}):(\d{2})$/.exec(v) : null;
  return m && +m[1] <= 23 && ["00", "15", "30", "45"].includes(m[2]) ? +m[1] * 60 + +m[2] : null;
};
function parseHours(v: unknown): { from: string; to: string }[] | null | false {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > 2) return false;
  const out: { from: string; to: string; a: number; b: number }[] = [];
  for (const w of v) {
    if (!isObject(w) || Object.keys(w).some((k) => k !== "from" && k !== "to")) return false;
    const a = clock(w.from), b = clock(w.to);
    if (a === null || b === null || a >= b) return false;
    out.push({ from: w.from as string, to: w.to as string, a, b });
  }
  out.sort((x, y) => x.a - y.a);
  if (out.length === 2 && out[0].b > out[1].a) return false;
  return out.map(({ from, to }) => ({ from, to }));
}

/** The Umm al-Qura local day a Hijri month starts on, found near its mean-month estimate (ICU is never more than 2 days off it). */
function uqMonthStart(y: number, m: number, zone: Zone): string | null {
  const est = new Date(Date.UTC(622, 6, 19) + Math.round(((y - 1) * 12 + (m - 1)) * 29.530588853) * 864e5).toISOString().slice(0, 10);
  for (let k = -6; k <= 6; k++) {
    const day = addDays(est, k);
    const h = hijriDate(new Date(zoneTime(day, 12, 0, zone)), zone);
    if (h.y === y && h.m === m && h.day === 1) return day;
  }
  return null;
}

const HOLIDAY_FORMATS: [RegExp, (m: RegExpExecArray) => boolean][] = [
  [MD_RE, (m) => validDay(2000, +m[1], +m[2])],
  [DAY_RE, (m) => validDay(+m[1], +m[2], +m[3])],
  [H_MD_RE, (m) => +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 30],
  [H_YMD_RE, (m) => +m[1] >= 1400 && +m[1] <= 1600 && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 30],
];
const HOLIDAY_MAX = 30;
const holidayValue = (v: unknown) => typeof v === "string" && HOLIDAY_FORMATS.some(([re, ok]) => { const m = re.exec(v); return !!m && ok(m); });

const TOP_FIELDS = new Set(["v", "weekend", "ramadanHours", "hijriFix", "holidays", "updatedAt", "updatedBy"]);
const FIX_FIELDS = { ramadan1: 9, shawwal1: 10, dhulhijja1: 12 } as const;

/**
 * Check the Working days settings an admin saves, field by field (spec §1.1), and return them normalised and stamped
 * with `now` and the admin's `login`. Refused: an unknown field (`bad_request`); a weekend that is not 0-3 contiguous
 * days (`weekend_invalid`); Ramadan hours that are not at most two "HH:mm" windows on the quarter hour, each from
 * before to, not overlapping (`ramadan_hours_invalid`); a `hijriFix` year after the zone's next Hijri year (`bad_year`)
 * or a date more than a day from Umm al-Qura's (`hijri_fix_range`); more than 30 values in `add` or `remove`, a
 * malformed value, or a removal that no default day of the coming year matches (`holidays_invalid`).
 * Stale values are dropped, not refused (ruling R8), so settings read from a GET and saved back unchanged still save:
 * a `hijriFix` year before the current Hijri year, and a dated value ("YYYY-MM-DD", "H-YYYY-MM-DD") before today-14.
 * `v`, `updatedAt` and `updatedBy` may come back from a GET and are replaced.
 */
export function parseCalendar(body: Record<string, unknown>, now: number, zone: Zone, login: string): { ok: true; cal: SecCalendar } | CalFail {
  if (!isObject(body)) return calFail("bad_request");
  for (const k of Object.keys(body)) if (!TOP_FIELDS.has(k)) return calFail("bad_request", k);
  if (body.v !== undefined && body.v !== 1) return calFail("bad_request", "v");

  const weekend = parseWeekend(body.weekend);
  if (weekend === false) return calFail("weekend_invalid", "weekend");
  const ramadanHours = parseHours(body.ramadanHours);
  if (ramadanHours === false) return calFail("ramadan_hours_invalid", "ramadanHours");

  const hijriFix: SecCalendar["hijriFix"] = {};
  if (body.hijriFix !== undefined && body.hijriFix !== null) {
    if (!isObject(body.hijriFix)) return calFail("bad_request", "hijriFix");
    const current = hijriDate(new Date(now), zone).y;
    for (const [year, fix] of Object.entries(body.hijriFix)) {
      if (!/^\d{4}$/.test(year) || +year > current + 1) return calFail("bad_year", `hijriFix.${year}`);
      if (+year < current) continue; // ruling R8: a past year is dropped, so settings saved back unchanged still save
      if (!isObject(fix)) return calFail("bad_request", `hijriFix.${year}`);
      const out: SecCalendar["hijriFix"][string] = {};
      for (const [field, value] of Object.entries(fix)) {
        if (!Object.prototype.hasOwnProperty.call(FIX_FIELDS, field)) return calFail("bad_request", `hijriFix.${year}.${field}`);
        const computed = uqMonthStart(+year, FIX_FIELDS[field as keyof typeof FIX_FIELDS], zone);
        if (!isDay(value) || !computed || Math.abs(daysBetween(computed, value)) > 1) return calFail("hijri_fix_range", `hijriFix.${year}.${field}`);
        out[field as keyof typeof FIX_FIELDS] = value;
      }
      if (Object.keys(out).length) hijriFix[year] = out;
    }
  }

  const holidays: SecCalendar["holidays"] = { add: [], remove: [] };
  const first = windowStart(now, zone);
  if (body.holidays !== undefined && body.holidays !== null) {
    if (!isObject(body.holidays) || Object.keys(body.holidays).some((k) => k !== "add" && k !== "remove")) return calFail("holidays_invalid", "holidays");
    for (const list of ["add", "remove"] as const) {
      const v = body.holidays[list] ?? [];
      if (!Array.isArray(v) || v.length > HOLIDAY_MAX || !v.every(holidayValue)) return calFail("holidays_invalid", `holidays.${list}`);
      holidays[list] = [...new Set(v as string[])].filter((x) => !isStale(x, first));
    }
  }
  const cal: SecCalendar = { v: 1, weekend, ramadanHours, hijriFix, holidays, updatedAt: new Date(now).toISOString(), updatedBy: login };

  // `remove` takes only days the defaults produce: a default holiday or day in lieu of the coming calendar window.
  if (holidays.remove.length) {
    const { produced } = build({ ...cal, holidays: { add: [], remove: [] } }, zone, now);
    if (!holidays.remove.every((v) => produced.some((p) => matchesValue(v, p.day, p.h)))) return calFail("holidays_invalid", "holidays.remove");
  }
  return { ok: true, cal };
}
