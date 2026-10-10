import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appDict } from "@/lib/app-i18n";
import { MODELS, pickerView } from "@/lib/models/catalog";
import {
  NOTE_MS,
  chosenId,
  formatMultiplier,
  needsChinaConfirm,
  nextBrandPick,
  nextMadePicks,
  pickBodies,
  pickChanges,
  pickRefusal,
  pickedChat,
  pickerLocked,
  pickerOptions,
  readModelsView,
  sendPick,
  storedPick,
  unitsText,
  type MadePicks,
  type ModelsView,
  type PickBody,
  type PickedChat,
  type PickerRowView,
} from "@/lib/model-picker";
import type { ChatStatus } from "@/lib/chat-allowance";
import { ModelOptionList } from "@/components/app/ModelPicker";

/**
 * The model picker (spec 2026-10-08-straitly-model-routing, plan Task 7): the chat header's per-conversation pick and the
 * brand page's "Default model for content". Everything it shows comes from GET /api/models (labels, tiers, hosting, the
 * multipliers per surface and the chat units): the client holds no rate and no multiplier of its own. Automatic is
 * always first and sends `model: null`; a China-hosted entry is labelled and asks the owner once before the first pick.
 */

const WEST: PickerRowView = { id: "w-std", label: { ar: "نموذج غربي", en: "West model" }, tier: "standard", hosting: "west", tools: true };
const CHINA: PickerRowView = { id: "cn-eco", label: { ar: "نموذج صيني", en: "China model" }, tier: "economy", hosting: "china", tools: true };
const NO_TOOLS: PickerRowView = { id: "w-notools", label: { ar: "نموذج بلا أدوات", en: "No tools model" }, tier: "premium", hosting: "west", tools: false };

/** A GET /api/models answer with numbers no tier table holds, so a hard-coded multiplier cannot pass. */
const view = (over: Partial<ModelsView> = {}): ModelsView => ({
  models: [WEST, CHINA, NO_TOOLS],
  multipliers: { chat: { "w-std": 1.25, "cn-eco": 0.35, "w-notools": 3.5 }, generate: { "w-std": 0.45, "cn-eco": 0.2, "w-notools": 1.75 } },
  chatUnits: { "w-std": 2, "cn-eco": 1, "w-notools": 4 },
  chinaConfirmed: false,
  ...over,
});

const M = { ar: appDict.ar.models, en: appDict.en.models };

/** Every leaf path of a nested object of strings, e.g. "units.two". */
const leaves = (o: unknown, at = ""): [string, string][] =>
  typeof o === "string" ? [[at, o]] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k));

describe("the picker's copy (app dictionary, both languages)", () => {
  it("every new dictionary key exists in ar and en, with the same placeholders, and none is empty", () => {
    const ar = new Map(leaves(M.ar));
    const en = new Map(leaves(M.en));
    expect([...ar.keys()].sort()).toEqual([...en.keys()].sort());
    expect(ar.size).toBeGreaterThan(15);
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [k, a] of ar) {
      const e = en.get(k)!;
      expect(a.trim(), `ar ${k}`).not.toBe("");
      expect(e.trim(), `en ${k}`).not.toBe("");
      expect(a, `ar ${k} is Arabic`).toMatch(/[؀-ۿ]/);
      // The Arabic dual form names "two" in words; every other string carries the same placeholders in both languages.
      if (k !== "units.two") expect(holes(a), k).toEqual(holes(e));
    }
  });

  it("names the product Thakeen (ذكين), never the code name, and types no number of its own (ruling 6 and 8)", () => {
    const all = [...leaves(M.ar), ...leaves(M.en)].map(([, s]) => s);
    for (const s of all) {
      expect(s).not.toMatch(/Nashr|nashr/);
      // The only numbers the picker shows are the server's multipliers and chat units, filled into {x} and {n}.
      expect(s, s).not.toMatch(/[0-9٠-٩]/);
      expect(s, s).not.toMatch(/SAR|ريال|\$/);
    }
    expect(M.en.autoHint).toContain("Thakeen");
    expect(M.ar.autoHint).toContain("ذكين");
    expect(M.en.auto).toBe("Automatic (recommended)");
    expect(M.ar.auto).toBe("تلقائي (موصى به)");
    expect(M.en.china).toBe("Hosted in China");
    expect(M.ar.china).toBe("مستضاف في الصين");
    expect(M.en.brandTitle).toBe("Default model for content");
  });

  it("the brand multiplier reads as a multiplier, never as a price: '{x} per batch', no credit count (review I-1)", () => {
    expect(M.en.perBatch).toBe("{x} per batch");
    expect(M.ar.perBatch).toBe("{x} لكل دفعة");
    expect(M.en.perMessage).toBe("{x} per message");
    for (const s of [M.en.perBatch, M.ar.perBatch, M.en.perMessage, M.ar.perMessage]) expect(s).not.toMatch(/credit|كريدت/i);
  });

  it("the Arabic refusals read unambiguously without vowel marks, and the brand note reads naturally (review minor 1 and 2)", () => {
    expect(M.ar.unavailable).toBe("هذا النموذج غير متاح الآن. أعدنا تحميل القائمة، اختر نموذجاً آخر.");
    expect(M.ar.notFound).toBe("لم نجد هذه المحادثة. أعدنا تحميل قائمة المحادثات.");
    expect(M.ar.brandSub).toBe("تعمل عليه كل دفعة محتوى لهذه العلامة. وإن كان نوع الدفعة مما لا يكتبه هذا النموذج، تعمل على الاختيار التلقائي.");
    for (const [k, s] of leaves(M.ar)) expect(s, k).not.toContain("حدّثنا");
  });
});

