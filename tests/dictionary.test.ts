import { describe, expect, it } from "vitest";
import { INITIAL, reduce, canAdvance, WORDS, SECTORS, samplePlan, sampleDraft, type DictState, type DictAction } from "@/lib/dictionary";
import { isAgentId } from "@/lib/agents";

const run = (...as: DictAction[]) => as.reduce(reduce, INITIAL);
const five = WORDS.slice(0, 5).map((w) => ({ type: "word", value: w.id }) as DictAction);
const atStep = (step: DictState["step"]): DictState => ({ step, brand: "قهوة الصباح", sector: "coffee", words: WORDS.slice(0, 5).map((w) => w.id) });

describe("قاموس ذكين", () => {
  it("will not leave step 1 without a brand and a sector", () => {
    expect(run({ type: "next" }).step).toBe(1);
    expect(run({ type: "brand", value: "   " }, { type: "sector", value: "coffee" }, { type: "next" }).step).toBe(1);
    expect(run({ type: "brand", value: "Qahwa" }, { type: "sector", value: "coffee" }, { type: "next" }).step).toBe(2);
  });
  it("caps the brand at 40 characters and collapses runs of spaces", () => {
    expect(run({ type: "brand", value: "x".repeat(200) }).brand).toHaveLength(40);
    expect(run({ type: "brand", value: "  a    b" }).brand).toBe("a b");
  });
  it("picks at most five words and unpicks on a second tap", () => {
    const s = run(...five, { type: "word", value: WORDS[5].id });
    expect(s.words).toHaveLength(5);
    expect(reduce(s, { type: "word", value: WORDS[0].id }).words).toHaveLength(4);
  });
  it("needs exactly five words to leave step 2", () => {
    expect(canAdvance({ ...atStep(2), words: [] })).toBe(false);
    expect(canAdvance(atStep(2))).toBe(true);
  });
  it("only the approve action leaves step 5", () => {
    expect(reduce(atStep(5), { type: "next" }).step).toBe(5);
    expect(reduce(atStep(5), { type: "approve" }).step).toBe(6);
    expect(reduce(atStep(3), { type: "approve" }).step).toBe(3);
  });
  it("ends at step 7 and never goes below step 1", () => {
    expect(reduce(atStep(7), { type: "next" }).step).toBe(7);
    expect(reduce(INITIAL, { type: "back" }).step).toBe(1);
    expect(reduce(atStep(4), { type: "back" }).step).toBe(3);
  });
  it("writes samples from the brand and the first word, with no digits anywhere", () => {
    for (const sector of SECTORS) for (const w of WORDS) for (const lang of ["ar", "en"] as const) {
      const s: DictState = { step: 4, brand: "Qahwa", sector: sector.id, words: [w.id] };
      const plan = samplePlan(s, lang), draft = sampleDraft(s, lang);
      expect(plan).toHaveLength(3);
      expect(plan[0]).toContain(w.tone[lang]);
      expect(draft.post).toContain("Qahwa");
      expect(draft.whatsapp).toContain("Qahwa");
      expect([...plan, draft.post, draft.whatsapp].join(" ")).not.toMatch(/[0-9٠-٩]/);
    }
  });
  it("has twelve words and five sectors, and only agents react", () => {
    expect(WORDS).toHaveLength(12);
    expect(SECTORS).toHaveLength(5);
    for (const w of WORDS) expect(isAgentId(w.react.who)).toBe(true);
  });
});

describe("قاموس ذكين — controller ruling R1 (brand trims start only, not end)", () => {
  it("keeps a trailing space the user just typed, but whitespace-only still blocks step 1", () => {
    expect(run({ type: "brand", value: "قهوة " }).brand).toBe("قهوة ");
    expect(
      run({ type: "brand", value: "   " }, { type: "sector", value: "coffee" }, { type: "next" }).step,
    ).toBe(1);
  });
});
