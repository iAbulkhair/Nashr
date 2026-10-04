import { describe, expect, it } from "vitest";
import { INITIAL, reduce, WORDS, answersOf, answersToBrand, noSiteBrand, parseAnswers, type DictAction, type GameAnswers } from "@/lib/dictionary";

/**
 * قاموس ذكين as the first-login onboarding (docs/superpowers/specs/2026-10-04-dictionary-onboarding-design.md): what the
 * owner answers in the game becomes their brand file. Rules 520 (the mapping) and 521 (the validation the confirm route
 * and the build rely on).
 */
const okAr: GameAnswers = { brand: "قهوة الصباح", sector: "coffee", words: ["bold", "warm", "refined", "popular", "calm"], lang: "ar" };
const okEn: GameAnswers = { ...okAr, lang: "en" };

describe("rule 520: the game's answers become the brand file", () => {
  it("answers map to name, industry and tone in the language played", () => {
    expect(answersToBrand(okAr)).toEqual({ name: "قهوة الصباح", industry: "قهوة", tone: "جريئة، دافية، راقية، شعبية، هادية" });
    expect(answersToBrand(okEn)).toEqual({ name: "قهوة الصباح", industry: "Coffee", tone: "bold, warm, refined, down-to-earth, calm" });
  });
  it("a name is stored as typed text, trimmed and capped", () => {
    const odd = parseAnswers({ ...okAr, brand: "  <b>$&</b>  " });
    expect(odd!.brand).toBe("<b>$&</b>");
    expect(answersToBrand(odd!).name).toBe("<b>$&</b>");
    expect(parseAnswers({ ...okAr, brand: "x".repeat(40) })!.brand).toHaveLength(40);
    expect(parseAnswers({ ...okAr, brand: ` ${"x".repeat(41)} ` })).toBeNull();
  });
  it("the no-site body carries products, audience, dialect and language", () => {
    expect(noSiteBrand(okEn, " beans ", " offices ")).toEqual({ name: "قهوة الصباح", industry: "Coffee", tone: "bold, warm, refined, down-to-earth, calm", products: "beans", audience: "offices", dialect: "english", languages: ["en"] });
    const ar = noSiteBrand(okAr, "بن مختص", "موظفين");
    expect(ar.dialect).toBe("saudi");
    expect(ar.languages).toEqual(["ar"]);
  });
});

describe("rule 521: only a finished, well-formed game is accepted", () => {
  it("validation refuses a bad sector, word list, name or language", () => {
    const bad: unknown[] = [
      { ...okAr, sector: "bank" },
      { ...okAr, words: okAr.words.slice(0, 4) },
      { ...okAr, words: [...okAr.words, "fun"] },
      { ...okAr, words: ["bold", "bold", "warm", "refined", "calm"] },
      { ...okAr, words: ["bold", "warm", "refined", "calm", "evil"] },
      { ...okAr, words: "bold" },
      { ...okAr, brand: "   " },
      { ...okAr, brand: 7 },
      { ...okAr, lang: "fr" },
      null,
      "قهوة",
      [],
    ];
    for (const raw of bad) expect(parseAnswers(raw), JSON.stringify(raw)).toBeNull();
    expect(parseAnswers(okAr)).toEqual(okAr);
  });
  it("answersOf reads the reducer state", () => {
    const words = WORDS.slice(0, 5).map((w) => ({ type: "word", value: w.id }) as DictAction);
    const played = [{ type: "brand", value: "Qahwa " } as DictAction, { type: "sector", value: "store" } as DictAction, { type: "next" } as DictAction, ...words].reduce(reduce, INITIAL);
    expect(answersOf(played, "en")).toEqual({ brand: "Qahwa", sector: "store", words: WORDS.slice(0, 5).map((w) => w.id), lang: "en" });
    expect(answersOf(INITIAL, "ar")).toBeNull();
  });
});
