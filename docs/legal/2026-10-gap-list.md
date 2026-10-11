# Legal drafts: product gaps and lawyer questions (2026-10-11)

Companion to the four drafts in `docs/legal/`:
- `2026-10-privacy-policy-draft_AR.md`, `2026-10-privacy-policy-draft_EN.md`
- `2026-10-terms-draft_AR.md`, `2026-10-terms-draft_EN.md`

Written by Claude (not a lawyer) from origin/main `37b00583`, plus three other sources:
- the media storage spec on `origin/claude/media-storage-spec-41fe7e`;
- the 360 study on `claude/360-study-2026-10-11`, findings C-002, C-009, C-010, C-020 and G-006, G-007, G-010.

Nothing here changes code. Each item says what the product must do so that the drafts become true, with file pointers. Anything that changes a route, a permission or a stored shape follows the usual rules:
- docs/system updates;
- a `docs/system/tests/NNNN-*.md` file;
- expand then contract (rule 679);
- a rate limit on public routes.

The drafts are **not** publishable until every item marked **before publishing** is done, or the matching sentence is removed from the drafts.

## 1. Facts found (inventory)

### 1.1 Personal data and where it lives

| Data | Where stored | Evidence |
|---|---|---|
| Account: name, email, phone (optional), bcrypt hash, lang, plan, credits, trial end, `sessionsAfter` | Upstash Redis `user:{email}` | `src/lib/auth.ts:227-247` (`createUser`), `src/app/api/auth/signup/route.ts:34` |
| Sessions: raw token, 30 days | Redis `session:{token}`, cookie `nashr_session` | `src/lib/auth.ts:169,294-312` |
| Team members, invites, roles, governance history with emails | Redis | `src/lib/team.ts`, `src/lib/governance.ts:202` |
| Brand file, crawl text, catalogue, workspace files (text only) | Redis, per scope | `src/lib/brand.ts`, `src/lib/crawl.ts`, `src/lib/files.ts` |
| Chat, tasks, decisions, feedback reasons, Reem items, activity log | Redis, capped lists (`CAPS`) | `src/lib/db.ts:481`, `src/lib/conversations.ts` |
| Connector tokens: AES-256-GCM under `CONNECT_SECRET`; or a Composio account id, with the token at Composio | Redis | `src/lib/connectors/store.ts`, `src/lib/connectors/via-composio.ts` |
| Store sales: counts, revenue and product names only; no customer PII | Redis | `src/lib/connectors/sales.ts:3,62` |
| GA4 / Search Console totals incl. public search queries; social post results; ad totals | Redis | `src/lib/site-stats.ts`, `src/lib/social-stats.ts`, `src/lib/ad-stats.ts` |
| Booking attendees (Cal.com, Calendly): name, event name, times; never email, phone or answers | Redis | `src/lib/secretary-booking.ts:1-20` |
| Generated media: public, unguessable URL, 1-year cache; fal images hot-linked when not copied | Vercel Blob | `src/lib/media/blob.ts`, `docs/system/architecture.md` 2.7 |
| Paymob saved card: token, last4, brand; no PAN | Redis (only when Paymob is on) | `src/lib/billing.ts:60,267` |
| Partner: IBAN, holder name, country, tax number; `consentAt` and `termsVersion` | Redis | `src/lib/partners.ts`, `src/app/api/affiliates/route.ts:27` |
| Support tickets, enterprise and early-adopter leads: name, company, contact, message; newest 2,000, no TTL | Redis `support-tickets` | `src/app/api/support/route.ts:15`, `src/lib/leads.ts` |
| Usage analytics: self-hosted counters, active-user sets keyed by email, `ulast:` | Redis | `src/lib/track.ts` |
| IP in rate-limit keys (TTL = window) | Redis | `src/lib/rate.ts`, e.g. `signup:ip:` 3,600 s, tools 86,400 s |
| Admin log: impersonation and console actions | Redis `admin:log`, capped at 2,000 | `src/app/api/admin/impersonate/route.ts:35` |

Cookies:

