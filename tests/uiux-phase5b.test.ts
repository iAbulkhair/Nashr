// UI/UX phase 5b (docs/reports/2026-10-10-supastarter-uiux-report.md §4.12 fix 2, docs/system/tests/1220-uiux-phase5b.md):
// the home page's live UI gallery. Real app components with made-up data, labelled illustrative on every panel, copy in
// its own file, no claims, no model names, the Tabs primitive, light only. Source-reading checks and static renders.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RAW_COLOUR } from "../eslint-rules/thakeen-ui.mjs";
import { appDict } from "@/lib/app-i18n";
import { approvalDict } from "@/lib/approval-dict";
import { GALLERY_COPY, GALLERY_TABS, gallerySamples, galleryStrings } from "@/lib/home-gallery";
import { HOME_NAV, SCENES_COPY } from "@/lib/home";
import { AGENTS } from "@/lib/agents";
import { isTaskType } from "@/lib/tasks";
import { CHANNEL_LIMITS } from "@/lib/channel-limits";
import Gallery from "@/components/home/Gallery";
import ApprovalCard from "@/components/app/ApprovalCard";
import ChatBubble from "@/components/app/ChatBubble";

const read = (f: string) => readFileSync(f, "utf8");
/** The source without block comments and `//` line comments (a `//` after a colon is a URL). */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const GALLERY = "src/components/home/Gallery.tsx";
const TABS = "src/components/home/GalleryTabs.tsx";
const COPY = "src/lib/home-gallery.ts";
const PAGE = "src/app/[lang]/page.tsx";

describe("rule 1220: the gallery sits on the home page with its copy in its own file", () => {
  it("is mounted between your day and the seven steps, as a section with its own heading", () => {
    const page = read(PAGE);
    const at = ["<Day ", "<Gallery ", "<Steps "].map((c) => page.indexOf(c));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(page).toMatch(/import Gallery from "@\/components\/home\/Gallery"/);
    expect(read(GALLERY)).toMatch(/<section[^>]*\bid="gallery"[^>]*aria-labelledby="t-gallery"/);
  });
  it("takes its copy from src/lib/home-gallery.ts and never from src/lib/home.ts", () => {
    for (const f of [GALLERY, TABS, COPY]) expect(code(f), f).not.toMatch(/from "@\/lib\/home"/);
    expect(code(GALLERY)).toMatch(/from "@\/lib\/home-gallery"/);
  });
  it("keeps the scenes' heading to the critique's wording (rule 1840) and the gallery free of it", () => {
    expect(SCENES_COPY.h.ar).toBe("كيف يشتغل أصحاب المحلات مع ذكين.");
    expect(SCENES_COPY.h.en).toBe("How shop owners work with Thakeen.");
    // The section chips under the cover (rule 1854): the team is the cover itself, so it has no chip.
    expect(HOME_NAV.map((n) => n.href)).toEqual(["#rules", "#day", "#steps", "#price", "#faq"]);
    for (const s of galleryStrings()) expect(s).not.toContain("كيف يشتغل أصحاب المحلات");
  });
});

describe("rule 1221: every sample is labelled illustrative, on screen", () => {
  it("says under the heading that the data is illustrative and not real customers, in both languages", () => {
    expect(GALLERY_COPY.sub.ar).toMatch(/توضيحية/);
    expect(GALLERY_COPY.sub.ar).toMatch(/مو لعملاء حقيقيين/);
    expect(GALLERY_COPY.sub.en).toMatch(/illustrative/i);
    expect(GALLERY_COPY.sub.en).toMatch(/not real customers/);
    expect(GALLERY_COPY.label).toEqual({ ar: "مثال توضيحي", en: "Illustrative example" });
  });
  it("puts the label inside each tab panel, above the screen, and says the buttons save nothing", () => {
    const src = code(TABS);
    const panel = src.slice(src.indexOf("<TabPanel"), src.indexOf("</TabPanel>"));
    expect(panel).toMatch(/<Badge tone="info">\{text\.label\}<\/Badge>/);
    expect(panel.indexOf("text.label")).toBeLessThan(panel.indexOf("<ChatBubble"));
    expect(panel).toMatch(/\{text\.note\}/);
    expect(GALLERY_COPY.note.en).toMatch(/nothing is published or saved/);
  });
  for (const lang of ["ar", "en"] as const) {
    it(`renders the label, the line and the note in ${lang}`, () => {
      const html = renderToStaticMarkup(h(Gallery, { lang }));
      expect(html).toContain(GALLERY_COPY.label[lang]);
      expect(html).toContain(GALLERY_COPY.sub[lang]);
      expect(html).toContain(GALLERY_COPY.note[lang]);
    });
  }
});

