# Nashr (نشر) — Product Requirements Document

**Product:** Nashr — an autonomous AI marketing agent ("Noor") for GCC businesses
**Version:** 1.0 (MVP scope) · **Date:** 17 September 2026 · **Owner:** Founder
**Status:** v0 live at https://nashr-tau.vercel.app (17 Sep 2026). Current build state and owner action items: `Requirements_and_Steps_AR.md`.

---

## 1. Summary

Nashr is a subscription + credits SaaS that gives a Gulf business a marketing agent that works on its own. The agent (Noor) connects to the customer's commerce, ads, analytics, and messaging accounts; builds a brand voice file; proposes a weekly plan; executes approved work across Snapchat, TikTok, Meta, Google, WhatsApp, and the customer's website; and reports every morning on WhatsApp.

The model is proven in the US by Enrich Labs (Helena, $39–$199/mo + credits). Nashr localizes the model for the GCC: Arabic-first output with dialect control, Snapchat and TikTok as primary ad channels, WhatsApp as the primary owned channel, Salla and Zid as primary commerce platforms, the Gulf seasonal calendar, local payment rails, and in-Kingdom data residency (PDPL).

**Business goal (12 months):** ~1,000 paying brands, SAR 430k MRR, ~74% gross margin, net revenue retention ≥100% (base case in `Nashr_Financial_Model.xlsx`).

---

## 2. Problem

| Who | Pain today |
|---|---|
| Salla/Zid/Shopify merchant | Posts inconsistently, runs Snap/TikTok ads by gut, no time for SEO, misses seasons, pays freelancers SAR 2–6k/mo for mediocre Arabic content. |
| Real-estate developer / broker | Project launches need volume of creative fast; leads arrive on WhatsApp and go cold; no follow-up system. |
| Law firm / professional services | Needs steady, compliant educational content and Google/AI visibility; has zero marketing staff. |
| Startup founder | Needs LinkedIn/X presence and growth experiments on a tiny budget; no marketer until Series A. |
| Clinic / restaurant | Local search (GBP), reviews, WhatsApp bookings, daily offers — repetitive and never done. |
| Agency | Ten clients, small team, wants leverage and white-label reporting. |

Common thread: execution volume across too many channels, in two languages, with a seasonal calendar nobody has time to plan around. Existing tools (Jasper, Canva, Hootsuite, Predis) are English-first, non-agentic, and disconnected from ad spend and revenue data.

---

## 3. Target customers and personas

**Beachhead (months 1–6):** KSA e-commerce merchants on Salla/Zid/Shopify with SAR 50k–2M annual GMV and SAR 3k–50k/mo ad spend. Distribution via Salla and Zid app stores.

**Expansion (months 4–12):** real estate, legal, startups, clinics, restaurants, agencies. UAE and Kuwait after KSA product-market fit.

### Personas

1. **Abdullah, Salla merchant (perfume/fashion)** — 1 store, SAR 20k/mo Snap + TikTok ads, no marketer. Wants: consistent posts, ads that don't waste money, someone to handle Ramadan and National Day. Success: ROAS up, hours down.
2. **Sara, marketing manager at a real-estate developer** — 3 projects launching per year, 2 agencies, leads on WhatsApp. Wants: creative volume, faster follow-up, reports for the CEO. Success: lower cost per qualified lead.
3. **Faisal, managing partner at a 6-lawyer firm** — no marketing staff. Wants: monthly Arabic articles, LinkedIn presence, compliant tone, showing up in ChatGPT answers. Success: 3–5 consultations per month from content.
4. **Reem, agency owner (8 clients)** — team of 4. Wants: multi-brand workspace, white-label reports, agent does the daily grind. Success: take 4 more clients without hiring.

---

## 4. Product principles

1. **Approve, don't operate.** The customer's job is to approve or edit, never to build. One inbox.
2. **Arabic is first-class.** Dialect control, banned/preferred words, RTL everywhere, Hijri-aware calendar.
3. **Money moves only inside guardrails.** Ad changes are bounded by customer-set limits and are always reversible.
4. **Report where the customer lives:** WhatsApp, not dashboards.
5. **Learn from every edit.** Acceptance rate is the north-star quality metric.
6. **Data stays in-Kingdom.** PDPL by design.

---

## 5. Scope

### 5.1 MVP (v1.0, weeks 1–12) — must have

