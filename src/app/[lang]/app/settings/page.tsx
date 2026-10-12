import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { currentUser } from "@/lib/auth";
import { SETTINGS_COPY } from "@/lib/settings-nav";
import PageHeader from "@/components/ui/PageHeader";
import SettingsNav from "@/components/app/settings/SettingsNav";

export const dynamic = "force-dynamic";
export const generateMetadata = appScreenMeta("settings");

/** The settings index (rule 1140): every section with one line of what it holds. The rail and the account menu open it. */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  if (!(await currentUser())) redirect(`/${lang}/app/login`);
  const C = SETTINGS_COPY[lang];
  return (
    <div className="grid gap-6">
      <PageHeader lang={lang} title={C.title} sub={C.sub} seed="settings-index" />
      <SettingsNav lang={lang} variant="list" current={null} />
    </div>
  );
}
