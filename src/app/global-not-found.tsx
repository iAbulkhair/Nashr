import type { Metadata } from "next";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import localFont from "next/font/local";
import Link from "next/link";
import "./globals.css";
import Scribble from "@/components/Scribble";

// A smaller set than the language layout's (the Next docs' advice for this page): the display face in bold for the
// headings, the body face in two weights. Same files, same licence terms (rule 317): they reach the browser only
// through the build.
const thmanyah = localFont({
  src: [{ path: "./fonts/thmanyah-serif-display/thmanyahserifdisplay-Bold.woff2", weight: "700", style: "normal" }],
  variable: "--font-thmanyah",
  display: "swap",
});
const plexArabic = IBM_Plex_Sans_Arabic({ subsets: ["arabic"], weight: ["400", "700"], variable: "--font-plex-arabic" });

export const metadata: Metadata = {
  title: "الصفحة غير موجودة · Page not found — ذكين",
  description: "الرابط الذي فتحته غير موجود. The link you opened does not exist.",
};

/**
 * The 404 for an address outside the language tree (rule 1875), such as `/xyz` or `/ar-sa/pricing`: Next skips every
 * layout and renders this file alone (`experimental.globalNotFound` in next.config.ts), so it is a whole document with
 * its own `lang`, `dir`, fonts and the global styles. Arabic first and right to left, the English beside it in its own
 * left-to-right block, a link home in each language. Light theme always: the viewer's theme is read only inside the
 * language tree (src/lib/theme.ts, `THEMED_PATH`). The 404 inside the tree stays src/app/[lang]/not-found.tsx.
 */
export default function GlobalNotFound() {
  return (
    <html lang="ar" dir="rtl" translate="no" data-theme="light" className={`${thmanyah.variable} ${plexArabic.variable}`}>
      <body>
        <main id="main" className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-6 px-4 py-20 text-center">
          <p className="s-stamp font-mono text-2xl tracking-widest" dir="ltr"><Scribble kind="stamp" seed="global-not-found" fill="lemon" />404</p>
          <div className="grid gap-2">
            <h1 className="font-display text-3xl font-bold">الصفحة غير موجودة</h1>
            <p className="text-foreground-muted">الرابط الذي فتحته غير موجود أو كُتب بشكل خاطئ.</p>
          </div>
          <div className="grid gap-2" lang="en" dir="ltr">
            <h2 className="font-display text-xl font-bold">Page not found</h2>
            <p className="text-foreground-muted">The link you opened does not exist or was mistyped.</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/ar" className="s-btn min-h-[var(--hit-min)]"><Scribble kind="pill" seed="global-not-found-ar" fill="ink" shadow ring />الصفحة الرئيسية</Link>
            <Link href="/en" lang="en" hrefLang="en" className="s-btn s-btn--ghost min-h-[var(--hit-min)]"><Scribble kind="pill" seed="global-not-found-en" fill="lemon" ring />Home</Link>
          </div>
        </main>
      </body>
    </html>
  );
}