| Cookie | Duration | Evidence |
|---|---|---|
| `nashr_session` | 30 days | `src/lib/auth.ts` |
| `nashr_lang` | 1 year | `src/components/LangToggle.tsx:8` |
| `nashr_oauth` | 600 s | `src/app/api/connect/[provider]/start/route.ts:41` |
| `nashr_partner` | 30 days | `src/lib/legal.ts:15` |
| `nashr_admin`, `nashr_impersonate`, `nashr_return` | Founder only | |

Local storage: `nashr_invite_token`, `nashr_install_hint_dismissed`.

There is no third-party analytics script. Fonts come from `next/font`, which self-hosts them at build time.

Region of the Upstash database, the Hostinger data centre and every provider's processing location: **not documented anywhere in the repository** (grep for region names and "data residency" returned nothing). The drafts leave these as placeholders.

### 1.2 Processors and sub-processors found

| Provider | State in code | Evidence |
|---|---|---|
| Anthropic | Active, every model call | `src/lib/model.ts`; `ANTHROPIC_API_KEY`; architecture 2.7 |
| Straitly gateway | Optional, off by default (`LLM_PROVIDER=straitly`) | `src/lib/model.ts:25-45`; variables.md §1 |
| Upstash Redis | Active, all persistence | `src/lib/db.ts:70-75`; `KV_REST_API_*` |
| Upstash QStash | Active, Reem's 15-minute tick | `src/lib/qstash.ts`; architecture 2.7 |
| Hostinger | Live host of thakeen.com | architecture §6; 360 study C summary |
| Vercel and Vercel Blob | Media copies today; the old nashr-tau project still serves main (C-001) | `src/lib/media/blob.ts`; `BLOB_READ_WRITE_TOKEN`; draft PR #319 |
| Resend | Active, all email | `src/lib/notify.ts:28`; `RESEND_API_KEY` |
| fal.ai | Default image model | `src/lib/media/fal.ts`; `FAL_KEY` |
| kie.ai | Optional models, gated by `MEDIA_MODELS_ON` | `src/lib/media/kie.ts` |
| Higgsfield | Optional models, gated by `MEDIA_MODELS_ON` | `src/lib/media/higgsfield.ts` |
| Composio | Built, dormant until `COMPOSIO_*` is set | `src/lib/connectors/composio.ts`, `via-composio.ts`; variables.md §5a |
| Paymob | Built, gated off | `src/lib/paymob.ts`, `src/lib/billing.ts`; variables.md §4a |
| Cloudflare Turnstile | Built, off on live (`turnstileKey: null`, C-005) | `src/lib/turnstile.ts`, `src/components/app/Turnstile.tsx` |
| placehold.co | URL only, no data sent | `src/lib/media/start.ts:47` |
| Mailbox for hello@thakeen.com, WhatsApp | Operational, not in code | Founder to confirm the provider |

Connector platforms (not our processors; the customer connects them):
- OAuth: X, Shopify, Google, Meta, Salla, Zid, LinkedIn, TikTok, Snapchat, Microsoft (`mscal`, not live).
- Keys: WordPress, WooCommerce, Klaviyo, Odoo, PrestaShop, Telegram, Brevo.
- Webhooks: Cal.com, Calendly.

Evidence: architecture 2.7 "Connector platforms"; `src/lib/connectors/registry.ts`.

### 1.3 Rights features that exist today

- **Account deletion:** self-serve, owner only, password-confirmed. Cascades every key family. Evidence: `src/app/api/account/route.ts:72-80`, `src/lib/account.ts:59` (`wipeAccount`).
- **Leaving a team:** a member can leave (`src/app/api/team/leave`, `leaveTeam` in `src/lib/team.ts:408`).
- **Disconnecting a platform:** deletes its tokens.
- **Password change:** revokes MCP tokens.
- **Data export:** **missing**. The current policy says "use the support form, within 30 days" (`src/lib/legal.ts:16,41`).
- **Consent record at owner signup:** **missing**. Only the "By continuing you agree" line exists (`src/components/app/AuthForm.tsx:21,95`). Partners have one.
- **Marketing unsubscribe:** **missing** (no `unsubscribe` anywhere in `src/`).

