# Reporting, dashboards and decks playbook (Dana)

## Principles
- Lead with the decision: line one says what to do or approve, then the evidence.
- One number per sentence, with unit, period and comparison: "Leads 142, up 18% on last week, 5% under target."
- Every metric carries three anchors: target, prior period, same Hijri period last year.
- Say what changed and why; an unvalidated cause is labeled a hypothesis.
- Close each section with next action, owner and date.
- Status is text (On track, Watch, Off track, Exceeded), never color alone.
- Compare like with like: same definition, same calendar.
- Same structure every cycle; misses in the first three lines; data gaps and freshness in a footer.

## KPI framework
Metric tree: Revenue = Customers x Purchase frequency x Average order value. Customers = Qualified leads x Lead-to-customer rate. Leads = Reach x Engagement rate x Click-to-lead rate. Nashr supplies the left side; the owner enters revenue and deals.

Leading, weekly: posts published vs plan, approval turnaround, reach, engagement rate, leads, cost per lead. Lagging, monthly: revenue, closed deals, average order value, repeat rate, ROAS.

Weekly owner set: revenue (entered), new leads, lead-to-customer %, cost per lead, posts published vs plan, reach, pipeline value, credits used vs budget.

Industry variations:
- E-commerce: orders, AOV, site conversion %, ROAS, repeat purchase %.
- Clinics: bookings, show rate, new patients, cost per booking, review rating.
- Restaurants: orders, delivery-app share, average ticket, promo redemptions.
- Real estate: qualified inquiries, viewings booked, viewing-to-offer %, days on market.
- Services and agencies: proposals sent, win rate, active retainers, client retention.

## Weekly report structure
One screen, under 400 words. Order: (1) Headline, one sentence. (2) Scorecard, 6-8 metrics: This week / Last week / Change / 4-week avg / Target / Status. (3) What moved and why, three bullets with a number and a driver. (4) Concerns, up to three, each with impact and action. (5) Next week, three items with owners. (6) Data notes.

Missing data: never blank, never invented. Write `[not entered: revenue W37]`, set status `No data`, add a one-line ask to the owner.

Tone: direct, no adjective without a number, no emojis.

## Monthly and quarterly review
Order: executive summary (5 lines); scorecard with Actual / Target / Variance % / Prior month / Same Hijri month last year; variance analysis for any line off by more than 10% (planned, actual, owned cause, fix with date); trend commentary on 3-6 month lines and their drivers; wins (3, quantified), misses (3, with mitigation), learnings (3); next-month plan of 3-5 priorities with key result and owner; appendix.

Quarterly adds: quarter vs plan, YTD vs annual target, ROI by channel, forecast as a range, decisions-needed list.

## Executive summary methods
- BLUF: bottom line first, then why, then what next.
- SCQA: Situation (one line), Complication (what changed), Question (what must be decided), Answer (recommendation).
- Pyramid: one governing thought, three non-overlapping arguments, evidence under each. Test: if the reader stops after line one, do they know what to do?

Five-line board summary: (1) result vs target, one number; (2) main driver, quantified; (3) main miss or risk, plain; (4) recommendation with cost and return; (5) decision needed and by when. Replace adjectives with numbers; state best estimate, confidence and what would change it.

## Dashboard specification
Tiles: 6-10. Top row outcomes (revenue, leads, conversion), second row drivers (published, reach, spend, credits), bottom a detail table.

Chart per metric: trend = line; channel comparison = horizontal bar; part of whole = stacked bar, never pie; single KPI = card with delta and sparkline; funnel = step bar; pacing = bullet bar. Y-axis starts at zero.

Targets: every tile has one. Status: On track within 10% of pace, Watch 10-25% behind, Off track beyond 25%, Exceeded. Flag values beyond two standard deviations of the 8-week average.

Colors and RTL: one accent for "us", grey for comparisons, red only for Off track. Arabic mode mirrors the grid (first tile top right), right-aligns labels, keeps the time axis left to right, and isolates numbers with bidi marks so "SAR 12,500" does not flip.

Refresh: Nashr hourly, connectors daily, entered revenue weekly; print "Data as of".

Definition table: metric, formula, source, period, target, chart, owner; changes get a dated note and restated history.

## Board and investor deck
Slide purposes: title and period; five-line summary; scorecard vs target and prior; revenue and pipeline bridge; marketing drivers; wins with numbers; misses with cause, fix and revised range; customers and market; team, capacity and credits; top three risks with owners; next-period plan with key results; decisions with options, recommendation and deadline.

Investor update email, under 800 words: three-sentence TL;DR; metrics table; highlights; lowlights with cause and fix; cash in months; specific asks with names.

Sourcing: every number names its source and period; entered and estimated figures are tagged `(entered)` or `(est.)`; forecasts are ranges with a confidence statement.

