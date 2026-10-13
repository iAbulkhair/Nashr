/**
 * Time, money and plural words for the app's own screens (rules 1092-1094), shared by the server and the browser.
 * It imports only `dates.ts`, which is import-free, for the same reason: client components use it.
 *
 * Western digits in both languages (`-u-nu-latn`), and dates only through `dateFormat`, which never asks for the Saudi
 * locale tag and its Umm al-Qura calendar (see `dates.ts`). A bare `YYYY-MM-DD` is a calendar
 * day and is read in UTC so it never slides to the day before; a full timestamp is a moment and is shown in the brand's
 * zone, Asia/Riyadh unless the caller passes another. Text formatted here inside a client component goes in an element
 * with `suppressHydrationWarning` (the `<Time>` component does this), because Node's and the browser's CLDR differ.
 */
import { dateFormat } from "./dates";

export type FormatLang = "ar" | "en";

/** The zone a timestamp is read in when the brand has none of its own. */
export const BRAND_TZ = "Asia/Riyadh";

const locale = (lang: FormatLang) => (lang === "ar" ? "ar-u-nu-latn" : "en");

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What `formatTime` can show: a day, a day with the time, or the time alone. */
export type TimeStyle = "date" | "datetime" | "time";

const STYLES: Record<TimeStyle, Intl.DateTimeFormatOptions> = {
  date: { day: "numeric", month: "short", year: "numeric" },
  datetime: { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" },
  time: { hour: "numeric", minute: "2-digit" },
};

/**
 * An ISO date or timestamp as words for the page, or "" when the value is not a date (a stored record from before the
 * field existed shows nothing rather than "Invalid Date"). A bare day ignores `style: "time"` and the zone.
 */
export function formatTime(value: string | number | Date | null | undefined, lang: FormatLang, style: TimeStyle = "date", timeZone: string = BRAND_TZ): string {
  if (value === null || value === undefined || value === "") return "";
  const bareDay = typeof value === "string" && DAY.test(value);
  const d = value instanceof Date ? value : new Date(bareDay ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return "";
  const opts = bareDay ? STYLES.date : STYLES[style];
  return dateFormat(lang, opts, bareDay ? "UTC" : timeZone).format(d);
}

/** The machine-readable form for `<time dateTime>`: the day as given, or the full ISO instant. */
export function isoFor(value: string | number | Date): string {
  if (typeof value === "string" && DAY.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * An amount of money with its currency, SAR unless given: "299 ر.س." / "SAR 299". Whole amounts show no fraction;
 * others show two places. Non-numbers show "".
 */
export function formatMoney(amount: number, lang: FormatLang, currency = "SAR"): string {
  if (!Number.isFinite(amount)) return "";
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat(locale(lang), { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(amount);
}

/** A plain count with Western digits and the language's grouping: 1,250. */
export function formatNumber(n: number, lang: FormatLang): string {
  return Number.isFinite(n) ? new Intl.NumberFormat(locale(lang)).format(n) : "";
}

/** The word forms a count can take. Arabic has six (zero, one, two, few, many, other); English uses one and other. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/**
 * The right word for a count, from the language's own plural rules: `plural("ar", 3, { one: "يوم واحد", two: "يومان",
 * few: "# أيام", many: "# يوماً", other: "# يوم" })` gives "3 أيام". `#` becomes the count in Western digits. A form the
 * caller left out falls back to `other`.
 */
export function plural(lang: FormatLang, n: number, forms: PluralForms): string {
  const rule = new Intl.PluralRules(lang === "ar" ? "ar" : "en").select(n);
  return (forms[rule] ?? forms.other).replaceAll("#", formatNumber(n, lang));
}

/**
 * Text arrows that follow the reading direction (rule 1588): "next" points the way the line reads, "back" points to its
 * start. On an Arabic page that is ← for next and → for back; a bare → in Arabic text points backwards.
 */
export const nextArrow = (lang: FormatLang): string => (lang === "ar" ? "←" : "→");
export const backArrow = (lang: FormatLang): string => (lang === "ar" ? "→" : "←");
