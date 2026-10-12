# Thakeen Design System · نظام تصميم ذكين

Source of truth: `assets/design-tokens.json`, mirrored by hand in `src/app/tokens.css` (`tests/design-tokens.test.ts`, rule 510, fails if the two drift apart), then the Tailwind theme and component classes in `src/app/globals.css`. The palette is prototype D's (spec `docs/superpowers/specs/2026-10-04-thakeen-reskin-design.md` §1).

## 1. Token layers · طبقات الرموز

| Layer | Where | Examples | When to change |
|---|---|---|---|
| Primitive · أساسي | `tokens.css` `--primitive-*` | `--primitive-color-ink` #2b193d, `-muted` #5d4a70, `-paper` #fff, `-ground` #f7f3f9, `-lilac` #efe7f7, `-lemon` #f9f871, `-gold` #c9a227 (figure strokes only), `-danger` #cc0000; `--primitive-color-agent-<id>`; strokes, spacing 1–20, radius sm–full, durations 150/200/300 ms, easing | Rarely; brand refresh |
| Semantic · دلالي | `tokens.css` `--color-*`, `--stroke-*`, `--ease-out`, `--duration-*`, `--spacing-*` | `--color-ink`, `--color-agent-noor`, `--color-background` (ground), `--color-foreground`/`--color-primary`/`--color-ring` (ink), `--color-accent` (lemon), `--color-danger`, `--stroke-pen` 1.25px, `--stroke-figure` 1.5px, `--ease-out` `cubic-bezier(.22,1,.36,1)` | Theme switches (dark mode later) |
| Component · مكوّن | `tokens.css` `--button-*`, `--input-*`, `--card-*` | `--button-bg`, `--button-radius`, `--input-focus-ring`, `--card-padding` | Per-component tuning |

Agents: noor #f9f871 · sami #ff5da2 · razan #00d9ff · faris #b517ff · dana #14b8a6 · majed #2b193d · layan #3fcf7e · reem #ff8a1f · you #fff. Agent colours are fills and strokes, never text colour; faris and majed fills carry paper text (ink on faris is 3.5:1). Error boxes: sami's rose fill with ink text; error text and borders `danger` #cc0000.

Tailwind utilities `bg-ink`, `text-muted`, `bg-ground`, `bg-lilac`, `bg-lemon`, `border-danger`, `bg-agent-<id>` map onto the primitives via `@theme inline` in `globals.css`. The old names (`oasis`, `saffron`, `sadu`, `salt`, `mist`) are gone: no alias exists, and `tests/palette-clean.test.ts` (rule 513) checks every file under `src/`. Tailwind's `white` maps to `paper`.

Strokes: pen 1.25px (`--stroke-pen`, scribbles), figure 1.5px (borders, figures), fine 1px (ghost lines), gold 1.75px (figure accents only), focus 2px ink outline at 2px offset. No drop shadows anywhere.

## 2. Component classes · فئات المكوّنات

Defined in `globals.css` under `@layer components`. Use these instead of repeating utility strings.

### Buttons `.btn`

| Variant | Class | Default | Hover | Active | Disabled |
|---|---|---|---|---|---|
| Primary · أساسي | `btn btn-primary` | bg primary, text primary-fg | bg primary-hover | bg primary-active | opacity 0.5, no pointer |
| Accent · مميز (CTA) | `btn btn-accent` | bg accent (lemon), text ink, 1.5px ink border | bg paper | bg accent-active | opacity 0.5 |
| Secondary · ثانوي | `btn btn-secondary` | transparent, 1.5px ink border at 25% | ink border | bg background-muted | opacity 0.5 |
| Danger · خطر | `btn btn-danger` | transparent, danger text, 40% danger border | bg danger, text white | | opacity 0.5 |
| Danger solid | `btn btn-danger-solid` | bg danger, text white | bg danger-hover | | opacity 0.5 |
| Ghost on dark | `btn btn-ghost-inverse` | transparent, 25% inverse-foreground border, inverse-foreground text | 60% border | | opacity 0.5 |

Sizes: `btn-xs` (pill, 12px), `btn-pill` (pill, 14px), `btn-sm` (rounded, 14px), default (rounded, 14px, 12px/20px padding), `btn-lg` (pill, 16px).
Focus: global `:focus-visible` outline in `--color-ring` (ink), 2px (`--stroke-focus`), offset 2px.

### Cards `.card`
Paper bg, 1.5px ink border at 15%, radius sm, no shadow, padding 20px. `card-sm` 16px padding. `card-inverse` for the ink surface. `card-title` for the heading.

