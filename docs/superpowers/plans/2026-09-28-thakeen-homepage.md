# Thakeen Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the homepage with the approved Thakeen experience: the owner's question storm, seven hand-drawn agents (value → name → rotating questions), team banter, the قاموس ذكين game, then truths, pricing, FAQ.

**Architecture:** Copy and game logic live in two pure, import-light modules (`src/lib/home.ts`, `src/lib/dictionary.ts`) that unit tests pin to the product's real task types. Client components under `src/components/home/` render them; GSAP ScrollTrigger drives only the scroll story, everything else is CSS. Characters are inline SVG with a fixed part contract so the illustrator's final art replaces the placeholders without code changes.

**Tech Stack:** Next.js 16 app router, React 19, TypeScript, CSS Modules, GSAP 3 + ScrollTrigger, Vitest 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-thakeen-homepage-design.md`

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next-specific code (AGENTS.md: this Next.js has breaking changes).
- Public name on this page: **ذكين / Thakeen**. Never name the AI model. Code identifiers stay `nashr`.
- Copy is verbatim from spec §5 and this plan; no invented numbers, customers, testimonials or result promises (CLAUDE.md, `tests/content-claims.test.ts`).
- Client components import only types from `@/lib/agents` / `@/lib/tasks` / `@/lib/i18n`, or values from import-free modules; never a value from a server-only module (`tests/client-bundle.test.ts`).
- Colours: noor `#f9f871`, sami `#ff5da2`, razan `#00d9ff`, faris `#b517ff`, dana `#efe7f7`, majed `#2b193d`, layan `#7fe9ff`, you `#ffffff`; ground `#f7f3f9`; ink `#2b193d`. Colour never carries meaning alone.
- Type: until licences arrive, `--home-display` and `--home-body` = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Geeza Pro", "Noto Naskh Arabic", sans-serif`. No El Messiri, no Cormorant.
- Motion: questions flip every 2400 ms, staggered by 343 ms per figure; banter every 8000 ms; `prefers-reduced-motion: reduce` → no storm, no flipping (first question stays), no breathing/blink/eye-follow.
- The game makes no network request. Game state is never stored or sent.
- Budgets: added JS < 90 KB gzipped; all character SVG together < 250 KB; LCP < 2.5 s on a mid phone.
- RTL: `/ar` mirrors the layout; the lineup reads Noor first from the right.
- Before every commit: `npm run check` and `npx next build` pass (CLAUDE.md).
- Adding `gsap`: follow the CLAUDE.md lockfile rule (regenerate `package-lock.json` from `package.json` in an empty directory, confirm `@rolldown/binding-linux-*` entries).
- Do not merge to `main` until the launch gates in spec §9 are cleared (Claude unpaused, site-wide rename, final art and type). Open a PR and verify on the Vercel preview.

## Review Focus

1. **Arabic order:** on `/ar` the lineup must read Noor at the right edge and the owner at the left; on `/en` the reverse. Pinned in Task 3.
2. **Hostile brand input:** 200 characters, runs of spaces or markup like `<b>x</b>` typed as the brand must be capped at 40 characters, collapsed, and shown as literal text. Pinned in Task 2 (unit) and Task 5 (e2e).
3. **Scrolling back up:** after reaching the finale and returning to the top, all 36 questions are back in the storm and no chapter is stuck. Pinned in Task 4.
4. **No JavaScript yet:** the slogan, the lineup and the start form render from the server and the form works as a plain GET. Pinned in Task 3.
5. **Phone width:** at 375 px the page never scrolls sideways, even with the storm running. Pinned in Task 3.

---

### Task 1: Home copy module

**Files:**
- Create: `src/lib/home.ts`
- Test: `tests/home-copy.test.ts`

**Interfaces:**
- Consumes: `type Lang` from `@/lib/i18n`; `type AgentId`, `agentById`, `isAgentId` from `@/lib/agents`; `type TaskType`, `isTaskType` from `@/lib/tasks`.
- Produces:
  - `type L = Record<Lang, string>`
  - `type Question = { ar: string; en: string; task: TaskType }`
  - `type CastId = AgentId | "you"`
  - `type CastMember = { id: CastId; name: L; value: L; color: string; questions: Question[] }`
  - `type AgentMember = CastMember & { id: AgentId }`
  - `SLOGAN: { line1: L; line2: L }`
  - `HOME: { scroll: L; finaleWord: L; finaleLine: L; cta: L; urlPlaceholder: L; aiLabel: L; truthsTitle: L }`
  - `CAST: CastMember[]` (order noor, sami, razan, faris, dana, majed, layan, you)
  - `AGENT_CAST: AgentMember[]` (CAST without `you`)
  - `STORM: Question[]` (= `AGENT_CAST.flatMap(a => a.questions)`)
  - `type Banter = { lines: { who: AgentId; text: L }[]; rule: string }`, `BANTER: Banter[]`
  - `TRUTHS: { title: L; body: L }[]`