## 2. Code and operations gaps

### Before publishing

**L-01 Controller identity and contact.**
- Fill company name, CR, address and VAT number in the new `src/lib/legal.ts` text, and in the site footer (`src/components/Footer.tsx`) for the E-Commerce Law disclosures.
- Replace the personal WhatsApp number as the rights contact with hello@thakeen.com: `src/lib/legal.ts:17,42` and the `help.ts` privacy answers (`src/lib/help.ts:88-91`).
- Fix the dead `hello@nashr.ai`: `src/lib/i18n.ts`, `src/app/[lang]/app/billing/page.tsx`, `src/components/app/TopupCard.tsx` (G-007).
- Make sure hello@thakeen.com actually receives mail.

**L-02 Record acceptance at signup.**
- Add optional fields on `User`: `termsVersion`, `privacyVersion`, `acceptedAt`. Set them in `createUser` (`src/lib/auth.ts:227`) from the signup body (`src/app/api/auth/signup/route.ts:34`).
- Replace the browsewrap line with an unticked checkbox, or an explicit "I agree" button, in `src/components/app/AuthForm.tsx:95`.
- Do the same for team members accepting an invite (`src/app/api/team/accept`, `src/components/app/JoinForm.tsx`).
- Copy the pattern from `src/app/api/affiliates/route.ts:27`.
- Expand step only: old records without the field are read as "accepted before versioning".
- Add a test.

**L-03 Age and capacity confirmation.** The checkbox text in L-02 includes "I am 18 or older and authorised to act for this business".

**L-04 Processor list kept true.**
- Move the processor table into one source, e.g. `src/lib/processors.ts`, rendered on `/{lang}/privacy` (`src/app/[lang]/privacy/page.tsx`) or a `/privacy/processors` sub-page.
- Add a unit test: every provider whose key is in `docs/system/variables.md` §1-5a appears in the list.
- Replace the stale "Vercel / Vercel Blob" sentences in `src/lib/legal.ts:13,16,38,41` and `src/lib/help.ts:89-90`. This is coordinated with #319 and #320 (rule 1014 in the media spec).

**L-05 Generated media after account deletion (C-020).**
- Today `wipeAccount` leaves Blob files and fal images public, and the drafts say so honestly.
- Either delete the account's files in `wipeAccount` (`src/lib/account.ts`), which needs a per-scope index of media URLs (`src/lib/media/blob.ts` writes none today), or ship the 30-day retention from the media spec (`docs/superpowers/specs/2026-10-10-media-storage-hostinger-drive-design.md` §D.1, rules 991-1015).
- Then write the real period into privacy §8.

**L-06 Self-serve data copy (right to a copy).**
- New owner-only route, e.g. `GET /api/account/export`, returning JSON (or a ZIP) of:
  - the user record without `passHash`, session or card token;
  - brands, files, tasks, conversations, decisions;
  - Reem items, activity and governance history.
- Reuse the key list `wipeAccount` already maintains (`src/lib/account.ts`) so the two never drift.
- Read with `pmap`, scope from `sc(u)`, rate-limited (`src/lib/rate.ts`).
- Add a button on the profile page (`src/components/app/ProfilePanel.tsx`).
- Until it ships, the drafts promise a copy by email within the deadline. The founder needs a written manual procedure.

**L-07 Rights request procedure (operations).** Write a short runbook covering:
- identity check (reply from the registered email);
- the log of requests and response dates;
- who answers;
- the 30-day clock.

