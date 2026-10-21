import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { turnstileSiteKey } from "@/lib/turnstile";
import { ForgotForm } from "@/components/app/AuthForm";
import { appHref } from "@/lib/ws-path";

// The Turnstile site key is public; it is set only when both Turnstile keys are (src/lib/turnstile.ts).
export const generateMetadata = appScreenMeta("forgot");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (await currentUser()) redirect(appHref(lang));
  const wa = process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}` : null;
  return <ForgotForm lang={lang} whatsapp={wa} turnstileKey={turnstileSiteKey()} />;
}
