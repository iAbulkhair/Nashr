---
name: add-arabic-and-english-copy
description: Use when adding or editing any customer-facing text in Thakeen; Arabic first, both languages at parity, house spelling rules.
---

# Add Arabic and English copy

Thakeen is Arabic-first. `Lang` is `"ar" | "en"` and `isLang` is in `src/lib/i18n.ts`. There are two dictionaries:

- Marketing and public copy: `dict` in `src/lib/i18n.ts`, plus library files `src/lib/site.ts`, `src/lib/pages-industry.ts`, `src/lib/pages-compare.ts`, `src/lib/home.ts`.
- App copy: `appDict` in `src/lib/app-i18n.ts`, assembled from `src/lib/app-i18n-shell.ts`, `app-i18n-workspace.ts`, `app-i18n-pages.ts`, `app-i18n-todo.ts` and `app-i18n-team.ts`. The Arabic object is written first and the English object is typed as `typeof ar`, so a missing English key is a compile error.
- Email copy: `src/emails/copy.ts` (add-or-edit-an-email). Blog posts: front matter and `---EN---` split (add-a-public-page-or-guide).

## Steps

1. Write the Arabic first, in the product voice: short, plain, direct. Then the English with the same meaning, not a literal copy.
2. Add keys to the right file (shell for the frame, workspace for brand screens, pages for page bodies, todo for tasks, team for members). Group keys by screen. Never inline a string in a component, and never build a sentence from concatenated fragments; give the whole sentence a key with placeholders.
3. Read in pages with `appDict[lang]` after `isLang(lang)`; in client components receive the dictionary slice as props from the page.
4. Error texts: a new API error code needs both texts in the client error map in `src/lib/app-i18n.ts` (add-an-api-route, step on `ApiError`).
5. Numbers and dates: format through the shared helpers so Arabic digits, separators and calendars are consistent. `tests/arabic-digit-codes.test.ts` pins the codes.
6. Run `npm run check`: the type check catches missing English; the copy tests catch the spelling rules below.

## House rules (each is pinned by a test or a recorded founder decision)

- No arrows in Arabic copy (rule 687).
- Spell «إنستقرام» as written here; write «ثلاث عملاء» as the founder decided.
- Never mention the Thmanyah font anywhere.
- No invented customers, logos, testimonials, numbers or result promises, in either language. A scenario is labelled as a scenario.
- Prices and limits come from `src/lib/pricing.ts`, never typed (change-a-plan-or-price).
- The public name is Thakeen (ذكين); "Nashr" is the code name and does not appear in customer copy.
- Approval-first wording: the product proposes, the person approves. Do not write copy that implies the product posts or spends on its own.

## Tests that watch copy

`tests/site-critique-copy.test.ts`, `tests/arabic-digit-codes.test.ts`, `tests/pricing-copy.test.ts`, `tests/mail-templates.test.ts`. If your change adds a general rule (a banned phrase, a spelling), add it to one of them and give it a rule number in a `docs/system/tests/` file.

## Checks

`npx vitest run tests/site-critique-copy.test.ts tests/arabic-digit-codes.test.ts`, then `npm run check`. Open the screen in both languages in the browser: right-to-left alignment, no truncated button text, no mixed-direction punctuation at line ends.

## Traps

- Leaving the English as a copy of the Arabic key name. It ships.
- Machine-translated Arabic. Read it aloud; if it sounds like a manual, rewrite it.
- Hard-coded `left`/`right` in the layout that makes the Arabic version look mirrored wrong (add-a-ui-component).
