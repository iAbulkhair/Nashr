import SettingsNav, { SettingsBack } from "./SettingsNav";
import type { Lang } from "@/lib/i18n";

/**
 * The settings area's frame (rule 1140): the section list as a column at the start side on a wide screen, the section
 * beside it. On a phone the column is hidden; the index lists the sections full width and each section page starts with
 * a link back to that list. Each page signs in and checks its own role: this frame reads no data.
 *
 * Shared by the account settings layout (`/{lang}/app/settings`) and the brand settings layout
 * (`/{lang}/app/b/{brand}/settings`, rule 885), so the four brand sections sit in the same frame as the others. `brand`
 * is the path's brand when there is one; the nav links the brand sections under it.
 */
export default function SettingsFrame({ lang, brand, children }: { lang: Lang; brand?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
      <aside className="hidden lg:block">
        <div className="sticky top-0 pt-1">
          <SettingsNav lang={lang} brand={brand} />
        </div>
      </aside>
      <div className="min-w-0">
        <SettingsBack lang={lang} />
        {children}
      </div>
    </div>
  );
}
