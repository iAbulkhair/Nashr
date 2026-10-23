---
name: add-a-public-page-or-guide
description: Use when adding a public marketing page, an industry or compare page, or a blog post to thakeen.com, in Arabic and English, with sitemap and metadata.
---

# Add a public page or guide

Public pages live under `src/app/[lang]/...` and need no sign-in. Blog posts are Markdown files, not pages. Next.js 16 page and metadata APIs differ from older versions: read the matching guide in `node_modules/next/dist/docs/` first.

## A blog post (the common case)

1. Create `content/blog/<slug>.md`. Front matter keys: `title_ar`, `title_en`, `desc_ar`, `desc_en`, `date`. The Arabic body comes first, then a line `---EN---`, then the English body.
2. `src/lib/blog.ts` validates the files (rule 1979) and feeds the blog index, the post page and the sitemap. Do not add a route by hand.
3. Write the copy by the rules in add-arabic-and-english-copy: Arabic first, parity, no invented customers, numbers or results. Model-written HTML is never trusted; posts render through `render` in `src/lib/md.ts`.
4. Run `npx vitest run tests/blog-sitemap.test.ts` and `npm run check`.

## A new page

1. Create `src/app/[lang]/<segment>/page.tsx`. Check `isLang(lang)` from `src/lib/i18n.ts` and call `notFound()` otherwise. Export `generateMetadata` built with `pageMeta` from `src/lib/page-meta.ts` so title, description, canonical and hreflang are consistent.
2. Build the page from `Nav`, `Footer` and `FinalCta` in `src/components` and the UI primitives in `src/components/ui` (add-a-ui-component). Page copy lives in a library file, not inline: `src/lib/site.ts`, `src/lib/pages-industry.ts`, `src/lib/pages-compare.ts` or `src/lib/home.ts`, with Arabic and English side by side.
3. A new top-level public folder must be listed in `PUBLIC_SEGMENTS` in `src/proxy.ts`, otherwise the proxy sends visitors to sign in. `tests/global-nav.test.ts` compares that list with the folders on disk.
4. Add the URL to `src/app/sitemap.ts` (both languages, with hreflang alternates) and to the page list in `src/app/llms.txt/route.ts`.
5. Add a link from `Nav` or `Footer` only if the founder wants it in the global navigation.
6. Pricing, plan names and limits are never typed into the page: read them from `src/lib/pricing.ts` (change-a-plan-or-price). `tests/pricing-copy.test.ts` fails on a hard-coded price.

## Rules for every public page

- No invented customers, logos, testimonials, counts or result promises (CLAUDE.md). Scenarios are labelled as scenarios.
- Spellings and phrasing: `tests/site-critique-copy.test.ts` and `tests/arabic-digit-codes.test.ts` pin them. The Thmanyah font is never named.
- Both languages work with right-to-left layout and logical CSS properties (no `left`/`right` classes; the lint rule `no-physical-direction` warns).
- Check the page in the browser at phone width and desktop, in both languages, light and dark.

## Checks

`npx vitest run tests/global-nav.test.ts tests/pricing-copy.test.ts tests/site-critique-copy.test.ts`, then `npm run check` and `npx next build`.

## Traps

- Forgetting `PUBLIC_SEGMENTS`: the page works signed in and bounces signed out.
- Adding the page to the sitemap in one language only.
- Copying a competitor claim or a number from research. If a number cannot be proven from the repo, leave it out.
- Docs: add the route to `docs/system/architecture.md` and a rule file under `docs/system/tests/` (add-a-feature, step on numbering).
