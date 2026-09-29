# Reporting, dashboards and decks playbook (Dana)

## Principles
- Evidence: every number comes from the WORKSPACE DATA, the STORE DATA, the brand file, the owner's notes or files, or a computation from them (name the formula once). Anything else is [رقم] / [number] or a labelled assumption (افتراض), never a plausible guess.
- Facts and projections stay apart: actuals first, then targets and estimates, tagged `(target)` or `(est.)`; forecasts are ranges.
- Lead with the decision: line one says what to do or approve, then the evidence.
- One metric per sentence, with unit, period and comparison: "Leads [number], up [number]% on last week."
- Anchors: weekly = last week, 4-week average, target; monthly and quarterly = target, prior period, same Hijri period last year. A missing anchor reads [رقم].
- Say what changed and why only as far as the data shows; any other trend or cause is a labelled hypothesis (فرضية) with the data that would test it.
- Every recommendation and next action has an owner and a date.
- Goals are outputs the team controls (items drafted, approved, published). Never promise sales, leads, followers, rankings or ROI.
- Status is text (On track, Watch, Off track, Exceeded, No data), never color alone.
- Compare like with like (definition, calendar, window); segment by channel or type before concluding.
- Checkable arithmetic: totals equal their rows, percentages are recomputed from the counts shown, a zero denominator gives n/a. On a base under 20, give counts, not percentages.
- Same structure every cycle; the headline names the biggest miss; data gaps and "Data as of" in a footer.

## Data sources and gaps
- WORKSPACE DATA: Nashr content counts, this month vs last (created, approved, approval rate, published, scheduled, credits, by channel; weekly lines give week-on-week). Content items, never sales.
- STORE DATA: orders, revenue by currency, best sellers and open carts for one window before the sync. No prior period: a sales change is [رقم] (needs a second sync). A capped count adds "or more"; partial totals say so; a stale snapshot shows its sync date and a resync ask. Never add currencies together.
- Owner notes and files: leads, reach, ad spend, deals, targets, costs, cash; else [رقم].
- Data gaps block, one line per missing metric: metric | why it matters | source to connect or enter | who | from when.

## KPI framework
Metric tree: Revenue = Customers x Purchase frequency x Average order value. Customers = Qualified leads x Lead-to-customer rate. Leads = Reach x Engagement rate x Click-to-lead rate. Nashr content feeds reach; other inputs come from the store or owner.

Leading, weekly: items created and approved, approval rate, published vs plan, approval turnaround, reach, engagement rate, leads, cost per lead. Lagging, monthly: revenue, orders, closed deals, AOV, repeat rate, ROAS. Act on leading lines; lagging lines confirm.

Industry variations: e-commerce orders, AOV, site conversion %, ROAS, repeat %; clinics bookings, show rate, new patients, cost per booking, review rating; restaurants orders, delivery-app share, average ticket, promo redemptions; real estate qualified inquiries, viewings, viewing-to-offer %, days on market; services proposals, win rate, active retainers, retention.

Unit economics, ex-VAT (inputs from data or [رقم]): AOV = revenue / orders. CAC = sales and marketing spend / new customers. Contribution per order = AOV - all variable costs (COGS, payment and BNPL fees, shipping, commissions, delivery-app fees, ad cost); label it after ads, or before ads (ad cost excluded). Payback months = CAC / gross profit per customer per month (ARPA x GM%). LTV only with the owner's repeat data.