/**
 * Words and ids that name a MODEL (ruling 6: no model name in public copy). Case-sensitive: `CLAUDE_PAUSED` is an
 * identifier, not copy. A model maker is not a model name; see MAKERS below for the one place a maker is named.
 */
const NAMES = new RegExp(
  [
    "\\b(Claude|Opus|Sonnet|Haiku|DeepSeek|Qwen|Kimi|GLM)\\b",
    "كلود|أوبس|سونيت|هايكو",
    ...MODELS.flatMap((m) => [m.id, m.label.en, m.label.ar]).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  ].join("|"),
);
const MAKERS = /\bAnthropic\b|أنثروبيك/;
/**
 * The one allowed maker mention: the privacy policy's list of AI providers that process the customer's content
 * (`src/lib/legal.ts`, shown on the privacy and terms pages and in `llms.txt`). A sub-processor disclosure is owed to
 * the customer, so it names the text provider; it names no model. Allowed is the phrase, once per line, in that file:
 * it is taken out of the line and the rest is scanned like any other line.
 */
const MAKER_ALLOWED = [{ file: "src/lib/legal.ts", phrase: /Anthropic للنصوص|Anthropic for text/ }];
/** Does line `l` of file `f` name a maker outside the allowed disclosure? */
const makerHit = (f: string, l: string) => MAKERS.test(MAKER_ALLOWED.filter((a) => a.file === f).reduce((rest, a) => rest.replace(a.phrase, ""), l));
const walk = (p: string): string[] =>
  statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : /\.(ts|tsx|md|mdx|txt)$/.test(p) ? [p] : [];
/** Comments removed with their line breaks kept, so a hit still reports its own line. A `//` after `:` (a URL) stays. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")).replace(/(?<![:"'\w])\/\/.*$/gm, "");

/** The public copy: the pages outside the signed-in app, `llms.txt`, `/p`, the site components, copy modules and the blog. */
const PUBLIC = () => [
  ...walk("src/app/[lang]").filter((f) => !f.startsWith(join("src/app/[lang]", "app") + "/")),
  ...walk("src/app/llms.txt"),
  ...walk("src/app/p"),
  ...readdirSync("src/components").filter((f) => f.endsWith(".tsx")).map((f) => join("src/components", f)),
  ...walk("src/components/home"),
  ...["i18n", "home", "site", "help", "pages-vs", "pages-industry", "changelog", "dictionary", "legal"].map((f) => `src/lib/${f}.ts`),
  ...walk("content/blog"),
];
/** Copy modules whose comments are notes for developers (they name models there), scanned with the comments removed. */
const PUBLIC_CODE = ["src/lib/tools.ts", "src/lib/pricing.ts"];
const linesOf = (f: string) => (PUBLIC_CODE.includes(f) ? stripComments(readFileSync(f, "utf8")) : readFileSync(f, "utf8")).split("\n");

