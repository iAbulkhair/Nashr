import { AGENTS, agentById, type Agent, type AgentId } from "./agents";
import type { TaskType } from "./tasks";

/**
 * Agents as config (Thakeen v2, C14, rules 4600-4609, docs/system/architecture.md "Agent profiles").
 *
 * One typed profile per agent: who it is and what it is given to work with. A profile is platform code, versioned by the
 * prompt stamp: src/lib/prompt-stamp.ts hashes the persona, the specs and the review focus through `fixedPrompt`,
 * `taskSpec` and `reviewerRubric`, so a profile change shows in every new item's stamp and in the next golden run.
 * Customers still change an agent's behaviour only through the instruction layers and Governance, never here.
 *
 * Two halves make one profile (`agentProfile`):
 * - Who the agent is: id, name, role, task types, skills file, playbook slices and persona, in `AGENTS`
 *   (src/lib/agents.ts). That registry is shared with the browser (the sidebar, the approval cards), so it imports types
 *   only (tests/client-bundle.test.ts) and the prompt text below stays out of the browser bundle.
 * - What the agent is given: the spec of each task type it owns, keyed by type in the order of its `tasks`, and the
 *   reviewer's fit check for its deliverables (check 6 of `reviewerRubric`). Here, read on the server by noor.ts.
 *
 * Not in a profile, because no agent differs today: the tool policy is `on` for every agent and capability until the owner
 * changes it (src/lib/tool-authority.ts, where `on` is the absence of a stored value, so a per-agent default other than
 * `on` would first need a stored `on`), the model is chosen per purpose and task type (src/lib/models/route.ts), and the
 * per-agent budget caps are the owner's (src/lib/governance.ts). A field joins the profile when a first agent needs a
 * value of its own.
 *
 * A ninth agent is one `AGENTS` entry, one entry here and its content/skills file; tests/v2-agent-profiles.test.ts fails
 * until they agree.
 */
export type AgentProfile = Agent & {
  /** The spec each task type it owns is written to: exactly its `tasks`, in that order. `taskSpec` fills `{CURRENCY}`. */
  specs: Partial<Record<TaskType, string>>;
  /** What "fit for purpose" means for its deliverables: check 6 of the reviewer's rubric. */
  reviewFocus: string;
};

type Prompts = Pick<AgentProfile, "specs" | "reviewFocus">;

/**
 * What Dana's reports and Majed's strategy review are built from (spec A5): the blocks `statsFor` attaches, each only when
 * it was read (src/lib/stats.ts); a change over time only where the data holds the previous period; ad totals only from
 * AD DATA (performance-learnings.md keeps the latest platform's findings, never a total); and the NOT READ list, built in
 * code (rule 738), repeated as it is. `where` says where that list goes in the deliverable.
 */
const reportData = (where: string) =>
  `Use the WORKSPACE DATA and, when present, the STORE DATA, SITE DATA, SOCIAL DATA and AD DATA, each figure with its own dates; take ad totals only from AD DATA. Compare with the previous period only where prev exists (in WORKSPACE DATA, the previous month); otherwise write [رقم] for the change and say it needs a second read. When NOT READ is attached, name its platforms ${where}, exactly as listed and each with its reason in plain words; never add or drop one.`;

/**
 * The prompt half of each profile. `reviewFocus` is per agent because the reviewer used to introduce itself as Noor's and
 * check platform fit (hashtags, caption length) on every item, so Razan's forecasts and Dana's reports were reviewed as if
 * they were Instagram posts and nobody checked that their numbers added up or came from the data.
 */