- [ ] **Step 1: Write the failing test** in `tests/home-copy.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { CAST, AGENT_CAST, STORM, BANTER, SLOGAN, TRUTHS, HOME } from "@/lib/home";
import { agentById, isAgentId } from "@/lib/agents";
import { isTaskType } from "@/lib/tasks";

describe("home copy is true to the product", () => {
  it("lists the seven agents in order, then the owner", () => {
    expect(CAST.map((c) => c.id)).toEqual(["noor", "sami", "razan", "faris", "dana", "majed", "layan", "you"]);
    expect(AGENT_CAST.map((c) => c.id)).toEqual(["noor", "sami", "razan", "faris", "dana", "majed", "layan"]);
  });
  it("gives every agent a value line, a name and at least four questions in both languages", () => {
    for (const a of AGENT_CAST) {
      expect([a.value.ar, a.value.en, a.name.ar, a.name.en].every(Boolean)).toBe(true);
      expect(a.questions.length).toBeGreaterThanOrEqual(4);
      for (const q of a.questions) expect(q.ar.length > 0 && q.en.length > 0).toBe(true);
    }
  });
  it("ties every question to a task that agent really does", () => {
    for (const a of AGENT_CAST) for (const q of a.questions) {
      expect(isTaskType(q.task), `${a.id}: ${q.en}`).toBe(true);
      expect(agentById(a.id).tasks, `${a.id}: ${q.en}`).toContain(q.task);
    }
  });
  it("builds the storm from exactly the agents' 36 questions", () => {
    expect(STORM).toHaveLength(36);
    expect(STORM).toEqual(AGENT_CAST.flatMap((a) => a.questions));
  });
  it("keeps the approved slogan and finale verbatim", () => {
    expect(SLOGAN.line1.ar).toBe("ذكين. الذكي المكين.");
    expect(SLOGAN.line2.ar).toBe("أسئلة كثيرة تدور في راسك كل يوم… وذكين يحلها.");
    expect(HOME.finaleWord.ar).toBe("موافق.");
    expect(CAST.find((c) => c.id === "you")?.questions).toEqual([]);
  });
  it("has four banter exchanges spoken only by agents, and four truths", () => {
    expect(BANTER).toHaveLength(4);
    for (const b of BANTER) for (const l of b.lines) expect(isAgentId(l.who)).toBe(true);
    expect(TRUTHS).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/home-copy.test.ts`
Expected: FAIL, cannot resolve `@/lib/home`.

- [ ] **Step 3: Create `src/lib/home.ts`**

Type-only imports from `./i18n`, `./agents`, `./tasks`. Doc comment: copy approved by the founder on 2026-09-28, spec §5; every question maps to a real task; no numbers or promises. Data, verbatim:

- `SLOGAN`: line1 `{ ar: "ذكين. الذكي المكين.", en: "Thakeen. Smart. Steadfast." }`; line2 `{ ar: "أسئلة كثيرة تدور في راسك كل يوم… وذكين يحلها.", en: "So many questions spin in your head every day… Thakeen solves them." }`.
- `HOME`: scroll `مرّر` / `Scroll`; finaleWord `موافق.` / `Approved.`; finaleLine `هم يشتغلون. وأنت توافق.` / `They do the work. You approve.`; cta `ابدأ بموقعك` / `Start with your website`; urlPlaceholder `رابط موقعك أو متجرك` / `Your website or store URL`; aiLabel `وكلاء ذكاء اصطناعي` / `AI agents`; truthsTitle `الموجود اليوم` / `What's true today`.
- `CAST`: names, value lines, colours and questions exactly as spec §5.2 tables (AR, EN, task per row), in the order above. Owner: `{ id: "you", name: { ar: "أنت", en: "You" }, value: { ar: "أنت توافق.", en: "You approve." }, color: "#ffffff", questions: [] }`.
- `BANTER`: the four exchanges of spec §5.3, `rule` = the "Rule it teaches" column.
- `TRUTHS`:
  1. `يبدأ من موقعك` / `It starts from your website` — `تلصق الرابط، وتطلع لك ملفات علامتك وفرصها واستراتيجيتها.` / `Paste the URL and get your brand file, guidelines, opportunities, market research and a strategy.`
  2. `كل شي ينتظر موافقتك` / `Everything waits for your yes` — `كل مسودة تنتظر موافقتك، والنشر قرارك دائماً.` / `Drafts sit in Approvals. Publishing is always your call.`
  3. `يشتغل على جدول` / `It runs on a schedule` — `خطة أسبوعية صباح كل أحد، وموجز يومي الساعة ٨ الصبح.` / `A weekly plan every Sunday morning and a brief every day at 08:00.`
  4. `مصنوع للخليج` / `Made for the Gulf` — `عربي أولاً، بمواسم الخليج وقنواته.` / `Arabic first, Gulf seasons, and the channels people here use.`