**Onboarding**
- Sign up with email/Google/Apple; phone (WhatsApp) verification.
- Enter website or Salla/Zid/Shopify store URL → crawler builds initial brand profile.
- Connect accounts via OAuth: Salla, Zid, Shopify, Meta (Pages/IG/Ads), Snapchat Ads, TikTok (Business + Ads), Google (GA4, Search Console, Business Profile, Ads read-only), WhatsApp Business (Cloud API via Meta), LinkedIn (company page), X.
- Brand voice file: dialect (MSA / Saudi / Emirati / Kuwaiti / English), tone sliders, banned words, preferred words, competitors (up to 5), products/services, offers, target audiences.
- Guardrails: daily ad spend cap, minimum ROAS, allowed channels, auto-publish toggles per content type, quiet hours (e.g., no publishing during Friday prayer).

**Planner (Noor)**
- Weekly plan generated every Sunday 06:00 local: content calendar, ad actions, messaging campaigns, SEO targets — grounded in connected data and the Gulf calendar.
- Seasonal prep triggers 4 weeks before each calendar event.

**Task agents**
- Social: posts (image + caption) for IG, TikTok (slideshow), Snapchat (story/spotlight), X, LinkedIn; ~50/month on Pro.
- Ads (read + suggest on Starter; act on Pro+): waste detection, budget reallocation across Snap/TikTok/Meta/Google, pause underperformers, creative A/B proposals. Runs every 2 hours on Agency, daily on Pro.
- WhatsApp: template creation and submission for Meta approval; abandoned-cart recovery (Salla/Zid/Shopify webhooks); post-purchase and re-engagement flows; segment builder.
- SEO/GEO: keyword-gap analysis vs competitors; 1,500–2,000-word Arabic/English articles with images; publish to Salla/Zid/Shopify/WordPress/Webflow; Google Business Profile posts; schema.
- Competitor watch: nightly crawl of up to 5 competitor sites; price/offer/new-product diffs surfaced in the brief.

**Approval inbox**
- Unified queue: approve / edit / reject / "always allow this type."
- Inline editor with dialect switch and regenerate.
- Edits are stored as preference signals for the brand voice file.

**Daily brief (WhatsApp, 08:00 local)**
- Yesterday's revenue/orders (commerce), ad spend and ROAS by channel, what Noor did, what awaits approval, 1–3 recommendations. Deep link to inbox.

**Billing**
- Plans: Starter SAR 149, Pro SAR 399, Agency SAR 799, Enterprise custom. Credits 200/700/2,000. Annual = 10 months. 7-day trial, no card.
- Credit ledger: post/image/ad/chat = 1, article = 2, WhatsApp campaign or TikTok slideshow = 3, video 4–12s = 12, video 16–20s = 24. Top-ups: 100 credits SAR 59, 500 credits SAR 249.
- Payments: Tap or Moyasar (mada, Visa/MC, Apple Pay, STC Pay). VAT-compliant invoices (ZATCA e-invoicing phase 2 ready).

**Workspace & team**
- Brands (1 / 1 / 5 / unlimited), seats, roles (owner, editor, viewer), agency white-label report PDF.

**Platform**
- Web app AR/EN (RTL/LTR), mobile-responsive. Native apps out of scope.
- Marketing site (already built: `/ar`, `/en`, `/pricing`, waitlist).

### 5.2 v1.1 (months 4–6)
- Specialist agents as add-ons: Sultan (ads), Reem (WhatsApp), Faisal (SEO/GEO), Lama (social/influencers).
- Video generation (short-form) and UGC scripts with licensed-influencer shortlist (Mawthooq filter).
- Salla and Zid app-store listings; Shopify app.
- MCP server and public API (Agency+).
- Slack/Teams digests for enterprise.

### 5.3 Out of scope (v1)
- Running ads on the customer's behalf from a Nashr ad account (they keep their own accounts).
- Influencer payments/escrow.
- CRM replacement.
- Telephony / call center.

---

## 6. User journeys

### 6.1 First hour (merchant)
1. Enters store URL → sees a draft brand profile in 60 seconds.
2. Connects Salla + Snap + Meta (3 OAuth clicks).
3. Confirms dialect and guardrails (2-minute form).
4. Noor shows a 7-day "starter week" (14 posts, 1 article, 1 WhatsApp cart-recovery flow, ad audit).
5. Approves → first post scheduled; ad audit report delivered to WhatsApp within 10 minutes.

