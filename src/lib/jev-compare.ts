import type { Brand } from "./brand";
import { AUTOFAIL, type Autofail, type Quality } from "./judge";

/**
 * Agreement between the Sonnet judge and Jev (src/lib/jev.ts) on golden-set items. Pure: `scripts/jev-compare.ts`
 * collects the rows, this decides what they mean. The switch rule is the one agreed on 2026-09-29: Jev may take over
 * scoring only if it agrees with Sonnet on automatic fails and on honesty at least 90% of the time, in every language
 * the set covers, and never lets through an automatic fail Sonnet caught.
 */
export const GATE_RATE = 0.9;
/** Fewer comparisons than this in a language and the gate says nothing for it rather than pass on a handful. */
export const MIN_N = 5;
/** Fewer Sonnet automatic fails than this in total and a zero-miss result proves nothing about recall. */
export const MIN_SONNET_FAILS = 3;

export type Band = "ready" | "edit" | "regenerate";
/** The judge's own bands: 85+ ready, 70-84 light edit, below 70 regenerate. */
export const band = (s: number): Band => (s >= 85 ? "ready" : s >= 70 ? "edit" : "regenerate");

export type Lang = "ar" | "en" | "mixed";
export const brandLang = (b: Brand): Lang => (b.languages.length > 1 ? "mixed" : b.languages[0] ?? "ar");

const NO_VERDICT = /^judge returned no verdict/;
/**
 * Sonnet's automatic fail per item, read from a stored golden run. The run keeps notes in item order, each prefixed
 * `[code]` when an automatic fail was set (judge.ts). Alignment is lost when the judge skipped an item (the first note
 * says so) or the counts differ, and then nothing is guessed: the answer is null for the whole case.
 * Runs before GOLDEN_VERSION 5 had no automatic-fail triggers, so they are unknown too.
 */
export function storedAutofails(notes: string[], items: number, version: number): (Autofail | null)[] | null {
  if (version < 5 || notes.length !== items || notes.some((n) => NO_VERDICT.test(n))) return null;
  return notes.map((n) => {
    const code = /^\[([a-z_]+)\]/.exec(n)?.[1];
    return code && Object.hasOwn(AUTOFAIL, code) ? (code as Autofail) : null;
  });
}

export type Dims = Quality["dims"];
export type ItemRow = {
  runId: string; caseId: string; lang: Lang; index: number;
  /** The stored body was cut at 3000 chars; in stored mode Sonnet had read the whole item and Jev did not. */
  trimmed: boolean;
  jev: Quality | null; jevAutofailConfidence: number | null;
  /** Per-item Sonnet verdict: only with --rejudge. */
  sonnet: Quality | null;
  /** Sonnet's automatic fail: a code, null for none, undefined when unknown. */
  sonnetAutofail: Autofail | null | undefined;
};
export type CaseRow = {
  runId: string; caseId: string; lang: Lang;
  /** Stored mode and an item was trimmed: completeness, format and the overall score are not comparable. */
  partial: boolean;
  sonnet: { score: number; dims: Dims } | null;
  jev: { score: number; dims: Dims } | null;
};

export type Agreement = { n: number; agree: number; rate: number | null };
const agreement = (pairs: [unknown, unknown][]): Agreement => {
  const agree = pairs.filter(([a, b]) => a === b).length;
  return { n: pairs.length, agree, rate: pairs.length ? Math.round((agree / pairs.length) * 1000) / 1000 : null };
};
const mae = (pairs: [number, number][]) => (pairs.length ? Math.round((pairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / pairs.length) * 10) / 10 : null);

const DIMS = ["completeness", "brand", "honesty", "language", "format"] as const;
const PARTIAL_DIMS = new Set<string>(["completeness", "format"]);

export type LangReport = {
  items: number; cases: number;
  autofailFlag: Agreement; autofailExact: Agreement;
  caseBand: Agreement; caseHonestyBand: Agreement; caseMae: Record<string, number | null>;
  itemBand: Agreement | null; itemHonestyBand: Agreement | null; itemMae: Record<string, number | null> | null;
};

