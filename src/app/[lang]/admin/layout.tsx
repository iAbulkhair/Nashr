import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { adminKeySession, currentUser, isAdminCookie, isFounderActor } from "@/lib/auth";
import AdminNav from "@/components/admin/AdminNav";

export const dynamic = "force-dynamic";

/**
 * The founder console's own layout (rule 871): a sibling of /{lang}/app, so the customer sidebar, trial banner, install
 * hint and limit modal never wrap it. The shell renders only behind the gate; without it the children render bare, so
 * the key form at /{lang}/admin?login=1 shows without any console chrome. The gate itself is in every page
 * (`requireAdmin`), not here: a layout that called notFound() would 404 the key form too.
 */
export default async function AdminLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (!(await isAdminCookie())) return <div className="min-h-dvh bg-ground"><main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{children}</main></div>;
  const [keySession, user] = await Promise.all([adminKeySession(), currentUser()]);
  return (
    <div className="flex min-h-dvh flex-col bg-ground lg:flex-row">
      <AdminNav lang={lang} keySession={keySession} founder={isFounderActor(user)} />
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
