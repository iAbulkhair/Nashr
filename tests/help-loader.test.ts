import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe as describeTopic, helpHref, HELP, HELP_ICONS, helpTopics, helpTopicsIn, ORIGIN_SLOT } from "@/lib/help";
import { helpEntry, loadHelpIndex, loadHelpTopic } from "@/lib/help-loader";
import { LANGS } from "@/lib/i18n";
import { Icon } from "@/components/app/Icons";
import HelpCenter from "@/components/HelpCenter";

/**
 * Rule 3318: the help index and every topic page read a topic through one loader that returns its title, description, icon and
 * rendered answers, and each topic has a drawn icon from the app's own set. Nothing the visitor reads changes: the loader
 * writes no sentence, the URLs are the same and the answers are the same text (with the origin slot filled).
 */
afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/help");
});

const O = "https://o.test";

describe("rule 3318: the loader returns what the pages always showed", () => {
  it("lists, for each language, the same topics in the same order, with the same titles, descriptions and addresses", () => {
    for (const lang of LANGS) {
      const idx = loadHelpIndex(O, lang);
      const old = helpTopicsIn(O, lang);
      expect(idx.map((e) => e.id)).toEqual(old.map((t) => t.id));
      for (const [k, e] of idx.entries()) {
        const t = old[k];
        expect(e.title).toBe(t.title[lang]);
        expect(e.description).toBe(describeTopic(lang, t));
        expect(e.href).toBe(helpHref(lang, t.id));
        expect(e.lang).toBe(lang);
      }
    }
  });
  it("gives each answer's question, text and its own anchor address, with the origin slot filled", () => {
    for (const lang of LANGS) {
      for (const [k, e] of loadHelpIndex(O, lang).entries()) {
        const t = helpTopicsIn(O, lang)[k];
        expect(e.answers.map((a) => [a.slug, a.question, a.answer, a.href])).toEqual(t.items.map((i) => [i.slug, i.q[lang], i.a[lang], helpHref(lang, t.id, i.slug)]));
        for (const a of e.answers) expect(a.answer).not.toContain(ORIGIN_SLOT);
      }
    }
    // The answers that name the MCP address carry the origin it was given.
    expect(loadHelpIndex(O, "en").flatMap((e) => e.answers).some((a) => a.answer.includes(O))).toBe(true);
  });
  it("prints answers as the plain text they are: no markup is added, and text that holds markup is not turned into it", () => {
    const t = { ...HELP[0], items: [{ ...HELP[0].items[0], a: { ar: "<b>x</b> & y", en: "<b>x</b> & y" } }] };
    expect(helpEntry(t, "en").answers[0].answer).toBe("<b>x</b> & y");
  });
  it("reads a topic page's entry in the language it exists in, keeping the links on the reader's address", () => {
    const r = loadHelpTopic(O, "en", HELP[0].id)!;
    expect(r.served).toEqual({ lang: "en", fallback: false });
    expect(r.entry.title).toBe(HELP[0].title.en);
    expect(r.entry.href).toBe(`/en/help/${HELP[0].id}`);
    expect(r.topic.id).toBe(HELP[0].id);
    expect(r.topic.items.length).toBe(r.entry.answers.length);
  });
  it("is null for a topic that does not exist", () => {
    expect(loadHelpTopic(O, "ar", "nope")).toBeNull();
    expect(loadHelpTopic(O, "ar", "__proto__")).toBeNull();
  });
  it("serves a topic written in one language on the other's address in that language, with links on the reader's own address", async () => {
    vi.resetModules();
    vi.doMock("@/lib/help", async (orig) => {
      const real = await orig<typeof import("@/lib/help")>();
      const only = (o: string) => real.helpTopics(o).map((t, k) => (k === 0 ? { ...t, only: "ar" as const, title: { ar: t.title.ar, en: "" }, items: t.items.map((i) => ({ ...i, q: { ar: i.q.ar, en: "" }, a: { ar: i.a.ar, en: "" } })) } : t));
      return { ...real, helpTopics: only, helpTopicsIn: (o: string, l: "ar" | "en") => only(o).filter((t) => (t.only ? [t.only] : ["ar", "en"]).includes(l)) };
    });
    const { loadHelpTopic: load, loadHelpIndex: index } = await import("@/lib/help-loader");
    const id = HELP[0].id;
    const r = load(O, "en", id)!;
    expect(r.served).toEqual({ lang: "ar", fallback: true });
    expect(r.entry.title).toBe(HELP[0].title.ar);
    expect(r.entry.lang).toBe("ar");
    expect(r.entry.href).toBe(`/en/help/${id}`);
    expect(r.entry.answers[0].href).toBe(`/en/help/${id}#${HELP[0].items[0].slug}`);
    expect(index(O, "en").map((e) => e.id)).not.toContain(id);
    expect(index(O, "ar").map((e) => e.id)).toContain(id);
  });
});

