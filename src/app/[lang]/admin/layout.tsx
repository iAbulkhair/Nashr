import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { consoleIdentity } from "@/lib/auth";
import { ownerExists } from "@/lib/staff";
import ConsoleBanners from "@/components/admin/ConsoleBanners";
import AdminNav from "@/components/admin/AdminNav";
import SecondFactor from "@/components/admin/SecondFactor";
import { secondFactorStatus } from "@/lib/admin-2fa";
import { SKIP_TO_CONTENT } from "@/lib/screen-titles";

export const dynamic = "force-dynamic";
// Never indexed: robots.txt disallows only /{lang}/app/, and naming /{lang}/admin there would advertise it.
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The founder console's own layout (rule 871): a sibling of /{lang}/app, so the customer sidebar, trial banner, install
 * hint and limit modal never wrap it. The shell renders only behind the gate; without it the children render bare, so
 * the key form at /{lang}/admin?login=1 shows without any console chrome. The gate itself is in every page
 * (`requireAdmin`), not here: a layout that called notFound() would 404 the key form too.
 */
export default async function AdminLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const who = await consoleIdentity();
  if (!who.staff && !who.keySession && !who.founder) return <div className="min-h-dvh bg-background"><a href="#main" className="skip-link">{SKIP_TO_CONTENT[lang]}</a><main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{children}</main></div>;
  const [sf, owner] = await Promise.all([secondFactorStatus(), ownerExists()]);
  const keySession = !who.staff && who.keySession;
  return (
    <div className="flex min-h-dvh flex-col bg-background lg:flex-row">
      {/* Rule 968: past the console's links straight to the section. */}
      <a href="#main" className="skip-link">{SKIP_TO_CONTENT[lang]}</a>
      <AdminNav lang={lang} keySession={keySession} founder={who.founder} />
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {/* Rules 1377-1379: the second factor's banner or status line, and the code prompt every console write can open. */}
        {/* Rules 1639, 1645, 1649: break-glass key session, the expand-only customer path, the first staff login. */}
        <ConsoleBanners lang={lang} keySession={keySession} founder={!who.staff && who.founder} staff={!!who.staff} ownerExists={owner} consoleCode={sf.enrolled} />
        <SecondFactor lang={lang} enrolled={sf.enrolled} />
        {children}
      </main>
    </div>
  );
}
