import { afterEach, describe, expect, it, vi } from "vitest";
import { GOLDEN_BRANDS } from "@/lib/golden";
import { AUTOFAIL, AUTOFAIL_CAP, AUTOFAIL_HONESTY } from "@/lib/judge";
import { JEV_MODEL, JEV_URL, LEVELS, jevRequest, jevScoreItems, levelToScore, toQuality } from "@/lib/jev";
import { band, compare, storedAutofails, type CaseRow, type ItemRow } from "@/lib/jev-compare";

const brand = GOLDEN_BRANDS.roastery;
const item = { channel: "instagram", title: "t", body: "محمّص طازج من المحمصة لبابك" };
const KEY = "ts-test-key-not-real";

/** A full, well-formed Jev answer set: every dimension at `level`, the automatic-fail choice `af`. */
const answers = (level: number, af = "none") => ({
  ...Object.fromEntries(Object.keys(LEVELS).map((d) => [d, { type: "score", score: level, confidence: 0.9 }])),
  autofail: { type: "choice", choice: af, probabilities: {}, confidence: 0.8 },
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllEnvs());

describe("Jev judge adapter", () => {
  it("places levels inside the judge's own bands", () => {
    expect(levelToScore(0)).toBe(20);
    expect(levelToScore(4)).toBe(92);
    expect(band(levelToScore(2))).toBe("regenerate");
    expect(band(levelToScore(3))).toBe("edit");
    expect(band(levelToScore(4))).toBe("ready");
    expect(levelToScore(2.5)).toBe(72); // between 65 and 78
    expect(levelToScore(-1)).toBe(20);
    expect(levelToScore(9)).toBe(92);
  });

  it("asks five Score questions and one automatic-fail Choice, with the item as data in the state", () => {
    const req = jevRequest(brand, "social", item, 3, 3, { notes: "لا تذكري أي سعر." });
    expect(req.model).toBe(JEV_MODEL);
    expect(Object.keys(req.questions).sort()).toEqual(["autofail", "brand", "completeness", "format", "honesty", "language"]);
    for (const d of Object.keys(LEVELS)) expect(req.questions[d]).toMatchObject({ type: "score", criteria: LEVELS[d as keyof typeof LEVELS] });
    expect((req.questions.autofail as { criteria: Record<string, string> }).criteria).toEqual({ none: expect.any(String), ...AUTOFAIL });
    expect(req.state.item.body).toBe(item.body);
    expect(req.state.brand_file.name).toBe(brand.name);
    expect(req.state.owner_notes).toBe("لا تذكري أي سعر.");
    // Owner asked for 3 of a larger batch: the override is stated, and a shortfall is named when fewer came back.
    expect(req.state.request).toMatch(/exactly 3/);
    expect(jevRequest(brand, "social", item, 3, 2, {}).state.request).toMatch(/only 2 were delivered/);
  });

  it("applies the judge's weights and automatic-fail caps in code", () => {
    const clean = toQuality(answers(4), "jev").quality!;
    expect(clean.score).toBe(92);
    expect(clean.autofail).toBeUndefined();
    const failed = toQuality(answers(4, "invented_fact"), "jev").quality!;
    expect(failed.autofail).toBe("invented_fact");
    expect(failed.dims.honesty).toBe(AUTOFAIL_HONESTY);
    expect(failed.score).toBeLessThanOrEqual(AUTOFAIL_CAP);
    expect(failed.notes).toBe("[invented_fact]");
  });

  it("leaves an item unjudged, never 0, when an answer is missing, malformed or an unknown code", () => {
    const noHonesty: Record<string, unknown> = answers(3);
    delete noHonesty.honesty;
    expect(toQuality(noHonesty as ReturnType<typeof answers>, "jev").quality).toBeNull();
    expect(toQuality({ ...answers(3), brand: { type: "score", score: "high" } }, "jev").quality).toBeNull();
    expect(toQuality(answers(3, "made_up_code"), "jev").quality).toBeNull();
    expect(toQuality(undefined, "jev").quality).toBeNull();
  });

  it("posts to the fixed TypeSafe endpoint with the bearer key and retries 429", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", KEY);
    const f = vi.fn().mockResolvedValueOnce(reply({}, 429)).mockResolvedValueOnce(reply({ model: "jev-1", answers: answers(3), usage: { input_tokens: 900, output_tokens: 6 } }));
    const [v] = await jevScoreItems(brand, "social", [item], 1, {}, { fetch: f as unknown as typeof fetch, backoffMs: 0 });
    expect(f).toHaveBeenCalledTimes(2);
    const [url, init] = f.mock.calls[1];
    expect(url).toBe(JEV_URL);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body).state.item.body).toBe(item.body);
    expect(v.quality?.model).toBe("jev-1");
    expect(v.usage.input_tokens).toBe(900);
  });

  it("refuses without a key before any request, and never puts the key in an error", async () => {
    const f = vi.fn();
    vi.stubEnv("TYPESAFE_API_KEY", "");
    await expect(jevScoreItems(brand, "social", [item], 1, {}, { fetch: f as unknown as typeof fetch })).rejects.toThrow("no_typesafe_key");
    expect(f).not.toHaveBeenCalled();
    vi.stubEnv("TYPESAFE_API_KEY", KEY);
    const err = await jevScoreItems(brand, "social", [item], 1, {}, { fetch: vi.fn().mockResolvedValue(reply({ error: "bad key" }, 401)) as unknown as typeof fetch }).catch((e: Error) => e);
    expect(String(err)).toContain("jev_http_401");
    expect(String(err)).not.toContain(KEY);
  });
});

