import Link from "next/link";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { safeNext } from "@/lib/safe-next";
import { appDict } from "@/lib/app-i18n";
import { currentUser, currentUserUnverified, isFounderActor, trialDaysLeft } from "@/lib/auth";
import Sidebar from "@/components/app/Sidebar";
import TrialBanner from "@/components/app/TrialBanner";
import InstallHint from "@/components/app/InstallHint";
import LangToggle from "@/components/LangToggle";
import Wordmark from "@/components/Wordmark";
import LimitModal from "@/components/app/LimitModal";
import { getBrand } from "@/lib/brand";
import { sc } from "@/lib/auth";
import { can } from "@/lib/roles";
import { topupsSold } from "@/lib/pricing";
import { SKIP_TO_CONTENT } from "@/lib/screen-titles";

/**
 * Paths reachable without a session. `/join` accepts a team invite (the token is in the URL fragment). `/verify` is the
 * page an owner who has not proved the address lands on: `currentUser()` reads that owner as signed out (rule 751), so the
 * page reads the session itself (`currentUserUnverified`, rule 752).
 */
const PUBLIC = ["/login", "/signup", "/forgot", "/reset", "/admin", "/join", "/verify"];

export default async function AppLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = appDict[lang];
  const h = await headers();
  const path = h.get("x-pathname") ?? "";
  const isPublic = PUBLIC.some((p) => path.endsWith(p));
  const user = await currentUser();
  // An owner who has not verified the address reads as signed out above; send them to the code page, not to login (rule 754).
  const pending = !user && !isPublic && path ? await currentUserUnverified() : null;
  if (pending?.actor?.kind === "owner") {
    // The requested page rides along in `next`, kept to a same-site path, so verifying lands where the owner was going.
    const back = safeNext(path);
    redirect(`/${lang}/app/verify${back ? `?next=${encodeURIComponent(back)}` : ""}`);
  }
  if (!user && !isPublic && path) redirect(`/${lang}/app/login`);

  if (!user) {
    return (
      <div className="min-h-screen bg-ground">
        <a href="#main" className="skip-link">{SKIP_TO_CONTENT[lang]}</a>
        <header className="border-b-[1.5px] border-ink bg-ground text-ink">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
            <Link href={`/${lang}`} className="font-display text-xl font-bold"><Wordmark lang={lang} name={t.appName} /></Link>
            <LangToggle lang={lang} />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{children}</main>
      </div>
    );
  }

  const brand = await getBrand(sc(user));
  const impersonating = (await cookies()).get("nashr_impersonate")?.value;
  // `user` is the ACCOUNT (the owner's record); the person acting is `user.actor`. Plan and credits belong to the account,
  // the name, email and role shown are the actor's. The flags only hide controls; the routes enforce the same `can()`.
  const actor = user.actor;
  const owner = can(user, "billing");
  return (
    <div className="flex min-h-dvh flex-col bg-ground lg:h-dvh lg:flex-row lg:overflow-hidden">
      {/* Rule 968: past the sidebar's links straight to the screen. */}
      <a href="#main" className="skip-link">{SKIP_TO_CONTENT[lang]}</a>
      <Sidebar t={t} lang={lang} user={{ name: actor?.name ?? user.name, email: actor?.email ?? user.email, role: actor?.role ?? "member", credits: user.credits, plan: user.plan }} show={{ owner, refer: can(user, "referral"), mcp: can(user, "mcp.token"), partner: !!user.partnerCode && can(user, "partner") }} brandName={brand?.name} admin={isFounderActor(user)} supportWa={(process.env.SUPPORT_WHATSAPP ?? "").replace(/\D/g, "") || undefined} />
      <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col px-4 py-5 sm:px-8 lg:overflow-y-auto">
        {impersonating && (
          <form action="/api/admin/impersonate" method="post" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border-[1.5px] border-danger bg-paper px-3 py-2 text-xs text-ink">
            <input type="hidden" name="lang" value={lang} />
            <span>{lang === "ar" ? `تتصفح كالمستخدم ${impersonating} (لمدة ساعتين كحد أقصى)` : `Viewing as ${impersonating} (2 hours max)`}</span>
            <button type="submit" className="btn btn-danger btn-xs">{lang === "ar" ? "إنهاء والعودة للوحة" : "Stop and return to console"}</button>
          </form>
        )}
        {!path.endsWith("/billing") && !path.endsWith("/start") && !path.endsWith("/join") && <TrialBanner lang={lang} days={trialDaysLeft(user.trialEnds)} plan={user.plan} industry={brand?.industry} owner={owner} />}
        <InstallHint lang={lang} />
        {children}
      </main>
      <LimitModal t={t} lang={lang} owner={owner} governs={can(user, "governance.write")} topups={topupsSold(user.plan)} />
    </div>
  );
}
