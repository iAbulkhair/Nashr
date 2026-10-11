# 04-I. Go-to-market and content honesty (Thakeen 360, 2026-10-11)

Workstream I. Read-only. Sources: origin/main 3bf67673, origin/production 487984f4, live https://thakeen.com (fetched 2026-10-11), `gh` (GET only), memory files (checked against code). Machine-readable findings: `raw/findings-I.jsonl` (I-001 to I-023).

## Summary

1. The next release PR will turn the live homepage from «كيف يشتغلون مع ذكين» + «أمثلة توضيحية» into «عملاء جربوا ذكين» over 24 invented first-person quotes with no disclaimer (#311, on main, not live). Nothing in the repo shows a single customer. P0 decision for the founder.
2. The pitch deck (`scripts/build_deck.py`, `docs/Nashr_Pitch_Deck.pptx`) still holds an invented Riyadh perfume-merchant quote, old prices 149/399/799, a 7-day trial, a false "KSA region, PDPL-compliant" row and three contradictory traction targets. Treat it as unsendable.
3. Trial and offer terms are decided three ways (code 3 days, PRD 7 days, founding-20 "pay first, 7-day refund, no free"), while the live site pushes "start free" to everyone. This must be one decision before the 1 Nov KR1 clock.
4. Debts owed to people: corrections for the "7-day" WhatsApp launch message (#191) and for old prices; both unsent as far as any record shows.
5. Evidence of real signups, waitlist rows or paying customers: unknown (production not accessed). Docs show only 12 accounts on 2026-09-18 and "all current accounts are trial" on 2026-10-09.

## Current state

| Item | State | Evidence (verified 2026-10-11) |
|---|---|---|
| Live site copy (thakeen.com /ar, /en, /pricing, /vs, /affiliates, /customers) | Clean of invented numbers, logos, quotes; no "first 100 / two months" text; brand name Thakeen only | live HTML fetched; text scan found no `%`, `x`, customer counts |
| Homepage scenes heading, live vs main | Live: «كيف يشتغلون مع ذكين.» + «أمثلة توضيحية». Main: «عملاء جربوا ذكين.», disclaimer removed | `src/lib/home.ts:488-489`; production `home.ts:488-489`; PR #311 |
| `/customers` page | Honest: "early-customers stage, no logo or number until real and consented" | `src/lib/site.ts:49` |
| Pricing page | 299/499/999 + VAT, 3-day trial; "(قريباً)" tags on unbuilt items; Agency lists "Dedicated success manager" untagged and "Data hosted inside Saudi Arabia (coming soon)" | live `/ar/pricing`, `i18n.ts:255,407` |
| Affiliates | Live 15% for 4 months, own code; GTM doc still says 25% lifetime | live `/ar/affiliates`; `docs/GTM_Teardown_and_Nashr_Plan.md:41` |
| Blog (13 files, about 6,250 words) | No customer claims or stats; one self-scored rubric ranking, disclosed, arithmetic pinned by test | `content/blog/*.md`, `tests/content-claims.test.ts` |
| Pitch deck + model | Stale and partly fabricated (see findings) | `scripts/build_deck.py`, `build_model.py` |
| GTM doc | Stale: 7-day trial, 25% lifetime, nashr-tau links, "first AI agent for the Gulf" | `docs/GTM_Teardown_and_Nashr_Plan.md:41,57,74,79,87,90,93` |
| Issue #191 (7-day correction) | Open, no comments, no tick in Owner_Tasks | `gh issue view 191`; Owner_Tasks_AR 127, 354 |
| Old-price message (rule 191 text) | Written, not sent per 30 Sep logs; no later evidence | PRD-Thakeen.md:231; Owner_Tasks_AR 400 |
| "First 100 brands two months free" | No code (no counter, no grant); dead strings `i18n.ts:277,429`, not rendered; decided out 2026-09-29 in favour of a 12-month price lock | grep src; Owner_Tasks_AR:368; live scan |
| KR1: 20 payers in 45 days from 1 Nov, then 100 in 6 months | Plan only; clock not started; baseline unknown | PRD-Thakeen.md:16,70,341 |

## Findings (P0 first)

**P0**
- **I-001** Homepage «عملاء جربوا ذكين.» over invented role-quotes; disclaimer removed by founder wording in #311; row 775 edited in place. Decide before the next release PR: restore a disclaimer, use non-claim wording, or hold the `home.ts` change out of the release.
- **I-002** Deck slide 2 quotes a merchant never interviewed, with "SAR 1.8M GMV" (`build_deck.py:156-158`; also in the pptx; issue #4). Remove and rebuild; founder says whether the deck went to anyone.
- **I-004** Trial terms conflict: `auth.ts:237` = 3 days; PRD:220,226 = founder decision 7 days; PRD 11.2-11.3 = founders pay first, no free, 7-day refund. Live site = free trial for all, partner and last-day 15% offers. Founder picks one set; Claude aligns code, copy, emails, drafts and adds a test.

**P1**
- **I-003** Deck and financial model: 149/399/799, 7-day trial, invented "night with Noor" numbers (214 customers, SAR 18,420), retired agent names, "KSA region, PDPL-compliant", Tap/Moyasar (production plans Paymob, gated off), "30 days free for installs", 25% rev-share, `hello@nashr.ai`, unsourced market stats, 300 vs 220 vs 100 paying brands.
- **I-005** Founding-20 mechanics unbuilt: no seat counter, no pay-first path, no refund calculation, no price lock (PRD marks 🔴).
- **I-006 / I-007** Corrections owed (#191 and old prices). Owner_Tasks:400 says Claude fixed the other docs; the GTM doc proves otherwise.
- **I-009** GTM doc drafts carry retired affiliate terms, `nashr-tau.vercel.app` (being retired in #319) and the "first AI marketing agent for the Gulf" superlative, which the project's own BeTrend finding contradicts.
- **I-010** Live Agency plan: "Dedicated success manager" untagged; "Data hosted inside Saudi Arabia (coming soon)" with no region or decision recorded (#132, #21).
- **I-011** No evidence of any real signup, waitlist, paid or consented customer. Unknown, needs a founder read of the console.
- **I-012** No real testimonial or story (#189); keep slots empty until consent exists.
- **I-013** The founding-20 funnel (contacts, offer text, refusals sheet, works-today list) lives outside the repo.

**P2**
- I-008 dead "first 100 / two months" strings and orphan waitlist route; I-014 partner 15% discount vs "no discount" KR1; I-015 self-scored blog ranking omits Gulf-native tools; I-016 Enrich facts dated 17 Sep; I-017 annual "two months free" with no annual billing; I-018 three overlapping founder-benefit programmes; I-019 name clash with thek.ai, trademark about 6,500 SAR deferred; I-020 Owner_Tasks and Handoff still point to nashr.ai / nashr-tau; I-021 #5, #19, #23 fixed in code but open; I-022 no test guards drafts or the deck; I-023 price-floor assumption versus 49-87 SAR local anchors.

## What could not be verified, and why

- Any production data: signups, waitlist rows, verified emails, paid accounts, extensions made "for promised 7 days" (rule: do not access production). All stated as unknown.
- Who received the 2026-09-17 WhatsApp messages (7-day trial, old prices), and whether a correction went out: held in the founder's chats, not in the repo.
- Whether the pitch deck was ever sent, and to whom.
- Upstash and Hostinger regions (dashboards not accessed), so the hosting claims are unverified rather than disproved. The repo records no region.
- Competitor facts (Enrich price, integration count, BeTrend, Store Tools, Adly): not re-fetched; dated 17 and 29 Sep.
- Whether Salla/Zid product import works as the comparison page implies (workstream A).
- Memory statements (founder's 150 contacts, about 60 owners) are the founder's own word, not checked.
- `staging.thakeen.com` and the early-customers form lead inbox were not tested.
