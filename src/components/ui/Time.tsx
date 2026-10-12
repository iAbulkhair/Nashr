import { formatMoney, formatTime, isoFor, type FormatLang, type TimeStyle } from "@/lib/format";

/**
 * A date or a moment for the page (rule 1092), in place of `value.slice(0, 10)`: words in the page's language with
 * Western digits, a bare day in UTC, a timestamp in the brand's zone (Asia/Riyadh by default). The `<time>` element
 * carries the machine form, and `suppressHydrationWarning` covers the one difference Intl data may have between the
 * server and the browser (src/lib/dates.ts). Nothing renders for a missing or broken value. No hooks.
 */
export function Time({ value, lang, style = "date", timeZone, className }: { value: string | number | Date | null | undefined; lang: FormatLang; style?: TimeStyle; timeZone?: string; className?: string }) {
  const text = formatTime(value, lang, style, timeZone);
  if (!text || value === null || value === undefined) return null;
  return <time dateTime={isoFor(value)} className={className} suppressHydrationWarning>{text}</time>;
}

/** An amount with its currency, SAR unless given, kept left to right inside Arabic text (rule 1093). */
export function Money({ amount, lang, currency, className }: { amount: number; lang: FormatLang; currency?: string; className?: string }) {
  const text = formatMoney(amount, lang, currency);
  if (!text) return null;
  return <bdi className={`tnum ${className ?? ""}`.trim()} suppressHydrationWarning>{text}</bdi>;
}
