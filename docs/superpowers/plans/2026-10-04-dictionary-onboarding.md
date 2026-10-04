# Dictionary onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new owner's first screen (`/app/start`) is the قاموس ذكين game; its answers become the brand file, through the site crawl or without a site.

**Architecture:** The pure reducer in `src/lib/dictionary.ts` gains answer types, validation and the answers-to-brand mapping. The confirm route stores validated answers beside the confirmed URL under `sc(u)`; the build reads them from there and writes name, industry and tone over the model's values. A new client game component replaces `StartWizard` on `/app/start`; its step 7 holds the moved URL form and a no-site form that saves through the existing `PUT /api/brand`.

**Tech Stack:** Next.js 16 app router, React 19 `useReducer`, Upstash Redis via `src/lib/db.ts`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-dictionary-onboarding-design.md` (approved by the founder 2026-10-04, all three decisions).

## Global Constraints

- Every read and write of answers or brand uses `sc(u)`; no Redis key from request data. Answers key: `onboardgame:${scope}`.
- Answers write: `can(u, "onboard")` (confirm route, unchanged gate). Brand write without a site: `PUT /api/brand`, `brand.write`, unchanged.
- The game is shown only when `can(u, "onboard") && can(u, "brand.write")` and `getBrand(sc(u))` is empty.
- Do not edit `src/app/[lang]/page.tsx` or `src/components/home/*`. `src/lib/dictionary.ts` keeps its existing exports unchanged.
- Colours from the app's existing Tailwind tokens (`oasis`, `saffron`, `ink`, `salt`, `sadu`…); no hex in new components.
- Samples stay tagged «مثال». No invented numbers or results; never name the model.
- Brand and user text rendered as text only (no `dangerouslySetInnerHTML`).
- Test rules 520-526 (block 520-529 claimed; 510-519 left for the re-skin session).
- Before each commit: `npm run check`. Before push: `npx next build` (outside the sandbox).

## Review Focus

- A brand name like `<b>$&</b>` or with trailing spaces: stored verbatim, trimmed, ≤40, never interpreted (Task 1 test).
- An owner who confirms with answers, then re-confirms without them (older tab): the stale answers are dropped, not applied (Task 2 test).
- An owner whose account language is Arabic plays the English page: industry and tone are stored in English, the language played (Task 1 and Task 2 tests).
- Answers confirmed in one brand's scope are never applied to another brand's build (Task 2 test).
- An owner who already has a brand opens `/app/start`: redirected to `/app`, so the no-site save cannot overwrite the brand (Task 3 test).

---

### Task 1: Answers in `src/lib/dictionary.ts` (rules 520, 521)

**Files:**
- Modify: `src/lib/dictionary.ts` (append; existing exports unchanged)
- Test: `tests/dictionary-onboarding.test.ts` (new)

**Interfaces:**
- Produces:
  - `type GameAnswers = { brand: string; sector: SectorId; words: WordId[]; lang: Lang }`
  - `parseAnswers(raw: unknown): GameAnswers | null` — null unless: object; `brand` string whose `trim()` is 1-40 chars (stored trimmed); `sector` in `SECTORS`; `words` array of exactly `MAX_WORDS` distinct ids in `WORDS`; `lang` `"ar"|"en"`.
  - `answersOf(s: DictState, lang: Lang): GameAnswers | null` — `parseAnswers({ brand: s.brand, sector: s.sector, words: s.words, lang })`.
  - `answersToBrand(a: GameAnswers): { name: string; industry: string; tone: string }` — name = `a.brand`; industry = sector `name[a.lang]`; tone = the words' `tone[a.lang]` joined with `"، "` (ar) / `", "` (en), in pick order.
  - `answersHint(a: GameAnswers): string` — one line for the model, e.g. `Owner's own answers: brand name "<name>"; sector <industry>; voice: <tone>. Use them as given.` (English for both languages; the model reads it).
  - `noSiteBrand(a: GameAnswers, products: string, audience: string)` → the `PUT /api/brand` body: `{ ...answersToBrand(a), products: products.trim(), audience: audience.trim(), dialect: a.lang === "en" ? "english" : "saudi", languages: [a.lang] }`.
  - `START_COPY` (type `L` per entry): `steps6` «تحليل وقياس» / "Analysis and measurement"; `steps7` «انطلق» / "Launch"; `haveSite` «عندي رابط» / "I have a link"; `noSite` «ما عندي موقع» / "I don't have a website"; `products` «وش تبيع بالضبط؟» / "What exactly do you sell?"; `audience` «مين عملاؤك؟» / "Who are your customers?"; `saveNoSite` «احفظ وابدأ» / "Save and start".
- Type-only import of `Brand` is not needed; keep `import type` only (client bundle rule).

- [ ] **Step 1: Write the failing tests** in `tests/dictionary-onboarding.test.ts`:
  - `rule 520: answers map to name, industry and tone in the language played` — for `{ brand: "قهوة الصباح", sector: "coffee", words: ["bold","warm","refined","popular","calm"], lang: "ar" }`: `answersToBrand` → `{ name: "قهوة الصباح", industry: "قهوة", tone: "جريئة، دافية، راقية، شعبية، هادية" }`; same with `lang: "en"` → industry `"Coffee"`, tone `"bold, warm, refined, down-to-earth, calm"`.
  - `rule 520: a name is stored as typed text, trimmed and capped` — `parseAnswers({...ok, brand: "  <b>$&</b>  "})!.brand === "<b>$&</b>"`; `answersToBrand` keeps it verbatim; a 41-char trimmed name → null.
  - `rule 520: the no-site body carries products, audience, dialect and language` — `noSiteBrand(okEn, " beans ", " offices ")` → `products: "beans"`, `audience: "offices"`, `dialect: "english"`, `languages: ["en"]`; ar → `"saudi"`, `["ar"]`.
  - `rule 521: validation refuses a bad sector, word list, name or language` — each returns null: `sector: "bank"`; 4 words; 6 words; 5 with a duplicate; an unknown word id; `brand: "   "`; `brand: 7`; `lang: "fr"`; `null`; a string.
  - `rule 521: answersOf reads the reducer state` — a state after steps 1-2 of `reduce` gives non-null; `INITIAL` gives null.
- [ ] **Step 2: Run** `npx vitest run tests/dictionary-onboarding.test.ts` — expected FAIL (exports missing).
- [ ] **Step 3: Implement** the Interfaces above in `src/lib/dictionary.ts`.
- [ ] **Step 4: Run** the same command — expected PASS; `npx vitest run tests/dictionary.test.ts tests/client-bundle.test.ts` still PASS.
- [ ] **Step 5: Commit** `feat(onboarding): game answers, validation and brand mapping (rules 520-521)`.

### Task 2: Confirm stores the answers, the build applies them (rules 522, 523)

**Files:**
- Modify: `src/lib/onboard-confirm.ts` (answers key beside `onboardok:`)
- Modify: `src/app/api/onboard/confirm/route.ts`
- Modify: `src/app/api/onboard/route.ts:100-170` (read under the lock, hint, override after build)
- Test: `tests/routes-onboard-publish.test.ts` (new `describe("the game's answers (rules 522-523)")`)
- Docs: `docs/system/flows.md` (onboarding flow), `docs/system/permissions.md` (confirm body)

**Interfaces:**
- Consumes: `parseAnswers`, `answersToBrand`, `answersHint`, `GameAnswers` (Task 1).
- Produces in `src/lib/onboard-confirm.ts`:
  - `confirmAnswers(scope: string, a: GameAnswers | null): Promise<unknown>` — sets `onboardgame:${scope}` with the same `TTL` when `a`, deletes it when null.
  - `confirmedAnswers(scope: string): Promise<GameAnswers | null>` — reads and re-validates with `parseAnswers` (a stored value is data too).
  - `clearOnboard(scope)` now deletes both keys.
- Confirm route: body `{ url, answers? }`. `answers` present and `parseAnswers` null → 400 `{ error: "bad_answers" }` before anything is written. On success `Promise.all([confirmOnboard(scope, url), confirmAnswers(scope, parsed ?? null)])`.
- Build route: add `confirmedAnswers(scope)` to the post-lock `Promise.all` with `built` and `stillConfirmed`. Hints to `buildFromSite`: `answers ? answersHint(answers) : b.hints`. After the build, before `saveBrand`: `if (answers) r.brand = { ...r.brand, ...answersToBrand(answers) }`.

- [ ] **Step 1: Write the failing tests:**
  - `rule 522: confirming stores valid answers under the caller's scope and refuses bad ones` — owner confirms `{ url, answers: okAr }` → 200 and `db.get("onboardgame:"+u.email)` equals `okAr`; `{ url, answers: { ...okAr, words: [] } }` → 400 `bad_answers` and neither `onboardok:` nor `onboardgame:` changed; a member (`newMember(owner, "member")`) → 403.
  - `rule 522: confirming again without answers drops the stale ones` — confirm with answers, then without → `onboardgame:` key null.
  - `rule 523: the build writes the answers over the model's name, industry and tone, read from the store` — confirm with `okEn` (account lang ar), POST `/api/onboard` with body `{ url, hints: "x", answers: { ...okEn, brand: "Evil" } }` → saved brand `name === okEn.brand`, `industry === "Coffee"`, `tone` English join; both keys cleared after the build.
  - `rule 523: answers confirmed for one brand are not applied to another` — confirm with answers under the default brand, switch the session to an added brand (as the existing "a confirmation belongs to the workspace that made it" test does), confirm without answers, build → brand name is the mock's, not the answers'.
- [ ] **Step 2: Run** `npx vitest run tests/routes-onboard-publish.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** the Interfaces above; update the doc comments of both routes and `onboard-confirm.ts` in their existing style.
- [ ] **Step 4: Run** the same command — expected PASS (old rules 14 and 97 tests too).
- [ ] **Step 5: Update** `flows.md` (start page → game → confirm with answers → build) and `permissions.md` (confirm accepts `answers`, `onboard` gate unchanged).
- [ ] **Step 6: Commit** `feat(onboarding): confirmed answers feed the site build (rules 522-523)`.

### Task 3: The game on `/app/start` (rules 524, 525, 526)

**Files:**
- Create: `src/components/app/StartLaunch.tsx` (client; step 7: choice, URL form moved from `StartWizard`, no-site form)
- Create: `src/components/app/DictionaryStart.tsx` (client; the game shell, steps 1-6, step 7 renders `StartLaunch`)
- Modify: `src/app/[lang]/app/start/page.tsx` (gate, redirect, render `DictionaryStart`)
- Delete: `src/components/app/StartWizard.tsx`
- Modify tests: `tests/pricing-copy.test.ts` (render `StartLaunch`; file list), `tests/teams-ui.test.ts` (rule 524), `tests/client-bundle.test.ts` (rule 525), `tests/routes-onboard-publish.test.ts` or `tests/brand-guardrails.test.ts` (rule 526)
- Docs: `docs/system/architecture.md` (components), `docs/system/tests.md` rows 520-526

**Interfaces:**
- Consumes: Task 1 exports; `DICT_COPY`, `SECTORS`, `WORDS`, `reduce`, `INITIAL`, `canAdvance`, `samplePlan`, `sampleDraft`; `Doodle` from `@/components/home/Doodle`; `AGENT_CAST` from `@/lib/home`.
- `StartLaunch` props: `{ t: AppDict; lang: Lang; answers: GameAnswers; initialUrl?: string; setupCost?: number; setupPaid?: boolean; credits?: number }`. Default view: the site form (so a static render shows the cost note and the Go button exactly as `StartWizard` did, classes `btn btn-accent btn-lg`). Site Go: `POST /api/onboard/confirm { url, answers }`, then `router.push(/${lang}/app/chat?onboard=...)`; 402 / 409 handling copied unchanged. No-site save: `PUT /api/brand` with `noSiteBrand(answers, products, audience)`, both fields `required`, then `router.push(/${lang}/app)` and `router.refresh()`; on a non-OK answer show `t.start.steps.error`.
- `DictionaryStart` props: `{ t: AppDict; lang: Lang; initialUrl: string; setupCost: number; setupPaid: boolean; credits: number }`. `useReducer(reduce, INITIAL)`. Step 6 shows `DICT_COPY.analysis` and `DICT_COPY.measure`; rail names use `DICT_COPY.steps` except 6 and 7 from `START_COPY`. Step 6's Next goes to step 7 (the shared reducer's `canAdvance(6)` is true; step 7 has no Next). Under the title: `Link` to `/${lang}/app/onboarding` with `t.start.manual`. Same focus-the-heading-on-step-change and `useReady` behaviour as the home component (copy the two small helpers, do not import from `home/Dictionary.tsx`).
- Start page: `if (!can(u, "onboard") || !can(u, "brand.write"))` keeps today's member branch; for the rest, `if (await getBrand(sc(u))) redirect(\`/${lang}/app\`)`, else render `DictionaryStart` with today's props.

- [ ] **Step 1: Write the failing tests:**
  - `pricing-copy`: the start-wizard test renders `StartLaunch` with `answers: okFor(lang)` and keeps every assertion; `StartWizard.tsx` in the literals file list becomes `StartLaunch.tsx` and `DictionaryStart.tsx`.
  - `teams-ui` `rule 524`: owner with no brand → page contains `esc(DICT_COPY.title.en)` and `en.start.manual`; member → no `DICT_COPY.title.en`; owner after `saveBrand` → `rejects.toThrow(/NEXT_REDIRECT/)`.
  - `client-bundle` `rule 525`: `clientFiles()` includes `src/components/app/DictionaryStart.tsx` and `src/components/app/StartLaunch.tsx` (so the existing value-import check covers them).
  - `rule 526`: `PUT /api/brand` with `noSiteBrand(okAr, "بن مختص", "موظفين")` as owner → 200, saved brand under the owner's email has `name`, `industry: "قهوة"`, `tone`, `products`, `audience`; as a member → 403 and no brand saved.
- [ ] **Step 2: Run** `npx vitest run tests/pricing-copy.test.ts tests/teams-ui.test.ts tests/client-bundle.test.ts tests/routes-onboard-publish.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** `StartLaunch.tsx`, `DictionaryStart.tsx`, the start page; delete `StartWizard.tsx`; `grep -rn StartWizard src tests docs/system` returns nothing.
- [ ] **Step 4: Run** the step 2 command — expected PASS. Then `npm run check` — expected all pass.
- [ ] **Step 5: Update** `architecture.md` (start page → `DictionaryStart` / `StartLaunch`; `StartWizard` gone) and add `tests.md` rows 520-526 with the status line counts from `npm run check`.
- [ ] **Step 6: Commit** `feat(onboarding): the Thakeen Dictionary replaces the start wizard (rules 524-526)`.

### Task 4: Build, preview, verify

- [ ] **Step 1:** `npx next build` outside the sandbox — expected success.
- [ ] **Step 2:** `git push -u origin claude/dictionary-onboarding`; open a draft PR (title `feat(onboarding): قاموس ذكين replaces the start wizard (rules 520-526)`); never merge.
- [ ] **Step 3:** On the Vercel preview, with a fresh test owner from the repo's test helpers: Arabic and English, desktop and 375 px phone; play to step 7 both ways (site link reaches the chat build; no-site lands on `/app` with the brand's name in the sidebar); a member account sees the wait note; screenshots to the founder.
- [ ] **Step 4:** Report to the founder: link, what was verified, what was not. Merge and production only on «انشرها على الموقع الحي».
