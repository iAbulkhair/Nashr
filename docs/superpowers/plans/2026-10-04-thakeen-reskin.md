# Thakeen re-skin to prototype D — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The whole site and app wear prototype D: D's palette with a colour per agent, Thmanyah headings over IBM Plex body, hand-drawn strokes; the homepage becomes D.

**Architecture:** One token source (`assets/design-tokens.json` → `src/app/tokens.css` → `@theme inline` in `globals.css`). Old palette names survive as aliases until slice 4, so slice 1 re-colours everything at once and later slices rename utilities file by file. D's `scribble.js` becomes a pure TS module plus a client component that renders on the server first and redraws at real size.

**Tech Stack:** Next.js 16 app router, React 19, Tailwind v4 (`@theme inline`), CSS modules, Vitest (node env, source-reading tests as in `tests/fonts.test.ts`), Playwright (`e2e/`, Chromium + WebKit).

**Spec:** `docs/superpowers/specs/2026-10-04-thakeen-reskin-design.md` (approved 2026-10-04). Replaces the homepage built by `docs/superpowers/plans/2026-09-28-thakeen-homepage.md`. Reference D: `thakeen-prototypes.vercel.app/d` and its `kit.css`, `figures.css`, `figures.js`, `scribble.js` (fetch with curl; never copy `/f/` fonts).

## Global Constraints

- Colours: ink #2b193d, muted #5d4a70, paper #fff, ground #f7f3f9, lilac #efe7f7, lemon #f9f871, gold #c9a227 (figure strokes only), danger #cc0000 (error text and borders only; error boxes are rose `agent-sami` fill with ink text).
- Agents: noor #f9f871, sami #ff5da2, razan #00d9ff, faris #b517ff, dana #14b8a6, majed #2b193d, layan #3fcf7e, reem #ff8a1f, you #fff. Fills and strokes only, never text colour; faris and majed fills carry paper text.
- Strokes: pen 1.25px, figure 1.5px, fine 1px, gold 1.75px, focus 2px (ink outline, offset 2px).
- Type: `--font-display` (Thmanyah Serif Display) for h1-h3 and large type; `--font-body` (IBM Plex Sans Arabic) for the rest. D scale 16 / 17 body / 21 / clamp(26px, 4vw, 40px).
- Motion: 150 / 200 / 300 ms, easing `cubic-bezier(.22,1,.36,1)`. No overshoot curve (no control-point y outside 0-1), no transition of width or height, everything decorative stops under `prefers-reduced-motion: reduce` and under the page's motion toggle. D's own `(.3,1.5,.5,1)` / `(.3,1.6,.5,1)` curves are replaced by the standard easing.
- No drop shadows. No hex outside `tokens.css`/`design-tokens.json`. Oasis green and saffron yellow gone by the end of slice 4.
- App screens: quiet D (plain 1.5px ink lines, scribbles only on primary buttons, empty states, agent avatars, section titles). Marketing pages: fully hand-drawn.
- Copy: no invented number, customer, logo, testimonial or result promise; never name the AI model; Arabic Gulf register as in D.
- Every commit: `npm run check` and `npx next build` (outside the sandbox) pass. Rules 510-517 are this work's; 518-529 reserved for it. Each rule gets a test and a row in `docs/system/tests.md`.
- Never merge to main, never deploy production, without the founder's words «انشرها على الموقع الحي». Each slice ends on a Vercel preview of `claude/thakeen-reskin`.

## Review Focus

- 360px Arabic with the longest names and nav labels: nothing overflows, no sideways scroll → `e2e/reskin-layout.spec.ts` (Task 5) asserts `scrollWidth <= innerWidth` and no element's right edge beyond the viewport.
- Reduced motion or motion toggle off: floating doodles, seams, boil and cloud motion stop → Task 8 e2e step runs with `reducedMotion: "reduce"` and asserts `document.getAnimations().length === 0`.
- Keyboard and touch on the lineup: Tab and tap select a figure, show its tag colour and cloud, Escape clears, focus ring visible → Task 8 e2e step.
- Windows forced colours: scribbles hide, real borders appear → Task 3 test asserts the `@media (forced-colors: active)` block in `scribble.css`.
- First paint without JS: scribbles are in the server HTML, so no layout shift → Task 3 test renders `<Scribble>` with `renderToString` and finds `<svg` with a non-empty `d`.

