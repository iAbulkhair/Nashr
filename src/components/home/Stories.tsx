import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import { AGENT_CAST, SCENES, SCENES_COPY } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import Person from "./Person";
import SceneTrack from "./SceneTrack";
import styles from "./home.module.css";

/** Scenes per slide. */
export const PER_SLIDE = 4;

const agentName = (id: string, lang: Lang) => AGENT_CAST.find((a) => a.id === id)?.name[lang] ?? "";

/**
 * The scenarios under the cover (rules 775, 1840-1842): eight kinds of business, four to a slide, each told as "if you
 * run a …" in a bubble, with the agent who does the job. The heading and the line under it name no customers and use
 * no "example" wording (rule 926); the cards carry no stamp. They are not quotes, so no quotation markup and no caption:
 * a plain paragraph and the business it is about. Without script the slides still scroll and snap.
 */
export default function Stories({ lang }: { lang: Lang }) {
  const c = SCENES_COPY;
  const rtl = lang === "ar";
  const sets = Array.from({ length: Math.ceil(SCENES.length / PER_SLIDE) }, (_, i) => SCENES.slice(i * PER_SLIDE, (i + 1) * PER_SLIDE));
  return (
    <section className={styles.sec} aria-labelledby="t-scenes">
      <div className={styles.sh}>
        <h2 id="t-scenes">
          <span className={styles.ul}>
            <ScribbleStatic kind="underline" seed="scenes-h" rtl={rtl} />
            {c.h[lang]}
          </span>
        </h2>
        <p className={styles.sub}>{c.sub[lang]}</p>
      </div>
      <SceneTrack lang={lang} label={c.h[lang]} prev={c.prev[lang]} next={c.next[lang]} slide={c.slide[lang]} pause={c.pause[lang]} play={c.play[lang]}>
        {sets.map((set, i) => (
          <ul key={i} className={styles.grid4} role="list">
            {set.map((s, j) => {
              const k = i * PER_SLIDE + j;
              return (
                <li key={k} className={`${styles.panel} ${styles.scn}`}>
                  <Scribble kind="box" seed={`sc${k}`} fill="paper" />
                  <div className={styles.sfig}>
                    <p className="s-bubble" data-tail="bottom">
                      <Scribble kind="bubble" seed={`sb${k}`} tail="bottom" tailAt={0.2} rtl={rtl} />
                      {s.line[lang]}
                    </p>
                    <p className={styles.swho}>
                      <span className={styles.pface} aria-hidden="true">
                        <Scribble kind="circleLoop" seed={`sp${k}`} fill="none" />
                        <i>
                          <Person look={s.look} />
                        </i>
                      </span>
                      <span>
                        <b>{s.role[lang]}</b>
                        <small>
                          {c.with[lang]} {agentName(s.agent, lang)}
                        </small>
                      </span>
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        ))}
      </SceneTrack>
    </section>
  );
}