- [ ] **Step 4: Run the test and see it pass**

Run: `npx vitest run tests/home-copy.test.ts tests/content-claims.test.ts tests/client-bundle.test.ts`
Expected: PASS (all three files).

- [ ] **Step 5: Commit**

Run `npm run check` (PASS), then:
```bash
git add src/lib/home.ts tests/home-copy.test.ts
git commit -m "feat(home): approved Thakeen copy tied to real agent tasks"
```

---

### Task 2: قاموس ذكين game logic

**Files:**
- Create: `src/lib/dictionary.ts`
- Test: `tests/dictionary.test.ts`

**Interfaces:**
- Consumes: `type L` from `@/lib/home`; `type AgentId` from `@/lib/agents`; `type Lang` from `@/lib/i18n`.
- Produces:
  - `type SectorId = "coffee" | "restaurant" | "clinic" | "store" | "services"`
  - `type WordId = "bold" | "warm" | "refined" | "popular" | "calm" | "luxury" | "fun" | "local" | "fast" | "honest" | "family" | "youthful"`
  - `type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7`
  - `type DictState = { step: Step; brand: string; sector: SectorId | null; words: WordId[] }`
  - `type DictAction = { type: "brand"; value: string } | { type: "sector"; value: SectorId } | { type: "word"; value: WordId } | { type: "next" } | { type: "back" } | { type: "approve" } | { type: "reset" }`
  - `INITIAL: DictState`, `MAX_WORDS = 5`, `BRAND_MAX = 40`
  - `reduce(s: DictState, a: DictAction): DictState`, `canAdvance(s: DictState): boolean`
  - `SECTORS: { id: SectorId; name: L }[]`
  - `WORDS: { id: WordId; name: L; tone: L; react: { who: AgentId; text: L } }[]`
  - `samplePlan(s: DictState, lang: Lang): string[]` (3 lines), `sampleDraft(s: DictState, lang: Lang): { post: string; whatsapp: string }`
  - `DICT_COPY: { title: L; subtitle: L; steps: Record<Step, L>; example: L; greet: { who: AgentId; text: L }; approve: L; approveNote: L; analysis: { who: AgentId; text: L }; measure: L; cta: L; brandLabel: L; sectorLabel: L; next: L; back: L; counter: L }`

- [ ] **Step 1: Write the failing test** in `tests/dictionary.test.ts`

```ts
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
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/dictionary.test.ts`
Expected: FAIL, cannot resolve `@/lib/dictionary`.

- [ ] **Step 3: Implement `src/lib/dictionary.ts`**

Imports are type-only. Rules:
- `reduce` is pure. `brand`: collapse whitespace runs to one space, trim both ends, cap at `BRAND_MAX` characters. `word`: toggle; adding is ignored at `MAX_WORDS`. `next`: `step + 1` when `canAdvance(s)` and `step !== 5` and `step < 7`. `approve`: only at step 5, to step 6. `back`: `max(1, step - 1)`. `reset`: `INITIAL`.
- `canAdvance`: step 1 `brand !== "" && sector !== null`; step 2 `words.length === MAX_WORDS`; steps 3, 4, 6 `true`; steps 5 and 7 `false`.
- `samplePlan`: the sector's three lines for `lang`, `{tone}` replaced by the first picked word's `tone[lang]`. `sampleDraft`: the sector post and the shared WhatsApp line, `{brand}` replaced.

Data, verbatim:

`SECTORS`: coffee `قهوة / Coffee`, restaurant `مطعم / Restaurant`, clinic `عيادة / Clinic`, store `متجر إلكتروني / Online store`, services `خدمات / Services`.

`WORDS` (name AR/EN · tone AR/EN · reaction):

| id | name | tone | react (who: AR / EN) |
|---|---|---|---|
| bold | جريء / Bold | جريئة / bold | faris: «يعجبني.» / "I like it." |
| warm | دافي / Warm | دافية / warm | sami: «العميل يحس فيها.» / "Customers feel that." |
| refined | راقي / Refined | راقية / refined | majed: «بشرط ما نبالغ.» / "As long as we don't overdo it." |
| popular | شعبي / Down-to-earth | شعبية / down-to-earth | noor: «قريب من الناس، أبشر.» / "Close to people. Done." |
| calm | هادي / Calm | هادية / calm | layan: «الهدوء يرجّع العميل.» / "Calm brings customers back." |
| luxury | فاخر / Luxurious | فاخرة / luxurious | razan: «والسعر يشبهه؟» / "Does the price match?" |
| fun | مرح / Playful | مرحة / playful | noor: «ترند جاهز.» / "A trend waiting to happen." |
| local | محلي / Local | محلية / local | faris: «نبدأ من الحي.» / "We start with the neighbourhood." |
| fast | سريع / Quick | سريعة / quick | sami: «أرد قبل ما يبرد العميل.» / "I reply before the lead goes cold." |
| honest | صادق / Honest | صادقة / honest | dana: «هذي كلمتي.» / "That's my word." |
| family | عائلي / Family | عائلية / family-friendly | layan: «العائلة ترجع.» / "Families come back." |
| youthful | شبابي / Youthful | شبابية / youthful | noor: «تيك توك يناديك.» / "TikTok is calling." |

