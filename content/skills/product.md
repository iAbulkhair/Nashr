# Product, product marketing and retention playbook (Layan)

## Principles
- Evidence rule: every number comes from the owner's notes, workspace data or a computation from them (show the formula); anything else is [رقم] / [number], or tagged "افتراض / Assumption" or Open question with how to validate it. Keep facts, projections and targets on separate lines.
- Targets are the owner's goals, [رقم] (owner to set) until given, never a forecast or promise. Plans commit to outputs (interviews run, PRD approved, flow shipped), not results (sales, retention, leads).
- Quotes are verbatim from provided feedback with a source id; counts counted, with sample size n. No data, no quote, no count.
- Discovery before delivery: a PRD without customer evidence says so and puts the validation step first.
- Outcomes over features: each roadmap item names a metric, baseline [رقم] and the owner's target.
- Retention first: fix the leaky bucket before buying acquisition; act on early signals, before the cancel click.
- Segment everything: free vs paid, new vs tenured, COD vs prepaid, city.
- Write for a founder with ten minutes, in Arabic-ready wording.

## Discovery and JTBD
Interview 5 to 8 customers per cycle (30 min, call or WhatsApp voice, consent to record); stop when the same pain repeats in 3+ interviews.

Script: (1) "Tell me about the last time you [did the job]." (2) "What happened right before you looked for a solution?" (3) "How do you handle it today? What did you try and why did you stop?" (4) "What does this cost you each week?" (5) Switching forces: push, pull, habit, anxiety. Past behaviour only, never "would you use X". Keep verbatim Arabic quotes.

5 whys: when a customer names a feature, ask why until you reach the job. Write jobs as verb + object + context, solution-agnostic; split functional, social, emotional.

Opportunity solution tree: one measurable outcome on top; 3 to 7 opportunities phrased "I struggle to..."; score importance x (1 minus satisfaction) from customer ratings, else Assumption; 3+ solutions per top opportunity; one cheap experiment each, pass threshold set beforehand.

## Feedback synthesis
- Only feedback in the owner notes, files or workspace data counts. If none, say so first, then give the script above and a blank template: no sample themes, quotes or counts.
- Log each item: id, source (WhatsApp, review, ticket, call), segment, date. State N, sources, date range and exclusions (duplicates, spam) first.
- Themes max 8, solution-agnostic; an item may carry several. Count = items tagged, "n of N"; with N under 20 give counts, not percentages.
- Severity 1 to 5 from the customer's words: 1 cosmetic, 3 slows the job, 5 blocks it or costs money. Matrix: severe+frequent fix now; severe+rare investigate; mild+frequent quick win; mild+rare monitor.
- 1 to 3 verbatim quotes per theme with item id; never paraphrase inside quote marks, correct dialect or merge customers.
- One loud customer or copies of one complaint count once; flag themes resting on one source or segment.
- Close with evidence gaps (churned, silent, missing cities or segments) and confidence Low/Medium/High, set by the weakest link.

## PRD
Opportunity check first: why now; evidence with source and n; cost of waiting; options (full build, thin slice, buy or integrate, defer); decision build / explore / defer / kill (a recommendation; the full PRD follows, validation first on defer or kill).

One to three pages, no pixel specs. Acceptance criteria are testable (Given / When / Then, one edge case each); every risk has an owner; launch in phases (internal, one segment, full), each with a success gate, plus kill or rollback criteria. Cover Arabic-first UX and WhatsApp touchpoints where relevant.

## Prioritisation and roadmap
RICE: Reach, Impact, Confidence, Effort each 1 to 10; RICE = R x I x C / E, inputs shown. Reach from data, else Assumption. Confidence names its source: 8 to 10 owner data or observed behaviour, 5 to 7 interviews or feedback, 1 to 4 a guess or one request. Effort from whoever builds it, never solo.

Now = this quarter, committed, 3 to 5 items with owners; Next = scoped, blockers named; Later = undated, scored, each with a signal to advance. 8 to 12 items across two quarters. Sequence by dependencies and fixed dates (Ramadan, Eid, peak season) before score. Name one shock absorber to move first if anything slips. 1 to 2 themes per quarter; each item is a hypothesis: "if we ship X, [segment] will Y, measured by Z".

Capacity: 60 to 70% of team time on roadmap, the rest bugs and support (Assumption; adjust to team history). Anything over a month gets a thin first slice.

Saying no: each "not now" row names the job behind the request and any workaround. Scope changes are accepted, deferred or rejected in writing, never silently absorbed.

## Product marketing
Positioning: "For [ICP] who [trigger], [brand] is the [category] that [outcome]. Unlike [alternative used today], we [differentiator with proof]." Messaging: one promise, three pillars (benefit, proof, customer phrase), in customer language. Proof, differentiator included, only from the brand file or owner data, else [دليل مطلوب / proof needed] in plans; customer copy drops unsourced proof.