describe("no public marketing page mentions a model name", () => {
  it("the pages outside the signed-in app, the site copy modules (privacy, free tools and pricing included) and the blog name no model", () => {
    const files = [...PUBLIC(), ...PUBLIC_CODE];
    expect(files.length).toBeGreaterThan(40);
    const hits = files.flatMap((f) => linesOf(f).flatMap((l, i) => (NAMES.test(l) ? [`${f}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
    // The comments removed from the two code modules do name models: the scan above would catch them if they reached copy.
    expect(PUBLIC_CODE.some((f) => NAMES.test(readFileSync(f, "utf8")))).toBe(true);
    expect(stripComments("a // Claude\nb /* Opus\n */ c 'https://x.example/Kimi'")).toBe("a \nb \n c 'https://x.example/Kimi'");
  });

  it("a model maker is named only in the privacy policy's AI-provider disclosure, which is allow-listed by file and line", () => {
    const files = [...PUBLIC(), ...PUBLIC_CODE];
    const hits = files.flatMap((f) => linesOf(f).flatMap((l, i) => (makerHit(f, l) ? [`${f}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
    // The allowance is the disclosure phrase, not its whole line: legal.ts keeps a page's paragraphs on one line, so
    // another maker mention next to the disclosure is still a hit; the phrase anywhere else is too.
    expect(makerHit("src/lib/legal.ts", "We use AI providers (Anthropic for text; fal.ai for images).")).toBe(false);
    expect(makerHit("src/lib/legal.ts", "مزودي الذكاء الاصطناعي (Anthropic للنصوص، وfal.ai للصور).")).toBe(false);
    expect(makerHit("src/lib/legal.ts", "We use AI providers (Anthropic for text). Our agents run on Anthropic models.")).toBe(true);
    expect(makerHit("src/lib/legal.ts", "(Anthropic للنصوص) ونستخدم نماذج أنثروبيك")).toBe(true);
    expect(makerHit("src/lib/home.ts", "We use AI providers (Anthropic for text).")).toBe(true);
    // The disclosure is there (in both languages), so the allow-list is not hiding a line that moved away.
    const legal = readFileSync("src/lib/legal.ts", "utf8");
    expect(legal).toMatch(/Anthropic للنصوص/);
    expect(legal).toMatch(/Anthropic for text/);
  });

  it("the picker's own copy names no model either: names reach the signed-in picker only from the server's labels", () => {
    for (const [k, s] of [...leaves(M.ar), ...leaves(M.en)]) {
      expect(s, k).not.toMatch(NAMES);
      expect(s, k).not.toMatch(MAKERS);
    }
    for (const f of ["src/lib/model-picker.ts", "src/components/app/ModelPicker.tsx"]) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, f).not.toMatch(NAMES);
      expect(code, f).not.toMatch(MAKERS);
    }
  });
});

describe("the picker lists Automatic first and labels china entries", () => {
  it("Automatic is the first option in both surfaces, with no tier and no multiplier, and stands for null", () => {
    for (const surface of ["chat", "generate"] as const) {
      const opts = pickerOptions(view(), surface, "en", M.en.auto);
      expect(opts[0]).toEqual({ id: null, label: "Automatic (recommended)", tier: null, china: false, multiplier: null, units: null });
      expect(opts.slice(1).every((o) => o.id !== null)).toBe(true);
    }
  });

  it("a China-hosted entry carries the label in English and in Arabic; a west one does not", () => {
    const en = renderToStaticMarkup(createElement(ModelOptionList, { t: appDict.en, lang: "en", surface: "chat", options: pickerOptions(view(), "chat", "en", M.en.auto), selected: null, onPick: () => {} }));
    const ar = renderToStaticMarkup(createElement(ModelOptionList, { t: appDict.ar, lang: "ar", surface: "chat", options: pickerOptions(view(), "chat", "ar", M.ar.auto), selected: null, onPick: () => {} }));
    expect(en.indexOf("Automatic (recommended)")).toBeGreaterThan(-1);
    expect(en.indexOf("Automatic (recommended)")).toBeLessThan(en.indexOf("West model"));
    expect(en.split("Hosted in China").length - 1).toBe(1);
    expect(en.indexOf("Hosted in China")).toBeGreaterThan(en.indexOf("China model"));
    expect(ar.split("مستضاف في الصين").length - 1).toBe(1);
    expect(ar.indexOf("تلقائي (موصى به)")).toBeLessThan(ar.indexOf("نموذج غربي"));
    // The chosen entry is marked for assistive technology, and only that one: a plain list of buttons, the chosen one
    // `aria-current` (review minor 5: no listbox or option role around a button, which assistive technology reports as
    // a nested interactive control).
    const sel = renderToStaticMarkup(createElement(ModelOptionList, { t: appDict.en, lang: "en", surface: "chat", options: pickerOptions(view(), "chat", "en", M.en.auto), selected: "w-std", onPick: () => {} }));
    expect(sel.split('aria-current="true"').length - 1).toBe(1);
    expect(sel).toMatch(/<button[^>]*aria-current="true"[^>]*>(?:(?!<\/li>).)*West model/);
    expect(sel).not.toMatch(/role="(?:listbox|option)"|aria-selected/);
    expect((sel.match(/<button\b/g) ?? []).length).toBe(3);
  });

  it("the trigger is a disclosure: aria-controls names the popover only while it is shown, whatever it holds, and Escape gives focus back to the trigger (review minor 5)", () => {
    const src = readFileSync("src/components/app/ModelPicker.tsx", "utf8");
    expect(src).not.toMatch(/role="(?:listbox|option)"|aria-selected|aria-haspopup/);
    // The id it points at is on the popover itself, which wraps the list, the default-thread hint and the load failure alike.
    expect(src).toMatch(/aria-controls=\{open \? popId : undefined\}/);
    expect(src).toMatch(/<div id=\{popId\}/);
    expect(src).toMatch(/e\.key === "Escape"\) \{ setOpen\(false\); trigger\.current\?\.focus\(\); \}/);
    expect(src).toMatch(/<button ref=\{trigger\}/);
  });
});

describe("ruling 1: multipliers come from the server, per surface and per model id", () => {
  it("formats x0.6, x1, x2 and trims trailing zeros", () => {
    expect(formatMultiplier(0.6)).toBe("x0.6");
    expect(formatMultiplier(1)).toBe("x1");
    expect(formatMultiplier(2)).toBe("x2");
    expect(formatMultiplier(0.5)).toBe("x0.5");
    expect(formatMultiplier(1.25)).toBe("x1.25");
    expect(formatMultiplier(0.1 + 0.2)).toBe("x0.3");
    expect(formatMultiplier(0.6 / 2)).toBe("x0.3");
  });

  it("the chat list shows the chat multiplier and the chat units; the brand list shows the generation multiplier and no units", () => {
    const chat = pickerOptions(view(), "chat", "en", M.en.auto);
    const gen = pickerOptions(view(), "generate", "en", M.en.auto);
    expect(chat.find((o) => o.id === "w-std")).toMatchObject({ multiplier: "x1.25", units: 2, tier: "standard" });
    expect(chat.find((o) => o.id === "cn-eco")).toMatchObject({ multiplier: "x0.35", units: 1, china: true });
    expect(gen.find((o) => o.id === "w-std")).toMatchObject({ multiplier: "x0.45", units: null });
    expect(gen.find((o) => o.id === "w-notools")).toMatchObject({ multiplier: "x1.75", units: null, tier: "premium" });
  });

  it("an entry the server sent no multiplier for is left out rather than shown with a guessed one", () => {
    const v = view({ multipliers: { chat: { "w-std": 1.25 }, generate: { "w-std": 0.45, "cn-eco": Number.NaN } } });
    expect(pickerOptions(v, "chat", "en", M.en.auto).map((o) => o.id)).toEqual([null, "w-std"]);
    expect(pickerOptions(v, "generate", "en", M.en.auto).map((o) => o.id)).toEqual([null, "w-std"]);
  });

  it("with generateByTask (rule 902) the brand list shows the range over the types the model may run; chat is unchanged", () => {
    const v = view({ generateByTask: { article: { "w-std": 1, "cn-eco": 0.35 }, social: { "w-std": 0.45, "cn-eco": 0.35 }, ads: { "w-std": 0.45, "cn-eco": Number.NaN } } });
    const gen = pickerOptions(v, "generate", "en", M.en.auto);
    expect(gen.find((o) => o.id === "w-std")!.multiplier).toBe("x0.45–1");
    expect(gen.find((o) => o.id === "cn-eco")!.multiplier).toBe("x0.35");
    // A model with no type it may run is left out, as one with no multiplier is.
    expect(gen.map((o) => o.id)).toEqual([null, "w-std", "cn-eco"]);
    expect(pickerOptions(v, "chat", "en", M.en.auto).find((o) => o.id === "w-std")!.multiplier).toBe("x1.25");
    // An older server's answer has no generateByTask: the single multipliers.generate, as before.
    expect(pickerOptions(view(), "generate", "en", M.en.auto).find((o) => o.id === "w-std")!.multiplier).toBe("x0.45");
    // A generateByTask that is not a map of number maps is a bad answer.
    for (const bad of [[], "x", { article: "x" }, { article: { "w-std": "1" } }]) expect(readModelsView({ ...view(), generateByTask: bad }), JSON.stringify(bad)).toBeNull();
    expect(readModelsView(v)).toEqual(v);
  });

  it("chat units read 'counts as N messages' only above 1, in both languages, with the Arabic dual and plural forms", () => {
    expect(unitsText(1, "en", M.en.units)).toBeNull();
    expect(unitsText(null, "en", M.en.units)).toBeNull();
    expect(unitsText(2, "en", M.en.units)).toBe(M.en.units.few.replace("{n}", "2"));
    expect(unitsText(2, "en", M.en.units)).toMatch(/counts as 2 messages/);
    expect(unitsText(2, "ar", M.ar.units)).toBe(M.ar.units.two);
    expect(unitsText(4, "ar", M.ar.units)).toBe(M.ar.units.few.replace("{n}", "4"));
    expect(unitsText(11, "ar", M.ar.units)).toBe(M.ar.units.many.replace("{n}", "11"));
    const html = renderToStaticMarkup(createElement(ModelOptionList, { t: appDict.en, lang: "en", surface: "chat", options: pickerOptions(view(), "chat", "en", M.en.auto), selected: null, onPick: () => {} }));
    expect(html).toContain("x1.25");
    expect(html).toContain("counts as 2 messages");
    expect(html).not.toContain("counts as 1 message");
  });

  it("the brand list words the multiplier per batch, never as a number of credits", () => {
    const html = renderToStaticMarkup(createElement(ModelOptionList, { t: appDict.en, lang: "en", surface: "generate", options: pickerOptions(view(), "generate", "en", M.en.auto), selected: null, onPick: () => {} }));
    // The multiplier sits in its own left-to-right span inside the sentence: compare the text without the markup.
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("x0.45 per batch");
    expect(text).not.toMatch(/credits? per batch/);
    expect(html).not.toContain("x1.25");
    const ar = renderToStaticMarkup(createElement(ModelOptionList, { t: appDict.ar, lang: "ar", surface: "generate", options: pickerOptions(view(), "generate", "ar", M.ar.auto), selected: null, onPick: () => {} })).replace(/<[^>]+>/g, "");
    expect(ar).toContain("x0.45 لكل دفعة");
    expect(ar).not.toContain("كريدت");
  });

  it("neither the picker module nor the component holds a multiplier, a tier table or a rate", () => {
    for (const f of ["src/lib/model-picker.ts", "src/components/app/ModelPicker.tsx"]) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      // A decimal literal outside a class name (Tailwind's "mt-0.5" is spacing, not a multiplier).
      expect(code, f).not.toMatch(/TIER_MULTIPLIER|PRICED_AT|\brate\b|costUsd|(?<![\w.-])\d*\.\d+(?![\w.])/);
    }
    // The module reads only types from the tier file (the browser may import it); nothing else.
    const imports = readFileSync("src/lib/model-picker.ts", "utf8").split("\n").filter((l) => /^\s*import\s/.test(l));
    expect(imports).toEqual([`import type { Surface, Tier } from "./models/tiers";`]);
  });
});