describe("rule 1222: the screens are the app's own components, and in the gallery they write nothing", () => {
  it("draws the chat bubble, the approval card and the starter plan from src/components/app", () => {
    const src = code(TABS);
    expect(src).toMatch(/import ApprovalCard from "@\/components\/app\/ApprovalCard"/);
    expect(src).toMatch(/import ChatBubble from "@\/components\/app\/ChatBubble"/);
    expect(src).toMatch(/import \{ PlanCard \} from "@\/components\/app\/OnboardCards"/);
    expect(code("src/components/app/ChatPanel.tsx")).toMatch(/<ChatBubble key=\{i\} role=\{m\.role\}/);
  });
  it("runs every one of them in demo", () => {
    const src = code(TABS);
    expect(src.match(/<ApprovalCard [^>]*\bdemo\b/g)).toHaveLength(2);
    expect(src).toMatch(/<PlanCard [^>]*\bdemo\b/);
    expect(src).not.toMatch(/fetch\(/);
  });
  it("the approval card's demo changes only the card: it returns before any request", () => {
    const src = code("src/components/app/ApprovalCard.tsx");
    const body = src.slice(src.indexOf("async function setState"));
    expect(body.indexOf("if (demo)")).toBeGreaterThan(-1);
    expect(body.indexOf("if (demo)")).toBeLessThan(body.indexOf("fetch("));
    expect(body.slice(body.indexOf("if (demo)"), body.indexOf("fetch(")).match(/return;/)).not.toBeNull();
  });
  it("the starter plan's demo neither reads nor writes the plan", () => {
    const src = code("src/components/app/OnboardCards.tsx");
    const plan = src.slice(src.indexOf("export function PlanCard"), src.indexOf("export function WhatsAppCard"));
    expect(plan).toMatch(/useEffect\(\(\) => \{ if \(demo\) return; fetch\("\/api\/onboard\/plan"\)/);
    expect(plan.indexOf("if (demo) return;", plan.indexOf("async function add"))).toBeLessThan(plan.indexOf('method: "POST"'));
  });
  it("draws a bubble the same way the chat did: the owner on the inline end in ink, the agent with a name", () => {
    const you = renderToStaticMarkup(h(ChatBubble, { role: "user", children: "hi" }));
    expect(you).toMatch(/justify-end/);
    expect(you).toMatch(/bg-inverse text-inverse-muted/);
    const agent = renderToStaticMarkup(h(ChatBubble, { role: "assistant", name: "Noor", wide: true, children: "hello" }));
    expect(agent).toMatch(/justify-start/);
    expect(agent).toMatch(/w-full max-w-\[95%\]/);
    expect(agent).toContain(">Noor</span>");
  });
});

describe("rule 1223: the gallery's copy and samples claim nothing", () => {
  const all = galleryStrings();
  it("is written in both languages", () => {
    for (const s of all) expect(s.trim().length, s).toBeGreaterThan(0);
  });
  it("names no AI model or its maker", () => {
    for (const s of all) expect(s, s).not.toMatch(/Claude|Anthropic|GPT|OpenAI|Gemini|Opus|Sonnet|Haiku|نموذج|ذكاء اصطناعي/i);
    for (const f of [GALLERY, TABS, COPY]) expect(code(f), f).not.toMatch(/Claude|Anthropic/);
  });
  it("invents no number, price or percentage: no digit anywhere, Latin or Arabic-Indic", () => {
    for (const s of all) expect(s, s).not.toMatch(/[0-9٠-٩۰-۹%٪]/);
  });
  it("quotes no customer and promises no result", () => {
    const claims = /عملاؤنا|عملائنا|زادت|ضاعف|نتائج|مضمون|نضمن|ارتفع|our customers|testimonial|increase|doubled?|guarantee|results?\b|boost|grew|growth of/i;
    for (const s of all) expect(s, s).not.toMatch(claims);
    // The sample business has no name: it is "the roastery", never a brand in quotes.
    for (const s of all) expect(s, s).not.toMatch(/[«"“].+[»"”]/);
  });
  it("shows no logo or picture of a customer", () => {
    for (const f of [GALLERY, TABS]) expect(code(f), f).not.toMatch(/<img|<Image|next\/image|logo/i);
  });
  it("ties every sample to a task type an agent really does, on a channel the card knows", () => {
    for (const lang of ["ar", "en"] as const) {
      const s = gallerySamples(lang);
      for (const it of [s.chat.item, ...s.inbox]) {
        expect(isTaskType(it.type)).toBe(true);
        expect(AGENTS.some((a) => a.tasks.includes(it.type)), it.type).toBe(true);
        expect(it.channel in CHANNEL_LIMITS, it.channel).toBe(true);
        expect(it.body.length).toBeLessThan(CHANNEL_LIMITS[it.channel]);
        expect(it.status).toBe("pending");
      }
      for (const p of s.plan) expect(AGENTS.find((a) => a.id === "noor")!.tasks).toContain(p.type);
    }
  });
});

describe("rule 1224: only the approval card's words go to the browser", () => {
  it("passes approvalDict(...) to the client component, never the whole app dictionary", () => {
    const src = code(GALLERY);
    expect(src).toMatch(/t=\{approvalDict\(appDict\[lang\]\)\}/);
    expect(src).not.toMatch(/t=\{appDict\[lang\]\}/);
  });
  it("is a small slice with exactly the keys the card reads", () => {
    for (const lang of ["ar", "en"] as const) {
      const t = approvalDict(appDict[lang]);
      expect(Object.keys(t).sort()).toEqual(["agents", "channelNames", "chat", "inbox", "team"]);
      expect(Object.keys(t.chat).sort()).toEqual(["approveFail", "approved", "copyTo", "readNotes", "undo", "xflagHint"]);
      expect(Object.keys(t.inbox).sort()).toEqual(["approve", "approved", "copy", "pending", "waitAdmin", "xNote", "xNotes"]);
      expect(t.inbox.approve).toBe(appDict[lang].inbox.approve);
      expect(t.agents.noor).toEqual({ name: appDict[lang].agents.noor.name });
      expect(JSON.stringify(t).length).toBeLessThan(JSON.stringify(appDict[lang]).length / 10);
    }
  });
  it("the card takes the slice, so the app and the gallery pass the same shape", () => {
    expect(code("src/components/app/ApprovalCard.tsx")).toMatch(/t: ApprovalDict/);
    const html = renderToStaticMarkup(h(ApprovalCard, { item: gallerySamples("en").inbox[0], t: approvalDict(appDict.en), lang: "en", demo: true }));
    expect(html).toContain(appDict.en.inbox.approve);
    expect(html).toContain(appDict.en.inbox.pending);
  });
});

describe("rule 1225: the tabs are the Tabs primitive, by keyboard in both directions, still", () => {
  it("uses Tabs and TabPanel with one id base, three tabs in order, chat first", () => {
    const src = code(TABS);
    expect(src).toMatch(/import Tabs, \{ TabPanel \} from "@\/components\/ui\/Tabs"/);
    expect(GALLERY_TABS).toEqual(["chat", "plan", "inbox"]);
    expect(src).toMatch(/useState<GalleryTab>\("chat"\)/);
  });
  for (const lang of ["ar", "en"] as const) {
    it(`renders a labelled tablist with the first tab chosen and its panel only, in ${lang}`, () => {
      const html = renderToStaticMarkup(h(Gallery, { lang }));
      expect(html).toContain(`role="tablist" aria-label="${GALLERY_COPY.tabsLabel[lang]}"`);
      expect(html.match(/role="tab"/g)).toHaveLength(3);
      expect(html).toMatch(/id="home-gallery-tab-chat" aria-selected="true"[^>]*tabindex="0"/);
      expect(html).toMatch(/id="home-gallery-tab-plan" aria-selected="false"[^>]*tabindex="-1"/);
      expect(html.match(/role="tabpanel"/g)).toHaveLength(1);
      expect(html).toContain('id="home-gallery-panel-chat"');
      for (const id of GALLERY_TABS) expect(html).toContain(`>${GALLERY_COPY.tabs[id].label[lang]}</button>`);
    });
  }
  it("adds no motion of its own", () => {
    for (const f of [GALLERY, TABS]) expect(code(f), f).not.toMatch(/animate-|transition|setInterval|setTimeout|autoplay/);
  });
});

describe("rule 1226: a static render in both languages shows the chat screen with its sample", () => {
  for (const lang of ["ar", "en"] as const) {
    it(`draws the heading, the owner's ask, Noor's answer and the pending draft in ${lang}`, () => {
      const html = renderToStaticMarkup(h(Gallery, { lang }));
      const s = gallerySamples(lang);
      expect(html).toContain(GALLERY_COPY.h[lang]);
      expect(html).toContain(s.chat.ask);
      expect(html).toContain(appDict[lang].agents.noor.name);
      expect(html).toContain(s.chat.item.title);
      expect(html).toContain(appDict[lang].inbox.pending);
      expect(html).toContain(appDict[lang].channelNames.instagram);
    });
  }
});

// Rule 1214 replaced the "stays light" half: the gallery follows the page's theme, set once by the language layout.
describe("rule 1227: the gallery uses only the colour roles and sets no theme of its own", () => {
  it("has no raw palette colour and no theme switch of its own", () => {
    for (const f of [GALLERY, TABS, "src/components/app/ChatBubble.tsx"]) {
      const src = read(f);
      for (const m of src.matchAll(/(?<![\w\-/:[])((?:[\w-]+:)*-?(?:bg|text|border|ring)-(?:ink|paper|white|ground|lilac|muted)(?:\/\d+)?)(?![\w\-/])/g)) {
        expect(RAW_COLOUR.test(m[1].replace(/^(?:[\w-]+:)*-?/, "")), `${f}: ${m[1]}`).toBe(false);
      }
      expect(src, f).not.toMatch(/ThemeScope|data-theme|ThemeToggle/);
    }
    expect(read(PAGE)).not.toMatch(/ThemeScope|data-theme/);
  });
});