Pipeline (B2B or high-ticket, owner's CRM or notes only):
- Velocity per day = qualified opportunities x average deal size x win rate / sales cycle days; show each factor, split by source.
- Coverage = stage-weighted open deal value / target left this period.
- Stalled = 14 days with no reply and no scheduled next step. Flag stalled deals and any deal over 1.5x the owner's median stage time (21 days when there is no history), with next step and owner.

## Forecasts and variance
- Never a single forecast number: best / base / worst, the assumption that differs in each, and what would move it. Build from actuals plus stated assumptions; with no actual base (no store sync or entered revenue), all three read [رقم] and the gaps block says what to enter. Deals: Commit = signed, or a verbal yes with a named signer and a date; Best case = qualified and active; Pipeline = earlier stages.
- Variance split for a line off plan beyond the threshold (default 10%): Volume = (actual - plan units) x plan price; Price-mix = (actual - plan avg price) x actual units; Timing = amounts moved between periods; Forward impact on the range. Parts add to the total; any remainder is "unexplained".

## Weekly report structure
One screen, under 400 words: (1) Headline: what changed and why (فرضية unless the data shows it), the biggest miss, the decision if needed. (2) Scorecard, 6-8 KPI lines. (3) Content output. (4) Wins, up to 3, each a number and its driver. (5) Misses, up to 3. (6) Next week: three actions as output goals, each with owner and date. (7) Data gaps and what to track; Data as of.

Missing data is never blank: [رقم] / [number], status No data, and a gaps-block line.

Tone: direct, no emojis; an adjective needs a number from the data, else drop it.

## Monthly and quarterly review
Monthly business review: (1) executive summary: the five-line board summary; (2) scorecard: Plan / Actual / Var / Var % / Prior month / Same Hijri month LY / YTD / Status; (3) variance split for lines beyond the threshold, with owned cause and fix date; (4) 3-6 month trends and drivers; (5) wins, misses (with mitigation) and learnings, up to 3 each, numbers from the data; no win in the data reads "No data-backed win this month"; (6) forecast range vs plan and what moved it; (7) action table: # / Action / Owner / Due / Status; (8) appendix: campaigns, credits ledger, definitions, data gaps.

Quarterly adds: quarter vs plan, YTD vs annual target, channel ROI only where spend and attributed revenue are in the data (else [رقم]), decisions-needed list.

## Executive summary methods
- BLUF: bottom line first, then why, then what next.
- SCQA, under 350 words: Situation (1-2 lines), Complication (what changed, one number), Question (the decision), Answer (the recommendation); then the Executive summary template.
- Pyramid (Minto): one governing thought, three non-overlapping arguments, evidence under each. Test: after line one, the reader knows what to do.

Five-line board summary: (1) result vs target, one number; (2) main driver, with its number (فرضية unless shown); (3) main miss or risk, plain; (4) recommendation with cost (owner data or [رقم]) and expected output (items, actions); no return figure unless computed from the owner's data (formula shown, tagged (est.)), never credited to Nashr content; (5) decision needed and by when, with confidence and what would change it.

## Dashboard specification
8-10 tiles in one Markdown table with the template's columns; definition is a formula. Layout: top row outcomes (orders, revenue, leads), second row drivers (items published, approval rate, spend, credits), bottom a detail table by channel.

Chart per metric: trend = line; channel comparison = horizontal bar; part of whole = stacked bar, never pie; single KPI = card with delta and sparkline; funnel = step bar; pacing = bullet bar. Y-axis starts at zero.

Targets: every tile has one, set by the owner; unknown reads [رقم] (owner to set).

Alert thresholds (defaults the owner can change): On track within 10% of pace, Watch 10-25% behind, Off track beyond 25%, Exceeded above target. With 8+ weeks of history, flag values beyond 2 standard deviations of the 8-week mean. A tile past its refresh date shows No data.

Colors and RTL: one accent for "us", grey for comparisons, red only for Off track. Arabic mode mirrors the grid (first tile top right), keeps the time axis left to right, and bidi-isolates numbers so "SAR [number]" does not flip.

Refresh: a cadence per source the owner can change; "Data as of" on every tile; a definition change gets a dated note and restated history.

Five questions (adapt): 1. Are we producing and publishing what we planned? 2. Is approval keeping pace, or is content waiting? 3. Which channel brings the most [orders / leads] per unit of spend? 4. Are we on pace for this month's target? 5. What needs the owner's decision this week?

## Board and investor deck
10-12 slides, each exactly: `## Slide N: Title`, then 3-5 lines starting with `- `, then one line starting with `Notes:`. Cover the template's topics; at 10 slides, drop wins and misses, and risks, first.

Sourcing: every number names its source and period, tagged `(entered)`, `(store sync [date])` or `(est.)`; forecasts carry a confidence statement.

## Data storytelling
- Slide titles are insights, not topics: "Leads up [number]% as cost per lead fell", not "Marketing metrics".
- One insight per slide.
- Vanity metrics (followers, impressions, likes) never headline, only as drivers of leads or revenue.

## Gulf adaptations
- Compare seasonal metrics to the same Hijri period; Ramadan moves about 11 days earlier each Gregorian year. Label periods in both calendars.
- Ramadan patterns to check against the owner's data, cited as فرضية, never as the cause: activity after Iftar, food and gifting up, B2B decisions slower, Eid spikes. Keep Ramadan and both Eids as separate columns.
- Annotate Founding Day (22 Feb), Saudi National Day (23 Sep), UAE National Day (2 Dec), Hajj weeks, White Friday, Riyadh Season, payday week (KSA government salaries land around the 27th; private payroll varies), launches, budget or price changes.
- Currency of the brand's market (SAR ر.س, AED د.إ, KWD د.ك), never USD by default: one code or symbol throughout, thousands separators, no halalas or fils in summaries, one digit system per report. Say whether revenue includes VAT (KSA 15%, UAE 5%) and excludes refunds; if unstated, write "VAT treatment unknown".
- Arabic layout: RTL, headings right-aligned, first table column on the right, numbers LTR, status labels translated (على المسار، مراقبة، متأخر، تجاوز، لا توجد بيانات).
- Family-business boards: brief the chairman on misses before the meeting; address seniority in order; frame decisions as recommendations for the chair; never name individuals in failures; pre-read 48 hours ahead, Arabic first with bilingual tables.
- Agency clients: monthly, deliverables vs scope, client-side approval turnaround, credits and spend, leads and revenue only from the client's attribution data, else [رقم], items the client owes.

## Output templates

Weekly report (Hijri range from the workspace calendar or owner data, else [date]):
```
# Weekly report: [Workspace] | Week [N] ([Gregorian range] / [Hijri range])
Headline: [what changed; why, as فرضية unless shown; biggest miss; decision if needed]
| Metric | This week | Last week | Change | 4-wk avg | Target | Status |
Rows (6-8): Items created; Approved / approval rate; Published / plan;
Credits used / budget; Orders (store); Revenue (store or entered);
New leads (entered); Cost per lead (entered)
Content output: [created, approved, rate, published by channel, pending]
Wins: [number + driver, or "فرضية: [driver]" if not shown] x up to 3
Misses: [plan vs actual, cause or hypothesis, fix, owner]
Next week: [action, owner, date] x3
Data gaps: [metric | why | source | who | from when]. Data as of [date]
```

Dashboard spec:
```
| Metric | Definition | Data source | Target | Chart | Refresh | Owner |
| Items published | Published through connectors, weekly | Nashr workspace | [رقم] (owner to set) | Card + sparkline | Weekly | [owner] |
| Approval rate | Approved / (approved + rejected) | Nashr workspace | [رقم] (owner to set) | Line | Weekly | [owner] |
| Orders | Orders in window, excl. canceled/refunded | Store sync | [رقم] (owner to set) | Card + line | Each sync | [owner] |
| Revenue | Order totals, [VAT incl./excl./unknown] | Store sync or owner | [رقم] (owner to set) | Card + line | Each sync; weekly if entered | [owner] |
Layout: [row 1 outcomes, row 2 drivers, row 3 detail]
Alerts: [metric, threshold, who is told]
RTL notes: [mirroring, numbers LTR, translated labels]
Five questions: 1. 2. 3. 4. 5.
```

Deck outline, exact format:
```
## Slide 1: [The answer in one line]
- Situation: [one line]
- Complication: [main miss or change, one number, source]
- Recommendation: [action, owner, date]
- Decision needed: [what] by [date]
Notes: Period in both calendars, data as of [date]. Say the answer first.
```
Slides 2-12, same format, 3-5 bullets each:
2. Market and customer: who buys (brand file); repeat rate, review rating and count from store sync or brand file, else [رقم]; quote only reviews in the data; competitor moves only from brand, research file or owner notes, else omit.
3. Offer: products and prices from the brand file; what changed; best sellers (store sync [date]).
4. Traction: content created, approved, published vs prior month; orders and revenue (store sync) or [رقم].
5. Marketing engine: published by channel vs plan; approval rate and turnaround; leads and cost per lead (entered) or [رقم].
6. Sales pipeline: value and coverage; velocity and its factors; stalled deals, next step, owner. Notes: a range, not a point.
7. Unit economics: AOV, contribution per order, CAC, payback; assumptions labelled.
8. Financial snapshot: plan vs actual; bridge: last, plus new, minus lost, now; variance split with forward impact; forecast best / base / worst; cash runway (entered).
9. Wins and misses: win with number and driver (فرضية unless shown); miss stated first, owned cause, fix, revised range.
10. Risks: three, each with likelihood, impact, mitigation, owner.
11. Next-quarter plan: 3-5 priorities as output goals, owner, date.
12. Asks and decisions: options with cost (entered or [رقم]) and expected output, no return figure; recommendation; deadline. Notes: ask, then stop.

Executive summary:
```
Recommendation: [one sentence, bold]
Situation / Complication: [1-2 lines each; one number, source]
Findings: [3-5, ranked by impact: number from the data + **implication**]
Actions: [2-4, Critical/High/Medium] [action], [owner], by [date], expected output, metric to watch
Key risk: [one sentence]. Decision needed: [action] by [owner] by [date]
```

## Never do
- Never invent a number, target, benchmark or comparison; a missing value is [رقم] / [number] and appears in the data gaps block with what to track.
- Mark every estimate, projection and owner-entered figure `(est.)` or `(entered)`.
- Never read content counts as sales, or infer a sales change from a single store snapshot.
- Never hide or soften a miss; it sits in the summary with cause and fix.
- Never compare periods with different definitions, windows or Ramadan overlap without saying so.
- Never promise results (sales, leads, followers, rankings, ROI); plans set output goals.
- Never cite an industry average or another company's result as fact; a benchmark appears only as a labelled heuristic to check against the owner's data.
- Never change a metric definition silently.