## Data storytelling
- Slide titles are insights, not topics: "Leads up 18% while cost per lead fell 12%", not "Marketing metrics".
- One insight per slide; a second insight gets a second slide.
- Annotate charts at events: launch, Ramadan start, budget or price change.
- Vanity metrics (followers, impressions, likes) never headline; they appear only as drivers of leads or revenue.
- Misses get the same prominence as wins: plan, actual, owned cause, remedy.

## Gulf adaptations
- Compare seasonal metrics to the same Hijri period; Ramadan moves about 11 days earlier each Gregorian year. Label periods in both calendars.
- Ramadan: activity shifts to after Iftar, food and gifting rise, B2B decisions slow, Eid spikes. Keep Ramadan and both Eids as separate columns.
- Annotate Founding Day (22 Feb), National Day (23 Sep), Hajj weeks, White Friday, Riyadh Season.
- SAR: code or riyal symbol used consistently, thousands separators, no halalas in summaries: SAR 125,000. One digit system per report.
- Arabic layout: RTL, headings right-aligned, first table column on the right, numbers LTR, status labels translated (على المسار، مراقبة، متأخر، تجاوز).
- Family-business boards: brief the chairman on misses before the meeting; address seniority in order; frame decisions as recommendations for the chair; never name individuals in failures; pre-read 48 hours ahead, Arabic first with bilingual tables.
- Agency clients: monthly, deliverables vs scope, client-side approval turnaround, credits and spend, leads and revenue attributed, items the client owes.

## Output templates

Weekly report:
```
# Weekly report: [Workspace] | Week [N] ([Gregorian range] / [Hijri range])
Headline: [decision or biggest change]
| Metric | This week | Last week | Change | 4-wk avg | Target | Status |
Rows: Revenue (entered); New leads; Lead-to-customer %; Cost per lead;
Posts published / planned; Reach; Pipeline value; Credits used / budget
What moved and why: 1. 2. 3.
Concerns: [issue, impact, action]
Next week: [focus, owner] x3
Data notes: [freshness, manual entries, gaps]
```

Monthly report:
```
# Monthly review: [Workspace] | [Month Year] / [Hijri month]
Executive summary: [5 lines]
| Metric | Actual | Target | Variance % | Prior month | Same Hijri month LY | Status |
Variance analysis (>10%): planned, actual, cause, fix, date
Trend commentary: [3-6 months]
Wins (3) / Misses (3) / Learnings (3)
| Priority | Key result | Owner |
Appendix: campaigns, credits ledger, definitions
```

Dashboard spec:
```
| Metric | Definition | Source | Target | Chart |
| Revenue | Sum of entered sales, weekly | Owner entry | SAR [x] | Card + line |
| New leads | Form + WhatsApp + call leads | Nashr CRM | [x] | Card + sparkline |
| Cost per lead | Ad spend / leads | Ad connectors | SAR [x] | Line |
| Credits used | Consumed / monthly budget | Nashr billing | [x] | Bullet bar |
```

Deck outline:
```
## Slide 1: [Company] board update, [Period]
- Period in both calendars
- Prepared by, confidential
- One-line agenda
Speaker note: Set the frame in fifteen seconds.
## Slide 2: Executive summary
- Result vs target
- Main driver, main miss
- Decision needed today
Speaker note: Five lines; the slide they remember.
## Slide 3: Scorecard
- 6-8 KPIs vs target and prior
- Variances above 10% in bold
- Data as of date
Speaker note: Read only lines that changed status.
## Slide 4: Revenue and pipeline
- Bridge: last, plus new, minus lost, now
- Pipeline value and close range
- Top deals with confidence
Speaker note: Give a range, not a point.
## Slide 5: Marketing performance
- Leads and cost per lead
- Channel mix
- Published vs plan, approval turnaround
Speaker note: Tie each driver to leads.
## Slide 6: What worked
- Win one, number
- Win two, number
- What we repeat
Speaker note: Name the repeatable pattern.
## Slide 7: What missed
- Plan vs actual
- Owned cause
- Fix, date, revised range
Speaker note: State the miss in sentence one.
## Slide 8: Customers and market
- Repeat or retention rate
- Reviews
- Competitor moves
Speaker note: Facts only.
## Slide 9: Risks
- Risk one: likelihood, impact, mitigation, owner
- Risk two
- Risk three
Speaker note: Name the one that changes the plan.
## Slide 10: Decisions needed
- Options with cost and impact
- Management recommendation
- Deadline
Speaker note: Ask for the decision, then stop.
```

Executive summary:
```
Recommendation: [one sentence, bold]
Why it matters: [impact in SAR or leads]
Evidence: [three bullets, one number each]
Key risk: [one sentence]
Decision needed: [action] by [owner] by [date]
```

## Never do
- Never invent a number; a missing value reads `[not entered]` and is reported as a gap.
- Mark every estimate, projection and owner-entered figure `(est.)` or `(entered)`.
- Never hide or soften a miss; it sits in the summary with cause and fix.
- Never headline a vanity metric.
- Never compare periods with different definitions or Ramadan overlap without saying so.
- Never present a forecast as a single point.
- Never change a metric definition silently.
