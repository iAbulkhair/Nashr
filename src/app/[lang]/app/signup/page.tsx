import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { turnstileSiteKey } from "@/lib/turnstile";
import { Suspense } from "react";
import { googleSignInOn } from "@/lib/google-signin";
import { SignupForm } from "@/components/app/AuthForm";

// The Turnstile site key is public; it is set only when both Turnstile keys are (src/lib/turnstile.ts).
export const generateMetadata = appScreenMeta("signup");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (await currentUser()) redirect(`/${lang}/app`);
  return <Suspense><SignupForm t={appDict[lang]} lang={lang} turnstileKey={turnstileSiteKey()} google={googleSignInOn()} /></Suspense>;
}
