import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appDict } from "@/lib/app-i18n";
import { MODELS, pickerView } from "@/lib/models/catalog";
import {
  chosenId,
  formatMultiplier,
  needsChinaConfirm,
  pickBodies,
  pickRefusal,
  pickerOptions,
  readModelsView,
  sendPick,
  unitsText,
  type ModelsView,
  type PickBody,
  type PickerRowView,
} from "@/lib/model-picker";
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
});

/** Words and ids that name a model or its maker. Case-sensitive: `CLAUDE_PAUSED` is an identifier, not copy. */
const NAMES = new RegExp(
  [
    "\\b(Claude|Anthropic|Opus|Sonnet|Haiku|DeepSeek|Qwen|Kimi|GLM)\\b",
    "كلود|أنثروبيك|أوبس|سونيت|هايكو",
    ...MODELS.flatMap((m) => [m.id, m.label.en, m.label.ar]).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  ].join("|"),
);
const walk = (p: string): string[] =>
  statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : /\.(ts|tsx|md|mdx|txt)$/.test(p) ? [p] : [];

describe("no public marketing page mentions a model name", () => {
  it("the pages outside the signed-in app, the site copy modules and the blog name no model and no model maker", () => {
    const files = [
      ...walk("src/app/[lang]").filter((f) => !f.startsWith(join("src/app/[lang]", "app") + "/")),
      ...walk("src/app/llms.txt"),
      ...walk("src/app/p"),
      ...readdirSync("src/components").filter((f) => f.endsWith(".tsx")).map((f) => join("src/components", f)),
      ...walk("src/components/home"),
      ...["i18n", "home", "site", "help", "pages-vs", "pages-industry", "changelog", "dictionary"].map((f) => `src/lib/${f}.ts`),
      ...walk("content/blog"),
    ];
    expect(files.length).toBeGreaterThan(40);
    const hits = files.flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((l, i) => (NAMES.test(l) ? [`${f}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });

  it("the picker's own copy names no model either: names reach the signed-in picker only from the server's labels", () => {
    for (const [k, s] of [...leaves(M.ar), ...leaves(M.en)]) expect(s, k).not.toMatch(NAMES);
    for (const f of ["src/lib/model-picker.ts", "src/components/app/ModelPicker.tsx"]) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, f).not.toMatch(NAMES);
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
    // The chosen entry is marked for assistive technology, and only that one.
    const sel = renderToStaticMarkup(createElement(ModelOptionList, { t: appDict.en, lang: "en", surface: "chat", options: pickerOptions(view(), "chat", "en", M.en.auto), selected: "w-std", onPick: () => {} }));
    expect(sel.split('aria-selected="true"').length - 1).toBe(1);
    expect(sel).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/li>).)*West model/);
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

  it("the brand list words the multiplier per batch of credits", () => {
    const html = renderToStaticMarkup(createElement(ModelOptionList, { t: appDict.en, lang: "en", surface: "generate", options: pickerOptions(view(), "generate", "en", M.en.auto), selected: null, onPick: () => {} }));
    // The multiplier sits in its own left-to-right span inside the sentence: compare the text without the markup.
    expect(html.replace(/<[^>]+>/g, "")).toContain(M.en.perBatch.replace("{x}", "x0.45"));
    expect(html).not.toContain("x1.25");
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
    expect(await sendPick(bodies, async (b) => { sent.push(b); return { status: 200 }; })).toBeNull();
    expect(sent).toEqual(bodies);
  });

  it("a refused confirmation stops there: the pick is never sent", async () => {
    const sent: PickBody[] = [];
    const out = await sendPick(pickBodies("brand", undefined, "cn-eco", true), async (b) => { sent.push(b); return { status: 403, error: "forbidden" }; });
    expect(out).toBe("owner_only");
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
    expect(await sendPick(pickBodies("conversation", "abc123", "w-std", false), async () => { throw new Error("offline"); })).toBe("failed");
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
