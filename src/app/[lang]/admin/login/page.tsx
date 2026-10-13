import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { consoleIdentity } from "@/lib/auth";
import { safeNext } from "@/lib/safe-next";
import { staffScreenMeta } from "@/lib/screen-titles";
import StaffSignIn from "@/components/admin/StaffSignIn";

export const dynamic = "force-dynamic";

// Never indexed and never cached (rule 1653): `staffScreenMeta`, and src/proxy.ts sends `x-robots-tag` and `no-store`.
export const generateMetadata = staffScreenMeta("login");

/**
 * The staff sign-in page (rules 1631, 1652): public, like the key form at ?login=1. Console pages with no live session
 * redirect here with `?next=` (a console path, checked by `safeNext` again here and in the form). A browser that already
 * has a staff session goes straight on.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ next?: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const raw = safeNext((await searchParams).next);
  const next = raw.startsWith(`/${lang}/admin`) && !raw.startsWith(`/${lang}/admin/login`) ? raw : "";
  if ((await consoleIdentity()).staff) redirect(next || `/${lang}/admin`);
  return <StaffSignIn lang={lang} next={next} />;
}
