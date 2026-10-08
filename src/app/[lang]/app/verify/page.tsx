import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUserUnverified, emailVerified } from "@/lib/auth";
import { mailReady } from "@/lib/notify";
import { safeNext } from "@/lib/safe-next";
import { devCodeExposed, hasPendingCode } from "@/lib/verify-email";
import VerifyForm from "@/components/app/VerifyForm";

/**
 * Where an owner who has not proved the address lands (rule 754). The layout sends them here; `currentUser()` reads them
 * as signed out, so this page (and the three verify routes) read the session with `currentUserUnverified` (rule 752). The
 * address shown is the session's, never one from the URL. A member, a founder session or an owner who is already verified
 * has nothing to prove and goes on to the app.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ next?: string | string[]; sent?: string | string[] }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUserUnverified();
  if (!u) redirect(`/${lang}/app/login`);
  const sp = await searchParams;
  const next = safeNext(Array.isArray(sp.next) ? sp.next[0] : sp.next);
  if (u.actor?.kind !== "owner" || emailVerified(u)) redirect(next || `/${lang}/app`);
  // Signup already mailed the first code; a login without a waiting code asks for one when the page opens.
  const autoSend = !(await hasPendingCode(u.email));
  const canChangeEmail = !!u.gatedSignup;
  const mailOn = mailReady() || devCodeExposed();
  // `sent=0` is signup saying its mail did not go out. It only changes which line the page shows; nothing trusts it.
  const mailSent = (Array.isArray(sp.sent) ? sp.sent[0] : sp.sent) !== "0";
  const whatsapp = process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}` : `/${lang}/help`; // the public help page: /app/help needs a verified session
  return <VerifyForm lang={lang} email={u.email} canChangeEmail={canChangeEmail} autoSend={autoSend} mailOn={mailOn} whatsapp={whatsapp} next={next} mailSent={mailSent} />;
}