### 6.2 Daily loop
- 08:00 brief on WhatsApp → open inbox → approve 3–6 items in 2 minutes.
- Noor executes, logs, learns.

### 6.3 Seasonal loop
- T-4 weeks before Ramadan: Noor proposes theme, creative set, budget plan, WhatsApp schedule; customer approves once; Noor executes for the season with weekly check-ins.

### 6.4 Agency
- Adds brand → onboarding per brand → white-label weekly PDF for each client → team roles per brand.

---

## 7. Functional requirements (selected)

| ID | Requirement | Priority |
|---|---|---|
| F-01 | OAuth connectors for Salla, Zid, Shopify, Meta, Snap Ads, TikTok, Google suite, WhatsApp Cloud API, LinkedIn, X | Must |
| F-02 | Brand voice file with dialect, tone, lexicon; editable; versioned | Must |
| F-03 | Weekly plan generation grounded in connected metrics and calendar | Must |
| F-04 | Approval inbox with edit/regenerate, per-type auto-approve toggles | Must |
| F-05 | Ad optimizer with guardrails, action log, one-click rollback | Must (Pro+) |
| F-06 | WhatsApp templates + campaigns via Cloud API; cart-recovery webhooks | Must (Pro+) |
| F-07 | SEO article generation + CMS publish; GBP posts | Must |
| F-08 | Daily WhatsApp brief 08:00 local; weekly on Starter | Must |
| F-09 | Credit ledger, plan limits, top-ups, VAT invoices | Must |
| F-10 | Competitor nightly diff | Must |
| F-11 | Multi-brand, roles, white-label PDF | Must (Agency) |
| F-12 | Quiet hours and prayer-time publishing avoidance | Should |
| F-13 | Hijri + Gregorian calendar with GCC events pre-loaded | Must |
| F-14 | Content moderation: brand-safety and regulatory rules (health claims, legal advertising rules, real-estate licensing numbers e.g. REGA/FAL) | Must |
| F-15 | Audit trail of every agent action, exportable | Must |

## 8. Non-functional requirements

- **Data residency:** primary DB and object storage in a KSA region (e.g., cloud region in Riyadh/Dammam). LLM calls via providers with regional endpoints or with no-retention agreements; PII minimized before model calls.
- **PDPL:** consent records, data subject access/deletion within 30 days, DPA with customers, breach notification process.
- **Availability:** 99.5% MVP, 99.9% Enterprise. Scheduled jobs must survive restarts (idempotent tasks).
- **Latency:** inbox loads < 1.5s; content generation < 30s for a post, < 3 min for an article.
- **Security:** OAuth tokens encrypted at rest (KMS), per-tenant isolation, SSO for Enterprise, SOC 2 roadmap in year 2.
- **Localization:** full RTL, Arabic numerals optional, Hijri dates, SAR/AED/KWD currencies.

---

## 9. Architecture

```
Client (Next.js, AR/EN) ── API (Node/TypeScript) ── Postgres (tenant, brand, plan, ledger, actions)
                                   │
                                   ├── Job queue + scheduler (Temporal or Inngest)
                                   │      ├── Planner agent (weekly / seasonal)
                                   │      ├── Task agents (social, ads, whatsapp, seo, competitor)
                                   │      └── Brief composer (daily 08:00)
                                   ├── Connector layer (Nango/Composio for OAuth + custom Salla/Zid/Snap/WhatsApp)
                                   ├── LLM gateway (Claude family; routing by task; caching; cost meter → credits)
                                   ├── Media gen (image/video API)
                                   └── Object storage (in-Kingdom) + vector store (brand knowledge)
```

**Agent loop:** fetch context (brand file + metrics + calendar) → plan → generate → self-critique against brand rules and compliance rules → enqueue to inbox or auto-execute → log action → collect feedback → update brand file.

**Cost control:** every LLM/media call meters tokens → converted to credits; plan caps enforced by ledger; hard stop + top-up prompt.

---

## 10. Metrics

**North star:** approved actions per brand per week.