---

## Slice 1 — tokens and chrome

### Task 1: Token source, D palette, aliases (rule 510)

**Files:**
- Modify: `assets/design-tokens.json`, `src/app/tokens.css` (header says "kept by hand from assets/design-tokens.json"), `src/app/globals.css:10-25` (`@theme inline`), `src/lib/home.ts:75-187` (cast `color` → `var(--color-agent-<id>)`), `src/components/home/home.module.css:6-21` (drop local palette copies)
- Test: `tests/design-tokens.test.ts`

**Interfaces:**
- Produces CSS variables and Tailwind utilities: `--color-{ink,muted,paper,ground,lilac,lemon,gold,danger}`, `--color-agent-{noor,sami,razan,faris,dana,majed,layan,reem,you}`, `--stroke-{pen,figure,fine,gold,focus}`, `--ease-out` = `cubic-bezier(.22,1,.36,1)`, `--duration-{fast,normal,slow}` = 150/200/300ms. Semantic layer re-pointed: background=ground, background-muted=lilac, surface=paper, foreground=ink, primary=ink, primary-foreground=paper, accent=lemon, accent-foreground=ink, danger=#cc0000, danger-foreground=paper, inverse-background=ink, inverse-surface=ink, inverse-foreground=paper, inverse-muted=lilac, ring=ink; components (`--button-*`, `--input-*`, `--card-*`) follow.
- Aliases in `@theme inline` (deleted in Task 19): `oasis`→ink, `oasis-deep`→`color-mix(in oklab, var(--color-ink) 85%, black)`, `saffron`→lemon, `sadu`/`sadu-deep`→danger, `salt`→ground, `salt-dim`→lilac, `mist`→lilac, `mist-dim`→`color-mix(in oklab, var(--color-lilac) 75%, var(--color-ink))`, `white`→paper.

- [ ] **Step 1: Write the failing test** `tests/design-tokens.test.ts`, describe "the palette is prototype D's (rule 510)": parse `tokens.css`; `it("defines D's base, highlight, figure and error colours")` expects the eight base values above; `it("gives each of the nine cast members D's colour")` expects the agent map; `it("keeps no oasis, saffron, sadu, salt or mist hex")` expects none of `#0F3D3A #0A2B29 #061C1B #F2B33D #F5C25E #D99A1F #D9503F #B93F30 #101418 #E9F0EC #A9BFB8 #F6F4EE #EBE7DC` (case-insensitive) in `tokens.css` or `design-tokens.json`; `it("matches design-tokens.json value for value")`; `it("the homepage cast reads its colour from the tokens")` expects every `CAST[i].color` to equal `var(--color-agent-${id})`.
- [ ] **Step 2:** `npx vitest run tests/design-tokens.test.ts` → FAIL on the first value.
- [ ] **Step 3:** Rewrite the JSON (primitive palette = D names, semantic and component layers as above), mirror it in `tokens.css`, add the `@theme inline` entries and aliases, point `home.ts` colours at the tokens, point `.doodle[data-cast]` fills in `home.module.css` at `var(--color-agent-<id>)` and drop its local `--c-*`/`--ink`/`--paper`/`--ground`.
- [ ] **Step 4:** test passes; `npm run check` passes (adjust `tests/home-copy.test.ts` only if it pins old hex).
- [ ] **Step 5:** Rows 510 and the reservation of 511-529 in `docs/system/tests.md`; palette section of `docs/Design_System.md`; commit `feat(reskin): prototype D palette as the one token source (rule 510)`.

### Task 2: Base classes, motion lint fixes, sadu band out (rule 511)

