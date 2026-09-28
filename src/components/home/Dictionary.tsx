"use client";
import { useEffect, useId, useReducer, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { AgentId } from "@/lib/agents";
import { AGENT_CAST, type L } from "@/lib/home";
import { DICT_COPY, INITIAL, MAX_WORDS, SECTORS, WORDS, canAdvance, reduce, sampleDraft, samplePlan, type Step } from "@/lib/dictionary";
import type { Lang } from "@/lib/i18n";
import Doodle from "./Doodle";
import StartForm from "./StartForm";
import styles from "./home.module.css";

const STEPS: readonly Step[] = [1, 2, 3, 4, 5, 6, 7];

const NAME = Object.fromEntries(AGENT_CAST.map((a) => [a.id, a.name])) as Record<AgentId, L>;

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
/** Arabic-Indic digits on the Arabic page, Western digits on the English one. */
const num = (n: number, lang: Lang) => (lang === "ar" ? String(n).replace(/\d/g, (d) => AR_DIGITS[Number(d)]) : String(n));

const noSubscribe = () => () => {};
/**
 * False in the server HTML and while React hydrates, true once React owns the page. Step 1's fields stay disabled until
 * then: a value typed into the bare HTML would sit in the DOM without ever reaching the reducer.
 */
const useReady = () => useSyncExternalStore(noSubscribe, () => true, () => false);

/** An agent's head in a circle: the full figure, cropped to the face and shoulders. */
function Face({ who }: { who: AgentId }) {
  return (
    <span className={styles.face} aria-hidden="true">
      <Doodle who={who} />
    </span>
  );
}

/** One agent speaking: their face, their name, their line. */
function Say({ who, lang, text }: { who: AgentId; lang: Lang; text: string }) {
  return (
    <div className={styles.say}>
      <Face who={who} />
      <p className={styles.bubble}>
        <span className={styles.sayName}>{NAME[who][lang]}</span>
        {text}
      </p>
    </div>
  );
}

/** A sample the agents prepared, always tagged «مثال»: pre-written, not generated for this visitor. */
function Sample({ who, lang, children }: { who: readonly AgentId[]; lang: Lang; children: ReactNode }) {
  return (
    <div className={styles.sample}>
      <div className={styles.sampleHead}>
        <span className={styles.sampleFaces}>
          {who.map((w) => (
            <Face key={w} who={w} />
          ))}
        </span>
        <span className={styles.sampleWho}>{who.map((w) => NAME[w][lang]).join(" · ")}</span>
        <span className={styles.exampleTag}>{DICT_COPY.example[lang]}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * قاموس ذكين, the homepage game: seven steps from a brand's name to its first result. Everything happens in this
 * component's reducer (`src/lib/dictionary.ts`): no request, no storage, nothing leaves the page. The brand is only ever
 * rendered as text. Steps 3–4 are pre-written samples tagged «مثال»; steps 6–7 are previews, because analysis and
 * measurement need real time and real data. Each step change moves focus to the new step's heading.
 */
export default function Dictionary({ lang }: { lang: Lang }) {
  const [s, dispatch] = useReducer(reduce, INITIAL);
  const ready = useReady();
  const uid = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(s.step);

  useEffect(() => {
    // Compared with the last step shown rather than skipped on mount, so a strict-mode double mount never steals focus.
    if (shownStep.current === s.step) return;
    shownStep.current = s.step;
    heading.current?.focus();
  }, [s.step]);

  const headingId = `${uid}-step`;
  const full = s.words.length >= MAX_WORDS;
  const lastWord = WORDS.find((w) => w.id === s.words[s.words.length - 1]);

  let body: ReactNode;
  switch (s.step) {
    case 1:
      body = (
        <>
          <div>
            <label htmlFor={`${uid}-brand`} className={styles.dictLabel}>
              {DICT_COPY.brandLabel[lang]}
            </label>
            <input
              id={`${uid}-brand`}
              className={styles.dictInput}
              value={s.brand}
              onChange={(e) => dispatch({ type: "brand", value: e.target.value })}
              disabled={!ready}
              dir="auto"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <fieldset className={styles.sectors}>
            <legend className={styles.dictLabel}>{DICT_COPY.sectorLabel[lang]}</legend>
            <div className={styles.sectorList}>
              {SECTORS.map((sector) => (
                <label key={sector.id} className={styles.sector}>
                  <input
                    type="radio"
                    name={`${uid}-sector`}
                    value={sector.id}
                    checked={s.sector === sector.id}
                    onChange={() => dispatch({ type: "sector", value: sector.id })}
                    disabled={!ready}
                  />
                  {sector.name[lang]}
                </label>
              ))}
            </div>
          </fieldset>
          <div aria-live="polite">{s.brand.trim() !== "" && <Say who={DICT_COPY.greet.who} lang={lang} text={DICT_COPY.greet.text[lang]} />}</div>
        </>
      );
      break;
    case 2:
      body = (
        <>
          <div className={styles.words} role="group" aria-labelledby={headingId}>
            {WORDS.map((w) => {
              const on = s.words.includes(w.id);
              return (
                <button key={w.id} type="button" className={styles.word} aria-pressed={on} disabled={full && !on} onClick={() => dispatch({ type: "word", value: w.id })}>
                  {on && (
                    <span className={styles.tick} aria-hidden="true">
                      ✓
                    </span>
                  )}
                  {w.name[lang]}
                </button>
              );
            })}
          </div>
          <div className={styles.dictLive} aria-live="polite">
            <p className={styles.counter}>{DICT_COPY.counter[lang].replace("{n}", num(s.words.length, lang))}</p>
            {lastWord && <Say key={lastWord.id} who={lastWord.react.who} lang={lang} text={lastWord.react.text[lang]} />}
          </div>
        </>
      );
      break;
    case 3:
      body = (
        <Sample who={["faris", "majed"]} lang={lang}>
          <ol className={styles.planList} role="list">
            {samplePlan(s, lang).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </Sample>
      );
      break;
    case 4: {
      const draft = sampleDraft(s, lang);
      body = (
        <div className={styles.samples}>
          <Sample who={["noor"]} lang={lang}>
            <p className={styles.post}>{draft.post}</p>
          </Sample>
          <Sample who={["sami"]} lang={lang}>
            <p className={styles.chat}>{draft.whatsapp}</p>
          </Sample>
        </div>
      );
      break;
    }
    case 5:
      body = (
        <div className={styles.approveBox}>
          <button type="button" className={styles.approve} aria-describedby={`${uid}-note`} onClick={() => dispatch({ type: "approve" })}>
            {DICT_COPY.approve[lang]}
          </button>
          <p id={`${uid}-note`} className={styles.approveNote}>
            {DICT_COPY.approveNote[lang]}
          </p>
        </div>
      );
      break;
    case 6:
      body = (
        <div className={styles.preview}>
          <Say who={DICT_COPY.analysis.who} lang={lang} text={DICT_COPY.analysis.text[lang]} />
        </div>
      );
      break;
    case 7:
      body = (
        <>
          <div className={styles.preview}>
            <p>{DICT_COPY.measure[lang]}</p>
          </div>
          <div className={styles.dictCta}>
            <p className={styles.dictCtaLine}>{DICT_COPY.cta[lang]}</p>
            <StartForm lang={lang} />
          </div>
        </>
      );
      break;
  }

  return (
    <section id="dictionary" className={styles.dict} data-testid="dictionary" data-step={s.step} aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`} className={styles.dictTitle}>
        {DICT_COPY.title[lang]}
      </h2>
      <p className={styles.dictSub}>{DICT_COPY.subtitle[lang]}</p>

      {/* `role="list"` here and on the plan: Safari drops the list semantics of a list drawn without markers. */}
      <ol className={styles.rail} role="list">
        {STEPS.map((n) => (
          <li key={n} className={styles.railStep} data-state={n === s.step ? "current" : n < s.step ? "done" : "todo"} aria-current={n === s.step ? "step" : undefined}>
            <span className={styles.railNum}>{num(n, lang)}</span>
            <span className={styles.railName}>{DICT_COPY.steps[n][lang]}</span>
          </li>
        ))}
      </ol>

      <div className={styles.dictPanel}>
        <h3 id={headingId} ref={heading} tabIndex={-1} className={styles.dictStep}>
          <span className={styles.dictCount}>
            {num(s.step, lang)}/{num(STEPS.length, lang)}
          </span>{" "}
          {DICT_COPY.steps[s.step][lang]}
        </h3>
        <div className={styles.dictBody}>{body}</div>
        <div className={styles.dictNav}>
          {s.step > 1 && (
            <button type="button" className={styles.dictBack} onClick={() => dispatch({ type: "back" })}>
              {DICT_COPY.back[lang]}
            </button>
          )}
          {s.step !== 5 && s.step !== 7 && (
            <button type="button" className={styles.dictNext} disabled={!canAdvance(s)} onClick={() => dispatch({ type: "next" })}>
              {DICT_COPY.next[lang]}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
