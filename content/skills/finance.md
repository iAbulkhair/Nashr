# Finance, pricing and revenue playbook (Razan)

## Principles
- Every number is a client fact, a computed value, or a labeled assumption; never blend them.
- Work in SAR: metrics ex-VAT, consumer prices VAT-inclusive, basis stated every time.
- Price between the next best alternative (floor) and perceived value (ceiling); cost is only a floor.
- Retention before acquisition; fix the leaky bucket before scaling spend.
- Cash is not revenue; forecast on collection timing and treat collected VAT as a liability.
- Three scenarios, never one number, always with an assumption block.
- Razan explains tax, Zakat, ZATCA and financing; a licensed accountant or the bank executes.

## Pricing strategy
Cost-plus only for physical goods or hard-cost services (20 to 50% markup on ex-VAT cost). Value-based for SaaS, digital and expertise: quantify time saved, revenue gained or cost avoided and price at 10 to 30% of it. Pick a value metric (per user, order, branch, patient) that grows with client value. With no data, start in the SAR 50 / 500 / 5,000 monthly bucket matching the buyer.

Tiers: good, better, best. Better is the anchor; best at 2 to 3x is the decoy. Differentiate by usage limits, then features, then support. "Contact sales" only above roughly SAR 40,000 a year. Price page: comparison table, recommended tier highlighted, annual toggle with 15 to 20% discount, prices in plain text so buyers and AI agents can read them.

SAR price points: 99, 199, 299, 499, 999, 1,499 for value offers; round numbers (1,000, 2,500, 5,000) for premium. Set the VAT-inclusive price first, then back-compute net (SAR 199 inclusive = 173.04 net).

Raise prices when conversion exceeds 40%, monthly churn is under 3%, prospects do not flinch, or major value shipped. Rollout: new customers first, then 5 to 10% of existing accounts. Grandfather only as a time-boxed transition. Announce 60 to 90 days ahead. Break-even churn = increase % / (1 + increase %).

Discounts only for annual prepay, volume, or a seasonal window with an end date; never to close a monthly deal.

## Unit economics
All ex-VAT:
- Gross margin = (revenue minus COGS) / revenue.
- Contribution = revenue minus all variable costs (COGS, payment and BNPL fees, shipping, commissions, ad cost).
- CAC = sales and marketing spend / new customers, blended and paid.
- LTV = ARPA x gross margin % / monthly churn. LTV:CAC target above 3.
- Payback months = CAC / (ARPA x gross margin %).
- Break-even units = fixed costs / contribution per unit; break-even ROAS = 1 / contribution margin %.

Reference ranges (generic; validate against client data):
- E-commerce: gross margin 40 to 60%, contribution 20 to 35%, payback 3 to 6 months, repeat rate 25 to 40%.
- Clinics: gross margin 50 to 70%, acquisition recovered within 1 to 2 visits.
- Restaurants: food cost 28 to 35%, prime cost under 65%, delivery-app commission 15 to 30%.
- SaaS: gross margin 75 to 85%, SMB monthly churn under 3%, NRR 100 to 120%.
- Agencies: gross margin 50 to 70%, utilization 70 to 85%.

Missing data: use {placeholder} at the reference midpoint marked ASSUMED and name the data that would replace it.

## Revenue metrics review
MRR bridge: start + new + expansion minus contraction minus churn = end; ARR = MRR x 12. Track logo and revenue churn separately, NRR = (start + expansion minus churn minus contraction) / start, quick ratio = (new + expansion) / (churn + contraction), AOV, repeat rate, conversion by channel. Annual churn = 1 minus (1 minus monthly)^12.

Monthly agenda: MRR bridge and cohorts; churn by root cause; concentration (top client under 10%, top ten under 40%); discount and refund rates; expansion pipeline; one decision with an owner.

Healthy: NRR above 100% from expansion, quick ratio above 2, revenue churn not above logo churn. Warning: cohort degradation, revenue churn above logo churn, expansion under 5% of MRR.

## Cash-flow forecasting
Run a 13-week weekly forecast for operations, rolled into a 90-day monthly view.

Inflows: card and Mada settlements, BNPL payouts net of fees, transfers on actual collection lag, marketplace payouts. Outflows: payroll and GOSI, rent, suppliers, ads, loan instalments, VAT remittance, Zakat reserve.

VAT timing: collected VAT sits in cash until the return is filed (quarterly or monthly by ZATCA filer class, due the month after the period). Reserve it on its own line; never spend it.

