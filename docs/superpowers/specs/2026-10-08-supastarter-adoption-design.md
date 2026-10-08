# supastarter adoption: what we port, what we skip (2026-10-08)

The founder bought supastarter (Solo licence) on 2026-10-08. The private upstream is cloned read-only at
`~/projects/supastarter` (HEAD 7862e42, 2026-10-08), outside this repository. **No supastarter file is committed here
as a whole.** We read it as reference and write our own code on Redis under our rules (`sc(u)`, `safeFetch`,
`sameSecret`, no `await db.*` in loops, `render` for model HTML, `csvSafe`, tests and `docs/system` in the same commit).
The licence allows unlimited commercial end products and forbids redistribution, so iAbulkhair/Nashr stays private.

This spec corrects the comparison artifact (v2, built from supastarter's public docs) after a code-against-code check:
every row below was verified against both trees and then challenged by a second reviewer.

## Verdict

Do not migrate. supastarter is weaker in code than its docs suggest, and the parts worth having are small:

| Area | Verified finding | Call |
|---|---|---|
| Payments | 5 same-shaped adapters picked by a re-export (`provider/index.ts:1`), not a runtime interface. No paid-amount check, one-time purchases re-created on every webhook retry, Creem HMAC compared with `!==`, no webhook tests. No Paymob adapter. | Reference only, inside the Paymob session (`claude/quizzical-galileo-5b3662`). Copy nothing. |
| Prepaid credits | supastarter has none (metered seats only). | Keep ours. |
| Email | 5 templates, LTR only, English/German/Spanish/French, Tailwind inside email. | Adapt the structure (layout, button, one file per template) with our own RTL layout. Phase 1 here. |
| Settings | Sessions list is real (better-auth). Avatar, email change, passkeys need better-auth or Postgres. | Sessions list later (after Paymob merges, it touches `auth.ts`). Skip the rest. |
| UI kit | Base UI, LTR-only physical classes. | Port single patterns: confirm dialog, show/hide password. Phase 1 here. |
| Uploads | S3 presigned uploads for avatars and logos. | Later, if brand logo upload is wanted. |
| Auth | Email verification, Google sign-in, magic link exist through better-auth plugins. CSRF/Origin check lives inside better-auth for `/api/auth/**` only. | Verification and Google sign-in later (they edit `auth.ts`, which Paymob edits). CSRF: build our own now. |
| Observability | No Sentry in code (docs claim it). Analytics = 6 provider snippets. | Founder decision on analytics vendor. |
| Background jobs | No job adapters in code (docs claim them). | Keep our crons. |
| Admin, teams, i18n, agents | Thakeen ahead (Arabic/RTL, founder console, AI agents, credits, rate limits, SSRF, tests). | Keep. |
| Docs site | Fumadocs app plus an `llms.txt` route. | Port the `llms.txt` idea only. |

Small finds outside the matrix: `getSafeRedirectPath` (normalise, then refuse `//`), invite-only signup switch,
`pnpm` install-time supply-chain gates (`minimumReleaseAge`, build allowlist).

## Phase 1, this branch (`claude/supastarter-thakeen-adoption-55ec97`)

Rules 685-699 and flows §49 are reserved for this branch (see `docs/system/tests.md`).

1. **Arabic and English HTML email** (rules 685-689). `src/emails/`: a layout with `lang` and `dir` on the document
   and on every table cell that Gmail keeps, inline colours from `src/app/tokens.css`, an Arabic-safe font stack,
   LTR runs (links, addresses) wrapped in `dir="ltr"`, a bulletproof button, and one module per template (reset
   password, team invite, generic notice). HTML is built by a small tagged template that escapes every interpolated
   value; there is **no `react-email` dependency** (v6 ships its CLI's esbuild, socket.io, babel and tailwind as
   runtime dependencies, and React 19's `react-dom/server` throws under the `react-server` condition that Next uses
   for route handlers). `sendEmail` gains an optional `html` argument; the hand-written text part stays, so every
   message is multipart. Callers in phase 1: password reset, team invite, lifecycle notes, Reem's reminder, series and
   evening mail. The team invite HTML keeps the relay rule: no organisation or brand name.
2. **Cross-site request check** (rules 690-693). `src/lib/csrf.ts` refuses a state-changing `/api` request whose
   `Sec-Fetch-Site` is `cross-site` or `same-site`; when that header is present it decides alone (Go 1.25's order), and
   only without it must `Origin` match the request's own origin or `appOrigin()`. Requests with neither header pass (cron, webhooks and MCP clients send none and carry no browser
   cookie). Bearer and webhook paths are exempt by path. `src/proxy.ts` adds every `/api` path except the exempt ones to its matcher (Next buffers
   the body of each request the proxy sees, which would undo the 64 KB caps on webhooks and crons). This closes
   login and logout CSRF, `text/plain` form JSON, and posts from same-site siblings such as `staging.thakeen.com`,
   which `SameSite=Lax` does not stop.
3. **`safeNext` normalisation** (rule 694). Return the normalised path (`pathname + search + hash`) and refuse it if
   normalisation produced `//`.
4. **Confirm dialog and password reveal** (rules 695-697). A `ConfirmDialog` on a native `<dialog>` with
   `showModal()`, logical classes and our tokens, through a `useConfirm()` hook that resolves a promise, with a pending
   state so a double click cannot fire twice. It replaces `confirm()` in `TeamPanel`, `FilesPanel`, `GovernancePanel`
   and `WishlistPanel`; `AdminConsole` waits for the per-account overrides session. Password fields get a show/hide
   toggle; the login field gets `autoComplete="current-password"`.
5. **`/llms.txt`** (rule 698). A route at `src/app/llms.txt/route.ts` built from existing site copy only (no new
   claims), not a file in `public/` (the PWA session owns it).

## Later, after the Paymob branch merges

They edit `src/lib/auth.ts`, `src/app/api/cron/daily/route.ts` or `docs/system/variables.md`, which the Paymob
session has open:

- email verification at signup (1.5-2 days);
- Google sign-in (2 days) and email magic link (1 day); Apple later if a store app needs it;
- active sessions list with per-device sign-out (2.5-3 days);
- daily brief, nudge and follow-up mail moved to the HTML layout;

## Founder decisions (2026-10-08)

- Analytics: not a marketing-site snippet. The founder means social platform analytics (Meta, Google, X, LinkedIn,
  TikTok, Snapchat and more) read by the agents for their reports: a separate feature that builds on the Composio
  read-only work (PR #272, merged) and the social results branch (PR #281), not part of this adoption.
- Invite-only switch: no, signup stays open.
- Google sign-in: yes, after the Paymob branch merges (the founder creates the Google OAuth client and adds the
  variables).
- npm supply-chain gate: yes, 7 days. Done on this branch: `.npmrc` `min-release-age=7` (rule 699).

## Open sessions and file ownership

- Paymob (`claude/quizzical-galileo-5b3662`): billing, `auth.ts`, `account.ts`, `credits.ts`, `cron/daily`,
  `roles.ts`, `variables.md`. Not touched here, except three line references in `variables.md` (`RESEND_API_KEY`,
  `MAIL_FROM`, `SUPPORT_WHATSAPP`) that the `notify.ts` and `lifecycle.ts` edits moved.
- PWA (`claude/laughing-elion-9449f8`, PR #280): `public/`, `manifest.ts`, layouts, and the `src/proxy.ts` matcher.
  Our matcher change conflicts on one line; the resolution keeps our `/api` lookahead entry and adds PWA's paths to
  the array.
- Per-account overrides session: `AdminConsole.tsx`. Its three `confirm()` calls move to the dialog after it merges.
