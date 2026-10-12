# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Launch priority, in order (confirmed 2026-09-17):
1. Saudi e-commerce founders on Salla, Zid or Shopify, 1-5 people, WhatsApp-heavy sales. Situation: no marketing hire, no agency budget, content always late for the season.
2. Clinics and local services (dental, derma, beauty, restaurants) that book via WhatsApp and Google Business.
3. Small Gulf marketing agencies running 3-10 client brands (multi-brand workspaces).
4. Startups and B2B firms (law firms, real-estate developers) needing content plus sales enablement.
All segments are supported; the product optimizes for segment 1 first. The buyer and the daily user are the same person: the owner, on phone and laptop, in Arabic first.

## Product Purpose
Thakeen (ذكين) is an autonomous marketing and sales team for Gulf SMBs. Nashr (نشر) is the internal code name: the repository, code identifiers and URLs keep it. The owner gives a website URL; Noor reads it, writes the brand file and a 90-day plan, then produces publish-ready content every week. Specialists cover sales enablement (Sami), finance and pricing (Razan), go-to-market and growth (Faris), reporting and decks (Dana), executive advice (Majed), product and retention (Layan). Everything lands in an approval inbox; nothing publishes without the owner unless delegated.
Success order for the first 90 days (confirmed): investor readiness first (traction story: users, approvals, testimonials, deck), then weekly active workspaces, then approved and published content per workspace, then paying customers.

## Positioning
A team of named Gulf agents that works from one brand file, in the owner's dialect, on the Gulf calendar (Ramadan, Eids, National Day, Founding Day, White Friday), with Saudi advertising guardrails and a second-pass reviewer. Enrich Labs (Helena) is the US reference; Thakeen's claim is the Gulf-native one: dialect, seasons, WhatsApp-first sales, SAR and VAT, Salla/Zid, approval-first trust.

## Operating Context
- Owner logs in a few times a week; the morning brief and follow-up notifications bring them back. Approval happens in chat cards or the approvals feed; scheduling in the calendar; performance on the performance page.
- Content is copied to platforms manually until connectors are live; WordPress, WooCommerce, Klaviyo, Odoo, PrestaShop, Telegram, Brevo work today; Shopify, X, Google, Meta, Salla, Zid, Snapchat, TikTok, LinkedIn activate when their platform keys are added.
- Credits are the unit of value (flat per batch); trial is 3 days and 50 credits; paid plans Starter 299 (300 credits, 1 seat), Pro 499 (700 credits, 3 seats) and Business 999 (1,500 credits, 7 seats) SAR per month plus VAT, and Agency by contract (never cheaper per credit than Business); brands are unlimited on every plan, the first brand's setup is free and each added brand's costs 9 credits. One table in code: `src/lib/pricing.ts` (pricing phase 1, 2026-09-30).
- Founder operates alone: admin console, Hostinger (the host since 2026-10-08), GitHub, Upstash Redis, Anthropic models; secrets are added by the founder in their own terminal.

## Capabilities and Constraints
- 18 task types across 7 agents; chat with tools; URL onboarding; multi-brand; governance (auto-approve types, weekly cap, reviewer, learning from edits); scheduled tasks (weekly plan, daily brief, follow-ups); notifications; reports dashboard; PowerPoint export; MCP server with OAuth 2.1; free public tools; blog; help center; referrals and share-on-social credits; automated quality judge; behavioural evals; founder admin.
- Images generate with `FAL_KEY` (placeholder otherwise); further image styles and video (generate, preview, download; no video publishing) from kie.ai and Higgsfield appear when their keys, the Blob store and `MEDIA_MODELS_ON` allow them. Email delivery needs `RESEND_API_KEY`. Performance numbers from analytics, ads, store and social platforms need their connections; until then the performance page shows workspace data and says so.
- Terminology (Arabic first): نور Noor, الفريق the team, صندوق الموافقة approval inbox / الخلاصة feed, كريدت credits, ملف العلامة brand file, المهام المجدولة scheduled tasks, الحوكمة governance, التكاملات integrations.
- Undecided: video publishing, SMS channel. Settled since this line was written: the payment provider is Paymob KSA (built, off until its keys and the founder's go-live, `docs/system/flows.md` billing sections), the domain is thakeen.com, and team seats ship with the plans (Pro 3, Business 7). Chat sharing: unverified.

## Brand Commitments
Confirmed binding:
- Arabic-first, Gulf identity: Arabic default, RTL first, Saudi dialect option. The oasis/saffron/salt/sadu palette and its Sadu weave are gone from `src/` (nothing there names them on 2026-10-12): the look is prototype D, with the ink, lilac and lemon tokens of `docs/Design_System.md` section 1 (rules 510-517).
- Approval-first trust: nothing publishes without the owner unless delegated; credits and costs are always shown honestly; no invented numbers anywhere in product or agent output.
- Bilingual parity: every screen and message equal in Arabic and English.
- Team of named agents: Noor and the six specialists are the product's face; never "an AI tool".
Names: Thakeen / ذكين; Noor / نور; Sami / سامي; Razan / رزان; Faris / فارس; Dana / دانة; Majed / ماجد; Layan / ليان. Fonts in use: Readex Pro (display), IBM Plex Sans Arabic (body), IBM Plex Mono (numbers).

## Evidence on Hand
- Real product runs on production (onboarding from live Saudi sites, weekly plans, WhatsApp batches, Sami and Dana outputs, judge scores). Screenshots can be taken from https://thakeen.com (the old public address nashr-tau.vercel.app belongs to the retired Vercel project).
- Docs: `docs/PRD.md`, `docs/Nashr_Financial_Model.xlsx`, `docs/Nashr_Pitch_Deck.pptx`, `docs/Enrich_Teardown.md`, `docs/GTM_Teardown_and_Nashr_Plan.md`, `docs/Requirements_and_Steps_AR.md`, `docs/Design_System.md`.
- Absent, do not fabricate: customer testimonials, customer logos, usage counts, revenue, press, awards, "N businesses on autopilot" style proof. The landing page currently shows only deliverable counts per plan, not customer numbers.

## Product Principles
1. Deliver first, advise second: the owner asks, the team produces, then suggests the next step. Never lecture before the work.
2. Honest by construction: placeholders for unknown numbers, visible credit costs, judge scores, and connection warnings instead of empty charts.
3. Gulf calendar and dialect drive the plan; global best practice is adapted, never pasted.
4. One brand file, one team: every agent reads the same memory and the owner's edits teach all of them.
5. The owner stays in control: approval inbox, governance switches, delegation by type.

## Accessibility & Inclusion
RTL-first layouts with logical properties; Arabic and English at parity; keyboard shortcuts on calendar; visible focus rings; no colour-only status (badges carry text). No formal WCAG target set yet.
