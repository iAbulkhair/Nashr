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
import { DEFAULT_RAMADAN_HOURS, addDays, daysBetween, defaultCal, endOfZoneDay, gregorianNext, ruleClock, zoneDay, zoneTime, type CalData, type QuietWhy, type SecRepeat } from "./secretary-agenda";
import { ZONES, weekStartDay, type Zone } from "./zones";
import type { SecFail } from "./secretary";

/** The brand's calendar settings, stored as one JSON value at `sec:cal:{scope}` (absent: every default). Spec §1.1. */
export type SecCalendar = {
  v: 1;
  /** Weekend weekdays, 0 Sunday … 6 Saturday: 0 to 3 days, unique and contiguous (Saturday → Sunday wraps). null: the zone's. */
  weekend: number[] | null;
  /** Ramadan chasing hours, local "HH:mm" on a 15-minute step, at most 2 windows. null: 10:00-15:00. []: no restriction. */
  ramadanHours: { from: string; to: string }[] | null;
  /**
   * Per Hijri year ("1448"), the owner's moon-sighting corrections: the local day Shawwal (Eid al-Fitr) and Dhu al-Hijjah
   * start, ±1 day of Umm al-Qura. The two the Working days panel writes; `ramadan1` is no longer taken (ruling R30).
   */
  hijriFix: Record<string, { shawwal1?: string; dhulhijja1?: string }>;
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
/** A day of the effective Hijri calendar: month (1 Muharram … 12 Dhu al-Hijjah) and day. */
type HijriPoint = { m: number; d: number };
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
type EidRule = { from: HijriPoint | typeof AFTER_29_RAMADAN; to?: HijriPoint; days?: number; comp: Trigger };
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

/**
 * "The day after 29 Ramadan" (Saudi Arabia's Eid al-Fitr; the UAE's, which adds 30 Ramadan when the month has 30 days),
 * ruling R26: the day before the effective 1 Shawwal when Ramadan, from its Umm al-Qura start to that 1 Shawwal, ran 30
 * days or more, else that 1 Shawwal. Without a correction it is what it always was (30 Ramadan in a 30-day month, else
 * 1 Shawwal); with Eid announced a day after a 30-day Umm al-Qura Ramadan, the holiday starts a day later too.
 */
const AFTER_29_RAMADAN = "after_29_ramadan" as const;

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

/** The first day the calendar covers (today-30) and its Umm al-Qura date: a dated value before it is stale. */
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

/**
 * The calendar covers today-30 … today+400 (spec §1.3; 30 back since ruling R17, so a chase moment an Eid moved keeps its
 * anchor through its seventh alert step); it is computed over a month more on each side, so an Eid or a day in lieu at
 * an edge comes out whole.
 */
const BACK = 30, AHEAD = 400, MARGIN = 35;

type Built = { data: CalData; ramadanSpans: { start: string; end: string }[]; produced: { day: string; h: Hijri | undefined }[] };

const inLieu = (n: Name | undefined): QuietWhy => ({ kind: "holiday", ...(n ? { name: { ar: `بدل ${n.ar}`, en: `Day in lieu of ${n.en}` } } : {}) });

function build(cal: SecCalendar | null, zone: Zone, now: number): Built {
  const rules = COUNTRY_CAL[countryOf(zone)];
  // Stored settings were checked on save, and are checked again here with the same parsers: a weekend that is not 0-3
  // contiguous days (an old or hand-edited record) is ignored for the zone's own, so no walk below can run over an
  // all-weekend week; Ramadan hours that are not valid windows read as the default, so no clock below throws on them.
  const own = parseWeekend(cal?.weekend), ownHours = parseHours(cal?.ramadanHours);
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
  // 2. The owner's sighting corrections move a whole month: Shawwal, Dhu al-Hijjah (±1 day, checked on save). Ramadan's
  // start is always Umm al-Qura's: a stored `ramadan1` (taken before ruling R30) is not read.
  const uqStarts = new Map(starts);
  const thisYear = hijriDate(new Date(now), zone).y;
  const accepted: Record<string, { shawwal1?: string; dhulhijja1?: string }> = {};
  for (const [y, fix] of Object.entries(cal?.hijriFix ?? {})) {
    if (+y < thisYear) continue; // a past year's correction (ruling R8)
    for (const [field, m] of [["shawwal1", 10], ["dhulhijja1", 12]] as const) {
      const v = fix?.[field], key = `${y}-${m}`, uq = starts.get(key);
      if (uq && isDay(v) && Math.abs(daysBetween(uq, v)) <= 1) {
        starts.set(key, v);
        (accepted[y] ??= {})[field] = v;
      }
    }
  }
  // No month has 31 days (ruling R26): a Ramadan the corrections stretch past 30 days (Eid a day after a 30-day Umm
  // al-Qura Ramadan) starts that much later instead, so its days and Ramadan hours stay 30.
  for (const [key, s] of starts) {
    const [y, m] = key.split("-").map(Number);
    const eid = m === 9 ? starts.get(`${y}-10`) : undefined;
    if (eid && daysBetween(s, eid) > 30) starts.set(key, addDays(eid, -30));
  }
  const start = (y: number, m: number) => starts.get(`${y}-${m}`);
  const next = (y: number, m: number) => (m === 12 ? start(y + 1, 1) : start(y, m + 1));
  const monthLen = (y: number, m: number) => { const s = start(y, m), n = next(y, m); return s && n ? daysBetween(s, n) : 30; };
  /** A Hijri day of the effective calendar as a local day; a day past the month's end is its last day. */
  const hDay = (y: number, p: HijriPoint) => { const s = start(y, p.m); return s ? addDays(s, Math.min(p.d, monthLen(y, p.m)) - 1) : undefined; };
  /** `AFTER_29_RAMADAN` (ruling R26): counted from Umm al-Qura's Ramadan start, not a corrected one. */
  const after29 = (y: number) => {
    const eid = start(y, 10), r = uqStarts.get(`${y}-9`);
    return eid && r ? (daysBetween(r, eid) >= 30 ? addDays(eid, -1) : eid) : undefined;
  };

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
      const from = rule.from === AFTER_29_RAMADAN ? after29(y) : hDay(y, rule.from);
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
  /** Holiday days the owner removed: a day in lieu never lands on one (removing an Eid day must not also cost its day in lieu). */
  const removedHoliday = new Set<string>();
  const owed: { occ: Occasion; n: number }[] = [];
  for (const occ of occasions) {
    occ.days.forEach((d) => produced.add(d));
    occ.days = occ.days.filter((d) => {
      if (!removed(d)) return true;
      removedHoliday.add(d);
      return false;
    });
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
  // Not a holiday day the owner removed. A removed day in lieu itself is still placed here, and step 7 drops it: the
  // owner's "remove" means that day is not quiet, never that the day in lieu moves to another one.
  const free = (d: string) => !isWk(d) && !holidayAt.has(d) && !lieu.has(d) && !removedHoliday.has(d);
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
    const why = holidayAt.get(day) ?? (lieu.has(day) && !removed(day) ? lieu.get(day) : undefined) ?? (add.some((v) => matchesValue(v, day, h)) ? { kind: "added" as const } : undefined);
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
    // The corrections the calendar read, for the Hijri rules of recurring items (`nextOccurrence`); absent when none.
    ...(Object.keys(accepted).length ? { hijriFix: accepted } : {}),
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
 * lieu and days the owner added; weekend days are left out) and the Ramadan days from today-30 to today+400, the Ramadan
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

/**
 * One Eid of the current or the next Hijri year, as the Working days panel shows it (spec §1.5): the month it falls in
 * starts on `uq` by Umm al-Qura and on `start` with the owner's sighting correction (`hijriFix[year][field]`, ignored
 * when it is not within a day of `uq`, as the calendar ignores it); `day` is the Eid's own day, 1 Shawwal or 10 Dhu
 * al-Hijjah. `earlier` and `later` are the `field` value each button saves (the month a day earlier or later), null when
 * that would be more than a day from Umm al-Qura or the Eid has passed. Saving `uq` itself means "as Umm al-Qura".
 * `name` is the holiday's own name, and `off` its days off as the days-off list shows them (the brand's weekend left out,
 * the owner's removals applied, days in lieu apart): first and last, null when none is left. So a button's effect, or
 * its absence (a Saudi Eid al-Fitr after a 29-day Ramadan, ruling R26), shows on the row.
 */
export type EidDay = {
  year: number; kind: "eid_fitr" | "eid_adha"; field: "shawwal1" | "dhulhijja1"; name: Name;
  uq: string; start: string; day: string; earlier: string | null; later: string | null;
  off: { first: string; last: string } | null;
};

/** This Hijri year's and the next one's Eid al-Fitr and Eid al-Adha in `zone` at `now`: the years `hijriFix` accepts. */
export function eidDays(cal: SecCalendar | null, zone: Zone, now: number): EidDay[] {
  const year = hijriDate(new Date(now), zone).y;
  const today = zoneDay(now, zone);
  // The calendar covers today-30 … today+400: an Eid outside it (next year's, or this year's long past) is read from the
  // calendar a year later or earlier, built (and memoised) the same way.
  const offOf = (kind: EidDay["kind"], day: string): EidDay["off"] => {
    const shift = daysBetween(today, day) > AHEAD - 10 ? 365 : daysBetween(day, today) > BACK - 10 ? -365 : 0;
    const { quiet } = workCalendar(cal, zone, now + shift * 864e5);
    const ds = Object.keys(quiet).filter((d) => quiet[d].kind === kind && Math.abs(daysBetween(d, day)) <= 10).sort();
    return ds.length ? { first: ds[0], last: ds[ds.length - 1] } : null;
  };
  const out: EidDay[] = [];
  for (const y of [year, year + 1]) {
    for (const [kind, field] of [["eid_fitr", "shawwal1"], ["eid_adha", "dhulhijja1"]] as const) {
      const uq = uqMonthStart(y, FIX_FIELDS[field], zone);
      if (!uq) continue;
      const fix = cal?.hijriFix?.[String(y)]?.[field];
      const start = isDay(fix) && Math.abs(daysBetween(uq, fix)) <= 1 ? fix : uq;
      const day = kind === "eid_fitr" ? start : addDays(start, 9);
      const move = (n: number) => {
        const to = addDays(start, n);
        return day >= today && Math.abs(daysBetween(uq, to)) <= 1 ? to : null;
      };
      out.push({ year: y, kind, field, name: kind === "eid_fitr" ? NAMES.fitr : NAMES.adha, uq, start, day, earlier: move(-1), later: move(1), off: offOf(kind, day) });
    }
  }
  return out;
}

/**
 * What the Working days panel and GET/PUT /api/secretary/calendar show for usable settings (`usableCalendar`, null for
 * every default) at `now` in `zone`: the settings, what is in force (`effective`, ruling R23: the country, the zone, the
 * weekend and the zone's own default weekend the page marks, the week's first day, the Ramadan hours), the next 365 days
 * of quiet days and the next Ramadan (`upcoming`), and this year's and next year's Eid (`eids`).
 */
export function calendarView(calendar: SecCalendar | null, zone: Zone, now: number) {
  const data = workCalendar(calendar, zone, now);
  const defaultWeekend: number[] = [...ZONES[zone].weekend];
  return {
    calendar,
    effective: { country: countryOf(zone), zone, weekend: data.weekend, defaultWeekend, weekStart: data.weekStart, ramadanHours: data.ramadanHours },
    upcoming: upcomingQuiet(calendar, zone, now),
    eids: eidDays(calendar, zone, now),
  };
}
export type CalendarView = ReturnType<typeof calendarView>;

/**
 * Whether a brand's city names Sharjah, in either language: the UAE's default weekend is Saturday and Sunday, and the
 * Working days panel then says Sharjah's government weekend includes Friday (spec §1.5). A hint only: nothing changes.
 */
export const namesSharjah = (city: unknown): boolean => typeof city === "string" && /\bsharjah\b|الشارقة|شارقة/i.test(city);

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

/** `uqMonthStart` answers, per zone, Hijri year and month: ICU is the slow part and the answer never changes. */
const UQ_MEMO_MAX = 2000;
const uqMemo = new Map<string, string | null>();

/** The Umm al-Qura local day a Hijri month starts on, found near its mean-month estimate (ICU is never more than 2 days off it). */
function uqMonthStart(y: number, m: number, zone: Zone): string | null {
  const key = `${zone}|${y}|${m}`;
  if (uqMemo.has(key)) return uqMemo.get(key)!;
  let found: string | null = null;
  const t = Date.UTC(622, 6, 19) + Math.round(((y - 1) * 12 + (m - 1)) * 29.530588853) * 864e5;
  if (Number.isFinite(t) && Math.abs(t) < 8.6e15 - 7 * 864e5) {
    const est = new Date(t).toISOString().slice(0, 10);
    for (let k = -6; k <= 6 && !found; k++) {
      const day = addDays(est, k);
      const h = hijriDate(new Date(zoneTime(day, 12, 0, zone)), zone);
      if (h.y === y && h.m === m && h.day === 1) found = day;
    }
  }
  if (uqMemo.size >= UQ_MEMO_MAX) uqMemo.delete(uqMemo.keys().next().value!);
  uqMemo.set(key, found);
  return found;
}

/**
 * The local day Hijri month `m` (1-12) of year `y` starts on in `zone`: Umm al-Qura's day, moved by the owner's sighting
 * correction for Shawwal (10, `shawwal1`) and Dhu al-Hijjah (12, `dhulhijja1`) when `fix` (`CalData.hijriFix`) holds one
 * within a day of it, as `build` reads it. Ramadan (9) follows ruling R26: when the Shawwal correction would stretch it
 * past 30 days it starts later instead, so its length stays 30. `null` when Umm al-Qura has no such month.
 */
export function hijriMonthStart(y: number, m: number, zone: Zone, fix?: CalData["hijriFix"]): string | null {
  const uq = uqMonthStart(y, m, zone);
  if (!uq) return null;
  const moved = (field: "shawwal1" | "dhulhijja1") => {
    const v = fix?.[String(y)]?.[field];
    return isDay(v) && Math.abs(daysBetween(uq, v)) <= 1 ? v : uq;
  };
  if (m === 10) return moved("shawwal1");
  if (m === 12) return moved("dhulhijja1");
  if (m === 9) {
    const eid = hijriMonthStart(y, 10, zone, fix);
    return eid && daysBetween(uq, eid) > 30 ? addDays(eid, -30) : uq;
  }
  return uq;
}

/** The Hijri candidates of an `hmonth` or `hyear` rule, in order, none before the anchor, until `stop`. */
function* hijriDays(rule: SecRepeat, low: string, stop: string, z: Zone, cal: CalData): Generator<string> {
  const n = Math.max(1, Math.floor(rule.interval) || 1);
  const noon = (day: string) => new Date(zoneTime(day, 12, 0, z));
  const a = hijriDate(noon(rule.anchor), z), l = hijriDate(noon(low), z);
  const monthly = rule.every === "hmonth";
  const k0 = Math.max(0, Math.floor((monthly ? (l.y * 12 + l.m) - (a.y * 12 + a.m) : l.y - a.y) / n) - 1);
  // A bounded search: a year and a bit of candidates at most (a month rule has at most 13, a year rule 3), so a rule
  // with no month start to build on (past Umm al-Qura's range) ends instead of looping.
  for (let k = k0; k < k0 + 16; k++) {
    const idx = a.y * 12 + (a.m - 1) + k * n;
    const y = monthly ? Math.floor(idx / 12) : a.y + k * n, m = monthly ? (idx % 12) + 1 : a.m;
    const s = hijriMonthStart(y, m, z, cal.hijriFix), e = m === 12 ? hijriMonthStart(y + 1, 1, z, cal.hijriFix) : hijriMonthStart(y, m + 1, z, cal.hijriFix);
    if (!s || !e) continue;
    const len = daysBetween(s, e);
    const want = monthly && rule.monthDay === -1 ? len : Math.max(1, Math.min(monthly ? rule.monthDay ?? a.day : a.day, len));
    const d = addDays(s, want - 1);
    if (d > stop) return;
    if (d >= rule.anchor && d >= low) yield d;
  }
}

/**
 * The next copy of a recurring item: its due date and whether it is all-day, or `null` when the series is over or nothing
 * is found. `prevDue` is the closed copy's `dueAt` (ISO), `n` the number of copies made so far (the closed one included).
 * Gregorian rules go to `gregorianNext`; `hmonth` and `hyear` count Hijri months from the anchor's Hijri date on the
 * calendar `cal` holds (Umm al-Qura plus the owner's `hijriFix`), clamping a day 30 to 29 in a short month per candidate,
 * with the same grid, no-pile-up and bound as the Gregorian ones. `null` when `n` has reached `count`, when the date is
 * after `until`, or when the bounded search (366 × interval days) finds nothing.
 */
export function nextOccurrence(rule: SecRepeat, prevDue: string, now: number, z: Zone, cal: CalData, n: number): { dueAt: string; allDay: boolean } | null {
  if (rule.count !== undefined && n >= rule.count) return null;
  const prevMs = Date.parse(prevDue);
  if (!Number.isFinite(prevMs)) return null;
  let found: { dueAt: string; allDay: boolean } | null = null;
  if (rule.every === "hmonth" || rule.every === "hyear") {
    if (!isDay(rule.anchor)) return null;
    const iv = Math.max(1, Math.floor(rule.interval) || 1);
    const today = zoneDay(now, z);
    const low = [zoneDay(prevMs, z), today].reduce((x, y) => (x > y ? x : y));
    const bound = addDays(low, 366 * iv + 7);
    const stop = isDay(rule.until) && rule.until < bound ? rule.until : bound;
    const clock = ruleClock(rule.time);
    const startOfToday = zoneTime(today, 0, 0, z);
    for (const day of hijriDays(rule, low, stop, z, cal)) {
      const at = clock ? zoneTime(day, clock.hh, clock.mm, z) : endOfZoneDay(day, z);
      if (at > prevMs && (clock ? at > now : at >= startOfToday)) { found = { dueAt: new Date(at).toISOString(), allDay: !clock }; break; }
    }
  } else found = gregorianNext(rule, prevMs, now, z, cal);
  if (found && rule.until && zoneDay(Date.parse(found.dueAt), z) > rule.until) return null;
  return found;
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
/** The `hijriFix` fields and the Hijri month each one starts (ruling R30: the two the Working days panel writes). */
const FIX_FIELDS = { shawwal1: 10, dhulhijja1: 12 } as const;

/**
 * Check the Working days settings an admin saves, field by field (spec §1.1), and return them normalised and stamped
 * with `now` and the admin's `login`. Refused: an unknown field (`bad_request`); a weekend that is not 0-3 contiguous
 * days (`weekend_invalid`); Ramadan hours that are not at most two "HH:mm" windows on the quarter hour, each from
 * before to, not overlapping (`ramadan_hours_invalid`); a `hijriFix` year after the zone's next Hijri year (`bad_year`)
 * or a date more than a day from Umm al-Qura's (`hijri_fix_range`); a `hijriFix` field other than `shawwal1` and
 * `dhulhijja1` (`bad_request`: a new `ramadan1` too, ruling R30); more than 30 values in `add` or `remove`, a malformed
 * value, or a new removal that no default day of the coming year matches (`holidays_invalid`).
 * `stored` is the record saved now, read under the calendar's lock (ruling R28): a removal already in its `remove` list
 * is kept though no default produces it any more (the Eid moved, the zone changed), so the panel can still save and the
 * owner can still turn it on; the calendar ignores it. Only a removal not stored before must match a default day.
 * Stale values are dropped, not refused (ruling R8), so settings read from a GET and saved back unchanged still save:
 * a `hijriFix` year before the current Hijri year, a dated value ("YYYY-MM-DD", "H-YYYY-MM-DD") before today-30, and
 * a `ramadan1` equal to the stored one (ruling R30).
 * `v`, `updatedAt` and `updatedBy` may come back from a GET and are replaced.
 */
export function parseCalendar(body: Record<string, unknown>, now: number, zone: Zone, login: string, stored: SecCalendar | null = null): { ok: true; cal: SecCalendar } | CalFail {
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
      const was: unknown = isObject(stored?.hijriFix) ? (stored.hijriFix as Record<string, unknown>)[year] : undefined;
      for (const [field, value] of Object.entries(fix)) {
        // A `ramadan1` saved before ruling R30, sent back as GET gave it: dropped, as a stale value is (ruling R8).
        if (field === "ramadan1" && isObject(was) && typeof value === "string" && was.ramadan1 === value) continue;
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

  // A new removal takes only days the defaults produce: a default holiday or day in lieu of the coming calendar window.
  // One already stored is kept as it is (ruling R28).
  const kept = new Set(Array.isArray(stored?.holidays?.remove) ? stored.holidays.remove.filter((v) => typeof v === "string") : []);
  const fresh = holidays.remove.filter((v) => !kept.has(v));
  if (fresh.length) {
    const { produced } = build({ ...cal, holidays: { add: [], remove: [] } }, zone, now);
    if (!fresh.every((v) => produced.some((p) => matchesValue(v, p.day, p.h)))) return calFail("holidays_invalid", "holidays.remove");
  }
  return { ok: true, cal };
}
