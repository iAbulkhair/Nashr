import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { Suspense } from "react";
import { googleSignInOn } from "@/lib/google-signin";
import { LoginForm } from "@/components/app/AuthForm";
import { passkeysOn } from "@/lib/passkey-switch";

export const generateMetadata = appScreenMeta("login");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (await currentUser()) redirect(`/${lang}/app`);
  // Fails closed: a switch that cannot be read draws no passkey button and no autofill (rule 2426).
  const passkeys = await passkeysOn().catch(() => false);
  return <Suspense><LoginForm t={appDict[lang]} lang={lang} google={googleSignInOn()} passkeys={passkeys} /></Suspense>;
}