Same for the WhatsApp password reset with no identity check (C-010, #105).

**L-08 Breach response plan.**
- A runbook in `docs/system/`: who decides, how to contain, the SDAIA notification within the deadline, the customer notice template, and evidence to keep.
- Today nothing exists (C-002).
- Also confirm how long Hostinger keeps server logs: an investigation needs them.

**L-09 Cross-border transfer evidence.**
- Founder: get each provider's DPA and region (Upstash database region, Hostinger data centre, Anthropic, Resend, fal, kie, Higgsfield, Composio, Paymob, Cloudflare). File them outside the repository, and fill Annex A.
- If the lawyer requires a transfer risk assessment, write it.
- Composio may not go to customers before this is answered in writing (Composio spec rule 11).

**L-10 Higgsfield and kie.ai training terms.**
- Re-verify both providers' current terms.
- If the lawyer requires consent: add an owner-level switch that turns these models off, or a consent step before the first use. Pointers: `src/lib/media/config.ts`, `MEDIA_MODELS_ON`, `src/lib/media/registry.ts`.

**L-11 Old Vercel deployment (C-001).** `nashr-tau.vercel.app` still runs with the old Redis and environment. Before publishing a policy that names Hostinger as the host:
- stop it (#319);
- decide what happens to any real user data in the old Redis (delete it, or tell the users).

### Soon after (needed for the promises in the drafts, but not blocking a first publish if the wording is adjusted)

**L-12 Marketing consent and unsubscribe.**
- Classify each email in `src/lib/lifecycle.ts`, `src/lib/notify.ts` and `src/emails/` as service or marketing.
- Add an unsubscribe link plus a `User` flag for marketing mails, and the `List-Unsubscribe` header in `sendEmail`.
- Signup nudges and trial reminders probably count as marketing. The lawyer decides.

**L-13 Retention periods in code.** Set and enforce TTLs, or a purge cron, for:
- support tickets (`support-tickets`, no TTL);
- waitlist entries (`src/app/api/waitlist/route.ts`);
- the admin log;
- usage sets (`active:*`, `uev:`, `ulast:` in `src/lib/track.ts`);
- trial accounts never activated.

Write each period into privacy §8.

**L-14 Payment record retention vs deletion.**
- `wipeAccount` keeps Paymob intents and transactions only "to their TTL" (`src/lib/account.ts` Paymob comment).
- Once the lawyer and accountant give the statutory period, keep a minimal invoice record for that period after deletion, in a store that is not keyed by a re-registrable email.

**L-15 Team member data after removal.**
- Activity logs and governance history keep member emails after the member leaves or is removed (`src/lib/governance.ts`, `src/lib/activity.ts`).
- Decide: pseudonymise on removal, or keep with the account. Write it into privacy §10.

**L-16 Founder access transparency.**
- Impersonation is logged in `admin:log` (`src/app/api/admin/impersonate/route.ts:35`), but the customer is not told.
- If the lawyer requires it: an in-app notice or an email after a support session.
- Minimise the users CSV export columns (`src/app/api/admin/export/route.ts`).

**L-17 Cookie notice.**
- Only first-party cookies exist. If the lawyer says `nashr_partner` needs consent, gate it in `src/app/p/[code]/route.ts` behind a notice.
- Add the cookie table to the privacy page from one source.

**L-18 Free tools notice.** Add one line under each free tool form (`src/app/[lang]/tools`) saying the text is sent to an AI provider and not kept. First verify that the tools route does not keep it (`src/app/api/tools/[tool]/route.ts`).

**L-19 Terms change notification.** When `termsVersion` changes, email owners with `sendOnce` (`src/lib/notify.ts`) and show an in-app banner. The new version is accepted on the next sign-in (needs L-02).

**L-20 Billing items the terms depend on.**
- VAT and ZATCA: `PRICES_INCLUDE_VAT` (`src/lib/pricing.ts:133`), `invoiceForPayment` returns null (`src/lib/invoice.ts:23`) (C-003, G-003).
- Trial length: 3 days in `src/lib/auth.ts:237`, 7 in the PRD and deck (G-010). One number goes into terms §5.
- Refund of a subscription payment leaves plan, paid-through date and saved card active (G-005, `src/lib/billing.ts` `refundPaymobPayment`). Align it with terms §7.
- Recurring charge consent text on the Paymob checkout (terms §6.6).

**L-21 Security claims stay true.**
- The drafts list only controls verified in code.
- Raw session tokens (C-013, `src/lib/auth.ts:310`) and the minimal CSP (C-006) are not mentioned. Fix them before adding stronger wording.
- No certification may be named.

**L-22 MCP consent page in Arabic (#127).** Privacy §6.3 relies on the owner understanding what an outside AI app can reach.

## 3. Questions for the lawyer

Top 10, in priority order:

1. **Registration and DPO.** Given an AI marketing SaaS, B2B, small and early-stage, must Thakeen register on SDAIA's National Data Governance Platform, appoint a data protection officer, or keep a formal record of processing activities now?
2. **Cross-border transfer basis.** Every processor (Anthropic, Upstash, Hostinger, Resend, fal, kie.ai, Higgsfield, Composio, Paymob, Cloudflare) appears to be outside the Kingdom. Which basis under the Transfer Regulation should we rely on (SDAIA standard contractual clauses, necessity for the contract, consent), and must we write a transfer risk assessment?
3. **Controller or processor.** For data customers bring in about third parties (booking attendee names, public search queries, social post text, uploaded campaign files), is Thakeen a processor? Do we need a Data Processing Agreement attached to the Terms?
4. **Legal basis per purpose.** Please confirm the table in privacy §4, especially: the `nashr_partner` attribution cookie, trial and nudge emails, self-hosted usage counters, and founder impersonation for support.
5. **AI provider training terms.** Higgsfield's and kie.ai's terms allow them to use inputs and outputs, or content, to improve their services. Is disclosure enough, or do we need explicit consent, or must we stop offering these models?
6. **E-Commerce Law scope.** Do its consumer provisions (7-day withdrawal, disclosures, refund) apply to sole traders and freelancers who buy a B2B digital subscription? What must the site footer and checkout disclose?
7. **Limitation of liability and disclaimers.** Under the Civil Transactions Law, what cap (fees paid in 3 or 12 months) and exclusions are enforceable, and how must the gross negligence and fraud carve-outs be worded?
8. **Ownership of AI output.** What is the position under Saudi IP law (SAIP) on AI-generated text, images and video? Is "our rights in the output pass to you" correct?
9. **Breach notification and request deadlines.** Please confirm the 72-hour SDAIA notification and the 30-day response deadline for data subject requests (and when it can be extended). What must a breach notice contain?
10. **Retention and deletion.** How long must payment, VAT and commercial records be kept after a customer deletes the account? May we keep them, and in what form? What period is reasonable for support tickets, logs and never-activated trial accounts?

Further questions:

11. **VAT display before registration.** May prices show "+VAT" before Thakeen is VAT-registered? What do we charge until then? (With the accountant.)
12. **Recurring charges.** What consent and notice wording is required for monthly saved-card renewals and the 7-day grace and lock?
13. **Marketing messages.** What consent is required for promotional email and WhatsApp messages to business customers? Is opt-out enough?
14. **Minimum age.** Is 18 the right threshold for a business service, and is a checkbox confirmation enough?
15. **Disputes.** Riyadh courts or SCCA arbitration? Does the governing-law clause hold for customers in other GCC states?
16. **Founder access.** Must customers be told before or after the founder signs in as them for support?
17. **Acceptance of changes.** Is continued use enough to accept changed terms, or is a click needed each time?
18. **Partner programme terms.** Please review `src/lib/partner-terms.ts`: IBAN, tax number, VAT or withholding on commissions.
19. **Comparison pages.** Please review the competitor price pages (`src/lib/pages-vs.ts`, C-008) for comparative advertising rules.
20. **Personal WhatsApp number.** Is publishing the founder's personal WhatsApp number as a support contact a problem? It is being replaced as the rights contact.
21. **Cross-account anonymous learning.** The founder decided on 2026-10-11 that counts of anonymous feedback categories across accounts may improve the agents for everyone (Prompt Studio learning loop, spec in PR #326, Q1). This never includes content or text, never fewer than 5 workspaces, and covers only accounts with learning on. What is the legal basis: legitimate interest or consent? Is a per-account opt-out toggle enough, or must it be opt-in? Privacy §4 has the matching row.
