/**
 * The home page's season ribbon (rule 1880): the next Gulf season on a real calendar date, counted in whole days on the
 * Riyadh calendar. Fixed Gregorian days are the national days `src/lib/seasons.ts` already plans for; White Friday is
 * the last Friday of November, computed; the Hijri ones (the first of Ramadan, Eid al-Fitr, Eid al-Adha) come from the
 * Umm al-Qura calendar, which an announced moon sighting can move by a day, so the ribbon says so. Approximate seasons
 * in seasons.ts (back to school, the Dubai festival) are left out. No module import: the client bundle stays small.
 */
type L = { ar: string; en: string };
export type HijriOf = (d: Date) => { m: number; day: number };
export type NextSeason = { name: L; days: number; hijri: boolean };

const GREGORIAN: { name: L; m: number; d: number }[] = [
  { name: { ar: "يوم التأسيس", en: "Saudi Founding Day" }, m: 2, d: 22 },
  { name: { ar: "العيد الوطني الكويتي", en: "Kuwait National Day" }, m: 2, d: 25 },
  { name: { ar: "اليوم الوطني السعودي", en: "Saudi National Day" }, m: 9, d: 23 },
  { name: { ar: "اليوم الوطني الإماراتي", en: "UAE National Day" }, m: 12, d: 2 },
];
const HIJRI: { name: L; m: number; day: number }[] = [
  { name: { ar: "رمضان", en: "Ramadan" }, m: 9, day: 1 },
  { name: { ar: "عيد الفطر", en: "Eid al-Fitr" }, m: 10, day: 1 },
  { name: { ar: "عيد الأضحى", en: "Eid al-Adha" }, m: 12, day: 10 },
];
const WHITE_FRIDAY: L = { ar: "الجمعة البيضاء", en: "White Friday" };

/** The Riyadh calendar day of an instant, as a UTC midnight (Riyadh is UTC+3 all year, no daylight saving). */
export const riyadhDay = (now: Date) => {
  const t = new Date(now.getTime() + 3 * 3600e3);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
};

/** The last Friday of November of `year`, as a UTC midnight. */
export const whiteFriday = (year: number) => {
  const last = new Date(Date.UTC(year, 10, 30));
  return Date.UTC(year, 10, 30 - ((last.getUTCDay() - 5 + 7) % 7));
};

/**
 * The season that starts soonest from today (today counts, as 0 days), looking a year ahead. `hijriOf` reads the
 * Umm al-Qura month and day of a Riyadh calendar day given as UTC midnight.
 */
export function nextSeason(now: Date, hijriOf: HijriOf): NextSeason {
  const today = riyadhDay(now);
  const y = new Date(today).getUTCFullYear();
  const DAY = 864e5;
  const found: NextSeason[] = [];
  for (const g of GREGORIAN) {
    let t = Date.UTC(y, g.m - 1, g.d);
    if (t < today) t = Date.UTC(y + 1, g.m - 1, g.d);
    found.push({ name: g.name, days: Math.round((t - today) / DAY), hijri: false });
  }
  let wf = whiteFriday(y);
  if (wf < today) wf = whiteFriday(y + 1);
  found.push({ name: WHITE_FRIDAY, days: Math.round((wf - today) / DAY), hijri: false });
  const best = Math.min(...found.map((f) => f.days));
  // Walk the Hijri calendar only as far as the nearest Gregorian season: nothing later can win.
  for (let i = 0; i < best; i++) {
    const h = hijriOf(new Date(today + i * DAY + 12 * 3600e3));
    const hit = HIJRI.find((x) => x.m === h.m && x.day === h.day);
    if (hit) return { name: hit.name, days: i, hijri: true };
  }
  return found.sort((a, b) => a.days - b.days)[0];
}

/** «باقي 12 يوم» / "in 12 days", in the home page's dialect. */
export function daysLeft(lang: "ar" | "en", n: number): string {
  if (lang === "en") return n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
  if (n === 0) return "اليوم";
  if (n === 1) return "باقي يوم";
  if (n === 2) return "باقي يومين";
  return n <= 10 ? `باقي ${n} أيام` : `باقي ${n} يوم`;
}

export const RIBBON: { lead: L; tail: L; hijri: L } = {
  lead: { ar: "الموسم الجاي:", en: "Next season:" },
  tail: { ar: "ونور تحسب حسابه في خطتك لما يقرب.", en: "Noor works it into your plan as it gets close." },
  hijri: { ar: "حسب تقويم أم القرى، وممكن يختلف يوم حسب الرؤية.", en: "By the Umm al-Qura calendar; a moon sighting can move it a day." },
};