**Files:**
- Modify: `src/app/globals.css` (`.btn*`, `.card*`, `.input*`, `.badge*`, `.page-title`, `.section-title`, `.eyebrow*`, `::selection`, `:focus-visible`, `.journey-fill`, `.pop-in` + `@keyframes pop`; remove `.sadu`/`.sadu-thin`), `src/components/app/JourneyCard.tsx:153`, `src/components/app/ChatPanel.tsx:747`, every file using `sadu-thin`/`className="sadu"` (`customers`, `resources`, `updates`, `enterprise`, `agents`, `agents/[agent]`, `for/[industry]` pages, `Pricing.tsx`, `Hero.tsx`, `Footer.tsx`)
- Test: `tests/motion-css.test.ts`

**Interfaces:**
- Consumes Task 1 tokens. Produces `.btn-primary` (ink fill, paper text, hover `oasis-deep` value), `.btn-accent` (lemon fill, ink text, 1.5px ink border), `.btn-secondary` (transparent, 1.5px ink at 25% → 100% on hover), `.card` (paper, 1.5px solid ink at 15%, radius `--primitive-radius-sm`, no shadow), `.input` (1.5px ink at 25%, focus: ink border + 2px ink outline), `.badge-*` on lilac/lemon/rose fills with ink text, `.eyebrow` muted. `.journey-fill` is full width with `transform: scaleX(var(--p))`, `transform-origin: left` (`right` under `[dir=rtl]`), `transition: transform var(--duration-slow) var(--ease-out)`; markup passes `style={{ "--p": pct / 100 }}`.

- [ ] **Step 1: Write the failing test** `tests/motion-css.test.ts`, describe "motion stays calm (rule 511)": glob `src/**/*.css`; `it("uses no overshoot easing")` — every `cubic-bezier(a,b,c,d)` has `0 <= b <= 1` and `0 <= d <= 1`; `it("never transitions width or height")` — no `transition` / `transition-property` value naming `width`, `height`, `max-height` or `all`; `it("the progress fill grows by transform")` — `.journey-fill` contains `scaleX` and no `width` transition, and `JourneyCard.tsx`/`ChatPanel.tsx` pass `--p`, not `width`.
- [ ] **Step 2:** run → FAIL (the width transition near L173, `.2,.9,.3,1.3` near L181; `@keyframes pop` 60% scale(1.08) becomes scale(.6) → scale(1)).
- [ ] **Step 3:** Apply the class changes; replace each `sadu-thin`/`sadu` band with a 1.5px ink rule (`border-t-[1.5px] border-ink`), swapped for `<Scribble kind="divider">` in Task 4; fix anything else the test flags.
- [ ] **Step 4:** test + `npm run check` pass.
- [ ] **Step 5:** row 511; commit `feat(reskin): D base classes; progress grows by transform, no overshoot (rule 511)`.

### Task 3: Scribble pen (rule 512)

