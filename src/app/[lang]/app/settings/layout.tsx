import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import SettingsNav, { SettingsBack } from "@/components/app/settings/SettingsNav";

/**
 * The settings area's frame (rule 1140): the section list as a column at the start side on a wide screen, the section
 * beside it. On a phone the column is hidden; the index lists the sections full width and each section page starts with
 * a link back to that list. Each page signs in and checks its own role, as before it moved here: this frame reads no data.
 */
export default async function SettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return (
    <div className="mx-auto w-full max-w-6xl lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
      <aside className="hidden lg:block">
        <div className="sticky top-0 pt-1">
          <SettingsNav lang={lang} />
        </div>
      </aside>
      <div className="min-w-0">
        <SettingsBack lang={lang} />
        {children}
      </div>
    </div>
  );
}
