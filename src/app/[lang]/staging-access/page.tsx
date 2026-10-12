import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { isStaging } from "@/lib/deploy-env";
import { isLang } from "@/lib/i18n";

const COPY = {
  ar: { title: "موقع التجربة", label: "رمز الدخول", enter: "دخول", wrong: "الرمز غير صحيح" },
  en: { title: "Staging", label: "Access code", enter: "Enter", wrong: "Wrong code" },
} as const;

/** Never indexed, on any host. The proxy also sends `X-Robots-Tag` on staging (rule 677). */
export async function generateMetadata(): Promise<Metadata> {
  return { robots: { index: false, follow: false } };
}

/**
 * The staging site's access page (rule 675): one field, one button, a plain form post to `/api/staging-access`. It is
 * one of the four paths the proxy leaves open on staging. Off staging it is a 404 like any unknown path. Reading
 * `searchParams` makes it render per request, so `isStaging()` is read when the page is asked for, not at build time.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ e?: string }> }) {
  const { lang } = await params;
  const { e } = await searchParams;
  if (!isStaging() || !isLang(lang)) notFound();
  const t = COPY[lang];
  return (
    <main className="page-wrap">
      <form method="post" action="/api/staging-access" className="mx-auto grid max-w-sm gap-3">
        <h1 className="font-display text-2xl font-bold text-foreground">{t.title}</h1>
        <input type="hidden" name="lang" value={lang} />
        <label htmlFor="code" className="text-sm">{t.label}</label>
        <input id="code" name="code" type="password" autoComplete="off" required dir="ltr" className="input" />
        {e === "1" && <p role="alert" className="text-sm text-danger">{t.wrong}</p>}
        <button type="submit" className="btn btn-primary">{t.enter}</button>
      </form>
    </main>
  );
}
