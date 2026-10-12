# Workstream E: UI/UX and brand (Thakeen 360, 2026-10-11)

Checked against origin/main `3bf67673`, origin/production `487984f4`, draft #317 (branch head `a2a5a915`), and the live site https://thakeen.com (120 sitemap URLs fetched 2026-10-11, plus a 375px browser check). Read-only. Findings: `raw/findings-E.jsonl` (E-001 to E-029).

## Summary

1. The foundation is good: `lang`/`dir` set, logical CSS properties (115 uses against 2 `text-left`), contrast tokens pass, focus ring exists, no horizontal overflow at 375px. Brand check passes: no "Nashr" and no model names (Claude, Sonnet, Opus, GPT as ours) on any live public page.
2. Draft #317 closes the report's bugs B-1 to B-11 and most quick wins, but it is still a draft, so none of it is on main or live. Production still has the admin "Cancel applies the change" bug (26 `prompt(` calls) and the bare password prompt on account deletion.
3. Phase 0 is not finished even with #317: Plex 700, font preload trim, "coming soon" bullets, `hello@nashr.ai`, 44px targets, Arabic aria-labels, mirrored arrows and Western digits are all still open.
4. Real customer-facing gaps: login inputs have no label, paid plan bullets list unshipped features as "(قريباً)" on 26 pages, no `loading.tsx`/skeleton anywhere, no automated accessibility test.
5. Phases 1 to 5 (tokens and primitives, shell states, settings and billing, founder console, dark mode) have not started. Recommended order: tokens/primitives, then settings and billing, dark mode last.

## Current state

