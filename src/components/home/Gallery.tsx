import Scribble from "@/components/Scribble";
import { appDict } from "@/lib/app-i18n";
import { approvalDict } from "@/lib/approval-dict";
import { GALLERY_COPY, GALLERY_TABS, gallerySamples } from "@/lib/home-gallery";
import type { Lang } from "@/lib/i18n";
import GalleryTabs, { type GalleryText } from "./GalleryTabs";
import styles from "./home.module.css";

/**
 * The live UI gallery (UI/UX phase 5b, rules 1220-1229): real screens of the app, the chat, the starter plan and the
 * inbox, drawn by the app's own components with made-up data. The line under the heading says the data is illustrative
 * and not real customers, and every panel carries the same label. The copy lives in `src/lib/home-gallery.ts`; only the
 * approval card's slice of the app dictionary goes to the browser.
 */
export default function Gallery({ lang }: { lang: Lang }) {
  const c = GALLERY_COPY;
  const text: GalleryText = {
    label: c.label[lang],
    note: c.note[lang],
    tabsLabel: c.tabsLabel[lang],
    tabs: Object.fromEntries(GALLERY_TABS.map((id) => [id, { label: c.tabs[id].label[lang], cap: c.tabs[id].cap[lang] }])) as GalleryText["tabs"],
  };
  return (
    <section className={styles.sec} id="gallery" aria-labelledby="t-gallery">
      <div className={styles.sh}>
        <h2 id="t-gallery">
          <span className={styles.ul}>
            <Scribble kind="underline" seed="gallery-h" />
            {c.h[lang]}
          </span>
        </h2>
        <p className={styles.sub}>{c.sub[lang]}</p>
      </div>
      <GalleryTabs lang={lang} t={approvalDict(appDict[lang])} samples={gallerySamples(lang)} text={text} />
    </section>
  );
}
