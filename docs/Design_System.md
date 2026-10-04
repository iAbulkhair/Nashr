# Thakeen Design System · نظام تصميم ذكين

Source of truth: `assets/design-tokens.json`, mirrored by hand in `src/app/tokens.css` (`tests/design-tokens.test.ts`, rule 510, fails if the two drift apart), then the Tailwind theme and component classes in `src/app/globals.css`. The palette is prototype D's (spec `docs/superpowers/specs/2026-10-04-thakeen-reskin-design.md` §1).

## 1. Token layers · طبقات الرموز

| Layer | Where | Examples | When to change |
|---|---|---|---|
| Primitive · أساسي | `tokens.css` `--primitive-*` | `--primitive-color-ink` #2b193d, `-muted` #5d4a70, `-paper` #fff, `-ground` #f7f3f9, `-lilac` #efe7f7, `-lemon` #f9f871, `-gold` #c9a227 (figure strokes only), `-danger` #cc0000; `--primitive-color-agent-<id>`; strokes, spacing 1–20, radius sm–full, durations 150/200/300 ms, easing | Rarely; brand refresh |
| Semantic · دلالي | `tokens.css` `--color-*`, `--stroke-*`, `--ease-out`, `--duration-*`, `--spacing-*` | `--color-ink`, `--color-agent-noor`, `--color-background` (ground), `--color-foreground`/`--color-primary`/`--color-ring` (ink), `--color-accent` (lemon), `--color-danger`, `--stroke-pen` 1.25px, `--stroke-figure` 1.5px, `--ease-out` `cubic-bezier(.22,1,.36,1)` | Theme switches (dark mode later) |
| Component · مكوّن | `tokens.css` `--button-*`, `--input-*`, `--card-*` | `--button-bg`, `--button-radius`, `--input-focus-ring`, `--card-padding` | Per-component tuning |

Agents: noor #f9f871 · sami #ff5da2 · razan #00d9ff · faris #b517ff · dana #14b8a6 · majed #2b193d · layan #3fcf7e · reem #ff8a1f · you #fff. Agent colours are fills and strokes, never text colour; faris and majed fills carry paper text (ink on faris is 3.5:1). Error boxes: sami's rose fill with ink text; error text and borders `danger` #cc0000.

Tailwind utilities `bg-ink`, `text-muted`, `bg-ground`, `bg-lilac`, `bg-lemon`, `border-danger`, `bg-agent-<id>` map onto the primitives via `@theme inline` in `globals.css`. The old names (`oasis`, `oasis-deep`, `saffron`, `sadu`, `sadu-deep`, `salt`, `salt-dim`, `mist`, `mist-dim`) are temporary aliases of D values while the re-skin renames them page by page; the last slice deletes them.

## 2. Component classes · فئات المكوّنات

Defined in `globals.css` under `@layer components`. Use these instead of repeating utility strings.

### Buttons `.btn`

| Variant | Class | Default | Hover | Active | Disabled |
|---|---|---|---|---|---|
| Primary · أساسي | `btn btn-primary` | bg primary, text primary-fg | bg primary-hover | bg primary-active | opacity 0.5, no pointer |
| Accent · مميز (CTA) | `btn btn-accent` | bg accent (saffron), text ink | bg accent-hover | bg accent-active | opacity 0.5 |
| Secondary · ثانوي | `btn btn-secondary` | transparent, 20% ink border | border+text primary | bg background-muted | opacity 0.5 |
| Danger · خطر | `btn btn-danger` | transparent, danger text, 40% danger border | bg danger, text white | | opacity 0.5 |
| Danger solid | `btn btn-danger-solid` | bg danger, text white | bg danger-hover | | opacity 0.5 |
| Ghost on dark | `btn btn-ghost-inverse` | transparent, 25% mist border, mist text | 60% mist border | | opacity 0.5 |

Sizes: `btn-xs` (pill, 12px), `btn-pill` (pill, 14px), `btn-sm` (rounded, 14px), default (rounded, 14px, 12px/20px padding), `btn-lg` (pill, 16px).
Focus: global `:focus-visible` ring in `--color-ring` (saffron), 3px, offset 2px.

### Cards `.card`
Surface bg, 10% ink border, radius lg, padding 20px. `card-sm` 16px padding. `card-inverse` for the dark oasis surface. `card-title` for the heading.

### Inputs `.input`
Full width, surface bg, 15% ink border, radius md, 12px/16px padding, 14px text. Hover 30% border; focus primary border + 45% saffron ring; disabled 60% opacity; `aria-invalid="true"` danger border. Add `rounded-full` for the chat composer.

### Badges `.badge`
`badge-primary` (10% primary tint), `badge-accent` (20% saffron tint), `badge-danger` (10% danger tint). 12px, pill.

### Typography
`page-title` (app page H1, display 30px bold, primary), `page-sub` (70% ink), `section-title` (marketing H2, 30→36px), `eyebrow` (12px uppercase, 0.2em tracking, sadu red), `eyebrow-accent` (saffron on dark).

### Layout
`section-wrap` (max 72rem, 80px vertical, 16/24px gutters), `page-wrap` (max 48rem, 64px vertical).

## 3. Rules · القواعد
1. No raw hex in components (validated with the skill's `validate-tokens.cjs`; only the PowerPoint exporter and the OAuth consent page carry literal colors on purpose).
2. Marketing pages: dark oasis sections alternate with salt sections; one accent CTA per section.
3. App pages: `page-title` + `page-sub`, then `card` blocks; primary action per card is `btn-primary btn-sm`, destructive is `btn-danger`.
4. RTL first: use logical properties (`ms-`, `me-`, `text-start`, `padding-inline`), numbers and URLs get `dir="ltr"`, free text gets `dir="auto"`.
5. Every user-facing string comes from `src/lib/i18n.ts` (marketing) or `src/lib/app-i18n.ts` (app) in both Arabic and English. Inline `ar ? … : …` pairs are acceptable inside a single component, never English-only.
6. Fonts: Thmanyah Serif Display for headings (`--font-display`, rule 317), IBM Plex Sans Arabic for body, IBM Plex Mono for numbers and code.

## 4. Status · الحالة (2026-09-17)
- Tokens generated and wired; 160 repeated class strings replaced across 40+ components with the classes above; visual parity verified on landing, inbox, profile and founder console in Arabic.
- Founder console and its login are now bilingual; every other page already reads from the dictionaries.
- Dark mode: semantic layer ready, not switched on.
