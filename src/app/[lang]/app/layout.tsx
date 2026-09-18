import Link from "next/link";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, isFounder, trialDaysLeft } from "@/lib/auth";
import Sidebar from "@/components/app/Sidebar";
import TrialBanner from "@/components/app/TrialBanner";
import LangToggle from "@/components/LangToggle";
import LimitModal from "@/components/app/LimitModal";
import { getBrand } from "@/lib/brand";
import { sc } from "@/lib/auth";

const PUBLIC = ["/login", "/signup", "/forgot", "/reset", "/admin"];

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
            <LangToggle lang={lang} />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{children}</main>
      </div>
    );
  }

  const brand = await getBrand(sc(user));
  const impersonating = (await cookies()).get("nashr_impersonate")?.value;
  return (
    <div className="flex min-h-dvh flex-col bg-salt lg:h-dvh lg:flex-row lg:overflow-hidden">
      <Sidebar t={t} lang={lang} user={{ name: user.name, email: user.email, credits: user.credits, plan: user.plan }} brandName={brand?.name} admin={isFounder(user.email)} supportWa={(process.env.SUPPORT_WHATSAPP ?? "").replace(/\D/g, "") || undefined} />
      <main className="flex min-w-0 flex-1 flex-col px-4 py-5 sm:px-8 lg:overflow-y-auto">
        {impersonating && (
          <form action="/api/admin/impersonate" method="post" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sadu/40 bg-sadu/10 px-3 py-2 text-xs">
            <input type="hidden" name="lang" value={lang} />
            <span>{lang === "ar" ? `تتصفح كالمستخدم ${impersonating} (لمدة ساعتين كحد أقصى)` : `Viewing as ${impersonating} (2 hours max)`}</span>
            <button type="submit" className="btn btn-danger btn-xs">{lang === "ar" ? "إنهاء والعودة للوحة" : "Stop and return to console"}</button>
          </form>
        )}
        {!path.endsWith("/billing") && !path.endsWith("/start") && <TrialBanner lang={lang} days={trialDaysLeft(user.trialEnds)} plan={user.plan} industry={brand?.industry} />}
        {children}
      </main>
      <LimitModal t={t} lang={lang} />
    </div>
  );
}
