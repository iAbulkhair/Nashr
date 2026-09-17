import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import Sidebar from "@/components/app/Sidebar";
import { getBrand } from "@/lib/brand";
import { sc } from "@/lib/auth";

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

  if (!user) {
    return (
      <div className="min-h-screen bg-salt">
        <header className="border-b border-mist/10 bg-oasis-deep text-mist">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
            <Link href={`/${lang}`} className="font-display text-xl font-bold">{t.appName}<span className="ms-2 inline-block h-2 w-2 rounded-full bg-saffron align-middle" aria-hidden /></Link>
            <Link href={lang === "ar" ? "/en/app/login" : "/ar/app/login"} className="text-xs text-mist-dim">{lang === "ar" ? "English" : "العربية"}</Link>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{children}</main>
      </div>
    );
  }

  const brand = await getBrand(sc(user));
  return (
    <div className="flex min-h-screen flex-col bg-salt lg:flex-row">
      <Sidebar t={t} lang={lang} user={{ name: user.name, email: user.email, credits: user.credits, plan: user.plan }} brandName={brand?.name} />
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8">{children}</main>
    </div>
  );
}
