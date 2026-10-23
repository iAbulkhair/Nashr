import type { Lang } from "./i18n";
import { describe, helpHref, HELP_ICONS, helpTopics, helpTopicsIn, serveTopic, type HelpSlug, type HelpTopic, type HelpTopicId } from "./help";
import type { Served } from "./lang-fallback";

/**
 * The one way a help topic is read for display (rule 3318): its title, description, icon and rendered answers in one language,
 * the same shape for the help index and for a topic's page. Before, the index walked `helpTopicsIn` and the topic page walked
 * `helpTopics` and `HELP` with their own language choices; each read the strings its own way, and none had an icon.
 *
 * "Rendered" here is what the help pages have always shown, nothing more: the text of the chosen language with the
 * `{origin}` slot filled with the canonical origin (answers are plain text, printed as text, never as HTML, so there is
 * nothing to escape or to render beyond that). The words are the topic's own: the loader writes no sentence, and the
 * description is `describe` (the topic's title and its own questions), unchanged. Pure and import-light, because the help
 * index is a client component and reads it too.
 */
export type HelpAnswer = { slug: HelpSlug; href: string; question: string; answer: string };
export type HelpEntry = {
  id: HelpTopicId;
  /** The language the text is in. */
  lang: Lang;
  /** The topic's page: `/{lang}/help/{id}`, in the language of the reader's address. */
  href: string;
  title: string;
  description: string;
  /** A name from the app's own icon set (`src/components/app/Icons.tsx`); see `HELP_ICONS`. */
  icon: string;
  answers: HelpAnswer[];
};

/**
 * One topic as an entry. `lang` is the language of the text; `at` the language of the address the reader is on, which the
 * links keep (a fallback page's links stay on the reader's own language, as the page's always did).
 */
export function helpEntry(t: HelpTopic, lang: Lang, at: Lang = lang): HelpEntry {
  return {
    id: t.id,
    lang,
    href: helpHref(at, t.id),
    title: t.title[lang],
    description: describe(lang, t),
    icon: HELP_ICONS[t.id],
    answers: t.items.map((i) => ({ slug: i.slug, href: helpHref(at, t.id, i.slug), question: i.q[lang], answer: i.a[lang] })),
  };
}

/** The help index in `lang`: every topic written in it, in the order of the file (a topic of the other language only is not listed). */
export function loadHelpIndex(origin: string, lang: Lang): HelpEntry[] {
  return helpTopicsIn(origin, lang).map((t) => helpEntry(t, lang));
}

/**
 * The topic at `/{lang}/help/{id}` (rule 3313): in `lang` when it is written in it, else in the language it exists in with
 * `served.fallback` set. `topic` is the origin-filled topic itself, for the structured data that wants every field. `null` for
 * an id no topic has.
 */
export function loadHelpTopic(origin: string, lang: Lang, id: string): { entry: HelpEntry; topic: HelpTopic; served: Served } | null {
  const topic = helpTopics(origin).find((t) => t.id === id);
  const served = topic ? serveTopic(topic, lang) : null;
  return topic && served ? { entry: helpEntry(topic, served.lang, lang), topic, served } : null;
}
