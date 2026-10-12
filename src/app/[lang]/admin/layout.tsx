import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { adminKeySession, currentUser, isAdminCookie, isFounderActor } from "@/lib/auth";
import AdminNav from "@/components/admin/AdminNav";
import { SKIP_TO_CONTENT } from "@/lib/screen-titles";
import ThemeScope from "@/components/ThemeScope";

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
  if (!(await isAdminCookie())) return <div className="min-h-dvh bg-background"><ThemeScope /><a href="#main" className="skip-link">{SKIP_TO_CONTENT[lang]}</a><main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{children}</main></div>;
  const [keySession, user] = await Promise.all([adminKeySession(), currentUser()]);
  return (
    <div className="flex min-h-dvh flex-col bg-background lg:flex-row">
      {/* Rule 1203: the founder's theme choice applies to the console too. */}
      <ThemeScope />
      {/* Rule 968: past the console's links straight to the section. */}
      <a href="#main" className="skip-link">{SKIP_TO_CONTENT[lang]}</a>
      <AdminNav lang={lang} keySession={keySession} founder={isFounderActor(user)} />
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
