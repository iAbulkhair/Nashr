import { appScreenMeta } from "@/lib/screen-titles";
import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentPerson, currentUser } from "@/lib/auth";
import { MULTI_ORG } from "@/lib/multi-org";
import JoinForm from "@/components/app/JoinForm";

export const dynamic = "force-dynamic";

/**
 * Public (listed in the app layout's PUBLIC paths): accept a team invite. The token is in the URL fragment (#t=…), which
 * never reaches the server, so this page cannot and does not read it; JoinForm reads it on the client and clears it.
 * A signed-in visitor is shown who they are signed in as and asked to log out first, never joined into that session.
 * With `MULTI_ORG` on (multi-workspace M2, rule 2116) the signed-in PERSON (`currentPerson()`, with or without a
 * workspace) is passed on, so one whose verified address is the invite's can join from their own session.
 */
export const generateMetadata = appScreenMeta("join");

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const [u, me] = await Promise.all([currentUser(), MULTI_ORG ? currentPerson() : null]);
  const person = me ? { email: me.person.email, verified: !!me.person.emailVerifiedAt } : null;
  return <JoinForm t={appDict[lang]} lang={lang} signedInAs={person?.email ?? (u ? (u.actor?.email ?? u.email) : null)} person={person} />;
}
