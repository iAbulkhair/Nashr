import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { Suspense } from "react";
import { googleSignInOn } from "@/lib/google-signin";
import { LoginForm } from "@/components/app/AuthForm";
import { appHref } from "@/lib/ws-path";
import { passkeysOn } from "@/lib/passkey-switch";
import { baOn } from "@/lib/auth-engine";
import { turnstileSiteKey } from "@/lib/turnstile";

export const generateMetadata = appScreenMeta("login");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (await currentUser()) redirect(appHref(lang));
  // Fails closed: a switch that cannot be read draws no passkey button and no autofill (rule 2426).
  const passkeys = await passkeysOn().catch(() => false);
  // AUTH_ENGINE=better-auth (rule 3417): the Password / Email link tabs; the link request uses Turnstile when it is set.
  const betterAuth = baOn();
  return <Suspense><LoginForm t={appDict[lang]} lang={lang} google={googleSignInOn()} passkeys={passkeys} betterAuth={betterAuth} turnstileKey={betterAuth ? turnstileSiteKey() : null} /></Suspense>;
}
