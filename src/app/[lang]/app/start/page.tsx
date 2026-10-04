import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { onboardCost } from "@/lib/pricing";
import { heldOnboard } from "@/lib/onboard-confirm";
import { can } from "@/lib/roles";
import DictionaryStart from "@/components/app/DictionaryStart";
import ReadOnlyNote from "@/components/app/ReadOnlyNote";
import Scribble from "@/components/Scribble";

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ url?: string }> }) {
  const { lang } = await params;
  const { url } = await searchParams;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // Building the workspace (POST /api/onboard/confirm, /api/onboard) and writing the brand (PUT /api/brand) are admin and
  // owner only. A plain member who joined before the owner set the brand up would otherwise get a game whose last step
  // the server refuses, with a generic error. Rule 524.
  if (!can(u, "onboard") || !can(u, "brand.write")) {
    // Once the brand exists there is nothing to wait for: the workspace is open.
    if (await getBrand(sc(u))) redirect(`/${lang}/app`);
    const t = appDict[lang].start;
    return (
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="start-t1" />{t.memberTitle}</span></h1>
        <ReadOnlyNote className="mt-4" text={t.memberWait} />
      </div>
    );
  }
  // The first-login game is for a workspace without a brand file; with one there is nothing to set up.
  if (await getBrand(sc(u))) redirect(`/${lang}/app`);
  // An added brand's setup costs credits (rule 246): the game's last step states the cost and the balance before the
  // owner presses Go, or that the setup is already paid for (a charge held from a run that did not finish, which the next
  // run reuses: the balance is then not asked again). Display only: POST /api/onboard/confirm and /api/onboard check the
  // balance and the hold, and charge, on the server.
  const setupCost = onboardCost(u.brandId);
  return <DictionaryStart t={appDict[lang]} lang={lang} initialUrl={typeof url === "string" ? url.slice(0, 300) : ""} setupCost={setupCost} setupPaid={setupCost > 0 && !!heldOnboard(u, sc(u))} credits={u.credits} />;
}
