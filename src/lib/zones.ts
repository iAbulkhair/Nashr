/**
 * The time zones a brand can keep its to-do list in: the six Gulf states, each a fixed offset from UTC all year (none
 * of them keeps daylight saving time), each with the weekend its working week skips. A fixed allow-list checked in
 * code: anything else stored on a brand (a model's `update_brand`, an old record) falls back to the default.
 *
 * Import-free, so the browser and the server share it. Offsets and weekends are data here, not a time-zone database:
 * the same answer on the server and in every browser.
 */
export const ZONES = {
  "Asia/Riyadh": { offsetMin: 180, weekend: [5, 6], city: { ar: "الرياض", en: "Riyadh" } },
  "Asia/Kuwait": { offsetMin: 180, weekend: [5, 6], city: { ar: "الكويت", en: "Kuwait City" } },
  "Asia/Qatar": { offsetMin: 180, weekend: [5, 6], city: { ar: "الدوحة", en: "Doha" } },
  "Asia/Bahrain": { offsetMin: 180, weekend: [5, 6], city: { ar: "المنامة", en: "Manama" } },
  // The UAE moved its weekend to Saturday and Sunday in 2022.
  "Asia/Dubai": { offsetMin: 240, weekend: [6, 0], city: { ar: "دبي", en: "Dubai" } },
  "Asia/Muscat": { offsetMin: 240, weekend: [5, 6], city: { ar: "مسقط", en: "Muscat" } },
} as const satisfies Record<string, { offsetMin: number; weekend: readonly number[]; city: { ar: string; en: string } }>;
export type Zone = keyof typeof ZONES;
export const ZONE_IDS = Object.keys(ZONES) as Zone[];
export const DEFAULT_ZONE: Zone = "Asia/Riyadh";
export const isZone = (v: unknown): v is Zone => typeof v === "string" && Object.prototype.hasOwnProperty.call(ZONES, v);

/** The offset of a zone in milliseconds (local wall time = UTC instant + offset). */
export const zoneOffsetMs = (z: Zone) => ZONES[z].offsetMin * 60_000;
/** "UTC+3" / "UTC+4". */
export const zoneUtcLabel = (z: Zone) => `UTC+${ZONES[z].offsetMin / 60}`;
/** A weekend day in that zone (0 Sunday … 6 Saturday, the local day of the week). */
export const isWeekend = (z: Zone, weekday: number) => (ZONES[z].weekend as readonly number[]).includes(weekday);
/** English day names by `getUTCDay()` number, for the prompt line and the week start. */
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
/**
 * The day the work week starts on, from a weekend (0 Sunday … 6 Saturday): the day after the last day of the contiguous
 * run, wrapping Saturday to Sunday, so Friday and Saturday give Sunday (0), Saturday and Sunday give Monday (1) and
 * Friday alone gives Saturday (6). No weekend, or all seven days, gives Sunday. A brand can change its weekend, so this
 * is computed from the brand's, not read off the zone.
 */
export function weekStartDay(weekend: readonly number[]): number {
  const last = weekend.find((d) => !weekend.includes((d + 1) % 7));
  return last === undefined ? 0 : (last + 1) % 7;
}
/** The first working day of the week in the zone's default weekend: Sunday where it is Friday and Saturday, Monday in the UAE. */
export const weekStart = (z: Zone): (typeof WEEKDAY_NAMES)[number] => WEEKDAY_NAMES[weekStartDay(ZONES[z].weekend)];

// Cities written the way owners write them, in either language, that name one zone without doubt.
const CITY_ZONE: [RegExp, Zone][] = [
  [/\b(dubai|abu ?dhabi|sharjah|ajman|al ?ain|ras al ?khaimah|fujairah|umm al ?quwain|uae|emirates)\b|دبي|أبو ?ظبي|ابو ?ظبي|الشارقة|عجمان|رأس الخيمة|الفجيرة|أم القيوين|الإمارات|الامارات/i, "Asia/Dubai"],
  // Not a bare «عمان»: unvowelled, it is also Amman.
  [/\b(muscat|salalah|sohar|nizwa|oman)\b|مسقط|صلالة|صحار|نزوى|عُمان|سلطنة عمان/i, "Asia/Muscat"],
  [/\bkuwait\b|الكويت/i, "Asia/Kuwait"],
  [/\b(doha|qatar)\b|الدوحة|قطر/i, "Asia/Qatar"],
  [/\b(manama|bahrain)\b|المنامة|البحرين/i, "Asia/Bahrain"],
  [/\b(riyadh|jeddah|jiddah|makkah|mecca|madinah|medina|dammam|khobar|dhahran|taif|abha|tabuk|qassim|buraidah|jazan|najran|saudi)\b|الرياض|جدة|مكة|الدمام|الخبر|الظهران|الطائف|أبها|تبوك|القصيم|بريدة|جازان|نجران|السعودية/i, "Asia/Riyadh"],
];

/**
 * The zone a brand's list is kept in: the one stored on the brand when it is on the list; else the zone its city names
 * without doubt (Dubai, Muscat, Kuwait, Doha, Manama, a Saudi city); else the one its dialect names (Emirati, Kuwaiti);
 * else Riyadh. A city that names two zones, or none, decides nothing.
 */
export function zoneOf(brand: { timeZone?: unknown; city?: unknown; dialect?: unknown } | null | undefined): Zone {
  if (!brand) return DEFAULT_ZONE;
  if (isZone(brand.timeZone)) return brand.timeZone;
  const city = typeof brand.city === "string" ? brand.city.trim() : "";
  if (city) {
    const hits = CITY_ZONE.filter(([re]) => re.test(city)).map(([, z]) => z);
    if (new Set(hits).size === 1) return hits[0];
  }
  if (brand.dialect === "emirati") return "Asia/Dubai";
  if (brand.dialect === "kuwaiti") return "Asia/Kuwait";
  return DEFAULT_ZONE;
}