describe("ruling 2: rows carry `tools`, and the chat picker shows only models that can run chat's tools", () => {
  it("pickerView rows fit the client's row type, tools included", () => {
    const rows: PickerRowView[] = pickerView();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(typeof r.tools, r.id).toBe("boolean");
  });

  it("the chat list hides an entry without tools; the brand list keeps it", () => {
    expect(pickerOptions(view(), "chat", "en", M.en.auto).map((o) => o.id)).toEqual([null, "w-std", "cn-eco"]);
    expect(pickerOptions(view(), "generate", "en", M.en.auto).map((o) => o.id)).toEqual([null, "w-std", "cn-eco", "w-notools"]);
  });

  it("an answer that is not the GET /api/models shape is refused rather than half shown", () => {
    expect(readModelsView(view())).toEqual(view());
    expect(readModelsView(null)).toBeNull();
    expect(readModelsView({ ok: false })).toBeNull();
    expect(readModelsView({ ...view(), models: [{ id: "x" }] })).toBeNull();
    expect(readModelsView({ ...view(), multipliers: { chat: {} } })).toBeNull();
  });
});

describe("ruling 3: Automatic is the default, sends null, and the stored value selects the entry", () => {
  const opts = pickerOptions(view(), "chat", "en", M.en.auto);
  it("nothing stored, a stored id the list no longer offers, or anything else selects Automatic", () => {
    expect(chosenId(undefined, opts)).toBeNull();
    expect(chosenId(null, opts)).toBeNull();
    expect(chosenId("gone-model", opts)).toBeNull();
    expect(chosenId("w-notools", opts)).toBeNull();
    expect(chosenId({ id: "w-std" }, opts)).toBeNull();
    expect(chosenId("w-std", opts)).toBe("w-std");
  });

  it("picking Automatic sends model null for the conversation, and for the brand without an id", () => {
    expect(pickBodies("conversation", "abc123", null, false)).toEqual([{ target: "conversation", id: "abc123", model: null }]);
    expect(pickBodies("brand", undefined, null, false)).toEqual([{ target: "brand", model: null }]);
    expect(pickBodies("brand", undefined, "w-std", false)).toEqual([{ target: "brand", model: "w-std" }]);
  });
});

