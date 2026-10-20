import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import SettingsFrame from "@/components/app/settings/SettingsFrame";

/**
 * The account settings sections' frame (rule 1140). The four brand sections live under `/{lang}/app/b/{brand}/settings`
 * (rule 885) in the same frame (`SettingsFrame`). No brand is known here yet, so the nav links those four by their old
 * path, which the `[...legacy]` page sends on to the session's brand.
 */
export default async function SettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return <SettingsFrame lang={lang}>{children}</SettingsFrame>;
}
