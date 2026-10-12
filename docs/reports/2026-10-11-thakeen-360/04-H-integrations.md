# 04-H Integrations (Thakeen 360, 2026-10-11)

Scope: one row per integration. Read-only study on origin/main 3bf67673, compared with origin/production 487984f4 (main is 77 commits ahead). Machine-readable findings: `raw/findings-H.jsonl` (H-001 to H-015). Env var NAMES only; no value was read or printed.

## Summary

1. Only key-based connectors (Telegram, WordPress, WooCommerce, Odoo, PrestaShop, Klaviyo, Brevo) and Resend mail work on thakeen.com without any approval. Social, ads and store OAuth are all dormant.
2. Composio (publishing plus read-only ads and analytics) is in production code but no COMPOSIO_* variable is known to be set, so Facebook, Instagram, X, LinkedIn and TikTok cannot be connected today.
3. LinkedIn: our code sends no Linkedin-Version header and calls no LinkedIn endpoint directly; the version is whatever Composio's toolkit sends. Our pins (linkedin 20260924_00, linkedin_ads 20260826_00) are Composio snapshot dates, not LinkedIn versions, so changing them does not set the header. 202510 sunsets on 15 Oct 2026 (confirmed 2026-10-12 on LinkedIn's official [versioning page](https://learn.microsoft.com/en-us/linkedin/marketing/versioning); latest 202609). Which version Composio sends is unverified. No live impact while Composio is dormant. The PRD toolkit pin (20250915_00) is stale; code pins 20260924_00.
4. Reem calendars, Drive archive and media storage are not live: calendars are main-only, Drive is a spec, media has no keys or Blob on live.
5. No page shows which integrations are on. Statuses had to be inferred from docs, logs and DNS.

## Current state

| Integration | Code present | In origin/production | Env var names | Approval needed | Status |
|---|---|---|---|---|---|
| Composio publish (FB, IG, X, LinkedIn, TikTok) | yes, `connectors/composio.ts`, `composio-catalog.ts` | yes | `COMPOSIO_API_KEY`, `COMPOSIO_PROVIDERS`, `COMPOSIO_AUTH_*` per toolkit | Composio account; per-platform app review (Meta, TikTok, LinkedIn) | dormant (env UNVERIFIED today) |
| Composio read-only ads and analytics (Meta Ads, Snap, Google Ads, TikTok Ads, LinkedIn Ads, GA4, GSC) | yes, `ads-via-composio.ts`, `site-stats.ts` | yes | same `COMPOSIO_*` | Meta ads_read review, Snap app, LinkedIn Advertising app, Google consent | dormant |
| Composio Wave B drafts (WhatsApp templates, YouTube private, Klaviyo, Brevo drafts) | yes | yes | same `COMPOSIO_*` | WhatsApp sending banned for AI providers; drafts only | dormant |
| Telegram | yes, `keyed.ts` | yes | none (customer bot token stored per account) | none | working in code; no customer use recorded |
| WordPress (+ WooCommerce) | yes | yes | none (customer app password) | none | working in code; title duplicates H1 (#144) |
| Odoo, PrestaShop, Klaviyo, Brevo | yes | yes | none (customer keys) | none | working in code |
| X direct OAuth | yes, `x.ts` | yes | `X_CLIENT_ID`, `X_CLIENT_SECRET` | X developer app, funded credits, spend limit | dormant |
| Shopify OAuth | yes, `shopify.ts`, API 2026-07 | yes | `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Partner app; protected customer data if customer scopes kept | dormant |
| Salla, Zid | yes | yes | `SALLA_CLIENT_ID/SECRET`, `ZID_CLIENT_ID/SECRET` | partner app approval | dormant |
| Meta direct (Graph v23.0) | yes, `meta.ts` | yes | `META_APP_ID`, `META_APP_SECRET` | App Review plus Business Verification (needs company papers) | dormant |
| Google Drive archive (#320) | no, spec only | no | none yet | Google consent verification for direct `drive.file` | not built |
| Google / Microsoft calendars (Reem) | yes, `secretary-gcal.ts` | no (main only, #314) | `GOOGLE_*`, `MICROSOFT_*`, QStash signing keys | Google sensitive-scope verification; Microsoft publisher verification | not live, cannot link |
| fal (images) | yes | yes | `FAL_KEY` | none; spend limit advised (#137) | UNVERIFIED on live; placeholders without key |
| kie.ai, Higgsfield | yes, `media/config.ts` | yes | `KIE_API_KEY`, `HIGGSFIELD_*`, `BLOB_READ_WRITE_TOKEN` | none | dormant; live has no Blob |
| Resend mail | yes, `notify.ts` | yes | `RESEND_API_KEY`, `MAIL_FROM` | none | working (verification codes delivered); DMARC p=none; reset incident e577 unresolved |
| LinkedIn version header | none in our code | n/a | n/a | n/a | version set by Composio toolkit (unverified which); Composio snapshot pins 20260924_00 and 20260826_00 |

## Findings (P0 first)

No P0 in H. Nothing here is a live bug or legal exposure on its own; the launch blockers are upstream (G-002 papers, G-006 legal text).

P1
- H-001 Composio dormant. Without it no social publishing exists. Founder creates the account and sets the env names; Claude probes on staging.
- H-002 LinkedIn 15 Oct sunset (202510, confirmed on the official page). No code change today. Before enabling LinkedIn: ask Composio support which Linkedin-Version toolkits 20260924_00 and 20260826_00 send, or run one read on a test account after 15 Oct; only if one sends 202510, move that pin to the newer Composio snapshot they name. Fix the PRD number.
- H-003 Read-only ads and analytics dormant; approvals with weeks of lead time (Meta ads_read, LinkedIn Advertising, Google).
- H-009 Meta direct and App Review not started; depends on company papers.
- H-011 Reem calendars main-only and unlinkable; Google sensitive-scope verification takes weeks and needs the privacy policy fixed first.
- H-012 Media providers: without `FAL_KEY` every image is a placeholder card while the site markets images.
- H-013 Resend works, but the 2026-10-09 password-reset report has no recorded cause and DMARC has no reporting address.
- H-014 Old Vercel project and Vercel Blob references remain in code, legal text and drafts #319/#320.

P2
- H-004 Wave B drafts exist; WhatsApp stays a link plus template draft.
- H-005 Key-based connectors work; one recorded live test would close the gap.
- H-006 X direct dormant; needs an X app and funded credits.
- H-007 Shopify dormant; drop `read_customers` if unused to avoid an extra review.
- H-008 Salla and Zid dormant.
- H-010 Drive archive is a spec only.
- H-015 No integrations status view for the founder.

## What could not be verified and why

- Current hPanel env vars: not readable. Statuses of every `COMPOSIO_*`, `X_*`, `SHOPIFY_*`, `META_*`, `FAL_KEY`, `KIE_*`, `HIGGSFIELD_*`, `GOOGLE_*`, `MICROSOFT_*`, QStash keys are as of 2026-10-08 logs, not today.
- Which Linkedin-Version Composio's toolkit 20260924_00 sends: not visible without calling Composio (paid account, not allowed).
- Whether any platform application (Meta, TikTok, Snap, LinkedIn, Google, Microsoft, Salla, Zid, Shopify, X) has been filed: not recorded in repo or issues.
- Whether Resend is the provider behind `send.thakeen.com`: DKIM record present and code uses Resend, but the sending account was not inspected.
- Customer use of Telegram and WordPress on live: no data accessible.
- Meta policy on WhatsApp sending and Shopify protected-data rules: taken from the PRD and general knowledge, not re-checked against the platforms today.
- Composio's Node requirement vs Hostinger Node 22.18: only a warning in the 2026-10-08 log; not re-tested.