describe("ruling 4: a China-hosted pick asks the owner once, then sends the confirmation before the pick", () => {
  const opts = pickerOptions(view(), "chat", "en", M.en.auto);
  const cn = opts.find((o) => o.id === "cn-eco")!;
  const west = opts.find((o) => o.id === "w-std")!;

  it("asks only for a China entry and only until the owner confirmed", () => {
    expect(needsChinaConfirm(cn, false)).toBe(true);
    expect(needsChinaConfirm(cn, true)).toBe(false);
    expect(needsChinaConfirm(west, false)).toBe(false);
    expect(needsChinaConfirm(opts[0], false)).toBe(false);
  });

  it("sends {confirmChina:true} alone first, then the pick, in that order", async () => {
    const bodies = pickBodies("conversation", "abc123", "cn-eco", true);
    expect(bodies).toEqual([{ confirmChina: true }, { target: "conversation", id: "abc123", model: "cn-eco" }]);
    const sent: PickBody[] = [];
    expect((await sendPick(bodies, async (b) => { sent.push(b); return { status: 200, body: { ok: true } }; })).why).toBeNull();
    expect(sent).toEqual(bodies);
  });

  it("a refused confirmation stops there: the pick is never sent", async () => {
    const sent: PickBody[] = [];
    const out = await sendPick(pickBodies("brand", undefined, "cn-eco", true), async (b) => { sent.push(b); return { status: 403, body: { error: "forbidden" } }; });
    expect(out.why).toBe("owner_only");
    expect(sent).toEqual([{ confirmChina: true }]);
  });
});

