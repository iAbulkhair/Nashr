import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { HELP, helpHref, helpTopic, helpTopics } from "@/lib/help";
import { helpFaqJsonLd, ldJson } from "@/lib/home-ld";
import { emptyHelp, EMPTY_KEYS } from "@/lib/empty-copy";
import { LANGS } from "@/lib/i18n";
import { appOrigin } from "@/lib/origin";
import sitemap from "@/app/sitemap";

const read = (f: string) => readFileSync(f, "utf8");
const TOPIC_PAGE = "src/app/[lang]/help/[topic]/page.tsx";

/**
 * Every answer's permanent address, as it shipped (rule 2141). A slug here may never be renamed, moved to another topic or
 * dropped: links from the app, from chat replies and from outside the site point at it. Rewording a question is fine and
 * leaves this list alone; a new answer adds its slug to its topic here.
 */
const PINNED: Record<string, string[]> = {
  start: ["how-to-start", "no-website", "dialect-and-tone", "chat-vs-ask-noor"],
  credits: ["task-costs", "credits-run-out", "chat-messages-run-out", "free-trial", "how-to-pay", "free-credits"],
  team: ["who-is-on-the-team", "talk-to-sami-or-razan", "sami-sales", "real-numbers", "board-deck", "reports-page", "majed-handoff", "my-to-dos", "working-days-and-away", "repeating-to-dos", "to-dos-in-phone-calendar", "cal-com-and-calendly", "after-a-booked-meeting", "reem-and-meetings"],
  inbox: ["approval-before-publishing", "learning-from-edits", "files", "add-files", "import-products", "images", "video", "content-calendar"],
  connect: ["platforms", "wordpress", "token-storage", "whatsapp"],
  automation: ["noor-on-her-own", "governance", "agent-activity", "second-reviewer", "cross-agent-review", "majed-auto-run"],
  mcp: ["mcp-setup", "lost-token"],
  privacy: ["model-training", "delete-account", "two-step-and-devices", "download-data", "processors"],
};

