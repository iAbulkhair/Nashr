---
name: add-a-ui-component
description: Use when adding or changing a shared UI component, a page layout or a style in Thakeen (tokens, dark mode, RTL, accessibility, lint rules).
---

# Add a UI component

The guide is `docs/Design_System.md`. Primitives live in `src/components/ui` (Badge, Button, Callout, ConfirmDialog, CopyButton, Dialog, EmptyState, ErrorState, Field, HelpLink, Menu, PageHeader, Sheet, Skeleton, Switch, Tabs, ThemeToggle, Time, Toast). App-specific pieces live in `src/components/app`. Tokens are in `assets/design-tokens.json`, `src/app/tokens.css` and `src/app/theme-dark.css`.

## Steps

1. Look for an existing primitive first. A button is `Button` (class helper in `src/components/ui/button-class.ts` for links), a confirmation is `ConfirmDialog`, an empty list is `EmptyState`, a failure is `ErrorState`. Only add a new primitive when two screens need it.
2. Put a shared component in `src/components/ui/<Name>.tsx`; keep a one-screen piece next to its page or in `src/components/app`. Mark it `"use client"` only if it needs state or events.
3. Colour: use the semantic role utilities (`bg-surface`, `text-foreground` and the like), never a raw hex or palette class. The lint rule `no-raw-colour` in `eslint-rules/thakeen-ui.mjs` is an error. Dark mode works because roles are redefined in `src/app/theme-dark.css`. If you need a new token, change `assets/design-tokens.json`, `src/app/tokens.css` and `src/app/theme-dark.css` together: `tests/design-tokens.test.ts` (rule 510) fails when they differ.
4. Shape: controls have 8px corners, surfaces 12px (rule 2316).
5. Right-to-left: use logical properties (`ms-`, `pe-`, `start`, `end`), never `left`/`right`. The rule `no-physical-direction` warns, and `eslint-rules/ratchet.json` with `tests/lint-ratchet.test.ts` stops the warning count from growing. If you removed warnings, lower the cap with `node scripts/lint-ratchet.mjs --write`.
6. Text: every visible string comes from `appDict` or the page dictionary (add-arabic-and-english-copy). Dates and numbers go through `Time` or the shared formatters, not `toISOString().slice`. Arabic digit codes follow `tests/arabic-digit-codes.test.ts`.
7. Accessibility: a real `button` or `a`, a visible focus ring, labels tied with `Field`, error text with a role that screen readers announce (the rule `danger-text-needs-alert` warns). Touch targets at least 44px on phones. Dialogs and sheets trap focus; reuse `Dialog` and `Sheet`.
8. Server or client: do not import server-only libraries (`src/lib/models/catalog.ts`, anything that reads Redis) into a client component. `tests/client-bundle.test.ts` guards it.
9. Verify in the browser: Arabic RTL and English, light and dark, phone width and desktop. Use the preview server (the `nashr-dev` entry in `.claude/launch.json`). Look at it; type checks do not show a broken layout.
10. Tests: a pure-logic test for any logic you put in the component. Layout rules are pinned in `tests/uiux-phase*.test.ts` and `tests/confirm-dialog.test.ts`; extend those when the rule is general. A customer flow change also gets a journey (write-a-browser-test).

## Checks

`npx vitest run tests/design-tokens.test.ts tests/lint-ratchet.test.ts tests/client-bundle.test.ts`, then `npm run check` and `npx next build`.

## Traps

- Hex colours copied from a mock-up. Map them to roles or ask for a token.
- A new animation without a `prefers-reduced-motion` path.
- Hiding a failure in a toast only. Persistent errors stay on screen.
- Decorative claims in empty states: no invented numbers, customers or testimonials.