| Metric | Target (month 6) |
|---|---|
| Trial → paid conversion | 12% |
| Acceptance rate (approved without edit) | 85% → 95% by week 8 of a brand |
| Weekly active brands (opened inbox) | 70% |
| Monthly logo churn | < 4% |
| Gross margin | ≥ 75% |
| Support tickets per 100 brands | < 15 / month |
| Brief open rate (WhatsApp) | > 80% |

---

## 11. Go-to-market

1. **Salla + Zid app stores** (largest lever): "Noor for Salla" listing; 30-day free on Starter for app-store installs.
2. **Founder-led content in Arabic:** free tools (hook generator, Ramadan planner, Snap ad audit), weekly X/LinkedIn threads, YouTube teardown series.
3. **Agency white-label program:** 25% revenue share, co-marketing.
4. **Partnerships:** Tap/Moyasar merchant newsletters, Monsha'at SME programs, Snap Ads KSA partner team, TikTok Shop MENA.
5. **Paid:** Snap + Meta to merchants; LinkedIn to agencies and real-estate.

Launch sequence: waitlist (now) → 20 design partners (weeks 4–8) → Salla app store beta (week 10) → public launch before White Friday.

---

## 12. Roadmap

| Phase | Weeks | Deliverables |
|---|---|---|
| 0 | 1–2 | Apply for Meta/WhatsApp, Snap, TikTok, Salla, Zid developer access; entity + VAT registration; cloud region; design partners recruited |
| 1 | 1–4 | Brand profile, Arabic social agent, approval inbox, Salla connector, billing (Tap), marketing site (done) |
| 2 | 5–8 | Snap/Meta/TikTok publishing, ad audit (read-only), WhatsApp brief, credit ledger, competitor watch, SEO agent + CMS publish |
| 3 | 9–12 | Ad optimizer with guardrails, WhatsApp campaigns + cart recovery, agency multi-brand, white-label PDF, 20 paying beta brands, Salla app store listing |
| 4 | 13–24 | Specialist add-ons, video, Zid/Shopify apps, MCP/API, UAE launch |

---

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Platform API approvals (Meta/WhatsApp, Snap, TikTok) take 4–8 weeks | Blocks core channels | Apply day 1; ship read-only + scheduling via approved partner APIs meanwhile |
| Arabic quality/dialect misses | Churn | Human QA loop for first 200 brands; lexicon controls; acceptance-rate monitoring per brand |
| Agent changes ad budgets wrongly | Trust loss, money loss | Guardrails, simulation mode for first 14 days, rollback, daily caps |
| LLM cost overruns | Margin | Credits tied to metered cost, model routing (small models for routine), caching |
| Regulatory (health/legal/real-estate advertising rules) | Fines, bans | Compliance rule packs per industry; mandatory license fields; block list |
| Enrich Labs or a global player localizes | Competition | Speed, Salla/Zid distribution, WhatsApp depth, in-Kingdom hosting, Arabic dialect moat |
| WhatsApp template rejections | Delays | Template library pre-approved; fallback SMS via Unifonic |

---

## 14. Open questions

1. Build own Salla/Zid connectors vs. wait for Composio coverage? (Recommendation: build own; they're the moat.)
2. Video generation in MVP or v1.1? (Recommendation: v1.1; credits pricing already reserved.)
3. Entity in KSA (SAMA/CST considerations for messaging) vs. UAE free zone first? (Recommendation: KSA entity for Salla/Zid partnership credibility and data residency.)
4. Which Arabic evaluation set to use for dialect QA? (Build 300-item golden set with 3 native reviewers.)

---

## 15. Appendix — Competitive reference

| | Enrich Labs (Helena) | Nashr (Noor) |
|---|---|---|
| Price | $39 / $99 / $199 + credits | SAR 149 / 399 / 799 + credits |
| Ads | Meta, Google, TikTok | Snap, TikTok, Meta, Google, X |
| Owned channel | Email (Klaviyo/Mailchimp) | WhatsApp Business API (+SMS, email) |
| Commerce | Shopify, WooCommerce | Salla, Zid, Shopify, WooCommerce |
| Language | English | Arabic (dialect-aware) + English |
| Calendar | US retail | Hijri + GCC national days + White Friday + DSF |
| Data residency | US | KSA |
| Payments | Stripe | Tap / Moyasar (mada, Apple Pay, STC Pay) |
| Distribution | SEO free tools, direct | Salla/Zid app stores, agencies, free Arabic tools |
