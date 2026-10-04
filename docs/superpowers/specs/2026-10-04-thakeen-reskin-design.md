# Thakeen re-skin to prototype D — design

Status: draft for the founder's approval, 2026-10-04. Branch `claude/thakeen-reskin`, cut from `claude/thakeen-heading-font` (PR #248, not merged), so it contains #248. Reference: prototype D (`thakeen-prototypes.vercel.app/d`, files `d.html`, `kit.css`, `figures.css`, `figures.js`, `scribble.js`). D's font files under `/f/` are never copied; the heading face comes from #248.

## 1. One token source

`assets/design-tokens.json` stays the only place a colour, size, stroke or duration is defined. `src/app/tokens.css` is its CSS form (kept by hand; the "auto-generated" header is corrected). `globals.css` `@theme inline` only maps Tailwind names onto those variables. Components never write a hex value.

| Group | Tokens (value from D) |
|---|---|
| Base | `ink` #2b193d · `muted` #5d4a70 · `paper` #fff · `ground` #f7f3f9 · `lilac` #efe7f7 |
| Highlight | `lemon` #f9f871 (swash, selection, ghost-button fill) |
| Agents (`agent-<id>`) | noor #f9f871 · sami #ff5da2 · razan #00d9ff · faris #b517ff · dana #14b8a6 · majed #2b193d · layan #3fcf7e · reem #ff8a1f · you #fff |
| Figure detail | `gold` #c9a227 (figure strokes only, as in D's kit) |
| Error | fill `agent-sami` rose with ink text; error *text* `danger-ink` #b3125f (rose darkened, 6.6:1 on white). The only colour not in D. |
| Stroke | `pen` 1.25px (scribbles) · `figure` 1.5px · `fine` 1px · `gold` 1.75px · `focus` 2px |
| Type | `--font-display` Thmanyah Serif Display (h1-h3, large type) · `--font-body` IBM Plex Sans Arabic · scale from D: 16 / 17 (body) / 21 / clamp(26-40px) |
| Motion | 150 / 200 / 300 ms, easing `cubic-bezier(.22,1,.36,1)`; no overshoot curves, no width/height transitions |

Contrast (measured): ink on ground 14.6, muted on ground 7.2, ink on every agent fill ≥ 5.6 except faris (3.5), so faris and majed fills carry paper text (as D's `.dk` does).

Rules: agent colours are fills and strokes only, never text colour. Focus ring is ink, 2px. No drop shadows; depth comes from D's offset hand-drawn shadow. Oasis green and saffron yellow are removed from the product.

## 2. Migration without a big-bang diff

Slice 1 adds the new names and turns the old ones (`oasis`, `oasis-deep`, `saffron`, `sadu`, `sadu-deep`, `salt`, `salt-dim`, `mist`, `mist-dim`) into aliases of D values (`ink` keeps its name and takes D's value), so all 84 files (about 2,000 colour utilities) change colour at once with no markup edits: `oasis`→ink, `oasis-deep`→ink darkened, `saffron`→lemon (fills) / ink (text and borders, fixed per file as each slice touches it), `sadu`→rose, `sadu-deep`→danger-ink, `salt`→ground, `salt-dim`→lilac, `mist`→lilac, `mist-dim`→muted on light / lilac at 70% on ink. Each later slice renames the utilities in the files it touches. The last slice deletes the aliases, and a test fails if an old name or old hex comes back.

## 3. Shared pieces

- `Scribble` — a port of `scribble.js` as a React component (`box`, `pill`, `underline`, `swash`, `cloud`, `stamp`, `puddle`), seeded so server and client draw the same path. Drawn on the server in a normalised box (non-scaling stroke) so it is there at first paint with no layout shift; a small client step redraws pills and clouds at their real size.
- `Doodle` (already D's figures), `Wordmark` (#248) reused as they are.
- Base classes in `globals.css` (`.btn`, `.btn-ghost`, inputs, cards) restyled once, so every screen using them follows.
- Marketing pages are fully hand-drawn like D. App screens are the quiet version: same colours, type and strokes, plain 1.5px ink lines on dense tables and forms, scribbles only on primary buttons, empty states, agent avatars and section titles. (Decision A below.)

## 4. Homepage (slice 2)

Order, as D: nav → hero (masthead, offer, the lineup of nine) → house rules → the day (four panels) → the seven steps, explained only (no live demo) → plans → FAQ → footer. Copy comes from D in Arabic and English; no number, customer or result that is not true today, and no model name.

Lineup: one row of nine from 1200px, 5+4 from 600px, 3+3+3 below 600px; figures 70-92px wide; the chosen figure (hover, focus, tap) grows by `transform` only, so nothing beside or below it moves. Its thought cloud and name tag take the agent's colour.

The «قاموس ذكين» game leaves the homepage: `Dictionary.tsx` is unmounted but not deleted (the onboarding session moves it). `Story` and `Truths` are removed with their CSS once nothing imports them.

## 5. Order of work

1. Tokens + chrome: tokens, aliases, `Scribble`, Nav, Footer, app shell, base classes; fix the two design-lint findings in `globals.css` (the width transition on `.journey-fill` becomes a `transform: scaleX` fill; the `.pop-in` overshoot curve becomes the standard ease).
2. Homepage.
3. Marketing pages: pricing, agents and each agent, for/[industry], vs/[competitor], tools, blog, help, resources, updates, customers, enterprise, affiliates, privacy, terms, 404.
4. App screens: login/signup/reset, onboarding/start, chat, to-do, tasks, calendar, files, brands, billing, then the rest of `/app/*`. Aliases removed at the end of this slice.

Each slice: its own commit set and Vercel preview, checked in Chromium and WebKit, Arabic and English, at 1440 / 1024 / 768 / 390 / 360 with no sideways scroll; `npm run check` and `npx next build` before every commit. Nothing merges to main and nothing reaches production without «انشرها على الموقع الحي».

## 6. What stays

Routes, behaviour, data, permissions, copy outside the homepage, the fonts and wordmark from #248, the figures, the motion toggle and reduced-motion handling, RTL/LTR logic.

## 7. Tests

One rule block (numbers picked after checking open PRs for reservations, first free above 509), each with a test in `tests/` and a row in `docs/system/tests.md`: the token set equals D's palette; no old palette name or hex in `src/` (enforced from slice 4); agent colours never used as text colour; no overshoot easing and no width/height transition in CSS; the lineup's three breakpoints and transform-only growth; the homepage section order without the game.

## 8. Decisions for the founder

- A. App density: quiet version in the app (recommended) or fully hand-drawn everywhere?
- B. Error text colour #b3125f, a darker rose not in D, so error messages stay readable. Accept?
- C. D's «اللوحة الجاية لك» start form is not in the homepage list. Leave it out (the hero and nav buttons go to sign-up), or keep it before plans?
