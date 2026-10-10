import { appScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";
import JoinForm from "@/components/app/JoinForm";

export const dynamic = "force-dynamic";

/**
 * Public (listed in the app layout's PUBLIC paths): accept a team invite. The token is in the URL fragment (#t=…), which
 * never reaches the server, so this page cannot and does not read it; JoinForm reads it on the client and clears it.
 * A signed-in visitor is shown who they are signed in as and asked to log out first, never joined into that session.
 */
export const generateMetadata = appScreenMeta("join");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  return <JoinForm t={appDict[lang]} lang={lang} signedInAs={u ? (u.actor?.email ?? u.email) : null} />;
}
