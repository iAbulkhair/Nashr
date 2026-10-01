import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { turnstileSiteKey } from "@/lib/turnstile";
import { ForgotForm } from "@/components/app/AuthForm";

// The Turnstile site key is public; it is set only when both Turnstile keys are (src/lib/turnstile.ts).
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (await currentUser()) redirect(`/${lang}/app`);
  const wa = process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}` : null;
  return <ForgotForm lang={lang} whatsapp={wa} turnstileKey={turnstileSiteKey()} />;
}
