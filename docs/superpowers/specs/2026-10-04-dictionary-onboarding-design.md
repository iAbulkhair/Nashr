# قاموس ذكين in first-login onboarding — design

Date: 2026-10-04. Branch: `claude/dictionary-onboarding`. Status: draft, awaiting the founder's approval. Test rules 520-529
(510-519 left free for the re-skin session).

Founder decision (2026-10-04): on first login a new client plays the game instead of filling a form; the answers go into
the brand file; the full form stays for later edits; the game leaves the homepage (the re-skin session removes it there).

## What the code says today

First login is not the brand form. An owner with no brand file is sent (app home, chat, generate, reports) to
`/app/start`, which renders `StartWizard`: one URL field, then Noor crawls the site in the "Getting started" chat and
writes the brand file, the market files and the starter plan (`POST /api/onboard/confirm`, then `POST /api/onboard`).
The full form (`/app/onboarding`, `BrandForm`) is only a link under that field. So the game replaces the `StartWizard`
screen, and the site link becomes the game's last step.

First login is detected the way it is today: `getBrand(sc(u))` is empty. No new flag.

## Flow, screen by screen (`/app/start`)

Who sees it: `can(u, "onboard") && can(u, "brand.write")` and no brand file. Anyone else gets today's member wait note
(or is sent to `/app` once the brand exists). Nothing is saved before step 7; leaving mid-game loses the answers.

1. **براندك**: brand name (`BRAND_MAX` 40, ruling R1) and sector (5 choices). Noor greets.
2. **كلماتك**: pick exactly 5 of the 12 voice words; each pick gets the agent's one-line reaction.
3. **خطة**: the pre-written sample plan, tagged «مثال».
4. **مسودة**: the sample post and WhatsApp reply, tagged «مثال».
5. **موافقتك**: the approve tap ("nothing goes out before this tap").
6. **تحليل وقياس**: Dana's analysis line and the measurement sources line (homepage steps 6 and 7 merged).
7. **انطلق** (new): two choices.
   - **عندي رابط**: URL field, with today's cost note and 402 handling for an added brand, and the review note when a
     `?url=` was carried in from signup. Go: `POST /api/onboard/confirm {url, answers}`, then the chat
     (`?onboard=`), where Noor crawls as today, using the answers.
   - **ما عندي موقع**: two short required fields, «وش تبيع بالضبط؟» (products) and «مين عملاؤك؟» (audience). Save:
     `PUT /api/brand`, then `/app`.

Under the title on every step: «أفضّل تعبئة النموذج يدوياً» → `/app/onboarding`.

## What is saved where

Every write is under `sc(u)` and behind `can()` in the route. One pure, client-safe function in `src/lib/dictionary.ts`
maps the answers; one validates them on the server.

| Answer | Brand field |
|---|---|
| name | `name` (trimmed, ≤40) |
| sector | `industry`: the sector's name in the owner's language («قهوة» / "Coffee") |
| 5 words | `tone`: their tone forms joined («جريئة، دافية، …») |
| app language | `dialect` (`saudi` / `english`), `languages` `[lang]` |
| products, audience (no-site path) | `products`, `audience` |

- **With a site**: the confirm route validates the answers (sector in `SectorId`, 5 distinct `WordId`, non-empty name
  ≤40; anything else is 400) and stores them at `onboardgame:${sc(u)}`, beside `onboardok:` with the same one-day TTL
  and cleared with it. `POST /api/onboard` reads them from there, never from its request body, passes them to the model
  as owner hints, and after the build writes `name`, `industry` and `tone` from the answers over the model's values, in
  code. The model fills the rest (products, audience, offers, files, plan). Answers are optional on confirm, so a run
  confirmed before the deploy still builds.
- **Without a site**: the page builds the brand and calls the existing `PUT /api/brand` (auth, `brand.write`,
  `sc(u)`, required fields, length caps). No new route.

## The crawl-based onboarding

Kept as it is (crawl, three model calls, files, plan, added-brand charge and hold, three runs a day, the lock, 409 once a
brand exists). It moves behind the game's step 7 and receives the answers. `StartWizard.tsx` is removed; its URL form,
cost note and 402 handling move into step 7.

## The full form

`/app/onboarding` and `BrandForm` are not changed: Sidebar «ملف العلامة», the home side card, the Inbox banned-word link
and the link on the game reach it. Members still see it read-only.

## Homepage and styling

`src/app/[lang]/page.tsx` and `src/components/home/*` are not touched; the re-skin session removes the homepage import
and the home component. The reducer and copy in `src/lib/dictionary.ts` stay shared (onboarding-only copy is added
beside them). New component `src/components/app/DictionaryStart.tsx` uses the app's existing colour tokens only (no hex
values) and reuses the `Doodle` faces, so the D identity lands through the tokens.

## Tests (rules 520-526) and verification

520 answers to brand mapping and caps. 521 answer validation refuses a bad sector, word list or name. 522 confirm stores
valid answers under the caller's scope, refuses bad ones, 403 for a member. 523 the build reads the answers from the
store, not the request, and they win over the model for name, industry and tone. 524 `/app/start` renders the game only
for an owner or admin with no brand. 525 the new component is in the client-bundle check. 526 the no-site path saves
through `PUT /api/brand` with its checks.

Verified on a Vercel preview with a fresh test owner, Arabic and English, desktop and phone, both paths, plus a member
account seeing the wait note. Not merged, not deployed, until the founder writes «انشرها على الموقع الحي».

Out of scope: the homepage, the D identity, saving a half-played game.