Plan lines per sector (`{tone}` in line 1):
- coffee — AR: `الأحد: صورة أول كوب في الصباح، بنبرة {tone}.` · `الثلاثاء: رسالة واتساب لعملاء الأسبوع الماضي.` · `الخميس: سؤال للمتابعين: وش قهوتكم للويكند؟` — EN: `Sunday: the first cup of the morning, in a {tone} voice.` · `Tuesday: a WhatsApp note to last week's customers.` · `Thursday: ask followers what they're drinking this weekend.`
- restaurant — AR: `الأحد: طبق الأسبوع بصورة قريبة، بنبرة {tone}.` · `الأربعاء: عرض الغداء لأهل الدوام.` · `الجمعة: قصة المطبخ قبل الافتتاح.` — EN: `Sunday: the dish of the week, close up, in a {tone} voice.` · `Wednesday: the lunch offer for the office crowd.` · `Friday: a kitchen story from before opening.`
- clinic — AR: `الأحد: نصيحة قصيرة من الطبيب، بنبرة {tone}.` · `الثلاثاء: تذكير بالمواعيد عبر واتساب.` · `الخميس: سؤال شائع وجوابه.` — EN: `Sunday: a short tip from the doctor, in a {tone} voice.` · `Tuesday: an appointment reminder on WhatsApp.` · `Thursday: a common question, answered.`
- store — AR: `الأحد: منتج الأسبوع، بنبرة {tone}.` · `الثلاثاء: رسالة لمن ترك السلة.` · `الخميس: الجديد قبل الويكند.` — EN: `Sunday: the product of the week, in a {tone} voice.` · `Tuesday: a note to everyone who left their cart.` · `Thursday: what's new, before the weekend.`
- services — AR: `الأحد: مشكلة يعرفها عميلك وكيف تحلها، بنبرة {tone}.` · `الثلاثاء: متابعة لمن طلب عرض سعر.` · `الخميس: خلف الكواليس: كيف نشتغل.` — EN: `Sunday: a problem your customer knows, and how you solve it, in a {tone} voice.` · `Tuesday: a follow-up to everyone who asked for a quote.` · `Thursday: behind the scenes, how we work.`

Posts (Noor): coffee `{brand}: أول كوب يرتّب يومك.` / `{brand}: the first cup that sorts your day.`; restaurant `{brand}: طبق اليوم ينتظرك.` / `{brand}: today's dish is waiting for you.`; clinic `{brand}: صحتك تستاهل موعد اليوم، مو بكرة.` / `{brand}: your health deserves an appointment today, not tomorrow.`; store `{brand}: وصل الجديد. خذ نظرة قبل الويكند.` / `{brand}: new arrivals are in. Take a look before the weekend.`; services `{brand}: نشيل عنك الشغل اللي ياخذ وقتك.` / `{brand}: we take the work that eats your time.`
WhatsApp (Sami, all sectors): `هلا! شكراً لسؤالك عن {brand}. تبي أرسل لك التفاصيل هنا، ولا نتصل فيك؟` / `Hi! Thanks for asking about {brand}. Shall I send the details here, or would you like a call?`

`DICT_COPY`: title `قاموس ذكين` / `The Thakeen Dictionary`; subtitle `سبع خطوات، من اسم علامتك لأول نتيجة.` / `Seven steps, from your brand's name to its first result.`; steps 1–7 `براندك / Your brand`, `كلماتك / Your words`, `خطة / Plan`, `مسودة / Draft`, `موافقتك / Your approval`, `تحليل / Analysis`, `قياس / Measurement`; example `مثال` / `Example`; greet noor `«حلو الاسم. خلّني أعرفكم.»` / `"Nice name. Let me get to know you."`; approve `موافق` / `Approve`; approveNote `ولا شي ينتشر قبل هالضغطة.` / `Nothing goes out before this tap.`; analysis dana `«الأسبوع الجاي أقول لك وش نفع ووش ما نفع، من أرقامك أنت.»` / `"Next week I'll tell you what worked and what didn't, from your own numbers."`; measure `نقيس من المصادر اللي تربطها: نتائج إعلانات ميتا وسناب، ومبيعات سلة وشوبيفاي وزد، أو ملف CSV.` / `We measure from the sources you connect: Meta and Snapchat ad results, Salla, Shopify and Zid sales, or a CSV file.`; cta `جرّبها على موقعك` / `Try it on your website`; brandLabel `وش اسم علامتك؟` / `What's your brand called?`; sectorLabel `وش تبيع؟` / `What do you sell?`; next `التالي` / `Next`; back `رجوع` / `Back`; counter `اخترت {n} من ٥` / `{n} of 5 picked`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/dictionary.test.ts tests/content-claims.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run `npm run check` (PASS), then:
```bash
git add src/lib/dictionary.ts tests/dictionary.test.ts
git commit -m "feat(home): قاموس ذكين game logic with honest sample outputs"
```