describe("rule 3318: an icon for every topic", () => {
  it("names one for each topic, and only for topics that exist", () => {
    expect(Object.keys(HELP_ICONS).sort()).toEqual(HELP.map((t) => t.id).sort());
    for (const lang of LANGS) for (const e of loadHelpIndex(O, lang)) expect(e.icon).toBe(HELP_ICONS[e.id]);
  });
  const svg = (name: string) => renderToStaticMarkup(createElement(Icon, { name }));
  it("is a drawn icon of the app's set, not the fallback shape, and each topic's differs", () => {
    const fallback = svg("__not_an_icon__");
    expect(fallback).toBe(svg("general"));
    const seen = new Set<string>();
    for (const name of Object.values(HELP_ICONS)) {
      const m = svg(name);
      expect(m, name).not.toBe(fallback);
      expect(m, name).toMatch(/^<svg [^>]*stroke="currentColor"/);
      expect(m, name).toContain('aria-hidden="true"');
      seen.add(m);
    }
    expect(seen.size).toBe(HELP.length);
  });
  it("adds no icon package: the help code imports none", () => {
    for (const f of ["src/lib/help.ts", "src/lib/help-loader.ts", "src/components/HelpCenter.tsx", "src/app/[lang]/help/[topic]/page.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/from "(?:lucide|react-icons|@heroicons|@radix-ui\/react-icons|@phosphor|@tabler)/);
    }
  });
});

describe("rule 3318: the index and the topic page use the loader", () => {
  it("the index draws every topic with its icon, title, address and answers in both languages", () => {
    for (const lang of LANGS) {
      const html = renderToStaticMarkup(createElement(HelpCenter, { lang, wa: null, origin: O }));
      for (const e of loadHelpIndex(O, lang)) {
        expect(html, e.id).toContain(`href="${e.href}"`);
        expect(html, e.id).toContain(e.title.replace(/&/g, "&amp;"));
        for (const a of e.answers) expect(html, a.slug).toContain(`id="${a.slug}"`);
      }
      expect((html.match(/<svg /g) ?? []).length).toBeGreaterThanOrEqual(HELP.length);
    }
  });
  it("the in-app copy keeps its titles plain text, still with the icon", () => {
    const html = renderToStaticMarkup(createElement(HelpCenter, { lang: "en", wa: null, origin: O, inApp: true }));
    expect(html).not.toContain(`href="/en/help/${HELP[0].id}"`);
    expect(html).toContain(HELP[0].title.en.replace(/&/g, "&amp;"));
  });
  it("the topic page and the index read topics through the loader, not through the raw lists", () => {
    const page = readFileSync("src/app/[lang]/help/[topic]/page.tsx", "utf8");
    expect(page).toContain("loadHelpTopic(origin, lang, topic)");
    expect(page).toContain("loadHelpTopic(appOrigin(), lang, topic)");
    expect(page).toContain("loadHelpIndex(origin, lang)");
    expect(page).not.toMatch(/helpTopics\(|helpTopic\(/);
    const center = readFileSync("src/components/HelpCenter.tsx", "utf8");
    expect(center).toContain("loadHelpIndex(origin, lang)");
    expect(center).not.toMatch(/helpTopicsIn|helpTopics\(/);
  });
  it("the topic page's metadata description is the loader's, which is the topic's own questions line", async () => {
    const { generateMetadata } = await import("@/app/[lang]/help/[topic]/page");
    for (const lang of LANGS) {
      for (const t of HELP) {
        const m = await generateMetadata({ params: Promise.resolve({ lang, topic: t.id }) });
        expect(m.description, `${lang}/${t.id}`).toBe(describeTopic(lang, helpTopics(O).find((x) => x.id === t.id)!));
      }
    }
  });
});
