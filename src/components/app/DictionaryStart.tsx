"use client";
import Link from "next/link";
import { useEffect, useId, useReducer, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { HomeAgentId } from "@/lib/home";
import { AGENT_CAST, type L } from "@/lib/home";
import { DICT_COPY, INITIAL, MAX_WORDS, SECTORS, START_COPY, WORDS, answersOf, canAdvance, reduce, sampleDraft, samplePlan, type Step } from "@/lib/dictionary";
import type { Lang } from "@/lib/i18n";
import Doodle from "@/components/home/Doodle";
import cast from "@/components/home/home.module.css";
import StartLaunch from "./StartLaunch";

const STEPS: readonly Step[] = [1, 2, 3, 4, 5, 6, 7];

const NAME = Object.fromEntries(AGENT_CAST.map((a) => [a.id, a.name])) as Record<HomeAgentId, L>;

/** The rail's names: the homepage game's for steps 1-5; here 6 joins analysis and measurement, and 7 is the launch. */
const stepName = (n: Step, lang: Lang) => (n === 6 ? START_COPY.steps6 : n === 7 ? START_COPY.steps7 : DICT_COPY.steps[n])[lang];

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
/** Arabic-Indic digits on the Arabic page, Western digits on the English one. */
const num = (n: number, lang: Lang) => (lang === "ar" ? String(n).replace(/\d/g, (d) => AR_DIGITS[Number(d)]) : String(n));

const noSubscribe = () => () => {};
/**
 * False in the server HTML and while React hydrates, true once React owns the page. Step 1's fields stay disabled until
 * then: a value typed into the bare HTML would sit in the DOM without ever reaching the reducer.
 */
const useReady = () => useSyncExternalStore(noSubscribe, () => true, () => false);

/**
 * An agent's head in a circle: the cast's figure and the cast's own colours (`home.module.css`, the one place they are
 * defined), so a palette change there reaches these faces too.
 */
function Face({ who }: { who: HomeAgentId }) {
  return (
    <span className={`${cast.home} ${cast.face}`} aria-hidden="true">
      <Doodle who={who} />
    </span>
  );
}

/** One agent speaking: their face, their name, their line. */
function Say({ who, lang, text }: { who: HomeAgentId; lang: Lang; text: string }) {
  return (
    <div className="pop-in flex items-end gap-3">
      <Face who={who} />
      <p className="min-w-0 rounded-2xl rounded-es-sm bg-lilac px-4 py-2.5 text-sm leading-relaxed">
        <span className="block text-xs font-semibold text-ink">{NAME[who][lang]}</span>
        {text}
      </p>
    </div>
  );
}

/** A sample the agents prepared, always tagged «مثال»: pre-written, not generated for this owner. */
function Sample({ who, lang, children }: { who: readonly HomeAgentId[]; lang: Lang; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-ink/10 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex -space-x-2">
          {who.map((w) => (
            <Face key={w} who={w} />
          ))}
        </span>
        <span className="text-sm font-semibold text-ink">{who.map((w) => NAME[w][lang]).join(" · ")}</span>
        <span className="badge badge-accent ms-auto">{DICT_COPY.example[lang]}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * قاموس ذكين as first-login onboarding (docs/superpowers/specs/2026-10-04-dictionary-onboarding-design.md): the owner of
 * a workspace without a brand file plays the homepage game's seven steps here instead of filling a form. Steps 1-6 live in
 * this component's reducer (`src/lib/dictionary.ts`): no request, nothing saved, leaving loses the answers. Steps 3-4 are
 * pre-written samples tagged «مثال»; step 6 is a preview of analysis and measurement. Step 7 (`StartLaunch`) is the only
 * one that writes: the site build with the answers, or the brand file without a site. The brand form stays one link
 * away under the title on every step. Each step change moves focus to the new step's heading.
 */
export default function DictionaryStart({ t, lang, initialUrl, setupCost, setupPaid, credits }: { t: AppDict; lang: Lang; initialUrl: string; setupCost: number; setupPaid: boolean; credits: number }) {
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
  const pill = "inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm transition-colors";

  let body: ReactNode;
  switch (s.step) {
    case 1:
      body = (
        <>
          <div className="grid gap-1.5">
            <label htmlFor={`${uid}-brand`} className="text-sm font-semibold">
              {DICT_COPY.brandLabel[lang]}
            </label>
            <input id={`${uid}-brand`} className="input py-3 text-base" value={s.brand} onChange={(e) => dispatch({ type: "brand", value: e.target.value })} disabled={!ready} dir="auto" autoComplete="off" spellCheck={false} />
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-semibold">{DICT_COPY.sectorLabel[lang]}</legend>
            <div className="flex flex-wrap gap-2">
              {SECTORS.map((sector) => (
                <label key={sector.id} className={`${pill} cursor-pointer border-ink/15 bg-white has-checked:border-ink has-checked:bg-ink/10 has-focus-visible:ring-2 has-focus-visible:ring-ink`}>
                  <input type="radio" className="accent-ink" name={`${uid}-sector`} value={sector.id} checked={s.sector === sector.id} onChange={() => dispatch({ type: "sector", value: sector.id })} disabled={!ready} />
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
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby={headingId}>
            {WORDS.map((w) => {
              const on = s.words.includes(w.id);
              return (
                <button key={w.id} type="button" aria-pressed={on} disabled={full && !on} onClick={() => dispatch({ type: "word", value: w.id })} className={`${pill} ${on ? "border-ink bg-ink text-white" : "border-ink/15 bg-white"} disabled:cursor-not-allowed disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-ink focus-visible:outline-none`}>
                  {on && <span aria-hidden="true">✓</span>}
                  {w.name[lang]}
                </button>
              );
            })}
          </div>
          <div className="grid gap-3" aria-live="polite">
            <p className="tnum text-sm text-ink/60">{DICT_COPY.counter[lang].replace("{n}", num(s.words.length, lang))}</p>
            {lastWord && <Say key={lastWord.id} who={lastWord.react.who} lang={lang} text={lastWord.react.text[lang]} />}
          </div>
        </>
      );
      break;
    case 3:
      body = (
        <Sample who={["faris", "majed"]} lang={lang}>
          <ol className="grid list-decimal gap-1.5 ps-5 text-sm" role="list">
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
        <div className="grid gap-3 sm:grid-cols-2">
          <Sample who={["noor"]} lang={lang}>
            <p className="text-sm leading-relaxed">{draft.post}</p>
          </Sample>
          <Sample who={["sami"]} lang={lang}>
            <p className="rounded-2xl rounded-ss-sm bg-lilac px-3 py-2 text-sm leading-relaxed">{draft.whatsapp}</p>
          </Sample>
        </div>
      );
      break;
    }
    case 5:
      body = (
        <div className="grid justify-items-center gap-2 py-4 text-center">
          <button type="button" className="btn btn-primary btn-lg min-w-40" aria-describedby={`${uid}-note`} onClick={() => dispatch({ type: "approve" })}>
            {DICT_COPY.approve[lang]}
          </button>
          <p id={`${uid}-note`} className="text-sm text-ink/60">
            {DICT_COPY.approveNote[lang]}
          </p>
        </div>
      );
      break;
    case 6:
      body = (
        <>
          <Say who={DICT_COPY.analysis.who} lang={lang} text={DICT_COPY.analysis.text[lang]} />
          <p className="rounded-xl bg-ground px-4 py-3 text-sm text-ink/80">{DICT_COPY.measure[lang]}</p>
        </>
      );
      break;
    case 7: {
      const answers = answersOf(s, lang);
      body = answers && <StartLaunch t={t} lang={lang} answers={answers} initialUrl={initialUrl} setupCost={setupCost} setupPaid={setupPaid} credits={credits} />;
      break;
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <section className="card overflow-hidden p-0" data-testid="dictionary-start" data-step={s.step} aria-labelledby={`${uid}-title`}>
        <div className="p-5 sm:p-6">
          <h1 id={`${uid}-title`} className="page-title">
            {DICT_COPY.title[lang]}
          </h1>
          <p className="mt-1 text-ink/70">{DICT_COPY.subtitle[lang]}</p>
          <Link href={`/${lang}/app/onboarding`} className="mt-2 inline-block text-sm text-ink/60 underline">
            {t.start.manual}
          </Link>

          <ol className="mt-5 flex items-start gap-1" role="list">
            {STEPS.map((n) => {
              const state = n === s.step ? "current" : n < s.step ? "done" : "todo";
              return (
                <li key={n} className="flex min-w-0 flex-1 flex-col items-center gap-1 text-center" aria-current={state === "current" ? "step" : undefined}>
                  <span className={`grid h-8 w-8 place-items-center rounded-full text-sm font-semibold ${state === "current" ? "bg-ink text-white" : state === "done" ? "bg-ink/15 text-ink" : "bg-lilac text-ink/50"}`}>{num(n, lang)}</span>
                  <span className={`text-xs leading-tight ${state === "current" ? "font-semibold text-ink" : "sr-only text-ink/50 sm:not-sr-only"}`}>{stepName(n, lang)}</span>
                </li>
              );
            })}
          </ol>

          <h2 id={headingId} ref={heading} tabIndex={-1} className="mt-6 font-display text-lg font-bold text-ink focus:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ink">
            <span className="tnum text-sm font-semibold text-ink/50">
              {num(s.step, lang)}/{num(STEPS.length, lang)}
            </span>{" "}
            {stepName(s.step, lang)}
          </h2>
          <div className="mt-4 grid gap-4">{body}</div>
          <div className="mt-6 flex items-center justify-between gap-2">
            {s.step > 1 ? (
              <button type="button" className="btn btn-secondary" onClick={() => dispatch({ type: "back" })}>
                {DICT_COPY.back[lang]}
              </button>
            ) : (
              <span />
            )}
            {s.step !== 5 && s.step !== 7 && (
              <button type="button" className="btn btn-primary" disabled={!canAdvance(s)} onClick={() => dispatch({ type: "next" })}>
                {DICT_COPY.next[lang]}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