---

### Task 3: Cast components and the new page

**Files:**
- Create: `src/components/home/home.module.css`, `src/components/home/useReducedMotion.ts`, `src/components/home/Doodle.tsx`, `src/components/home/QuestionFlip.tsx`, `src/components/home/Figure.tsx`, `src/components/home/Lineup.tsx`, `src/components/home/Story.tsx` (static in this task), `src/components/home/StartForm.tsx`, `src/components/home/Truths.tsx`, `e2e/home.spec.ts`
- Modify: `src/app/[lang]/page.tsx`, `src/lib/i18n.ts` (remove the `land` key from `Dict` and both languages), `e2e/fixtures/routes.ts:22` (home marker)
- Delete: `src/components/Landing.tsx`, `src/components/Sections.tsx` (their only importer is the homepage)

**Interfaces:**
- Consumes: Task 1 (`CAST`, `AGENT_CAST`, `STORM`, `SLOGAN`, `HOME`, `TRUTHS`, types).
- Produces:
  - `useReducedMotion(): boolean` (matchMedia, updates on change, `false` on the server)
  - `Doodle({ who, pose = "stand" }: { who: CastId; pose?: "stand" | "turn" })` → `<svg viewBox="0 0 200 480" data-cast={who} data-pose={pose}>` containing elements with `data-part` = `body`, `head`, `eyes`, `brows`, `arm-l`, `arm-r`, `prop`. **This part contract is the illustrator's delivery spec**; final SVGs replace placeholder bodies without code changes.
  - `QuestionFlip({ items, lang, delayMs = 0, paused = false }: { items: Question[]; lang: Lang; delayMs?: number; paused?: boolean })` → `aria-hidden` element `data-testid="qflip"`, one question visible, advancing every 2400 ms after `delayMs`; frozen on index 0 under reduced motion or `paused`.
  - `Figure({ member, lang, index }: { member: CastMember; lang: Lang; index: number })` → `<button data-testid="figure" data-cast={member.id}>` with QuestionFlip on top (`delayMs = index * 343`), Doodle, value line (largest), name; a visually hidden span holds the first question; `aria-label` = `${name} — ${value}`.
  - `Lineup({ lang }: { lang: Lang })` → section `data-testid="lineup"`, the eight Figures in `CAST` order plus the `HOME.aiLabel` label.
  - `StartForm({ lang }: { lang: Lang })` → GET form to `/${lang}/app/signup` with input `name="url"` (same contract as `src/components/UrlStart.tsx`, works without JS), button `HOME.cta[lang]`.
  - `Story({ lang }: { lang: Lang })` → section `data-testid="story"`; this task renders the static version: `<h1>` with `SLOGAN.line1` and a line with `SLOGAN.line2`, the owner Doodle, the storm as `STORM` spans `data-storm-q` carrying `data-agent` inside an element `data-testid="storm"`, and the finale block (`HOME.finaleWord`, `HOME.finaleLine`, `StartForm`).
  - `Truths({ lang }: { lang: Lang })`.

- [ ] **Step 1: Write the failing e2e test** in `e2e/home.spec.ts` and update the marker

In `e2e/fixtures/routes.ts` set the home entry's `unique` to `{ en: "Thakeen solves them", ar: "وذكين يحلها" }`.

```ts
import { test, expect, open, LANGS } from "./fixtures/app";

for (const lang of LANGS) {
  test.describe(`home · ${lang}`, () => {
    test("renders the slogan and all eight figures", async ({ page, failures }) => {
      void failures;
      await open(page, `/${lang}`);
      await expect(page.locator("h1")).toContainText(lang === "ar" ? "ذكين. الذكي المكين." : "Thakeen. Smart. Steadfast.");
      await expect(page.getByTestId("figure")).toHaveCount(8);
      await expect(page.getByTestId("storm").locator("[data-storm-q]")).toHaveCount(36);
    });
    test("reads Noor first in the reading direction", async ({ page }) => {
      await open(page, `/${lang}`);
      const first = await page.locator('[data-testid="lineup"] [data-cast="noor"]').first().boundingBox();
      const last = await page.locator('[data-testid="lineup"] [data-cast="you"]').first().boundingBox();
      expect(lang === "ar" ? first!.x > last!.x : first!.x < last!.x).toBe(true);
    });
    test("never scrolls sideways", async ({ page }) => {
      await open(page, `/${lang}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
}