Launch tiers: T1 major (new product or pricing; 6 to 8 weeks, all channels, pre-mortem); T2 feature (2 weeks; WhatsApp, in-app, social; announcement: hook, what is new, one brand-file proof if any, one CTA); T3 minor (changelog: date, benefit title, what changed, why it matters).

Checklist: positioning, FAQ and objections, support briefed, Arabic-first copy, tracking, success metric and kill criteria, phased launch, 7 and 30 day review.

Product page (Salla, Zid, Shopify): title with the job, 3 to 5 benefit bullets above the fold, price with VAT status, Arabic photos and video, sticky WhatsApp button; delivery time by city, return policy and Tabby/Tamara line only from the brand file or owner data, else [رقم] days / [policy].

## Onboarding and activation
Activation is the earliest action that predicts retention; find it by comparing retained and churned cohorts in owner data. Without data, propose a candidate labelled Assumption (store: first delivered order plus second visit; clinic: first completed booking) and the cohort check to confirm it. Time to value = median time from signup or first order to activation, by source; target [رقم] (owner to set).

First session: one goal, no dead ends, a 3 to 5 item checklist by value, empty states showing the next action, celebrate a real completed step. Friction-audit the core action (time, money, effort, mental load, social risk, novelty); fix the weakest link before adding nudges.

Five touches, WhatsApp first, email where given; each with trigger, one intent, one CTA and opt-out, stop once its goal is met: (1) T+0 welcome, one next step; (2) T+24h if not activated, "one thing left" plus link; (3) T+72h, help offer, short video or voice note; (4) on activation, what they achieved and the next win; (5) day 7, a tip tied to their usage. Never "we miss you".

Drop-offs: payment or verification step, blank first screen, jargon, data asked before value shown, COD confirmation unanswered. Rank the top three from funnel data, else as Assumption.

Honest nudges: one next step per message; changeable defaults; real progress only; respect quiet hours and preferred channel; if ignored, pause and ask their preferred cadence.

Assisted or B2B accounts: success criteria in writing at kickoff, an owner each side, a first-value date, then a met / partial / not met review.

## Retention and customer success
Cohorts by signup or first-order month: the share doing a real value action at day 7/30/90; flattening suggests fit, falling points at onboarding. Compare churn with the business's own trend, not outside benchmarks; track net revenue retention for B2B.

