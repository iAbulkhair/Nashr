/**
 * Locale-aware date formatting, shared by the server and the browser. Import-free on purpose: client components use
 * it, and anything it imported would be dragged into their bundles.
 *
 * Two rules are encoded here so no call site has to re-derive them:
 *
 * 1. Never `ar-SA`. That locale selects the Umm al-Qura calendar in WebKit's system ICU while Node's bundled ICU
 *    resolves it to the Gregorian one, so one timestamp renders "20 سبتمبر" on the server and "9 ربيع الآخر" in
 *    Safari. React throws away the server HTML with hydration error #418, and the Saudi iPhone owner this product
 *    is built for reads Hijri month names sitting above Gregorian day numbers. Plain `ar` is Gregorian in both.
 * 2. Always UTC. Scheduled dates are stored as a bare `YYYY-MM-DD`; formatting them in the visitor's own zone slides
 *    a post to the previous day for everyone west of Greenwich.
 *
 * `-u-nu-latn` keeps Latin digits in the Arabic UI, which is how the rest of the app writes numbers.
 *
 * Neither rule makes Intl output identical across engines: Node's bundled CLDR abbreviates the Arabic weekday as
 * "الأحد" where WebKit's system CLDR gives "أحد", and that is data, not configuration. Anything formatted here and
 * rendered inside a client component therefore needs `suppressHydrationWarning` on the element that holds the text.
 * That attribute is scoped to one element's text, so it hides this unavoidable difference without hiding a real one.
 */
export function dateFormat(lang: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-u-nu-latn" : "en", { ...opts, timeZone: "UTC" });
}
