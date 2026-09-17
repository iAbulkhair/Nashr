import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import LogoutButton from "@/components/app/LogoutButton";

const PUBLIC = ["/login", "/signup", "/admin"];

export default async function AppLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = appDict[lang];
  const h = await headers();
  const path = h.get("x-pathname") ?? "";
  const isPublic = PUBLIC.some((p) => path.endsWith(p));
  const user = await currentUser();
  if (!user && !isPublic && path) redirect(`/${lang}/app/login`);

  return (
    <div className="min-h-screen bg-salt">
      <header className="sticky top-0 z-40 border-b border-mist/10 bg-oasis-deep text-mist">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href={`/${lang}/app`} className="font-display text-xl font-bold">
            {t.appName}
            <span className="ms-2 inline-block h-2 w-2 rounded-full bg-saffron align-middle" aria-hidden />
          </Link>
          {user ? (
            <nav className="flex items-center gap-3 text-sm sm:gap-5" aria-label="App">
              <Link href={`/${lang}/app/chat`} className="rounded-full bg-saffron px-3 py-1.5 font-semibold text-ink">{t.nav.chat}</Link>
              <Link href={`/${lang}/app`} className="text-mist-dim hover:text-mist">{t.nav.inbox}</Link>
              <Link href={`/${lang}/app/generate`} className="hidden text-mist-dim hover:text-mist sm:inline">{t.nav.generate}</Link>
              <Link href={`/${lang}/app/calendar`} className="hidden text-mist-dim hover:text-mist sm:inline">{t.nav.calendar}</Link>
              <Link href={`/${lang}/app/files`} className="hidden text-mist-dim hover:text-mist md:inline">{t.nav.files}</Link>
              <Link href={`/${lang}/app/tasks`} className="hidden text-mist-dim hover:text-mist md:inline">{t.nav.tasks}</Link>
              <Link href={`/${lang}/app/governance`} className="hidden text-mist-dim hover:text-mist lg:inline">{t.nav.governance}</Link>
              <Link href={`/${lang}/app/inspo`} className="hidden text-mist-dim hover:text-mist lg:inline">{t.nav.inspo}</Link>
              <Link href={`/${lang}/app/integrations`} className="hidden text-mist-dim hover:text-mist xl:inline">{t.nav.integrations}</Link>
              <Link href={`/${lang}/app/refer`} className="hidden text-mist-dim hover:text-mist xl:inline">{t.nav.refer}</Link>
              <Link href={`/${lang}/app/onboarding`} className="hidden text-mist-dim hover:text-mist xl:inline">{t.nav.brand}</Link>
              <Link href={`/${lang}/app/billing`} className="font-mono text-xs text-saffron" dir="ltr">{user.credits} {t.nav.credits}</Link>
              <LogoutButton label={t.nav.logout} lang={lang} />
            </nav>
          ) : (
            <Link href={lang === "ar" ? "/en/app/login" : "/ar/app/login"} className="text-xs text-mist-dim">{lang === "ar" ? "English" : "العربية"}</Link>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