describe("Jev vs Sonnet comparison", () => {
  it("reads Sonnet's automatic fails from stored notes only when they line up with the items", () => {
    expect(storedAutofails(["[fake_proof] quote", "ready"], 2, 5)).toEqual(["fake_proof", null]);
    expect(storedAutofails(["[not_a_code] x", "ready"], 2, 5)).toEqual([null, null]);
    expect(storedAutofails(["judge returned no verdict for 1 of 2 item(s)", "ready"], 2, 5)).toBeNull();
    expect(storedAutofails(["ready"], 2, 5)).toBeNull();
    expect(storedAutofails(["ready", "ready"], 2, 4)).toBeNull(); // no triggers before v5
  });

  const q = (score: number, honesty: number, autofail?: "invented_fact") => ({ score, dims: { completeness: score, brand: score, honesty, language: score, format: score }, notes: "", model: "m", at: "", ...(autofail ? { autofail } : {}) });
  const itemRow = (i: number, lang: "ar" | "en", sonnetAf: "invented_fact" | null, jevAf?: "invented_fact", trimmed = false): ItemRow => ({
    runId: "r", caseId: `c${i}`, lang, index: 0, trimmed, jev: q(88, 90, jevAf), jevAutofailConfidence: 0.9, sonnet: null, sonnetAutofail: sonnetAf,
  });
  const caseRow = (i: number, lang: "ar" | "en", sonnetHonesty: number, partial = false): CaseRow => ({
    runId: "r", caseId: `c${i}`, lang, partial, sonnet: { score: 88, dims: q(88, sonnetHonesty).dims }, jev: { score: 88, dims: q(88, 90).dims },
  });

  it("fails when Jev passes an automatic fail Sonnet caught, and does not count one on a trimmed stored item", () => {
    const items = [...Array.from({ length: 6 }, (_, i) => itemRow(i, "ar", null)), itemRow(6, "ar", "invented_fact"), itemRow(7, "ar", "invented_fact", undefined, true)];
    const r = compare(items, [], "stored");
    expect(r.missed.map((m) => m.caseId)).toEqual(["c6", "c7"]);
    const gate = r.gates.find((g) => g.name === "no automatic fail missed")!;
    expect(gate.pass).toBe(false);
    expect(gate.detail).toMatch(/1 missed of 1.*1 more on trimmed items/);
    expect(r.verdict).toBe("FAIL");
  });

  it("is inconclusive, not a pass, when a language has too few comparisons or Sonnet caught too few fails", () => {
    const items = [...Array.from({ length: 6 }, (_, i) => itemRow(i, "ar", null)), itemRow(10, "en", null)];
    const cases = [...Array.from({ length: 6 }, (_, i) => caseRow(i, "ar", 90)), caseRow(10, "en", 90)];
    const r = compare(items, cases, "stored");
    expect(r.gates[0].pass).toBeNull(); // en has 1 item
    expect(r.gates[2].pass).toBeNull(); // no Sonnet fails to measure recall on
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("measures honesty per case in stored mode and keeps trimmed cases out of the overall score", () => {
    const cases = [...Array.from({ length: 5 }, (_, i) => caseRow(i, "ar", 90)), caseRow(5, "ar", 40, true)];
    const r = compare(Array.from({ length: 6 }, (_, i) => itemRow(i, "ar", null)), cases, "stored");
    expect(r.all.caseHonestyBand).toEqual({ n: 6, agree: 5, rate: 0.833 });
    expect(r.all.caseBand.n).toBe(5);
    expect(r.gates[1].pass).toBe(false);
  });
});