**Files:**
- Create: `src/lib/scribble.ts` (typed port of D's `scribble.js`), `src/components/Scribble.tsx` (client), `src/app/scribble.css` (D's `kit.css` `.scribble`/`.s-*` rules on tokens with D's half-weight pen values, imported from `globals.css`)
- Test: `tests/scribble.test.ts`

**Interfaces:**
- `export type ScribbleKind = "box" | "bubble" | "circleLoop" | "cloud" | "divider" | "pill" | "puddle" | "stamp" | "strike" | "swash" | "tape" | "tick" | "underline";`
- `export type ScribbleOpts = { tail?: "bottom" | "start" | "end" | "none"; tailAt?: number; rtl?: boolean; heavy?: boolean };`
- `export type ScribbleArt = { d: string; fill?: string; cap?: string; capFill?: string };`
- `export function scribble(kind: ScribbleKind, w: number, h: number, seed: string, opts?: ScribbleOpts): ScribbleArt` — same FNV-1a seed and PRNG as `scribble.js`, coordinates rounded to 0.1.
- `<Scribble kind seed fill? shadow? boil? tail? w? h? />` — renders `<svg class="scribble" aria-hidden viewBox="0 0 w h" preserveAspectRatio="none">` with `.s-art` paths (fill, shadow, main, boil, ring), absolutely placed in its parent. Server render uses `w`/`h` (defaults: box 240×64, pill 160×48, underline 120×10, cloud 280×120, bubble 240×80, others 64×64); after mount a `ResizeObserver` on the parent redraws at real size. `fill` takes a token (`paper`, `ink`, `lemon`, `lilac`, `agent-<id>`) or any CSS colour expression.

- [ ] **Step 1: Write the failing test** `tests/scribble.test.ts`, describe "the pen draws the same line for the same seed (rule 512)": `it("is deterministic")`; `it("varies with the seed")`; `it("draws every kind")` — all 13 kinds at 200×60 give a non-empty `d` matching `/^[MCQLZ0-9 .\-]+$/` with finite numbers; `it("keeps a box near its frame")` — every x in `scribble("box",200,60,"s").d` lies in [-8, 208]; `it("renders on the server")` — `renderToString(<Scribble kind="box" seed="t" />)` contains `<svg` and `d="M`; `it("hides in forced colours and keeps real borders")` — `scribble.css` has `@media (forced-colors: active)` hiding `.scribble` and bordering `.s-btn`, `.s-card`, `.s-input`.
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3:** Port the 13 shapes with readable names, then the component and the CSS.
- [ ] **Step 4:** test + `npm run check` pass.
- [ ] **Step 5:** row 512; commit `feat(reskin): the scribble pen as a module and a server-first component (rule 512)`.

### Task 4: Chrome — Nav, Footer, app shell (rule 513 starts)

**Files:**
- Modify: `src/components/Nav.tsx`, `src/components/Footer.tsx`, `src/components/LangToggle.tsx`, `src/app/[lang]/app/layout.tsx` (signed-out header, impersonation bar), `src/components/app/Sidebar.tsx`, `src/components/app/TrialBanner.tsx`, `src/components/app/LimitModal.tsx`; the Task 2 ink rules become `divider` scribbles
- Test: `tests/palette-clean.test.ts`

**Interfaces:**
- Consumes Tasks 1-3. Produces `CLEAN: string[]` in the test — files that must hold no old palette name; each later task appends its files; Task 19 replaces it with all of `src/`.
- Nav as D's header: ground bar with a 1.5px ink bottom line, ink wordmark (no saffron dot), ink links with an `underline` scribble on hover, focus and `aria-current`, dropdowns on paper inside a `box` scribble, CTA `s-btn s-btn--ghost` with a lemon `pill`. Footer: ground, `divider` scribble on top, wordmark, muted text, ink links. Sidebar (quiet): paper, 1.5px ink line, active item lilac fill with ink text, agent avatars on their agent fill.

- [ ] **Step 1: Write the failing test** `tests/palette-clean.test.ts`, describe "files moved to D use only D's names (rule 513)": for each file in `CLEAN`, `it(file)` expects no `/\b(oasis|saffron|sadu|salt|mist)(-deep|-dim)?\b/` and no `#[0-9a-f]{6}` outside comments; `it("the wordmark carries no dot")` — `Nav.tsx` and `app/layout.tsx` have no `rounded-full bg-` dot after `Wordmark`/`appName`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Restyle the files.
- [ ] **Step 4:** test + `npm run check` + `npx next build` pass.
- [ ] **Step 5:** row 513; commit `feat(reskin): D chrome for nav, footer and the app shell (rule 513)`.

### Task 5: Layout matrix and slice 1 preview

**Files:**
- Create: `e2e/reskin-layout.spec.ts`
- Modify: `playwright.config.ts` (a `webkit` project limited to `reskin-*.spec.ts`, only when `E2E_WEBKIT=1`, so CI is unchanged)

**Interfaces:**
- Produces `PAGES: string[]` (paths after the lang prefix) that Tasks 8, 10-18 extend, and the helper `noSideways(page)`.

- [ ] **Step 1:** Write the spec: for `lang` in `ar`, `en`, width in 1440/1024/768/390/360 (height 900), each path in `PAGES` (start: `""`, `/pricing`, `/app/login`): goto, `expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)`, and no visible element in `body *` with `getBoundingClientRect().right > innerWidth + 1` or `.left < -1` (skip `aria-hidden` decor inside an `overflow: clip` parent); full-page screenshot to `e2e/.output/reskin/<lang>-<w>-<slug>.png`.
- [ ] **Step 2:** `npx next build && npx next start -p 3210` (outside the sandbox), then `E2E_WEBKIT=1 npx playwright test e2e/reskin-layout.spec.ts` → PASS in Chromium and WebKit; look at the screenshots.
- [ ] **Step 3:** Commit `test(reskin): layout matrix across five widths, two languages, two engines`; push; open a **draft** PR "Thakeen re-skin to prototype D" against main (body: spec and plan links, slice checklist, "never merge without «انشرها على الموقع الحي»"). Follow `~/.claude/projects/-Users-ihejazy-projects-nashr/memory/nashr-deploy-verification.md` and re-run the spec against the Vercel preview with `E2E_BASE_URL`.
- [ ] **Step 4:** Send the founder the preview link and 4 screenshots (ar 1440 home, ar 390 home, en 1024 pricing, ar 360 app login). Stop for their word before slice 2.

## Slice 2 — homepage

### Task 6: Homepage copy from D (rule 514)

**Files:**
- Modify: `src/lib/home.ts` (add `HERO`, `RULES`, `DAY`, `STEPS`, `HOME_FAQ`; remove `BANTER`, `TRUTHS`, `SLOGAN` or others only when nothing imports them — keep every export `Dictionary.tsx` imports), `tests/home-copy.test.ts`

**Interfaces:**
- `HERO: { issue: L; tbox: L; offer: L; offerSwash: L; hint: L; hintTouch: L }`, `RULES: { title: L; story: L; who: HomeAgentId[] }[]` (4), `DAY: { cap: L; text: L; who: CastId }[]` (4), `STEPS: { title: L; body: L; who: HomeAgentId }[]` (7), `HOME_FAQ: { q: L; a: L }[]`. Text verbatim (Arabic and English) from D's dictionary in `d.html`, minus the prototype notes (`draft`, `foot`), the start panel (`p8*`), and anything the tests reject.

- [ ] **Step 1: Write the failing tests** in `tests/home-copy.test.ts`, describe "the D homepage copy is true (rule 514)": four rules, four day panels, seven steps, every `who` a real cast id; `it("names no AI model")` — no `/Claude|Anthropic|GPT|OpenAI|Gemini|Opus|Sonnet|Haiku/i` in any string; `it("has no number but a clock time")` — Latin or Arabic-Indic digits only in `DAY[].cap`; `it("promises nothing NOT_YET lists")` — the file's `promises()` on every string; the existing "eight agents then the owner" stays.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Add the exports and copy.
- [ ] **Step 4:** tests + `npm run check` pass.
- [ ] **Step 5:** row 514; commit `feat(reskin): homepage copy from prototype D, checked for truth (rule 514)`.

### Task 7: Lineup that wraps (rule 515)

**Files:**
- Modify: `src/components/home/Lineup.tsx` (rewrite), `src/components/home/Figure.tsx` (only if its props change), `src/components/home/home.module.css` (lineup block)
- Test: `tests/lineup-css.test.ts`

**Interfaces:**
- `export default function Lineup({ lang }: { lang: Lang })` stays. Markup: `<ul class="cast">` of nine `<li><button class="who" data-id aria-pressed>`, each with a `puddle` scribble on the agent fill, the `Figure`, and a name tag (`box` scribble, fill `var(--tag)`); one thought cloud (`cloud` scribble) absolutely placed above the row with that agent's questions, mirrored into an `aria-live="polite"` node.
- CSS: `.cast { display:flex; flex-wrap:wrap; justify-content:center }`, `li { flex: 0 0 calc(100% / 3) }`, `@media (min-width:600px) { li { flex-basis: calc(100% / 5) } }`, `@media (min-width:1200px) { li { flex-basis: calc(100% / 9) } }`, `.fig { width: clamp(70px, 12vw, 92px) }`; chosen (`:hover`, `:focus-visible`, `[aria-pressed=true]`) `.fig { transform: scale(1.25); transform-origin: 50% 100% }`, `transition: transform var(--duration-normal) var(--ease-out)`, `--tag: var(--color-agent-<id>)` (paper text on faris and majed). The cloud and tag never change layout.

- [ ] **Step 1: Write the failing test** `tests/lineup-css.test.ts`, describe "the lineup wraps and the chosen figure grows in place (rule 515)": the three flex-basis rules at no query / 600px / 1200px; `.fig` width clamps 70px-92px; every rule whose selector has `:hover`, `:focus-visible` or `aria-pressed` sets only `transform`, colours or custom properties other than `--w` — no `width`, `height`, `flex`, `margin`, `padding`; `Lineup.tsx` renders `CAST` in order.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Rewrite. Tap toggles `aria-pressed` (one at a time); Escape and an outside tap clear; reduced motion keeps the scale, drops the transition.
- [ ] **Step 4:** tests + `npm run check` pass.
- [ ] **Step 5:** row 515; commit `feat(reskin): the lineup wraps 9 / 5+4 / 3+3+3 and grows by transform (rule 515)`.

### Task 8: Homepage sections and order (rule 516)

**Files:**
- Create: `src/components/home/{Cover,Rules,Day,Steps,Plans,HomeFaq,Decor}.tsx`
- Modify: `src/app/[lang]/page.tsx`, `src/components/home/home.module.css` (D's section CSS on tokens; delete the Story/Truths/QuestionFlip/StartForm rules), `src/components/Nav.tsx` (on the homepage, anchors `#team #rules #day #steps #price #faq`), `e2e/reskin-layout.spec.ts`
- Delete: `Story.tsx`, `Truths.tsx`, `QuestionFlip.tsx`, `StartForm.tsx` when nothing else imports them. Keep `Dictionary.tsx`.
- Test: `tests/home-order.test.ts`

**Interfaces:**
- Consumes Task 6 exports, Task 7 `Lineup`, `Scribble`, `Doodle`, `Wordmark`, and `PLAN_PRICE_SAR`, `PLAN_CREDITS`, `PLAN_SEATS`, `PUBLIC_TIERS` from `src/lib/pricing.ts` (Plans never hard-codes a price; Agency links to `/enterprise`). `Cover` = issue stamp, masthead with `Wordmark` + ink `tbox`, offer with lemon `swash`, hint, `Lineup`. `Decor` = D's floating doodles and seams, `aria-hidden`, stopped by reduced motion and the motion toggle (`useMotionPaused`).

- [ ] **Step 1: Write the failing test** `tests/home-order.test.ts`, describe "the homepage is D, without the game (rule 516)": `page.tsx` renders `Cover, Rules, Day, Steps, Plans, HomeFaq` in that order and imports none of `Dictionary`, `Story`, `Truths`; section ids `team, rules, day, steps, price, faq`; `Plans.tsx` imports `@/lib/pricing` and holds no three-digit literal.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Build the sections from D's markup and CSS (tokens only, bounce curves replaced). In `e2e/reskin-layout.spec.ts` add for `""`: Tab to the first figure → its tag background is the agent colour and the cloud has text; Escape clears; hovering one figure leaves every other figure's rect unchanged; under `reducedMotion: "reduce"`, `document.getAnimations().length === 0`.
- [ ] **Step 4:** unit tests + `npm run check` + `npx next build` pass; the e2e spec passes locally in both engines.
- [ ] **Step 5:** row 516; append the homepage files to `CLEAN`; commit `feat(reskin): the homepage becomes prototype D (rule 516)`.

### Task 9: Slice 2 preview

- [ ] **Step 1:** Push; run `e2e/reskin-layout.spec.ts` against the preview in both engines. PASS.
- [ ] **Step 2:** Send the founder the link and screenshots (ar 1440 hero, ar 360 lineup, en 768 steps, ar 390 plans). Stop for their word before slice 3.

## Slice 3 — marketing pages

Routine for each task: rename old utilities to D names in its files; section headings in display type with an `underline` scribble; cards to `s-card` with a `box` scribble; buttons to `s-btn` (primary ink fill, ghost lemon); agents shown with their `Doodle` on their fill; append the files to `CLEAN` and the paths to `PAGES`; `npm run check`, `npx next build`, the matrix for those paths in both engines; commit `feat(reskin): <group> in D`.

### Task 10: Pricing — `pricing/page.tsx`, `src/components/Pricing.tsx`, `Faq.tsx`, `FinalCta.tsx`
### Task 11: Agents — `agents/page.tsx`, `agents/[agent]/page.tsx`
### Task 12: Sectors and comparisons — `for/[industry]`, `vs/[competitor]`, `ai-marketing-agent`, `customers`, `enterprise`, `src/components/Hero.tsx`, `ContactForm.tsx`, `UrlStart.tsx`
### Task 13: Content — `tools`, `tools/[tool]`, `ToolForm.tsx`, `blog`, `blog/[slug]` (`.prose-nashr` in `globals.css`), `help`, `HelpCenter.tsx`, `resources`, `updates`, `WishSuggest.tsx`, `WishVote.tsx`
### Task 14: Legal and edges — `affiliates`, `affiliates/terms`, `AffiliateForm.tsx`, `privacy`, `terms`, `not-found.tsx`, `error.tsx`, `[...rest]`, `src/app/global-error.tsx`

### Task 15: Slice 3 preview — as Task 9 with every marketing path in `PAGES`; screenshots: pricing ar 390, agent page en 1440, blog post ar 768, 404 ar 360. Stop for the founder's word.

## Slice 4 — app screens (quiet D)

Same routine as slice 3 with the quiet rules: tables and forms keep plain 1.5px ink lines; scribbles only on primary buttons, empty states, agent avatars and page titles; error text `text-danger`, error boxes `bg-agent-sami text-ink`. Signed-in paths in `PAGES` use the storage state from `e2e/auth.setup.ts`.

### Task 16: Auth and start — `app/login`, `signup`, `forgot`, `reset`, `join`, `start`, `onboarding` and their components in `src/components/app/`
### Task 17: Work — `app/page.tsx`, `chat`, `conversations`, `todo`, `tasks`, `calendar`, `files`, `brands`, `generate`, `inspo` with their components (`ChatPanel.tsx`, `JourneyCard.tsx`, …)
### Task 18: Account — `billing`, `refer`, `partner`, `profile`, `team`, `notifications`, `integrations`, `mcp`, `governance`, `reports`, `activity`, `help`, `admin` with their components

### Task 19: Remove the aliases (rules 513 final, 517)

**Files:** `src/app/globals.css` (alias lines), `tests/palette-clean.test.ts`, `tests/agent-colour.test.ts`, `docs/Design_System.md`, `docs/system/tests.md`

- [ ] **Step 1:** `CLEAN` becomes every `.ts`, `.tsx`, `.css` under `src/`; add `tests/agent-colour.test.ts`, describe "agent colours are fills, never text (rule 517)": no `text-agent-`, `decoration-agent-`, `placeholder-agent-` utility and no `color: var(--color-agent-` in `src/`.
- [ ] **Step 2:** run → FAIL wherever an old name is left; fix those files.
- [ ] **Step 3:** delete the aliases; `npm run check` + `npx next build` pass.
- [ ] **Step 4:** rows 513 (final wording) and 517; `Design_System.md` describes D tokens, strokes, scribble kinds and the quiet/loud split; commit `feat(reskin): old palette names removed; agent colours never text (rules 513, 517)`.

### Task 20: Whole-branch review

- [ ] **Step 1:** One reviewer over the full diff (`superpowers:requesting-code-review`): tenant and auth code untouched, no invented copy, no model named, no hex outside tokens, reduced motion honoured.
- [ ] **Step 2:** Fix findings; `npm run check` + `npx next build`.

### Task 21: Slice 4 preview and hand-over

- [ ] **Step 1:** Matrix over every path in both engines against the preview. PASS.
- [ ] **Step 2:** Mark the PR ready for review; send the founder the link and screenshots (chat ar 1440, todo ar 390, billing en 1024, login ar 360). Merge and production only on «انشرها على الموقع الحي».