test.describe("home without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("still shows the slogan, the lineup and a working start form", async ({ page }) => {
    await open(page, "/ar");
    await expect(page.locator("h1")).toContainText("ذكين");
    await expect(page.getByTestId("figure")).toHaveCount(8);
    await page.locator('form input[name="url"]').first().fill("example.sa");
    await page.locator('form input[name="url"]').first().press("Enter");
    await expect(page).toHaveURL(/\/ar\/app\/signup\?url=example\.sa/);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx playwright test e2e/home.spec.ts --project=chromium-desktop`
Expected: FAIL (old homepage: no `figure` test ids, old h1).

- [ ] **Step 3: Build the components and the page**

- `home.module.css`: root class `.home` defines `--ground: #f7f3f9; --ink: #2b193d;` the eight cast colours as `--c-<id>`, `--home-display` and `--home-body` (Global Constraints stack). Light ground, plum ink. The story is a normal block in this task (no sticky yet). Storm spans orbit with CSS keyframes (each span gets `--i` for radius and duration); under `prefers-reduced-motion: reduce` only the first storm question shows. Lineup: flex row; under 760 px it becomes a horizontal strip inside its own `overflow-x: auto` container, so the page itself never scrolls sideways. The value line is the largest type in a figure.
- `Doodle.tsx`: server-safe (no hooks). Placeholder drawing per cast member: a 3 px `var(--ink)` line figure, body filled with the member's colour, head circle, two eye dots in `data-part="eyes"`, two brow strokes, both arms, and one prop per spec §7.1 (phone on a small ring light, reading glasses and pocket calculator, scarf mid-stride, pearl and clipboard, bisht outline, headphones, phone to the ear; owner: none). `pose="turn"` mirrors the head and prop slightly.
- `page.tsx`: render `Nav`, then `<main className={styles.home}>` with `Story`, `Lineup`, a placeholder `<section id="dictionary" />` (Task 5 fills it), `Truths`, `Pricing`, `Faq`; then `Footer`. Remove every import of the deleted components.
- Delete `Landing.tsx` and `Sections.tsx`; remove the `land` key from `Dict` and both dictionaries in `src/lib/i18n.ts` after confirming with `grep -rn "\.land\b" src` that nothing else reads it.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx playwright test e2e/home.spec.ts e2e/public-pages.spec.ts` (both projects)
Expected: PASS.

- [ ] **Step 5: Commit**

Run `npm run check` and `npx next build` (both PASS), then:
```bash
git add -A src/components/home "src/app/[lang]/page.tsx" src/lib/i18n.ts e2e/home.spec.ts e2e/fixtures/routes.ts
git rm src/components/Landing.tsx src/components/Sections.tsx
git commit -m "feat(home): Thakeen lineup, static story and truths replace the old homepage"
```

---

### Task 4: Scroll story with GSAP

**Files:**
- Modify: `src/components/home/Story.tsx`, `src/components/home/home.module.css`, `package.json`, `package-lock.json`
- Test: `e2e/home.spec.ts`

**Interfaces:**
- Consumes: Task 3 (`Story` markup, `Doodle`, `QuestionFlip`, `StartForm`, `useReducedMotion`), Task 1 (`AGENT_CAST`, `STORM`, `HOME`).
- Produces: `Story` exposes `data-chapter` on its section (`0` hero, `1`–`7` agents in `AGENT_CAST` order, `8` finale) and sets `data-taken` on every storm question whose agent's chapter has been reached.

- [ ] **Step 1: Write the failing tests** (append to `e2e/home.spec.ts`)

```ts
test("the story walks the chapters and gives the questions back on the way up", async ({ page }) => {
  await open(page, "/ar");
  const story = page.getByTestId("story");
  const scrollTo = (f: number) => page.evaluate((f) => {
    const s = document.querySelector('[data-testid="story"]') as HTMLElement;
    window.scrollTo(0, s.offsetTop + (s.offsetHeight - window.innerHeight) * f);
  }, f);
  await scrollTo(0.5);
  await expect(story).toHaveAttribute("data-chapter", /^[3-5]$/);
  await scrollTo(1);
  await expect(story).toHaveAttribute("data-chapter", "8");
  await expect(story.getByText("موافق.")).toBeVisible();
  await scrollTo(0);
  await expect(story).toHaveAttribute("data-chapter", "0");
  await expect(story.locator("[data-storm-q]:not([data-taken])")).toHaveCount(36);
});

test.describe("home with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("shows no storm and keeps every question still", async ({ page }) => {
    await open(page, "/en");
    await expect(page.getByTestId("storm").locator("[data-storm-q]:visible")).toHaveCount(1);
    const q = page.getByTestId("qflip").first();
    const before = await q.textContent();
    await page.waitForTimeout(3000);
    expect(await q.textContent()).toBe(before);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx playwright test e2e/home.spec.ts --project=chromium-desktop -g "story|reduced"`
Expected: FAIL (`data-chapter` missing).

- [ ] **Step 3: Add GSAP and the choreography**

- Add `"gsap"` to `dependencies` at the current 3.x (`npm view gsap version`, caret range). Regenerate the lockfile per Global Constraints: copy `package.json` into an empty directory under `$TMPDIR`, run `npm install --package-lock-only --ignore-scripts` there, copy `package-lock.json` back, confirm `grep -c '@rolldown/binding-linux' package-lock.json` is above 0, then `npm install`.
- `Story.tsx` becomes a client component. The section is `900svh` tall with a sticky `100svh` stage. In an effect: `gsap.registerPlugin(ScrollTrigger)`, one `ScrollTrigger.create({ trigger, start: "top top", end: "bottom bottom", onUpdate })` mapping progress × 9 to chapter `min(8, floor(p))`; set React state only when the chapter changes; kill the trigger on cleanup. Under reduced motion there is no storm orbit; chapters still step.
- Stage: the owner Doodle on one side, the storm above its head, and the slogan; the other side shows the current agent (Doodle, value, name, `QuestionFlip`) entering on its chapter. Storm spans of agent k get `data-taken` once the chapter reaches k and move by CSS transition toward the agent side, then fade. Chapter 8 shows `HOME.finaleWord` fixed above the owner, `HOME.finaleLine` and `StartForm`.
- The stage paints the agent's colour over the ground in its chapter (CSS variable swap); text stays on a ground-coloured surface for contrast.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx playwright test e2e/home.spec.ts` (both projects)
Expected: PASS.

- [ ] **Step 5: Commit**

Run `npm run check` and `npx next build` (PASS; note the `/[lang]` first-load JS in the build output against the budget), then:
```bash
git add package.json package-lock.json src/components/home e2e/home.spec.ts
git commit -m "feat(home): scroll story, the storm leaves the owner chapter by chapter"
```

---

### Task 5: قاموس ذكين UI

**Files:**
- Create: `src/components/home/Dictionary.tsx`
- Modify: `src/app/[lang]/page.tsx` (replace the placeholder section), `src/components/home/home.module.css`
- Test: `e2e/home.spec.ts`

**Interfaces:**
- Consumes: Task 2 (`reduce`, `INITIAL`, `canAdvance`, `SECTORS`, `WORDS`, `samplePlan`, `sampleDraft`, `DICT_COPY`, `MAX_WORDS`), Task 3 (`Doodle`, `StartForm`).
- Produces: `Dictionary({ lang }: { lang: Lang })` → section `id="dictionary"` `data-testid="dictionary"` with `data-step` = current step.

- [ ] **Step 1: Write the failing test** (append)

```ts
test("plays steps 1 to 5 by keyboard with no request to the server", async ({ page }) => {
  await open(page, "/ar");
  const api: string[] = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/")) api.push(r.url()); });
  const game = page.getByTestId("dictionary");
  await game.getByLabel("وش اسم علامتك؟").fill("<b>قهوة</b>" + " ".repeat(10) + "x".repeat(100));
  await game.getByRole("radio", { name: "قهوة" }).check();
  await game.getByRole("button", { name: "التالي" }).press("Enter");
  await expect(game).toHaveAttribute("data-step", "2");
  for (const w of ["جريء", "دافي", "راقي", "شعبي", "هادي"]) await game.getByRole("button", { name: w }).press("Enter");
  await expect(game.getByText("اخترت ٥ من ٥")).toBeVisible();
  await game.getByRole("button", { name: "التالي" }).press("Enter");
  await game.getByRole("button", { name: "التالي" }).press("Enter");
  await expect(game).toHaveAttribute("data-step", "4");
  await expect(game.getByText("<b>قهوة</b>", { exact: false }).first()).toBeVisible();
  await game.getByRole("button", { name: "التالي" }).press("Enter");
  await game.getByRole("button", { name: "موافق" }).press("Enter");
  await expect(game).toHaveAttribute("data-step", "6");
  expect(api).toEqual([]);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx playwright test e2e/home.spec.ts --project=chromium-desktop -g "steps 1 to 5"`
Expected: FAIL (no `dictionary` section).

- [ ] **Step 3: Implement `Dictionary.tsx`**

Client component with `useReducer(reduce, INITIAL)`. A step rail shows `DICT_COPY.steps` with the current step marked in text as well as colour. Step 1: labelled input (`DICT_COPY.brandLabel`) and a radio group of `SECTORS` (`DICT_COPY.sectorLabel`); Noor's greeting bubble once a brand is typed. Step 2: the twelve `WORDS` as toggle buttons with `aria-pressed`, the counter `DICT_COPY.counter` with `{n}` as an Arabic-Indic digit in `/ar`, and the last picked word's reaction bubble from its agent. Steps 3–4: `samplePlan` / `sampleDraft` cards, each tagged `DICT_COPY.example`. Step 5: one large `DICT_COPY.approve` button with `approveNote`. Steps 6–7: preview cards (`analysis`, `measure`). After step 7: `DICT_COPY.cta` above `StartForm`. The brand renders as text, never HTML. Next/Back follow `canAdvance`; focus moves to the new step's heading on change.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx playwright test e2e/home.spec.ts` (both projects)
Expected: PASS.

- [ ] **Step 5: Commit**

Run `npm run check` and `npx next build` (PASS), then:
```bash
git add src/components/home "src/app/[lang]/page.tsx" e2e/home.spec.ts
git commit -m "feat(home): قاموس ذكين, seven steps, no server calls"
```

---

### Task 6: Life in the lineup

**Files:**
- Modify: `src/components/home/Lineup.tsx`, `src/components/home/Figure.tsx`, `src/components/home/home.module.css`
- Test: `e2e/home.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`BANTER`), Task 3 (`Figure`, `Doodle` part contract, `useReducedMotion`).
- Produces: speech bubbles as `data-testid="bubble"` inside the speaking figure; `Doodle` gets `pose="turn"` while its figure is hovered or focused.

- [ ] **Step 1: Write the failing test** (append)

```ts
test("the team talks and turns to you", async ({ page }) => {
  await open(page, "/en");
  const lineup = page.getByTestId("lineup");
  await lineup.scrollIntoViewIfNeeded();
  await expect(lineup.getByTestId("bubble").first()).toBeVisible({ timeout: 12000 });
  const noor = lineup.locator('[data-cast="noor"]').first();
  await noor.hover();
  await expect(noor.locator("svg")).toHaveAttribute("data-pose", "turn");
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx playwright test e2e/home.spec.ts --project=chromium-desktop -g "talks"`
Expected: FAIL (no bubbles).

- [ ] **Step 3: Implement the behaviour**

- `Lineup` (client): every 8000 ms start the next `BANTER` exchange, showing its lines one at a time for 2200 ms each in a bubble above the speaker; pause while the lineup is off screen (IntersectionObserver) or the tab is hidden. Under reduced motion bubbles still appear and disappear, without movement.
- One `pointermove` listener on the lineup sets `--gx` / `--gy` (clamped to ±3 px) and `[data-part="eyes"]` translates by them. CSS blink on `eyes` (scaleY, every 4–6 s, delay from the figure index) and a 1 px breathing loop on `body`. All three are off under reduced motion.
- `Figure` tracks hover and focus, passes `pose="turn"` to `Doodle` and `paused` to its `QuestionFlip`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx playwright test e2e/home.spec.ts` (both projects)
Expected: PASS.

- [ ] **Step 5: Commit**

Run `npm run check` and `npx next build` (PASS), then:
```bash
git add src/components/home e2e/home.spec.ts
git commit -m "feat(home): banter, eye contact and breathing in the lineup"
```

---

### Task 7: Docs, budgets, preview

**Files:**
- Modify: `docs/system/tests.md` (new rules), `docs/system/architecture.md` §2.2 (home content from `src/lib/home.ts` and `src/lib/dictionary.ts`, components in `src/components/home/`)

**Interfaces:**
- Consumes: everything above.
- Produces: an open PR with green CI and a checked Vercel preview; no merge.

- [ ] **Step 1: Document the rules** in `docs/system/tests.md`: home questions map to real agent tasks (`tests/home-copy.test.ts`); game samples carry no digits and the game sends no request (`tests/dictionary.test.ts`, `e2e/home.spec.ts`); reduced motion stills the page (`e2e/home.spec.ts`).

- [ ] **Step 2: Full verification**

Run: `npm run check` → PASS. `npx next build` → PASS, and the `/[lang]` first-load JS grows by less than 90 KB gzipped against the same build on `main`. `npx playwright test` → PASS on both projects.

- [ ] **Step 3: Commit, push, open the PR** (ask the founder before pushing)

```bash
git add docs/system/tests.md docs/system/architecture.md
git commit -m "docs: record the new homepage rules and structure"
git push -u origin claude/nahr-opus-homepage-a8cf3d
gh pr create --title "Thakeen homepage (hold: launch gates in spec §9)" --body "<summary, spec link, launch gates from spec §9>"
```

- [ ] **Step 4: Check the preview**

Open the PR's Vercel preview: `/ar` and `/en` load, the story scrolls to «موافق.», the game reaches step 7, and the start form lands on signup with the URL. Record the result in the PR. Leave it unmerged until spec §9 is cleared.
