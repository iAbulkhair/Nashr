/** Gulf marketing calendar. Hijri via Intl (Umm al-Qura), Gregorian for national days. */
import { DEFAULT_ZONE, type Zone } from "./zones";

export type Season = { id: string; name: string; nameAr: string; daysLeft: number; play: string };

/** One formatter per zone: building an `Intl.DateTimeFormat` is the slow part, and the cron asks six zones every tick. */
const HIJRI_FORMATTERS = new Map<Zone, Intl.DateTimeFormat>();

/**
 * The Umm al-Qura date of an instant on the wall clock of `zone`: year, month (1 Muharram … 12 Dhu al-Hijjah) and day.
 * The zone is named on the formatter, never left to the process: without `timeZone` the date is the server's (UTC on
 * Vercel), so for the first three hours of a Riyadh day (four in Dubai) the brand would be told it is still yesterday,
 * and the first day of Ramadan would start that much late. The Hijri day turns at the brand's local midnight, like
 * `zoneDay`. Server only (tests/date-locale.test.ts allows this file as the one formatter outside `dates.ts`).
 */
export function hijriDate(d: Date, zone: Zone = DEFAULT_ZONE): { y: number; m: number; day: number } {
  let f = HIJRI_FORMATTERS.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" });
    HIJRI_FORMATTERS.set(zone, f);
  }
  const parts = f.formatToParts(d);
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: num("year"), m: num("month"), day: num("day") };
}

function daysUntil(from: Date, month: number, day: number): number {
  const y = from.getUTCFullYear();
  let t = Date.UTC(y, month - 1, day);
  if (t < from.getTime() - 864e5) t = Date.UTC(y + 1, month - 1, day);
  return Math.round((t - from.getTime()) / 864e5);
}

/**
 * Seasons that are live or within a 35-day prep window. Sorted by urgency. The Hijri seasons are read on `zone`'s
 * calendar day (the brand's), the Gregorian ones count from the instant.
 */
export function activeSeasons(now = new Date(), zone: Zone = DEFAULT_ZONE): Season[] {
  const out: Season[] = [];
  const h = hijriDate(now, zone);

  // Hijri-driven
  if (h.m === 8) out.push({ id: "pre_ramadan", name: "Pre-Ramadan (Sha'ban)", nameAr: "ما قبل رمضان", daysLeft: 30 - h.day, play: "Build audience and email/WhatsApp lists, tease Ramadan collections, publish 'prepare for Ramadan' content, lock influencer slots, pre-approve WhatsApp templates." });
  if (h.m === 9) out.push({ id: "ramadan", name: "Ramadan", nameAr: "رمضان", daysLeft: 30 - h.day, play: "Post after Iftar (20:30–01:00 KSA) and pre-Suhoor; family, generosity, gifting themes; daily offers; last-ten-nights push (day 20+); Eid gifting starts day 15; delivery cutoffs communicated clearly." });
  if (h.m === 10 && h.day <= 7) out.push({ id: "eid_fitr", name: "Eid al-Fitr", nameAr: "عيد الفطر", daysLeft: 7 - h.day, play: "Eid greetings to customers, gift bundles, express delivery, post-Eid clearance from day 4." });
  if (h.m === 12 && h.day <= 13) out.push({ id: "eid_adha", name: "Eid al-Adha / Hajj", nameAr: "عيد الأضحى", daysLeft: 13 - h.day, play: "Family gatherings, hospitality and gifting, travel-ready products, Hajj-returnee welcome offers." });
  if (h.m === 1 && h.day <= 10) out.push({ id: "hijri_new_year", name: "Hijri New Year", nameAr: "رأس السنة الهجرية", daysLeft: 10 - h.day, play: "Reflection and fresh-start messaging; light touch, no hard sell." });

  // Gregorian-driven (prep window 35 days)
  const greg: [string, string, string, number, number, string][] = [
    ["founding_day", "Saudi Founding Day (22 Feb)", "يوم التأسيس", 2, 22, "Heritage storytelling, Najdi/Hijazi motifs, limited editions, 'since 1727' pride tone; avoid discount-only messaging."],
    ["national_day", "Saudi National Day (23 Sep)", "اليوم الوطني السعودي", 9, 23, "A major KSA sale season. Discount codes matching this year's anniversary number (year minus 1932), green creative, patriotic but not political, 3-day flash window, stock and delivery promises."],
    ["uae_national_day", "UAE National Day (2 Dec)", "اليوم الوطني الإماراتي", 12, 2, "UAE-facing campaigns, Emirati dialect, red/green/white creative, AED pricing."],
    ["white_friday", "White Friday (last Fri of Nov)", "الجمعة البيضاء", 11, 27, "Warm up 3 weeks early with waitlists and teasers; retargeting heavy; bundle deals; Tabby/Tamara installments highlighted; extend to 'White Week'."],
    ["back_to_school", "Back to school (late Aug)", "العودة للمدارس", 8, 25, "Family bundles, uniforms/supplies, installment plans, early-bird offers from Aug 1."],
    ["dsf", "Dubai Shopping Festival (Dec–Jan)", "مهرجان دبي للتسوق", 12, 15, "Tourist and English content, raffles, mall activations, late-night shopping hours."],
    ["kuwait_national_day", "Kuwait National & Liberation Days (25–26 Feb)", "العيد الوطني الكويتي", 2, 25, "Kuwaiti dialect, blue/white creative, two-day celebration window."],
  ];
  for (const [id, name, nameAr, m, d, play] of greg) {
    const left = daysUntil(now, m, d);
    if (left <= 35) out.push({ id, name, nameAr, daysLeft: left, play });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}