const PROMPTS: Record<AgentId, Prompts> = {
  noor: {
    specs: {
      weekly_plan:
        "One weekly marketing plan for the next 7 days: 7 day-by-day entries (channel, post idea, best posting time in local time, CTA), plus 2 ad ideas and 1 WhatsApp message idea. Consider upcoming Gulf seasons (Ramadan, Eids, Founding Day 22 Feb, Saudi National Day 23 Sep, UAE National Day 2 Dec, White Friday, back to school). channel = 'plan'.",
      social:
        "10 social media posts ready to publish. Mix: 4 Instagram captions (with 5-8 Arabic+English hashtags), 3 Snapchat story scripts (short, spoken tone), 2 TikTok video scripts (hook, 3 beats, CTA, ≤30s), 1 X post. Each body must be complete and copy-paste ready. channel = instagram | snapchat | tiktok | x.",
      article:
        "One SEO article of 1,200-1,600 words in the brand's primary language, targeting a keyword a competitor is likely missing. Include: title, meta description (≤155 chars), H2/H3 structure in Markdown, FAQ section with 3 questions, internal CTA. channel = 'blog'.",
      whatsapp:
        "3 WhatsApp Business messages: (1) abandoned-cart or lead follow-up, (2) seasonal offer announcement, (3) post-purchase thank-you with review request. Each ≤ 700 characters, template-friendly (use {{1}} placeholders for name/order), respectful tone, one clear CTA, opt-out line. channel = 'whatsapp'.",
      ads: "5 paid ad copies: 2 Snapchat (headline ≤34 chars + primary text ≤ 3 lines + CTA), 2 Meta/Instagram (primary text, headline ≤40 chars, description), 1 TikTok (spoken script ≤15s). Each with a target audience note and a suggested daily budget in {CURRENCY}. channel = snapchat | meta | tiktok.",
      gbp: "3 Google Business Profile posts (≤ 300 chars each): 1 offer, 1 update, 1 event/seasonal. Include CTA type (Call / Book / Order / Learn more). channel = 'gbp'.",
      cart_recovery:
        "Five items that win back shoppers who left products in their carts, built ONLY on the CART DATA block. Items 1-3: one WhatsApp Business recovery sequence sent about 1 hour, 24 hours and 72 hours after the cart was left, each under 500 characters, template-friendly with {{1}} for the shopper's name and {{2}} for the cart link (never write a real link), naming the products most often left from CART DATA where natural, one clear CTA, a respectful tone, and an opt-out line on the third. Items 4-5: one Instagram caption and one Snapchat story script featuring the products most often left in carts, each answering the likely hesitation (price, size, delivery, returns, authenticity) with facts from the brand file only. No discount, free shipping, gift or deadline unless it is in the brand file's current offers; otherwise leave it out or write [رقم]. Never mention cart counts, cart values, or that shopper data was read. These are drafts the owner pastes into the store's own abandoned-cart automation; Thakeen never messages shoppers. channel = 'whatsapp' | 'instagram' | 'snapchat'.",
    },
    reviewFocus:
      "Platform fit: the spec's length and character limits, hashtags only where and as many as the spec asks, one CTA, complete and paste-ready.",
  },
  sami: {
    specs: {
      sales_script:
        "Three sales assets for this brand: (1) a discovery call script: opening, 8 questions grouped by stage (situation, pain, impact, decision), and a closing next step, under 500 words; (2) a WhatsApp first-contact script with 3 variants (inbound lead, referral, warm intro), each under 500 characters; (3) an objection-handling sheet as a Markdown table with the 8 most likely objections in this industry: objection, root cause, response, proof to show. channel = 'sales'.",
      lead_qualifier:
        "One lead qualification card for this brand's ideal customer: ICP definition, 10 qualifying questions in the owner's language, a 0-100 scoring rubric (fit, intent, budget, timing, authority) with bands and the next action per band, and disqualifiers. Ready to paste into a CRM note. channel = 'sales'.",
      followup_seq:
        "Seven follow-up messages forming one cadence for a lead who went quiet after a quote or visit. Touches on day 0, 1, 3, 6, 10, 15, 21. Five WhatsApp messages under 400 characters, one email, one call script. Each with its intent in the title, one CTA, respectful tone, opt-out line on the last touch. channel = 'whatsapp' | 'email' | 'call'.",
    },
    reviewFocus:
      "Sales fit: every script and message ends in one clear next step; objections are answered with facts from the brand file, never with invented proof, customer names, win rates or reply rates; WhatsApp messages stay within the spec's length and carry the opt-out line where the spec asks; respectful Gulf tone, no pressure tactics or fake urgency.",
  },
  razan: {
    specs: {
      pricing_review:
        "One pricing review memo: current pricing summary (use [رقم] where unknown), three packaging options (good, better, best) with {CURRENCY} price points and a VAT-inclusive note, anchoring and psychological price logic, discount policy, what to test first, and risks. Every assumption labeled. channel = 'finance'.",
      unit_economics:
        "One unit-economics worksheet as a Markdown table with the formulas explained: price, COGS, gross margin, CAC by channel, LTV, LTV:CAC, payback period, break-even units. Fill known numbers from the brand file, mark every assumption, add industry benchmark ranges and the three levers that move the result most. channel = 'finance'.",
      cash_forecast:
        "One 90-day cash-flow forecast template for this brand: a 13-week Markdown table with inflow and outflow categories, VAT payment timing, seasonality notes for the upcoming Gulf seasons, best/base/worst scenario summary, and cash triggers with the action for each. Placeholders for unknown figures. channel = 'finance'.",
    },
    reviewFocus:
      "Finance fit: every figure is a fact from the brand file or the owner's notes, a computed value whose formula is shown, or labelled as an assumption; totals, margins and percentages add up; VAT treatment is stated; base, upside and downside scenarios are consistent with each other; tax, Zakat and VAT points are orientation only and name the professional to confirm; no guaranteed return.",
  },
  faris: {
    specs: {
      gtm_plan:
        "One 90-day go-to-market plan: positioning statement, ICP, message hierarchy, three phases with goals, channel sequencing for this industry, weekly milestones, budget split as percentages, KPIs with target placeholders, and an owner per workstream. channel = 'growth'.",
      growth_experiments:
        "Five growth experiment cards, ordered by ICE score. Each: hypothesis, channel, ICE (impact, confidence, ease, 1-10 each), setup steps, metric and success threshold, duration, cost estimate in {CURRENCY} as a placeholder. channel = 'growth'.",
      retention_play:
        "Three retention plays ready to implement: (1) activation and onboarding sequence for new customers, (2) churn-prevention play with early-warning signals and interventions, (3) referral or loyalty program with mechanics and rewards in {CURRENCY}. channel = 'growth'.",
    },
    reviewFocus:
      "Growth fit: every experiment has a hypothesis, one metric, a success threshold set before launch and a duration; KPIs are targets with [رقم] baselines, never predicted results; budget splits add up to 100%; no promised growth, rankings or AI-assistant mentions.",
  },
  dana: {
    specs: {
      weekly_report:
        "One weekly performance report built ONLY from the WORKSPACE DATA, the STORE DATA when present, the site, social and ad data when present, and owner notes provided: headline (what changed and why), 6-8 KPI lines each with its prior-period comparison where the data holds one, content output and approval rate, published items, wins, misses, and next week's three actions. Never invent numbers; where data is missing write [رقم] and say what to track. " +
        reportData("at the end of the report") +
        " channel = 'report'.",
      board_deck:
        "One board or investor deck outline of 10-12 slides. Format strictly: a line '## Slide N: Title', then 3-5 bullet lines starting with '- ', then one line starting with 'Notes:' holding speaker notes. Cover: executive summary, market and customer, offer, traction (from WORKSPACE DATA and STORE DATA when present, and the site, social and ad data), marketing engine, sales pipeline, unit economics, financial snapshot, next-quarter plan, asks. Numbers only from the data provided or as [رقم] placeholders. " +
        reportData("on the last slide") +
        " channel = 'deck'.",
      dashboard_spec:
        "One KPI dashboard specification: 8-10 tiles as a Markdown table (metric, definition, data source, target, chart type, refresh cadence, owner), layout order, RTL notes, alert thresholds, and the five questions the dashboard must answer. Any current figure or baseline comes only from the data provided. " +
        reportData("at the end, below the tiles") +
        " channel = 'dashboard'.",
    },
    reviewFocus:
      'Report fit: every number comes from <workspace_data> (when present), the brand file or the owner\'s notes, or is written as [رقم]; each comparison names its period; the spec\'s required headers ("## Slide N: Title", "Notes:") and table columns are present; no trend or cause the data does not show.',
  },
  majed: {
    specs: {
      strategy_review:
        "One 90-day strategy review as a one-page document: situation in 5 lines (from the brand file, the data provided and owner notes), the 3 bets to make, the kill list (what to stop), resource allocation as percentages, risks with mitigations, the 10 questions the owner must answer this quarter, and the decision deadline. Placeholders for unknown figures. " +
        reportData("at the end of the document") +
        " channel = 'strategy'.",
      okrs: "One quarterly OKR set for a 3-30 person company: at most 3 objectives, each with 2-4 measurable key results (baseline as [رقم] if unknown, target, owner), a weekly scorecard table, the monthly and quarterly review agenda, and the first two weeks of actions. channel = 'strategy'.",
      decision_memo:
        "One one-page decision memo on the question in the owner notes (if no question given, pick the most consequential open decision visible in the brand file and workspace data): context, 3 options with cost, upside, risk and reversibility, recommendation with reasoning, what would change the decision, owner, deadline. channel = 'strategy'.",
    },
    reviewFocus:
      "Executive fit: the number of options the spec asks for, each with cost, upside, risk and reversibility; the recommendation follows from the stated facts; assumptions are labelled; figures only from the brand file, the owner's notes or [رقم]; no promised outcomes.",
  },
  layan: {
    specs: {
      prd: "One compact PRD for the feature or product in the owner notes (if none, the most valuable next feature for this business): problem, users and jobs to be done, scope in and out, requirements table (must/should/could), success metrics with placeholders, risks, open questions, launch plan. Arabic-first UX and WhatsApp considerations where relevant. channel = 'product'.",
      roadmap:
        "One now/next/later roadmap for the next two quarters: quarterly themes, 8-12 items with RICE scores (reach, impact, confidence, effort 1-10 each), owner, dependency, and the explicit 'not now' list with reasons. channel = 'product'.",
      feedback_synthesis:
        "One feedback synthesis report from the customer feedback in the owner notes or files (if none, write the interview script and synthesis template instead and say so): themes with counts and representative quotes, severity and frequency matrix, opportunity solution tree for the top 3 themes, recommended next actions. Never invent quotes. channel = 'product'.",
      onboarding_flow:
        "One onboarding and activation flow for new customers of this business: the activation metric definition, first-session or first-purchase steps, a 5-touch WhatsApp and email checklist sequence with timing and message intent, the three most common drop-offs and fixes, and how to measure time to value. channel = 'product'.",
    },
    reviewFocus:
      "Product fit: requirements, metrics and RICE inputs use placeholders where data is missing; customer quotes, counts and themes come only from the owner's notes or files, never invented; scope in and out is explicit; onboarding and retention steps name their trigger and timing; no dark patterns or fake scarcity.",
  },
  reem: {
    specs: {},
    // Reem owns no deliverable type (agentForTask never returns her), so this line is never sent today; it is here so the
    // map stays complete and a future Reem deliverable is reviewed as hers.
    reviewFocus:
      "Secretary fit: every date, time, name and amount is one the owner gave, with dates in the brand's local time; nothing is marked done or promised on the owner's behalf; quoted customer or supplier text is kept as quoted data.",
  },
};

/** One agent's whole profile. */
export const agentProfile = (id: AgentId): AgentProfile => ({ ...agentById(id), ...PROMPTS[id] });

/** Every profile, in the roster's order. */
export const AGENT_PROFILES: readonly AgentProfile[] = AGENTS.map((a) => agentProfile(a.id));

/** Each task type's spec, from its owner's profile: what `taskSpec` (src/lib/noor.ts) reads. */
export const TASK_SPECS = Object.fromEntries(Object.values(PROMPTS).flatMap((p) => Object.entries(p.specs))) as Record<
  TaskType,
  string
>;

/** Each agent's fit check, by agent: what `reviewerRubric` (src/lib/noor.ts) reads. */
export const REVIEW_FOCUS = Object.fromEntries(AGENTS.map((a) => [a.id, PROMPTS[a.id].reviewFocus])) as Record<
  AgentId,
  string
>;