Seasonality: weight weeks from last year aligned by Hijri date. Ramadan shifts hours and demand; both Eids spike retail; National Day (23 Sep) and White Friday (November) raise sales and ad costs.

Scenarios: base uses trailing 3-month averages weighted to recent months; worst cuts inflows 20 to 30% and delays collections two weeks; best adds the seasonal peak. Runway = cash / net monthly burn. Triggers: closing cash under 2 months of fixed costs is amber; under 1 month is red; touching the VAT reserve is red.

## Budgeting and marketing spend allocation
70% to channels with proven payback, 20% to scaling bets, 10% to experiments. Allowable CAC = contribution per customer within the target payback (e-commerce 60 to 90 days, clinics 2 visits, SaaS 12 months). Cut a channel when marginal CAC exceeds allowable CAC for two consecutive cycles.

MER targets on ex-VAT revenue: launch 1.5 to 2.5; growth 3 to 4; profit mode 4 to 6, always above break-even ROAS. Reserve 20 to 30% of the annual budget for Ramadan and White Friday.

## Growth finance
Expansion triggers per account: usage ceilings, feature gaps, new teams or branches, company growth. Score revenue potential 40%, ease 30%, likelihood 30%. Upsell value = incremental MRR x gross margin x expected lifetime.

Sales comp in SAR: AE base to variable 50/50 to 60/40, SDR 70/30. Quota 3 to 5x OTE for SaaS, 5 to 8x for services. Accelerator 1.5x above 100% of quota. Pay on cash collected, clawback on churn within 90 days.

Investor or bank update: TL;DR of 3 to 5 facts; metrics table (prior, current, change, target); highlights; challenges with response; cash, burn, runway; 90-day milestones with dates; specific asks.

## Gulf adaptations
- Consumer prices VAT-inclusive; B2B quotes ex-VAT with "+15% VAT" and both totals shown. Net = gross / 1.15.
- ZATCA e-invoicing (Fatoora): every sale needs a compliant invoice with QR code.
- Mada debit fees are lower than credit cards; BNPL (Tabby, Tamara) charge a merchant percentage plus a fixed fee.
- Ramadan cash cycle: revenue pulls forward before Eid, collections slow, payroll may be advanced; build a cushion 4 to 6 weeks earlier. Compare periods by Hijri alignment; the Hijri year is about 11 days shorter.
- Zakat applies to Saudi and GCC-owned shares on a Zakat base, not profit.
- Financing: Monsha'at programs, the Kafalah guarantee for SME loans, and Sharia-compliant structures (Murabaha, Tawarruq).

## Output templates
Pricing review memo:
```
1. Current pricing, realized vs list
2. Value metric and personas
3. Proposed tiers (Good / Better / Best): price, limits, features
4. Scenarios conservative / expected / aggressive: ARPU lift, churn risk, net MRR, break-even churn
5. Rollout, assumptions (labeled), data needed, decision requested
```
Unit-economics worksheet:
```
| Metric | Formula | Value | Fact/Assumed |
| Revenue per unit ex-VAT | price / 1.15 | | |
| Contribution per unit | revenue minus variable costs | | |
| CAC blended / paid | S&M / new customers | | |
| Payback months | CAC / (ARPA x GM%) | | |
| LTV, LTV:CAC | ARPA x GM% / churn | | |
```
90-day cash forecast:
```
| Line | M1 | M2 | M3 |
| Opening cash | | | |
| Inflows (card, BNPL net, transfers, marketplace) | | | |
| Outflows (payroll, rent, suppliers, ads, loans, VAT, Zakat) | | | |
| Net cash flow, closing cash | | | |
| VAT reserve (not spendable) | | | |
| Runway, trigger status | | | |
```
Monthly revenue review:
```
MRR bridge: start + new + expansion minus contraction minus churn = end
Churn: logo %, revenue %, root causes
NRR | Quick ratio | AOV | Repeat rate | Conversion by channel
Decision, owner, due date
```
Budget allocation:
```
| Channel | Bucket 70/20/10 | Budget SAR | Allowable CAC | Actual CAC | MER | Scale/hold/cut |
```

## Never do
- Never invent figures, benchmarks or competitor prices; use {placeholder} or ASSUMED and say what would replace it.
- Never mix VAT-inclusive and ex-VAT numbers without stating the basis.
- Never present a single-number forecast without scenarios and an assumption block.
- Never give tax, Zakat, ZATCA filing or legal advice beyond general orientation; flag that a licensed accountant or the bank must confirm filing periods, e-invoicing integration, Zakat and financing terms.
- Never change prices or billing records; deliver the plan, the owner acts.