describe("ruling 5: each refusal maps to one answer, and a failure is reported so the caller rolls back", () => {
  it("maps statuses and error codes", () => {
    expect(pickRefusal(503, "busy", false)).toBe("busy");
    expect(pickRefusal(409, "busy", false)).toBe("busy");
    for (const e of ["unknown_model", "not_pickable", "china_unconfirmed"]) expect(pickRefusal(e === "china_unconfirmed" ? 409 : 400, e, false), e).toBe("unavailable");
    expect(pickRefusal(404, "not_found", false)).toBe("not_found");
    expect(pickRefusal(401, undefined, false)).toBe("signed_out");
    expect(pickRefusal(401, undefined, true)).toBe("signed_out");
    expect(pickRefusal(403, "forbidden", true)).toBe("owner_only");
    expect(pickRefusal(403, "forbidden", false)).toBe("forbidden");
    expect(pickRefusal(429, "slow_down", false)).toBe("slow_down");
    expect(pickRefusal(400, "bad_request", false)).toBe("failed");
    expect(pickRefusal(500, undefined, false)).toBe("failed");
  });

  it("a request that throws (offline) is a failure, not a success", async () => {
    expect((await sendPick(pickBodies("conversation", "abc123", "w-std", false), async () => { throw new Error("offline"); })).why).toBe("failed");
  });

  it("the refusal's error code is read from the answer's body", async () => {
    expect((await sendPick(pickBodies("conversation", "abc123", "w-std", false), async () => ({ status: 400, body: { error: "not_pickable" } }))).why).toBe("unavailable");
    expect((await sendPick(pickBodies("conversation", "abc123", "w-std", false), async () => ({ status: 409, body: { error: "busy" } }))).why).toBe("busy");
    expect((await sendPick(pickBodies("conversation", "abc123", "w-std", false), async () => ({ status: 500, body: null }))).why).toBe("failed");
  });

  it("every refusal has its sentence in both languages", () => {
    for (const k of ["busy", "unavailable", "notFound", "noBrand", "ownerOnly", "slow", "failed", "loadFailed"] as const) {
      expect(M.ar[k], k).toBeTruthy();
      expect(M.en[k], k).toBeTruthy();
    }
    expect(M.en.busy).toMatch(/moment/);
  });
});

/** Physical direction classes (the confirm dialog's list): the picker must read right to left as well as left to right. */
const PHYSICAL = /(?<![\w-])-?(?:ml|mr|pl|pr|left|right|rounded-l|rounded-r|border-l|border-r|text-left|text-right|float-left|float-right)(?:-[\w./[\]]+)?(?![\w-])/;

describe("ruling 7: right to left and left to right", () => {
  it("the picker component uses logical direction classes only", () => {
    const src = readFileSync("src/components/app/ModelPicker.tsx", "utf8");
    const classes = (src.match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) ?? []).join(" ");
    expect(classes).not.toBe("");
    expect(classes).not.toMatch(PHYSICAL);
  });

  it("a model label keeps its own direction inside the Arabic list", () => {
    const html = renderToStaticMarkup(createElement(ModelOptionList, { t: appDict.ar, lang: "ar", surface: "chat", options: pickerOptions(view({ models: [{ ...WEST, label: { ar: "Model X", en: "Model X" } }] }), "chat", "ar", M.ar.auto), selected: null, onPick: () => {} }));
    expect(html).toMatch(/<bdi[^>]*>Model X<\/bdi>/);
    expect(html).toMatch(/dir="ltr"[^>]*>x1\.25</);
  });
});

/** The account's chat status as `PUT /api/models` answers it for a conversation pick (`chatStatus`, on the server). */
const STATUS: ChatStatus = { used: 3, allowance: 30, left: 27, counted: 3, period: "month", overflow: { on: true, available: true, used: 0, credits: 0, hold: 4 } };

describe("review I-2: after a conversation pick the allowance line takes the server's chat status for the new model", () => {
  it("the client's copy of the status has exactly the server's shape, both ways (a drift fails the type check)", () => {
    const toStatus = (p: PickedChat): ChatStatus => p;
    const toPicked = (s: ChatStatus): PickedChat => s;
    expect(toPicked(toStatus(STATUS))).toEqual(STATUS);
  });

  it("the pick's answer is passed through as it came: the chat status when it has the shape, else nothing", async () => {
    const out = await sendPick(pickBodies("conversation", "abc123", "w-std", true), async (b) => ("confirmChina" in b ? { status: 200, body: { ok: true } } : { status: 200, body: { ok: true, chat: STATUS } }));
    expect(out.why).toBeNull();
    // The last answer is the pick's, not the confirmation's.
    expect(pickedChat(out.body)).toEqual(STATUS);
    expect(pickedChat({ ok: true })).toBeNull();
    expect(pickedChat(null)).toBeNull();
    expect(pickedChat({ chat: { ...STATUS, left: "27" } })).toBeNull();
    expect(pickedChat({ chat: { ...STATUS, period: "year" } })).toBeNull();
    expect(pickedChat({ chat: { ...STATUS, overflow: { ...STATUS.overflow, hold: undefined } } })).toBeNull();
    // A refused pick hands over nothing to show.
    const refused = await sendPick(pickBodies("conversation", "abc123", "w-std", false), async () => ({ status: 503, body: { error: "busy", chat: STATUS } }));
    expect(refused.why).toBe("busy");
  });

  it("the chat panel replaces its status with the one the pick answered, and computes nothing itself", () => {
    const picker = readFileSync("src/components/app/ModelPicker.tsx", "utf8");
    expect(picker).toMatch(/const chat = pickedChat\(body\);\s*if \(chat\) onChat\(chat\);/);
    const panel = readFileSync("src/components/app/ChatPanel.tsx", "utf8");
    expect(panel).toMatch(/onChat=\{setChatNow\}/);
  });
});

