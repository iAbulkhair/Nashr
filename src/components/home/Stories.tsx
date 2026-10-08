import Scribble from "@/components/Scribble";
import { AGENT_CAST } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import { PER_SLIDE, STORIES, STORIES_LIST, type Story } from "@/lib/stories";
import Avatar from "./Avatar";
import StoriesCarousel from "./StoriesCarousel";
import styles from "./home.module.css";

const agent = (id: Story["who"]) => AGENT_CAST.find((a) => a.id === id);

/** The story list cut into slides of four. */
const SLIDES = Array.from({ length: Math.ceil(STORIES_LIST.length / PER_SLIDE) }, (_, i) => STORIES_LIST.slice(i * PER_SLIDE, (i + 1) * PER_SLIDE));

/**
 * Illustrative personas under the cover, four a slide: a speech bubble with what the person wants from one agent, over
 * their drawn face, their role and the agent's name. Badged as illustrative, not as customers (see `src/lib/stories.ts`).
 * The faces are decoration; the role and the agent's name are text, so a screen reader hears who says what.
 */
export default function Stories({ lang }: { lang: Lang }) {
  return (
    <section className={styles.sec} id="stories" aria-labelledby="t-stories">
      <div className={styles.sh}>
        <h2 id="t-stories">
          <span className={styles.ul}>
            <Scribble kind="underline" seed="stories-h" />
            {STORIES.h[lang]}
          </span>
        </h2>
        <p className={styles.sub}>{STORIES.sub[lang]}</p>
        <p className={`s-tag ${styles.stBadge}`}>
          <Scribble kind="pill" seed="stories-badge" fill="lilac" />
          {STORIES.badge[lang]}
        </p>
      </div>
      <StoriesCarousel lang={lang} count={SLIDES.length}>
        {SLIDES.map((slide, si) => (
          <li key={si} className={styles.stSlide} aria-roledescription="slide" aria-label={`${STORIES.slide[lang]} ${si + 1} ${STORIES.of[lang]} ${SLIDES.length}`}>
            <ul className={styles.stFour} role="list">
              {slide.map((p, pi) => {
                const a = agent(p.who);
                return (
                  <li key={p.id} className={`${styles.panel} ${styles.stStory}`}>
                    <Scribble kind="box" seed={`stb-${p.id}`} fill="paper" />
                    <p className={`s-bubble ${styles.stSay}`} data-tail="bottom">
                      <Scribble kind="bubble" seed={`sb-${p.id}`} tail="bottom" tailAt={pi % 2 ? 0.7 : 0.3} rtl={lang === "ar"} />
                      <span className={styles.srOnly}>{STORIES.kind[p.kind][lang]}: </span>
                      {p.say[lang]}
                    </p>
                    <div className={styles.stWho}>
                      <span className={`${styles.dface} ${styles.dfaceLg}`} aria-hidden="true">
                        <Scribble kind="circleLoop" seed={`sf-${p.id}`} fill="paper" />
                        <i>
                          <Avatar look={p.look} who={p.who} seed={p.id} />
                        </i>
                      </span>
                      <span className={styles.stMeta}>
                        <b>{p.role[lang]}</b>
                        <small>
                          {STORIES.kind[p.kind][lang]} · {a?.name[lang]}
                        </small>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </StoriesCarousel>
    </section>
  );
}
