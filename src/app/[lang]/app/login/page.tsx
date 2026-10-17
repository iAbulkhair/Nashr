import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { Suspense } from "react";
import { googleSignInOn } from "@/lib/google-signin";
import { LoginForm } from "@/components/app/AuthForm";

export const generateMetadata = appScreenMeta("login");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (await currentUser()) redirect(`/${lang}/app`);
  return <Suspense><LoginForm t={appDict[lang]} lang={lang} google={googleSignInOn()} /></Suspense>;
}
