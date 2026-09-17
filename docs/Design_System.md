# Nashr Design System · نظام تصميم نشر

Source of truth: `assets/design-tokens.json` → generated `src/app/tokens.css` (never edit by hand) → Tailwind theme and component classes in `src/app/globals.css`.
Regenerate after editing the JSON:

```bash
node "<design-system skill dir>/scripts/generate-tokens.cjs" --config assets/design-tokens.json -o src/app/tokens.css
```

## 1. Token layers · طبقات الرموز

| Layer | Where | Examples | When to change |
|---|---|---|---|
| Primitive · أساسي | `tokens.css` `--primitive-*` | `--primitive-color-oasis-500` #0F3D3A, `--primitive-color-saffron-500` #F2B33D, `--primitive-color-sadu-500` #D9503F, `--primitive-color-salt-100` #F6F4EE, spacing 1–20, radius sm–full, shadows, durations | Rarely; brand refresh |
| Semantic · دلالي | `tokens.css` `--color-*`, `--spacing-*` | `--color-background`, `--color-surface`, `--color-foreground`, `--color-primary(-hover/-active/-foreground)`, `--color-accent(...)`, `--color-danger(...)`, `--color-inverse-*`, `--color-ring`, `--spacing-section` | Theme switches (dark mode later) |
| Component · مكوّن | `tokens.css` `--button-*`, `--input-*`, `--card-*` | `--button-bg`, `--button-radius`, `--input-focus-ring`, `--card-padding` | Per-component tuning |

Tailwind utilities (`bg-oasis`, `text-saffron`, `bg-salt-dim`, `text-mist`…) are mapped to the primitives via `@theme inline` in `globals.css`, so existing utility classes keep working and inherit any token change.

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
6. Fonts: Readex Pro for display, IBM Plex Sans Arabic for body, IBM Plex Mono for numbers and code.

## 4. Status · الحالة (2026-09-17)
- Tokens generated and wired; 160 repeated class strings replaced across 40+ components with the classes above; visual parity verified on landing, inbox, profile and founder console in Arabic.
- Founder console and its login are now bilingual; every other page already reads from the dictionaries.
- Dark mode: semantic layer ready, not switched on.
