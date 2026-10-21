import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import SettingsFrame from "@/components/app/settings/SettingsFrame";

/**
 * The brand settings sections (brand, connections, governance, notifications; rule 885, R-C6, R-C10) in the same frame
 * as the account ones. The brand layout above already held the path's brand to the session's (rule 891); the nav links
 * the brand sections under it.
 */
export default async function BrandSettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string; brand: string }> }) {
  const { lang, brand } = await params;
  if (!isLang(lang)) notFound();
  return <SettingsFrame lang={lang} brand={brand}>{children}</SettingsFrame>;
}