describe("review minor 6: the selection comes from the active conversation's record, not only from the newest hundred listed", () => {
  const listed = [{ id: "c1", model: "w-std" }, { id: "c2" }];
  it("a pick made here first, then the record the chat page read on the server, then the list", () => {
    // An old conversation opened with ?conv=, not among the listed rows: its own record decides.
    expect(storedPick("old", {}, { id: "old", model: "w-std" }, listed)).toBe("w-std");
    expect(storedPick("old", {}, { id: "old" }, listed)).toBeUndefined();
    // The active record wins over a listed copy of the same conversation.
    expect(storedPick("c1", {}, { id: "c1" }, listed)).toBeUndefined();
    expect(storedPick("c2", {}, { id: "c2", model: "cn-eco" }, listed)).toBe("cn-eco");
    // Another conversation than the active one: the list.
    expect(storedPick("c1", {}, { id: "old", model: "cn-eco" }, listed)).toBe("w-std");
    expect(storedPick("c1", {}, null, listed)).toBe("w-std");
    expect(storedPick("nope", {}, null, listed)).toBeUndefined();
    // A pick made in this panel is the latest: it wins, a cleared one (null) included.
    expect(storedPick("old", { old: "cn-eco" }, { id: "old", model: "w-std" }, listed)).toBe("cn-eco");
    expect(storedPick("c1", { c1: null }, null, listed)).toBeUndefined();
    // An inherited name is not a pick.
    expect(storedPick("toString", {}, null, listed)).toBeUndefined();
  });

  it("the chat page hands the panel the active conversation's id and pick only, and the panel feeds them to storedPick", () => {
    const page = readFileSync("src/app/[lang]/app/chat/page.tsx", "utf8");
    expect(page).toMatch(/active=\{active \? \{ id: active\.id, model: active\.model \} : null\}/);
    // The same record the allowance line's chat status was worked out for.
    expect(page).toMatch(/const record = getConversation\(sc\(u\), conv\);/);
    expect(page).toMatch(/record\.then\(\(c\) => chatStatus\(u, chatRouteFor\(u, c\)\.model\)\)/);
    const panel = readFileSync("src/components/app/ChatPanel.tsx", "utf8");
    expect(panel).toMatch(/stored=\{storedPick\(conv, made, active, convs\)\}/);
  });
});

describe("review minor 7: a stored id the list no longer offers can be cleared", () => {
  it("choosing Automatic over a stale stored id is a change (it sends null); choosing what is stored is not", () => {
    expect(pickChanges("gone-model", null)).toBe(true);
    expect(pickChanges(undefined, null)).toBe(false);
    expect(pickChanges(null, null)).toBe(false);
    expect(pickChanges("w-std", "w-std")).toBe(false);
    expect(pickChanges("w-std", null)).toBe(true);
    expect(pickChanges(undefined, "w-std")).toBe(true);
    // What the list shows for the stale id is Automatic, and the Automatic body is model null.
    const opts = pickerOptions(view(), "generate", "en", M.en.auto);
    expect(chosenId("gone-model", opts)).toBeNull();
    expect(pickBodies("brand", undefined, chosenId("gone-model", opts), false)).toEqual([{ target: "brand", model: null }]);
  });

  it("both pickers decide a change from the stored value itself, not from the entry shown", () => {
    const src = readFileSync("src/components/app/ModelPicker.tsx", "utf8");
    expect(src).toMatch(/!pickChanges\(stored, o\.id\)/);
    expect(src).toMatch(/const canSave = pickChanges\(pick\.saved, current\);/);
    expect(src).not.toMatch(/o\.id === selected\)/);
  });
});

