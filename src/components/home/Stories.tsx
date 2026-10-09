import Scribble from "@/components/Scribble";
import { AGENT_CAST, SCENES, SCENES_COPY } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import Person from "./Person";
import SceneTrack from "./SceneTrack";
import styles from "./home.module.css";

/** Scenes per slide. */
export const PER_SLIDE = 4;

const agentName = (id: string, lang: Lang) => AGENT_CAST.find((a) => a.id === id)?.name[lang] ?? "";

/**
 * The scenes under the cover (rule 775): illustrative owners, four to a slide, each saying in a bubble what they like,
 * a habit they recommend, or a suggestion, with the agent it is about. The line under the heading sits before any
 * scene (in English it says they are illustrative examples). Without script the slides still scroll and snap.
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
            <Scribble kind="underline" seed="scenes-h" />
            {c.h[lang]}
          </span>
        </h2>
        <p className={styles.sub}>{c.sub[lang]}</p>
      </div>
      <SceneTrack lang={lang} label={c.h[lang]} prev={c.prev[lang]} next={c.next[lang]} slide={c.slide[lang]}>
        {sets.map((set, i) => (
          <ul key={i} className={styles.grid4} role="list">
            {set.map((s, j) => {
              const k = i * PER_SLIDE + j;
              return (
                <li key={k} className={`${styles.panel} ${styles.scn}`}>
                  <Scribble kind="box" seed={`sc${k}`} fill="paper" />
                  <figure className={styles.sfig}>
                    <span className={`s-tag ${styles.kind}`}>
                      <Scribble kind="box" seed={`sk${k}`} fill={s.kind === "like" ? "lemon" : "lilac"} />
                      {c.kinds[s.kind][lang]}
                    </span>
                    <blockquote className="s-bubble" data-tail="bottom">
                      <Scribble kind="bubble" seed={`sb${k}`} tail="bottom" tailAt={0.2} rtl={rtl} />
                      {s.line[lang]}
                    </blockquote>
                    <figcaption className={styles.swho}>
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
                    </figcaption>
                  </figure>
                </li>
              );
            })}
          </ul>
        ))}
      </SceneTrack>
    </section>
  );
}
