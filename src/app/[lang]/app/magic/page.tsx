import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import { baOn } from "@/lib/auth-engine";
import { MagicLanding } from "@/components/app/MagicLanding";
import { appHref } from "@/lib/ws-path";

export const generateMetadata = appScreenMeta("magic");

/**
 * The page a sign-in link opens (rule 3416): `/{lang}/app/magic#t={token}`. Only while AUTH_ENGINE=better-auth; with
 * the switch off it is the app's 404, as the path was on main for a signed-in visitor (the layout sends a signed-out one
 * to the log-in page then). Someone already signed in goes to the app, as on the log-in page; the link stays unused.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang) || !baOn()) notFound();
  if (await currentUser()) redirect(appHref(lang));
  // The log-in strings (for the suspension line), passed whole: the stored `suspended` field is read only by isSuspended (rule 2071).
  return <Suspense><MagicLanding lang={lang} login={appDict[lang].login} /></Suspense>;
}