function langReport(items: ItemRow[], cases: CaseRow[], rejudge: boolean): LangReport {
  const known = items.filter((r) => r.jev && r.sonnetAutofail !== undefined);
  const both = cases.filter((c) => c.sonnet && c.jev);
  const whole = both.filter((c) => !c.partial);
  const caseMae: Record<string, number | null> = { score: mae(whole.map((c) => [c.sonnet!.score, c.jev!.score])) };
  for (const d of DIMS) caseMae[d] = mae((PARTIAL_DIMS.has(d) ? whole : both).map((c) => [c.sonnet!.dims[d], c.jev!.dims[d]]));
  let itemBand = null, itemHonestyBand = null, itemMae = null;
  if (rejudge) {
    const ib = items.filter((r) => r.jev && r.sonnet);
    itemBand = agreement(ib.map((r) => [band(r.sonnet!.score), band(r.jev!.score)]));
    itemHonestyBand = agreement(ib.map((r) => [band(r.sonnet!.dims.honesty), band(r.jev!.dims.honesty)]));
    itemMae = { score: mae(ib.map((r) => [r.sonnet!.score, r.jev!.score])) } as Record<string, number | null>;
    for (const d of DIMS) itemMae[d] = mae(ib.map((r) => [r.sonnet!.dims[d], r.jev!.dims[d]]));
  }
  return {
    items: items.length, cases: cases.length,
    autofailFlag: agreement(known.map((r) => [!!r.sonnetAutofail, !!r.jev!.autofail])),
    autofailExact: agreement(known.map((r) => [r.sonnetAutofail ?? "none", r.jev!.autofail ?? "none"])),
    caseBand: agreement(whole.map((c) => [band(c.sonnet!.score), band(c.jev!.score)])),
    caseHonestyBand: agreement(both.map((c) => [band(c.sonnet!.dims.honesty), band(c.jev!.dims.honesty)])),
    caseMae, itemBand, itemHonestyBand, itemMae,
  };
}

export type Miss = { runId: string; caseId: string; index: number; sonnet: Autofail | null; jev: Autofail | null; trimmed: boolean };
export type Gate = { name: string; pass: boolean | null; detail: string };
export type Report = {
  mode: "stored" | "rejudge";
  all: LangReport; byLang: Partial<Record<Lang, LangReport>>;
  /** Sonnet set an automatic fail and Jev did not: the costly error, a fabricated fact scored as passable. */
  missed: Miss[];
  /** Jev set an automatic fail Sonnet did not: an item held back that Sonnet would have passed. */
  extra: Miss[];
  gates: Gate[];
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
};

/** A rate gate over every language present: fails if any language fails, says nothing if any is too small. */
function rateGate(name: string, per: [Lang, Agreement | null][]): Gate {
  const parts = per.map(([l, a]) => (a && a.n >= MIN_N && a.rate !== null ? { l, a, pass: a.rate >= GATE_RATE } : { l, a, pass: null }));
  const detail = parts.map(({ l, a }) => `${l} ${a && a.rate !== null ? `${Math.round(a.rate * 100)}% of ${a.n}` : "no data"}${a && a.n < MIN_N ? " (too few)" : ""}`).join(", ");
  const pass = parts.some((p) => p.pass === false) ? false : parts.length && parts.every((p) => p.pass === true) ? true : null;
  return { name, pass, detail };
}

export function compare(items: ItemRow[], cases: CaseRow[], mode: "stored" | "rejudge"): Report {
  const rejudge = mode === "rejudge";
  const langs = [...new Set(items.map((r) => r.lang))].sort() as Lang[];
  const byLang: Partial<Record<Lang, LangReport>> = {};
  for (const l of langs) byLang[l] = langReport(items.filter((r) => r.lang === l), cases.filter((c) => c.lang === l), rejudge);
  const all = langReport(items, cases, rejudge);

  const known = items.filter((r) => r.jev && r.sonnetAutofail !== undefined);
  const row = (r: ItemRow): Miss => ({ runId: r.runId, caseId: r.caseId, index: r.index, sonnet: r.sonnetAutofail ?? null, jev: r.jev!.autofail ?? null, trimmed: r.trimmed });
  const missed = known.filter((r) => r.sonnetAutofail && !r.jev!.autofail).map(row);
  const extra = known.filter((r) => !r.sonnetAutofail && r.jev!.autofail).map(row);

  // In stored mode Sonnet read past the 3000-char cut, so a miss on a trimmed item may be text Jev never saw.
  const countable = missed.filter((m) => rejudge || !m.trimmed);
  const sonnetFails = known.filter((r) => r.sonnetAutofail && (rejudge || !r.trimmed)).length;
  const gates: Gate[] = [
    rateGate(`automatic-fail agreement ≥ ${GATE_RATE * 100}%`, langs.map((l) => [l, byLang[l]!.autofailFlag])),
    rateGate(`honesty band agreement ≥ ${GATE_RATE * 100}% (${rejudge ? "per item" : "per case"})`, langs.map((l) => [l, rejudge ? byLang[l]!.itemHonestyBand : byLang[l]!.caseHonestyBand])),
    {
      name: "no automatic fail missed",
      pass: countable.length ? false : sonnetFails >= MIN_SONNET_FAILS ? true : null,
      detail: `${countable.length} missed of ${sonnetFails} Sonnet automatic fails${sonnetFails < MIN_SONNET_FAILS ? ` (fewer than ${MIN_SONNET_FAILS}: recall not measurable)` : ""}${missed.length > countable.length ? `; ${missed.length - countable.length} more on trimmed items, not counted` : ""}`,
    },
  ];
  const verdict = gates.some((g) => g.pass === false) ? "FAIL" : gates.every((g) => g.pass === true) ? "PASS" : "INCONCLUSIVE";
  return { mode, all, byLang, missed, extra, gates, verdict };
}
