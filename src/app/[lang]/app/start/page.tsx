import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { onboardCost } from "@/lib/pricing";
import { heldOnboard } from "@/lib/onboard-confirm";
import { can } from "@/lib/roles";
import StartWizard from "@/components/app/StartWizard";
import ReadOnlyNote from "@/components/app/ReadOnlyNote";

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ url?: string }> }) {
  const { lang } = await params;
  const { url } = await searchParams;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  // Building the workspace (POST /api/onboard/confirm, /api/onboard) is admin and owner only. A plain member who joined
  // before the owner set the brand up would otherwise get a form the server refuses, with a generic error.
  if (!can(u, "onboard")) {
    // Once the brand exists there is nothing to wait for: the workspace is open.
    if (await getBrand(sc(u))) redirect(`/${lang}/app`);
    const t = appDict[lang].start;
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="page-title">{t.memberTitle}</h1>
        <ReadOnlyNote className="mt-4" text={t.memberWait} />
      </div>
    );
  }
  // An added brand's setup costs credits (rule 226): the wizard states the cost and the balance before the owner presses
  // Go, or that the setup is already paid for (a charge held from a run that did not finish, which the next run reuses:
  // the balance is then not asked again). Display only: POST /api/onboard/confirm and /api/onboard check the balance and
  // the hold, and charge, on the server.
  const setupCost = onboardCost(u.brandId);
  return <StartWizard t={appDict[lang]} lang={lang} initialUrl={typeof url === "string" ? url.slice(0, 300) : ""} setupCost={setupCost} setupPaid={setupCost > 0 && !!heldOnboard(u, sc(u))} credits={u.credits} />;
}