Health score (out of 100) = sum of (dimension score 1 to 10 x weight) / 10; weights: adoption 30 (frequency, breadth, trend), outcomes 25 (customer's own goal), relationship 20 (replies, NPS/CSAT, active contact), support 15 (open and severe tickets), commercial 10 (on-time payment, renewal intent). Bands: green 75+ (On track), amber 50 to 74 (Watch), red under 50 (Off track); both Assumption until tuned on the owner's churned accounts. The score lags: act on signals and trend.

Churn signals (starting triggers, tune to own data): usage well below the account's own baseline two weeks running, key feature stopped, tickets spike then silence, data export, NPS 0 to 6, payment failed. Main contact leaving is an automatic red: ask for an introduction, re-onboard the successor within a week.

Save plays by reason, every offer or credit within the discount policy: owner-approved and time-boxed. Price: downgrade or [رقم]% off for [رقم] months, never a deep permanent cut; not using: pause [رقم] months or an onboarding call; missing feature: a committed item or a workaround, never a promised date; technical: escalate within 24h plus a credit. Amber: personal message within 24h and an agreed recovery plan; red: the owner steps in. Keep "continue cancelling" visible.

Renewals (term contracts): value recap 90 days out, options by day 60, confirm by day 30; red gets the save play first. Upsell only green accounts, on a real trigger, owner-approved.

Win-back: day 0 confirmation; day 7 survey; day 30 what is new; day 60 address their reason if fixed; day 90 a final offer, same discount policy.

Repeat purchase and referral: replenishment reminder at the reuse interval, points tied to order frequency, double-sided referral ([رقم] credit each, brand's currency) paid only after the referred order is delivered and kept.

NPS quarterly, one question plus "why"; detractors get a personal reply within 24h. PMF survey only with 30+ users past first value; 40% "very disappointed" is a heuristic read with the cohort curve, not proof of fit.

## Follow-up discipline
Every follow-up adds something; never "just checking in"; never apologise.
- Purchase: T+0 confirmation, dispatch update, day 3 to 7 usage tip or review ask.
- Support ticket: acknowledge within 1 hour on WhatsApp, update every 24h, satisfaction check 48h after close (internal targets; customer copy says [رقم] hours until the owner confirms).
- Trial: day 1 next step, day 3 activation help, day 7 value recap, offer 3 days before end, final note 7 days after.
- Log every promise (fix, callback, feature) with owner and date; close the loop.
Quiet hours: Business WhatsApp and SMS go out between 9:00 and 22:00 local time, never at prayer times or Friday midday; in Ramadan shift later (after iftar and taraweeh). Off-window touches wait for the next window. Stop on explicit no, opt-out, a finished sequence with no reply, or a changed situation.

## Gulf adaptations
- WhatsApp-first onboarding: verified business number, opt-in first (PDPL, also for recordings and lists), approved templates with {{1}} variables, quick replies, voice notes, catalogue and payment links in chat.
- Arabic UX: RTL layout, mirrored icons, Hijri dates where relevant, short warm formal Arabic in the local register, English toggle for expats.
- Ramadan and Eid: seasonal preparation starts 4 to 6 weeks ahead (6 to 8 for a full launch); activity moves to night; reorder pushes before Eid, quiet week after. Hijri and peak-season dates only from owner or workspace data, else [date], never computed. National days (Saudi Founding Day 22 Feb, National Day 23 Sep; UAE 2 Dec) suit loyalty moments.
- Salary cycle: KSA government salaries land around the 27th; private payroll varies. Reorder reminders and renewal offers go just after payday.
- Family decision makers: a spouse or parent often weighs in; support shareable links, gifting and a second WhatsApp contact.
- Payments: mada and Apple Pay in KSA. COD may bring more refusals and returns (check owner data): confirm by WhatsApp before dispatch, reward prepaid. With Tabby/Tamara, compare instalment buyers' repeat rate in owner data; failed instalments are involuntary churn.
- VAT: if VAT-registered (owner data), prices say VAT included at the local rate (KSA 15%, UAE 5%), else [VAT status]; KSA billing PRDs include ZATCA e-invoicing.
- Cities: never state a delivery time the owner has not given; segment delivery, returns and retention by city from owner data.

## Output templates
PRD:
```
# [Feature] PRD v0.1 [date] [owner]
Opportunity: why now, evidence, cost of waiting, options, decision
Summary: [feature] for [user] to solve [problem]; primary metric, owner target [رقم] by [date] (goal, not forecast)
Problem: who, job to be done, why painful, evidence (source)
Scope: In / Out (reason) / Later
Requirements: ID, requirement, must/should/could, acceptance (Given/When/Then)
Decisions: chose A over B because; trade-off
Metrics: primary, secondary, guardrail (baseline + source, owner target [رقم], date)
Risks: value, usability, feasibility, viability (mitigation, owner); dependencies
Open questions: question, owner, deadline
Launch: tier; phase, audience, success gate; kill/rollback criteria
Self-check: weakest section, top 3 assumptions, next step
```
Roadmap:
```
Themes: [quarter] [theme]; [next quarter] [theme]
Stage, Initiative (hypothesis), Metric (baseline [رقم], owner target [رقم]), R, I, C (source), E, RICE, Owner, Dependency, Signal to advance (Later rows)
Shock absorber: [item]
Not now: request, source, reason, revisit condition
```
Feedback synthesis report:
```
Sample: N items, sources, date range, segments, excluded (why)
Theme, Count (n of N), Severity 1-5, Verbatim quote (item id), Segment, Quick win?
Matrix: fix now / investigate / quick win / monitor
OST for top 3 themes; next actions (action, owner, effort, metric)
Evidence gaps; confidence (Low/Medium/High, why)
```
Onboarding flow:
```
Activation event: definition, evidence or Assumption, how to confirm
Time to value: how measured, owner target [رقم]
Steps: screen or chat step, single next action, empty-state copy
Touches 1-5: timing, trigger, channel, intent, one CTA, copy with {{1}}, opt-out line, stop rule
Top 3 drop-offs (data or Assumption) and fixes
Measure: activation rate and median TTV by source, weekly
```
Retention programme:
```
Cohorts; health score, bands (Assumption until tuned)
Signal, Trigger, Play, Owner, Channel (champion leaves = red)
Save and win-back offers (owner-approved, time-boxed); renewal timeline; expansion criteria; referral; NPS
```
PMF survey:
```
Q1 "How would you feel if you could no longer use [product]?" very / somewhat / not disappointed; Q2 who benefits most; Q3 main benefit; Q4 how to improve
Result: n, very disappointed [رقم]% (computed), strongest segment, what the somewhat group needs for a must-have
```

## Never do
- Invent research, quotes, counts, benchmarks or metrics; use [رقم] / Assumption instead.
- Present inferred jobs, baselines or projections as facts, or targets as promised results.
- Dark patterns: hidden cancel, forced continuity, fake scarcity or deadlines, confirmshaming, guilt copy, pre-ticked consent.
- Message anyone who opted out, against the quiet-hours rule, or beyond the sequence.
- Promise dates gated on third parties, roadmap features to save an account, or unvalidated targets.
- Offer discounts, credits or rewards the owner has not approved; pitch upgrades before value is proven.
- Launch without a success metric and kill criteria.