describe("rule 2140: one page per help topic, built from HELP, an unknown topic is the branded 404", () => {
  it("static params are every topic in both languages", async () => {
    const { generateStaticParams } = await import("@/app/[lang]/help/[topic]/page");
    expect(generateStaticParams()).toEqual(LANGS.flatMap((lang) => HELP.map((t) => ({ lang, topic: t.id }))));
    expect(HELP.map((t) => t.id)).toEqual(Object.keys(PINNED));
  });

  it("an unknown topic or language calls notFound, which [lang]/not-found.tsx draws", async () => {
    const { default: Page } = await import("@/app/[lang]/help/[topic]/page");
    await expect(Page({ params: Promise.resolve({ lang: "ar", topic: "nope" }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    await expect(Page({ params: Promise.resolve({ lang: "xx", topic: "credits" }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    expect(helpTopic("nope")).toBeUndefined();
    expect(helpTopic("credits")?.id).toBe("credits");
  });

  it("the public index links each topic's page; the in-app copy keeps its titles plain", () => {
    expect(read("src/components/HelpCenter.tsx")).toContain("{inApp ? t.title[lang] : <a href={helpHref(lang, t.id)}");
  });
});

describe("rule 2141: every answer has a hand-written slug that never changes", () => {
  it("every pinned slug is still there, in the same topic and order", () => {
    for (const [id, slugs] of Object.entries(PINNED)) {
      const now = helpTopic(id)!.items.map((i) => i.slug);
      expect(now.filter((s) => slugs.includes(s)), id).toEqual(slugs);
    }
  });

  it("every answer has a pinned slug; slugs are kebab-case and unique across the help centre", () => {
    const all = HELP.flatMap((t) => t.items.map((i) => i.slug));
    expect([...all].sort()).toEqual(Object.values(PINNED).flat().sort());
    expect(new Set(all).size).toBe(all.length);
    for (const s of all) expect(s, s).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("slugs are stored, not derived from the question: the data spells each one out", () => {
    const src = read("src/lib/help.ts");
    for (const s of Object.values(PINNED).flat()) expect(src, s).toContain(`slug: "${s}"`);
    // helpTopics carries the slug through, so the pages read it from the filled copy.
    expect(helpTopics("https://x.example").flatMap((t) => t.items.map((i) => i.slug))).toEqual(HELP.flatMap((t) => t.items.map((i) => i.slug)));
  });
});

describe("rule 2142: an answer's anchor works on its topic page and on the index", () => {
  it("the topic page gives each answer its slug as id, with a link to itself", () => {
    const s = read(TOPIC_PAGE);
    expect(s).toContain("<section key={i.slug} id={i.slug}");
    expect(s).toContain("href={helpHref(lang, t.id, i.slug)}");
  });

  it("the index gives each answer's <details> its slug and opens the one the hash names", () => {
    const s = read("src/components/HelpCenter.tsx");
    expect(s).toContain("<details key={i.slug} id={i.slug}");
    expect(s).toMatch(/el instanceof HTMLDetailsElement\) \{ el\.open = true;/);
    expect(s).toContain('window.addEventListener("hashchange", open)');
  });

  it("helpHref builds the topic page and the anchor", () => {
    expect(helpHref("ar", "credits")).toBe("/ar/help/credits");
    expect(helpHref("en", "credits", "task-costs")).toBe("/en/help/credits#task-costs");
  });
});

describe("rule 2143: each topic page names itself in both languages, from its own questions", () => {
  it("title, description, canonical and hreflang for every topic", async () => {
    const { generateMetadata } = await import("@/app/[lang]/help/[topic]/page");
    for (const t of HELP) {
      const titles: unknown[] = [];
      for (const lang of LANGS) {
        const m = await generateMetadata({ params: Promise.resolve({ lang, topic: t.id }) });
        expect(m.title).toBe(`${t.title[lang]} — ${lang === "ar" ? "مساعدة ذكين" : "Thakeen help"}`);
        expect(m.alternates).toEqual({ canonical: `/${lang}/help/${t.id}`, languages: { ar: `/ar/help/${t.id}`, en: `/en/help/${t.id}` } });
        const d = String(m.description);
        expect(d.startsWith(`${t.title[lang]}: ${t.items[0].q[lang]}`), d).toBe(true);
        // Nothing but the topic's own questions after the title.
        for (const q of d.slice(t.title[lang].length + 2).split(" · ")) expect(t.items.map((i) => i.q[lang])).toContain(q);
        expect(m).not.toHaveProperty("openGraph");
        titles.push(m.title);
      }
      expect(titles[0]).not.toBe(titles[1]);
    }
    expect(await generateMetadata({ params: Promise.resolve({ lang: "ar", topic: "nope" }) })).toEqual({});
  });
});

describe("rule 2144: the sitemap lists every topic page (llms.txt follows it, tests/llms-txt.test.ts)", () => {
  it("each topic in both languages, with its hreflang twin, and no anchors", () => {
    const map = sitemap();
    const base = appOrigin();
    for (const l of LANGS) for (const t of HELP) {
      const e = map.find((x) => x.url === `${base}/${l}/help/${t.id}`);
      expect(e, `${l}/${t.id}`).toBeTruthy();
      expect(e!.alternates?.languages).toMatchObject({ ar: `${base}/ar/help/${t.id}`, en: `${base}/en/help/${t.id}` });
    }
    expect(map.some((x) => x.url.includes("#"))).toBe(false);
  });
});

describe("rule 2145: FAQPage structured data is the page's own questions and answers, escaped", () => {
  it("one Question per answer, the shown text exactly, with the answer's anchor", () => {
    const origin = "https://thakeen.example";
    for (const t of helpTopics(origin)) for (const lang of LANGS) {
      const ld = helpFaqJsonLd(lang, origin, t);
      expect(ld["@type"]).toBe("FAQPage");
      expect(ld.url).toBe(`${origin}/${lang}/help/${t.id}`);
      expect(ld.mainEntity).toEqual(t.items.map((i) => ({ "@type": "Question", name: i.q[lang], url: `${origin}/${lang}/help/${t.id}#${i.slug}`, acceptedAnswer: { "@type": "Answer", text: i.a[lang] } })));
      // No rating, review, author or date the page does not show.
      expect(Object.keys(ld).sort()).toEqual(["@context", "@type", "inLanguage", "mainEntity", "name", "url"]);
    }
  });

  it("the MCP answer carries the filled origin, never the slot", () => {
    const t = helpTopics("https://thakeen.example").find((x) => x.id === "mcp")!;
    const s = JSON.stringify(helpFaqJsonLd("en", "https://thakeen.example", t));
    expect(s).not.toContain("{origin}");
    expect(s).toContain("https://thakeen.example");
  });

  it("the page serialises it with ldJson, so no string can close the script element", () => {
    expect(read(TOPIC_PAGE)).toContain("dangerouslySetInnerHTML={{ __html: ldJson(helpFaqJsonLd(lang, origin, t)) }}");
    const first = helpTopics("https://x.example")[0];
    const t = { ...first, items: [{ ...first.items[0], a: { ar: "</script><script>alert(1)</script>", en: "</script>" } }] };
    const out = ldJson(helpFaqJsonLd("ar", "https://x.example", t));
    expect(out).not.toContain("<");
    expect(JSON.parse(out).mainEntity[0].acceptedAnswer.text).toBe("</script><script>alert(1)</script>");
  });
});

describe("rule 2146: helpHref fails the type check on an unknown topic or a slug from another topic", () => {
  it("compiles the good calls and rejects the bad ones", () => {
    // Each bad call must be a type error; an unused @ts-expect-error fails `tsc` (npm run check) if one ever compiles.
    // @ts-expect-error no such topic
    helpHref("en", "billing");
    // @ts-expect-error task-costs is a credits answer, not a privacy one
    helpHref("en", "privacy", "task-costs");
    // @ts-expect-error no such slug
    helpHref("en", "credits", "pricing");
    expect(helpHref("en", "privacy", "two-step-and-devices")).toBe("/en/help/privacy#two-step-and-devices");
  });
});

describe("rule 2147: a handful of app screens link the help answer about them", () => {
  const LINKED: [string, string][] = [
    ["src/app/[lang]/app/settings/billing/page.tsx", 'helpHref(lang, "credits", "task-costs")'],
    ["src/app/[lang]/app/settings/security/page.tsx", 'helpHref(lang, "privacy", "two-step-and-devices")'],
    ["src/app/[lang]/app/settings/brand/page.tsx", 'helpHref(lang, "start", "dialect-and-tone")'],
    ["src/app/[lang]/app/settings/connections/page.tsx", 'helpHref(lang, "connect", "platforms")'],
    ["src/components/app/Inbox.tsx", 'emptyHelp(lang, "inbox")'],
    ["src/components/app/FilesPanel.tsx", 'emptyHelp(lang, "files")'],
    ["src/components/app/TodoPanel.tsx", 'emptyHelp(lang, "todo")'],
    ["src/components/app/ReportsPanel.tsx", 'emptyHelp(lang, "reports")'],
    ["src/components/app/ActivityPanel.tsx", 'emptyHelp(lang, "activity")'],
  ];
  for (const [f, call] of LINKED) it(f, () => expect(read(f)).toContain(call));

  it("the brand form and the connections panel draw the link they are given", () => {
    for (const f of ["src/components/app/BrandForm.tsx", "src/components/app/IntegrationsPanel.tsx"]) expect(read(f), f).toContain("{help && <p className=\"mt-1\"><HelpLink lang={lang} href={help} /></p>}");
  });

  it("the empty states that link one point at the answer about that panel; the rest have none", () => {
    const linked = EMPTY_KEYS.filter((k) => emptyHelp("en", k));
    expect(linked).toEqual(["inbox", "files", "reports", "todo", "activity"]);
    expect(emptyHelp("ar", "inbox")).toEqual({ lang: "ar", href: "/ar/help/inbox#approval-before-publishing" });
    expect(emptyHelp("en", "activity")?.href).toBe("/en/help/automation#agent-activity");
    // Every link lands on an answer that exists.
    for (const k of linked) {
      const [, topic, slug] = emptyHelp("en", k)!.href.match(/^\/en\/help\/([^#]+)#(.+)$/)!;
      expect(helpTopic(topic)!.items.some((i) => i.slug === slug), k).toBe(true);
    }
  });

  it("the link opens a new tab, says so to a screen reader, and EmptyState draws it under the body", () => {
    const s = read("src/components/ui/HelpLink.tsx");
    expect(s).toContain('target="_blank" rel="noreferrer"');
    expect(s).toContain("(opens in a new tab)");
    expect(s).not.toMatch(/^"use client"/);
    expect(read("src/components/ui/EmptyState.tsx")).toContain("{help && <HelpLink lang={help.lang} href={help.href}");
  });
});

describe("rule 2148: the two-step and devices answer is help-page only, so the chat prompt keeps its size", () => {
  it("is flagged chat: false and the prompt's help lines leave it out", () => {
    const item = helpTopic("privacy")!.items.find((i) => i.slug === "two-step-and-devices")!;
    expect(item.chat).toBe(false);
    expect(item.a.en).toContain("In Settings, Security");
    expect(item.a.ar).toContain("«الإعدادات» ثم «الأمان»");
    const lines = helpTopics("https://x.example").flatMap((t) => t.items.filter((i) => i.chat !== false).map((i) => `- ${i.q.en} → ${i.a.en}`)).join("\n");
    expect(lines).not.toContain("two-step");
  });
});

describe("rule 2149: src/lib/help.ts stays client-safe", () => {
  it("imports only the language type and the import-free pricing and task tables", () => {
    const src = read("src/lib/help.ts");
    const sf = ts.createSourceFile("help.ts", src, ts.ScriptTarget.Latest);
    const from = sf.statements.filter(ts.isImportDeclaration).map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
    expect(from).toEqual(["./i18n", "./pricing", "./tasks"]);
    expect(src).toMatch(/^import type \{ Lang \} from "\.\/i18n";/);
    for (const f of ["src/lib/pricing.ts", "src/lib/tasks.ts"]) expect(read(f), f).not.toMatch(/^import /m);
  });
});