| Area | State | Evidence | Label |
|---|---|---|---|
| Brand name on public pages | Thakeen / ذكين everywhere; titles, manifest, llms.txt correct | 120 URLs scanned; 0 "Nashr" in visible text | VERIFIED |
| Model names on public pages | None for Claude/Sonnet/Opus/Haiku. Anthropic, fal.ai, kie.ai, Higgsfield named in privacy and help (sub-processor disclosure). ChatGPT named in comparison pages (competitor) | live /ar/privacy, /ar/help, /ar/pricing | VERIFIED |
| Old brand left in product | `hello@nashr.ai` (billing, top-up, contact error), `nashr_` MCP token prefix, `nashr_partner` cookie named in privacy text, `FALLBACK_ORIGIN` Vercel URL | src/app/[lang]/app/billing/page.tsx:124, src/lib/mcp.ts:24, src/lib/origin.ts:15 | VERIFIED |
| Design tokens | 3 layers in `src/app/tokens.css`, mapped in `globals.css`, held by `tests/design-tokens.test.ts`. No success/warning/muted-foreground tokens | tokens.css | VERIFIED |
| Contrast | Text tokens pass AA (muted on paper 7.84, ink/70 6.01, input border 3.75). Agent colours (lemon, cyan, green) fail as text but are used on ink or as fills only. Reports chart series fail (fixed in #317) | computed from token values | VERIFIED |
| RTL and Arabic type | `html lang/dir` set per language; logical utilities; Thmanyah for headings, Plex Sans Arabic body (400/500/600); home body font wrong (fix in #317); letter-spacing on Arabic only seen on the wordmark live | layout.tsx, live computed style | VERIFIED |
| Accessibility | Focus ring global; skip link only after #317 and only in app/console; login inputs unlabelled; 140 aria-labels in source; no axe in CI | live login HTML, package.json | VERIFIED |
| Mobile | No overflow at 375; 49 of 94 links/buttons under 44px, footer links 21px; nav trigger 32px | browser pane | VERIFIED |
| Dark mode | None. #317 pins `color-scheme: light` | no `prefers-color-scheme` in src | VERIFIED |
| Empty/loading/error | `error.tsx`, `not-found.tsx`, `global-error.tsx` at `[lang]`; no `loading.tsx`, no skeletons; `app/error.tsx` and `admin/error.tsx` only in #317 | file search | VERIFIED |
| Admin shell (#304) | Own layout, noindex, `<nav>` with `aria-current`, logical props, mobile drawer without dialog semantics | AdminNav.tsx, admin/layout.tsx | VERIFIED (source), UNVERIFIED (in browser, needs founder session) |
| Public "no invented customers" | Customers page says no logos until real and consented | live /ar/customers | VERIFIED |

## What draft #317 closes against the supastarter report

| Report item | #317 | Note |
|---|---|---|
| B-1 admin reason prompts | closed (rule 960) | in draft |
| B-2 extend trial | closed (960) | in draft |
| B-3 account delete password | closed (964) | in draft |
| B-4 temp password | closed (960) | in draft |
| B-5 chat thread key | closed (962) | code only, no runtime test yet |
| B-6 page titles (40 pages) | closed (961) | in draft |
| B-7 home font | closed (965) | live bug confirmed |
| B-8 chart contrast | closed (967) | in draft |
| B-9 Paymob confirm | closed (974) | in draft |
| B-10 BrandForm errors | closed (975) | in draft |
| B-11 Integrations errors | closed (976) | in draft |
| Skip link, `<nav>`, `aria-current`, `color-scheme`, Arabic letter-spacing, chat `role=log`, error boundaries | closed (963, 966, 968, 969, 973, 977) | skip link not on public pages |
| Plex 700, preload trim, coming-soon bullets, `hello@nashr.ai`, 44px trigger, Arabic aria-labels, `text-left`, mirrored arrows, Western digits, home type scale | not in #317 | needs phase 0b |
| Phases 1-5 | not started | see E-026 |

#317 checks: CI SUCCESS, Vercel status FAILURE (the old nashr project, retired by #319), Vercel Preview Comments SUCCESS. 68 files, rules 960-969 and 974-977.

## Findings (P0 first)

**P0**
- E-001 Founder console on production applies plan, seats, credits, refund and removal changes when the reason prompt is cancelled. Fix is in draft #317. Live now.

**P1**
- E-002 Extend trial: Cancel adds 7 days. E-003 Account deletion asks the password in a bare prompt. E-005 Chat thread key bug (code only). E-006 Home page in system font (live). E-008 One title for all 40 app and admin pages. All ship with #317.
- E-009 #317 is a draft; the founder has to mark it ready and a release PR has to carry it.
- E-010 Remaining phase 0 items need a second branch.
- E-011 Plans list unshipped features as "(قريباً)": yearly billing, social images, Saudi data residency, white-label reports, ad auto-tuning, WhatsApp campaigns, CRM link, voice-model training. Founder decision per bullet.
- E-012 `hello@nashr.ai` shown to customers; founder confirms the real support address.
- E-016 Login fields have placeholders only.
- E-017 No loading states; no app/admin error boundary until #317.
- E-026 Phases 1-5 not started.

**P2** (E-004, E-007, E-013 to E-015, E-018 to E-025, E-027 to E-029): leftover native dialogs (39), no dark mode or semantic tokens, vendor names in privacy text (decision), legacy `nashr_` identifiers (do not rename without expand/contract), skip link and axe test missing on public pages, small touch targets, Plex weight mismatch, home page weight (717 KB raw, 273 KB compressed), admin drawer semantics, doc drift (`PRODUCT.md:38`), mixed digit systems.

## Decisions for the founder

1. Mark #317 ready and release it, or hold it until #319 removes the red Vercel status.
2. Per "(قريباً)" bullet: remove from plan cards, or move to a roadmap list.
3. The real support mailbox to replace `hello@nashr.ai`.
4. Keep Anthropic and the media vendors in the privacy text as the stated exception to "no model mention" (recommended; hiding sub-processors is a legal risk).
5. Digit rule: Latin everywhere (matches prices), or Arabic-Indic.

## What could not be verified and why

- Runtime behaviour of #317 (B-5 chat key, dialogs): no dev server in the sandbox and no builds allowed in this study.
- Admin console in a browser: needs a founder session; judged from source only.
- Core Web Vitals and Lighthouse: not run; only byte sizes and timings from curl.
- Faux-bold rendering of Plex at weight 700 and Arabic line-height 1.2 on titles: certain from code, not screenshotted.
- Logged-in app screens, mobile chat pane and dark-OS rendering of the live app: no customer session used.
- Pages not in the sitemap (`/ar/for`, `/ar/vs` index return 404 and are not linked) and email templates: not audited.
- Competitor scoring tables in the blog (for example the "best AI marketing agents" post) were not fact-checked here; that belongs to the content workstream.
