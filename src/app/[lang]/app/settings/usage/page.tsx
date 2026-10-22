import { settingsScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import { monthKey } from "@/lib/credits";
import { isMonth, ownerUsage } from "@/lib/usage-report";
import { listBrands } from "@/lib/brands";
import { acct } from "@/lib/account-id";
import PageHeader from "@/components/ui/PageHeader";
import OwnerUsagePanel, { OWNER_USAGE_COPY } from "@/components/app/settings/OwnerUsagePanel";

export const dynamic = "force-dynamic";

/**
 * AI usage (rule 2907): the owner's or an admin's own month, rendered from `ownerUsage`, the same body GET /api/usage
 * returns. Requests and shares only, never a dollar figure. Other roles get the same 404 an unknown section gets.
 */
export const generateMetadata = settingsScreenMeta("usage");

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  if (!can(u, "usage.view")) notFound();
  const asked = (await searchParams)?.month;
  const month = isMonth(asked) ? asked : monthKey();
  const [view, brands] = await Promise.all([ownerUsage(u, month), listBrands(acct(u))]);
  return (
    <div>
      <PageHeader lang={lang} title={OWNER_USAGE_COPY[lang].title} sub={OWNER_USAGE_COPY[lang].sub} seed="usage-t1" />
      <OwnerUsagePanel lang={lang} view={view} brands={Object.fromEntries(brands.map((b) => [b.id, b.name]))} />
    </div>
  );
}