describe("review minor 9: the optimistic change and its rollback are one pure step", () => {
  it("a conversation pick shows at once, stays when it landed, and a refusal puts back that conversation's previous pick", () => {
    let made: MadePicks = {};
    made = nextMadePicks(made, "c1", null, "w-std", "pending");
    expect(made).toEqual({ c1: "w-std" });
    expect(nextMadePicks(made, "c1", null, "w-std", null)).toEqual({ c1: "w-std" });
    expect(nextMadePicks(made, "c1", null, "w-std", "busy")).toEqual({ c1: null });
    expect(nextMadePicks({ c1: "cn-eco" }, "c1", "w-std", null, "unavailable")).toEqual({ c1: "w-std" });
  });

  it("a rollback that arrives after the person switched conversation restores the conversation the pick was for, not the one open now", () => {
    // Pick on c1 (was w-std), then switch to c2 and pick there; c1's request is refused afterwards.
    let made: MadePicks = {};
    made = nextMadePicks(made, "c1", "w-std", "cn-eco", "pending");
    made = nextMadePicks(made, "c2", null, "w-std", "pending");
    made = nextMadePicks(made, "c1", "w-std", "cn-eco", "failed");
    expect(made).toEqual({ c1: "w-std", c2: "w-std" });
    expect(storedPick("c1", made, { id: "c2" }, [])).toBe("w-std");
    expect(storedPick("c2", made, { id: "c2" }, [])).toBe("w-std");
  });

  it("the brand field: saved at once, kept when it landed; a refusal restores the saved value and keeps the choice for another try, unless the list dropped it", () => {
    expect(nextBrandPick("w-std", "cn-eco", "pending")).toEqual({ saved: "cn-eco", choice: undefined });
    expect(nextBrandPick("w-std", "cn-eco", null)).toEqual({ saved: "cn-eco", choice: undefined });
    expect(nextBrandPick("w-std", "cn-eco", "busy")).toEqual({ saved: "w-std", choice: "cn-eco" });
    expect(nextBrandPick(null, "cn-eco", "unavailable")).toEqual({ saved: null, choice: undefined });
    // Clearing a stale id that is refused puts the stale id back as it was.
    expect(nextBrandPick("gone-model", null, "failed")).toEqual({ saved: "gone-model", choice: null });
  });

  it("the components apply these steps and nothing else to roll back", () => {
    const src = readFileSync("src/components/app/ModelPicker.tsx", "utf8");
    expect(src).toMatch(/onPicked\(at, previous, o\.id, "pending"\)/);
    expect(src).toMatch(/onPicked\(at, previous, o\.id, why\)/);
    expect(src).toMatch(/setPick\(nextBrandPick\(previous, o\.id, "pending"\)\)/);
    expect(src).toMatch(/setPick\(nextBrandPick\(previous, o\.id, why\)\)/);
    expect(src).not.toMatch(/onStored\(/);
    const panel = readFileSync("src/components/app/ChatPanel.tsx", "utf8");
    expect(panel).toMatch(/setMade\(\(p\) => nextMadePicks\(p, c, previous, model, outcome\)\)/);
  });
});

describe("review minor 8: the refusal note goes away by itself", () => {
  it("after 8 seconds, on Escape and on the next pick", () => {
    expect(NOTE_MS).toBe(8000);
    const src = readFileSync("src/components/app/ModelPicker.tsx", "utf8");
    expect(src).toMatch(/setTimeout\(\(\) => setNoted\(null\), NOTE_MS\)/);
    expect(src).toMatch(/clearTimeout\(timer\)/);
    expect(src).toMatch(/if \(e\.key === "Escape"\) setNoted\(null\);/);
    // The next pick starts by clearing it.
    expect(src).toMatch(/async function choose\(o: PickerOption\) \{\s*setOpen\(false\);\s*setNote\(""\);/);
  });
});

describe("re-review minor 2: no conversation pick while a message is in flight", () => {
  it("the chat picker's trigger is locked while a pick is being saved, while a reply is in flight, and before the list loads (a failed load still opens, to say so)", () => {
    const base = { picking: false, replying: false, loaded: true, failed: false };
    expect(pickerLocked(base)).toBe(false);
    expect(pickerLocked({ ...base, replying: true })).toBe(true);
    expect(pickerLocked({ ...base, picking: true })).toBe(true);
    expect(pickerLocked({ ...base, loaded: false })).toBe(true);
    expect(pickerLocked({ ...base, loaded: false, failed: true })).toBe(false);
    expect(pickerLocked({ ...base, loaded: false, failed: true, replying: true })).toBe(true);
  });

  it("the panel hands the picker its in-flight flag, and the picker locks the trigger and refuses a pick with the helper", () => {
    const panel = readFileSync("src/components/app/ChatPanel.tsx", "utf8");
    expect(panel).toMatch(/<ChatModelPicker [^\n]*\breplying=\{busy\}/);
    const src = readFileSync("src/components/app/ModelPicker.tsx", "utf8");
    expect(src).toMatch(/const locked = pickerLocked\(\{ picking: busy, replying, loaded: !!view, failed \}\);/);
    expect(src).toMatch(/<button ref=\{trigger\}[^\n]*\bdisabled=\{locked\}/);
    // A list left open when the reply started picks nothing.
    expect(src).toMatch(/if \(!view \|\| locked \|\| !pickChanges\(stored, o\.id\)\) return;/);
  });
});

describe("the pages wire the pickers in", () => {
  it("the chat header and the brand page render the picker, and the China confirmation is offered only to the owner", () => {
    const chat = readFileSync("src/components/app/ChatPanel.tsx", "utf8");
    expect(chat).toMatch(/<ChatModelPicker\b/);
    const brand = readFileSync("src/components/app/BrandForm.tsx", "utf8");
    expect(brand).toMatch(/<BrandModelField\b/);
    for (const page of ["src/app/[lang]/app/chat/page.tsx", "src/app/[lang]/app/onboarding/page.tsx"]) {
      const src = readFileSync(page, "utf8");
      expect(src, page).toMatch(/can\(u, "profile\.account"\) && u\.actor\?\.kind !== "founder"/);
      expect(src, page).toMatch(/canConfirmChina=\{/);
    }
  });
});
