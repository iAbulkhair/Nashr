import ScribbleStatic from "@/components/ScribbleStatic";
import { APP_SCREEN_COPY as C } from "@/lib/home-app-screen";
import type { Lang } from "@/lib/i18n";
import AppScreen from "./AppScreen";
import RolePreview from "./RolePreview";
import styles from "./home.module.css";

/**
 * The workspace section (rules 3348-3352): the drawing of the app screen, then the three team roles. Placed by
 * `APP_SCREEN_SPOT` in src/lib/home-app-screen.ts, outside the cover, which is already full.
 */
export default function Workspace({ lang }: { lang: Lang }) {
  return (
    <section className={styles.sec} id="workspace" aria-labelledby="t-workspace">
      <div className={styles.sh}>
        <h2 id="t-workspace">
          <span className={styles.ul}>
            <ScribbleStatic kind="underline" seed="workspace-h" rtl={lang === "ar"} />
            {C.h[lang]}
          </span>
        </h2>
        <p className={styles.sub}>{C.sub[lang]}</p>
      </div>
      <AppScreen lang={lang} />
      <RolePreview lang={lang} />
    </section>
  );
}