### Inputs `.input`
Full width, paper bg, 1.5px ink border at 55% (3:1 against white), radius md, 12px/16px padding, 14px text, muted placeholder. Hover 80% border; focus ink border + 2px ink outline; disabled 60% opacity; `aria-invalid="true"` danger border. Add `rounded-full` for the chat composer.

### Badges `.badge`
Flat D fills with ink text: `badge-primary` (lilac), `badge-accent` (lemon), `badge-danger` (sami's rose). 12px, pill.

### Typography
`page-title` (app page H1, display 30px bold, primary), `page-sub` (70% ink), `section-title` (marketing H2, 30→36px), `eyebrow` (12px uppercase, 0.2em tracking, muted), `eyebrow-accent` (lemon on ink).

### Motion
150 / 200 / 300 ms (`--duration-*`) with `--ease-out` `cubic-bezier(.22,1,.36,1)`; no overshoot curves, never a width or height transition (rule 511). Progress fills grow by `transform: scaleX(var(--p))`.

### Scribbles `<Scribble>`
Hand-drawn strokes from `src/lib/scribble.ts`, drawn by `src/components/Scribble.tsx` (server-rendered first, redrawn at real size; frozen under reduced motion; hidden in forced colours, where real borders show). Kinds: `box`, `bubble`, `circleLoop`, `cloud`, `divider`, `pill`, `puddle`, `stamp`, `strike`, `swash`, `tape`, `tick`, `underline`. Props: `seed` (stable shape), `fill` (a D colour name), `shadow`, `ring`, `boil`, `heavy`. The host element carries the matching class from `scribble.css` (`s-ul`, `s-btn`, `s-card`, `s-chip`, `s-input`, `s-num`, `s-bubble`, `s-cloud`, `s-stamp`, `s-tape`, `s-tag`, `s-link`) or `data-scribble` for a generic host.

### Loud and quiet · صاخب وهادئ
- **Marketing pages (loud):** headings with an `underline` scribble, cards as `s-card` + `box`, buttons as `s-btn` + `pill` (ink fill primary, lemon ghost), agents shown with their doodle on their fill.
- **App screens (quiet, rule 519):** plain 1.5px ink lines on tables and forms. Scribbles only on the page title (`<h1 class="page-title"><span class="s-ul"><Scribble kind="underline" …/>`), the main action of the sign-in screens (ink pill), agent avatars (`AgentAvatar`: `circleLoop` on the agent's fill) and empty states. Error boxes `border-danger bg-agent-sami/20`; lemon appears only on ink, never as text or an icon on a light ground. Centred page wrappers are `mx-auto w-full max-w-*`.

### Layout
`section-wrap` (max 72rem, 80px vertical, 16/24px gutters), `page-wrap` (max 48rem, 64px vertical).

### Semantic tokens added in phase 1 (rule 1080, expand only)
`foreground-muted` (#5d4a70), `foreground-subtle` (ink at 65%, 5.08:1 on white; the report asked 55%, which is 4.0:1, so it was raised to pass AA), `border` (ink 18%), `border-input` (ink 55%), `border-strong`, `surface-muted` (ground), `popover`, `overlay` (ink 45%), `success` #1f7a4d / `success-tint`, `warning` #8a5a00 / `warning-tint` #fff4d6, `info` / `info-tint`, `danger-tint` (danger 8%), `text-accent` (the `text-accent` utility: ink, bold; never lemon on light), `notice-bg` / `notice-border` (lilac, replaces lemon tints on light grounds), `ring-inverse` (lemon ring on ink, rule 1081). Sizes: `--radius-card` 0.75rem, `--leading-body` 1.5 / `--leading-title` 1.25 (Arabic 1.7 / 1.4 and `--text-xs-min` 13px under `:lang(ar)`), `--hit-min` 44px, `--hit-floor` 24px. Every text pair is at least 4.5:1 (WCAG 2.2 AA), pinned in `tests/uiux-phase1.test.ts`. `.card` radius and the body line height are unchanged until phase 2.

### Primitives `src/components/ui` (rules 1082-1094, phase 2: 1110-1118)
React components over the classes above, restyled to our tokens and RTL (not shadcn). Use them in new code; old screens move over one change at a time.

| Primitive | File | What it gives |
|---|---|---|
| `Button` / `buttonClass()` | `Button.tsx`, `button-class.ts` (pure, usable from server components and links) | Variants primary, secondary, accent, danger, danger-solid, ghost, ghost-inverse, pill (the sign-in ink pill with its scribble); sizes sm (36px), md (44px), lg (48px); `type="button"` unless set; `loading` keeps the label, adds a spinner, `aria-busy` and `aria-disabled` |
| `Field`, `Input`, `Textarea`, `Select` | `Field.tsx` | Visible label tied by id, hint and error in `aria-describedby`, `aria-invalid`, required marker, error as `role="alert"`. Inputs are 44px (`.control`), 16px text on phones (no iOS zoom); email, URL, phone, number and password read left to right, free text `dir="auto"`. `PasswordField` reads the same context |
| `Switch` | `Switch.tsx` | `role="switch"` button with `aria-checked`, a visible or `aria-label` name, logical thumb travel |
| `Badge` | `Badge.tsx` | Tones neutral, info (lilac), success, warning, danger, inverse (on ink); no lemon on light |
| `Callout` | `Callout.tsx` | Tones info, notice, success, warning, danger, each with an icon; danger is `role="alert"`, the rest `role="status"`, overridable (`role="note"` for standing notes) |
| `ToastProvider`, `useToast()` | `Toast.tsx` | Mounted once in the app layout. Polite live region at the bottom inline end (full width on a phone), at most three, 5-8 s, held while hovered or focused, 44px close. For "done" notes; an error the person must act on stays inline. Silent outside the provider |
| `Dialog`, `FormDialog`, `usePrompt()` | `Dialog.tsx` | Native `<dialog>` with `showModal()` (focus trap, Escape, inert page), named and described, focus back to the opener, close button last in the order. `FormDialog` shows one refusal line and a busy submit; `usePrompt` replaces `window.prompt`. `useConfirm` is in `ConfirmDialog.tsx` (below) |
| `Time`, `Money`, `plural()` | `Time.tsx`, `src/lib/format.ts` | Dates in words with Western digits: a bare day in UTC, a timestamp in Asia/Riyadh, through `dateFormat` (never the Saudi locale tag). SAR amounts in `<bdi>`. Arabic's six plural forms from `Intl.PluralRules` |
| `ConfirmDialog`, `useConfirm()` | `ConfirmDialog.tsx` (phase 2, rule 1110; the old app path re-exports it) | One question at a time on a native modal dialog. With `run`, the dialog runs the action itself: the confirm button is busy, cancel and Escape wait, a refusal shows inside the dialog |
| `Sheet` | `Sheet.tsx` (rule 1111) | A native modal `<dialog>` that slides from `start`, `end` or `bottom` (logical). Mount to open, unmount gives focus back to the opener; backdrop press closes; the page behind does not scroll. The phone navigation drawer |
| `Menu` | `Menu.tsx` (rule 1112) | Menu button pattern: `aria-haspopup="menu"`, `role="menu"` / `menuitem`, arrows wrap (`menuIndex`), Home/End, Escape returns focus, a `footer` outside the menu role for forms. The rail's account menu, the chat's specialists |
| `Tabs`, `TabPanel` | `Tabs.tsx` (rule 1113) | Tablist with automatic activation; the arrow moves the way it points in RTL (`tabStep`); 44px tabs on touch. The calendar's week, month and agenda |
| `PageHeader` | `PageHeader.tsx` (rule 1114) | Server-rendered title row: h1 with a `ScribbleStatic` underline drawn in the page's direction, a sub line, actions at the inline end |
| `Skeleton`, `SkeletonText`, `LoadingRegion` | `Skeleton.tsx` (rule 1115) | Shapes hidden from screen readers inside one polite `aria-busy` status. `src/components/app/RouteLoading.tsx` builds the `loading.tsx` screens from them. A `loading.tsx` is a Suspense boundary, and a `redirect()` behind one is a client-side meta refresh, not a 307: never put one above a page that redirects (none at the app root); such a page redirects first, then can wrap its body in `<Suspense fallback={<RouteLoading />}>` |
| `EmptyState`, `ErrorState` | `EmptyState.tsx`, `ErrorState.tsx` (rule 1116) | Nothing yet: one line and one action, plain content. Failed: an alert with a busy Try again |
| `CopyButton` | `CopyButton.tsx` (rule 1117) | Copies and says so in a polite status; `iconOnly` is a 44px named icon button |

Directional icons take `mirror` (rule 1118): `send` and `next` point along the reading direction. `ScribbleStatic` (`src/components/ScribbleStatic.tsx`) is the server-drawn scribble for underlines and ticks; the client `Scribble` stays for art that measures its parent. Phase 2 moved `.card` to `--radius-card` and the body line height to `--leading-body` (rule 1115). Rules 1110-1130: `docs/system/tests/1110-uiux-phase2.md`.

### Settings building blocks (phase 3, rules 1140-1158)

| Piece | File | Use |
|---|---|---|
| `SettingsCard`, `saveEnabled` | `src/components/app/settings/SettingsCard.tsx` | One setting, one card, one Save. The card is its own `<form noValidate>`; Save is `aria-disabled` (still focusable) until the value is changed and valid and no save is on its way; the result is a `role="status"` line under it. Without `onSave` it is a `<section>` with a note in place of Save |
| `SettingsNav`, `SettingsBack` | `src/components/app/settings/SettingsNav.tsx` | The settings sections as links from `SETTINGS_SECTIONS`; the column marks the current one `aria-current="page"`; the `list` variant (the index on a phone) shows each section's line; `SettingsBack` is the phone's way back from a section. 44px rows on touch |
| `PlanCard` | `src/components/app/settings/PlanCard.tsx` | One plan on the billing page. The price is ink, never `text-danger`; the current plan says «خطتك الحالية» / "Your current plan" and has a 2px ink border; «مقترحة» / "Recommended" comes from the pricing `highlight` flag and never shows on the current plan. The pay control is passed in |
| `PaymentHistory` | `src/components/app/settings/PaymentHistory.tsx` | A table of the payments already recorded (`paymentHistory`): date as stored, item, amount in SAR before VAT, the state in words. Western digits |

### Lint warnings (rules 1095-1098)
`eslint-rules/thakeen-ui.mjs`, loaded for `src/` as warnings: `danger-text-needs-alert` (red text is an alert or a destructive action), `lemon-on-ink` (lemon only inside `bg-ink`, `card-inverse` or `data-surface="inverse"`), `no-date-slice` (no `.slice(0, 10|16|19)` inside JSX; use `<Time>`), `no-physical-direction` (ml/mr/pl/pr/left/right/text-left/rounded-l/border-l and the like, with the logical name in the message). The primitives and the migrated screens raise none.

## 3. Rules · القواعد
1. No raw hex outside `tokens.css` (rule 513 checks all of `src/`). Exceptions, each named in the test: `global-error.tsx` (replaces the document, cannot load styles), and the crawler and media store, which handle customers' colours as data. The OAuth consent page renders its own document and imports `tokens.css`.
2. Marketing pages: hand-drawn like prototype D (scribbles, figures); app pages are the quiet version: same colours, type and strokes, plain ink lines. One accent CTA per section.
3. App pages: `page-title` (with its underline) + `page-sub`, then `card` blocks; primary action per card is `btn-primary btn-sm`, destructive is `btn-danger`.
7. Agent colours are fills and strokes, never text: no `text-agent-*`, `decoration-agent-*`, `placeholder-agent-*` and no CSS `color` from an agent variable (rule 517).
4. RTL first: use logical properties (`ms-`, `me-`, `text-start`, `padding-inline`), numbers and URLs get `dir="ltr"`, free text gets `dir="auto"`.
5. Every user-facing string comes from `src/lib/i18n.ts` (marketing) or `src/lib/app-i18n.ts` (app) in both Arabic and English. Inline `ar ? … : …` pairs are acceptable inside a single component, never English-only.
6. Fonts: Thmanyah Serif Display for headings (`--font-display`, rule 317), IBM Plex Sans Arabic for body, IBM Plex Mono for numbers and code.

8. Accessibility target is WCAG 2.2 AA: text 4.5:1, controls and focus 3:1, targets 44px (24px floor for dense lists), focus visible on every surface (lemon ring on ink), every field labelled, status and errors announced.

## 4. Status · الحالة (entries dated; the undated bullets below are from 2026-09-17)
- 2026-10-11, phase 1 of the UI/UX report (`docs/system/tests/1080-uiux-phase1.md`): semantic tokens and the `src/components/ui` primitives above; sign-in, sign-up, forgot and reset, the brand form, brands list, account deletion, integrations, governance and working-days switches and the trial strip moved onto them; lint warnings on. Left for phase 2: the other screens (160 warnings on 2026-10-11), the inline switches in tasks, chat allowance and series, `ConfirmDialog` into `ui/` with a busy confirm, the card radius and body line height, Skeleton and EmptyState.
- Tokens generated and wired; 160 repeated class strings replaced across 40+ components with the classes above; visual parity verified on landing, inbox, profile and founder console in Arabic.
- Founder console and its login are now bilingual; every other page already reads from the dictionaries.
- Dark mode: semantic layer ready, not switched on (on 2026-10-12 `src/app/*.css` carries no `prefers-color-scheme` or theme-attribute rule).
