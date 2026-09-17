# Enrich Labs (Helena) — Product Teardown vs Nashr

Walked as a logged-in trial user on 17 Sep 2026 (`agent.enrichlabs.ai`). Every route, panel and control below was opened and read.

## 1. Information architecture

Three-column workspace, Slack-like.

**Left sidebar**
- Workspace switcher (brand name + domain)
- CHANNELS: `#main`, `#content-inspo`, `#performance`, `#calendar`
- DIRECT MESSAGES: `Helena — AI Digital Marketer` + "+ New" (add another agent)
- CHAT HISTORY: search, list of conversations, "See all conversations"
- Files · Earn credits · Governance (NEW) · Integrations · Contact Us
- Account menu (email) bottom-left

**Center: chat thread**
- Channel header with rename, "SMS (NEW)" (text Helena from your phone), "Share"
- Agent shows a live activity trace while working: "Reading website content", "Searching the web", "Checking your plan"
- Outputs are **files** rendered inline as cards (`business-profile.md`, `brand-guidelines.md`, `market-research.md`, `homepage-conversion-audit.md`, `strategy.md`) with Collapse / Copy / Share and a "Saved" badge
- "Here's your plan" block: suggested tasks with a `+` to add to scheduled tasks, "Skip"
- Composer: attach files, text, send
- Persistent CTA under composer: outcome headline ("Grow your product search traffic 35% in 90 days") + **Activate Helena** + "First up: <first task>"

**Right panel (collapsible sections)**
- Metrics: Active users / Sessions / Meta ads … each "Connect now" (empty until GA/Meta connected)
- Channels
- Task Feed (NEW): Scheduled tasks list — "Weekly Automation Suggestions" (in 3h), "Weekly Quick Win" (4d) · filter All/Insights · "Manage all →"
- Brand Assets & Knowledge: the generated files + "Upload your logo" + "Add Assets" + "View all files"

## 2. Onboarding flow (what happened in the first 60 seconds)

1. Signup → one question: website URL + which services you want (Social, SEO, Content, Email, Paid Ads).
2. Helena crawls the site, searches the web, and writes **five foundation files** into the workspace. Even with a dead DNS (asbunat.sa didn't resolve) she produced a KSA-aware profile: Mada/Apple Pay/Tabby, TikTok/Snap/IG/X, Arabic+English, 9:16 mobile-first, WhatsApp retention.
3. She proposes 2 quick-win tasks and a 90-day outcome, then asks you to **Activate** (paywall). Trial = 3 days.
4. CEO email lands minutes later if you don't activate.

Takeaway: the "aha" is *files appearing in real time from one URL*. No form. Nashr currently asks a 12-field form first. **Flip it: URL first, form second (prefilled).**

## 3. Screens, one by one

| Route | What it is | Notes |
|---|---|---|
| `/marketing` (#main) | Chat with Helena, files inline | The product *is* the chat. Everything else is a view on its outputs. |
| `/marketing/explore` (#content-inspo) | "Marketing Intelligence Layer": swipe file of real brand emails/ads (Gantri, Spotify, Lacoste…), filtered by Email / Meta ads / Brand Campaigns / Workflows, type (image/video/text/interactive), format (newsletter, promo, welcome, winback, launch, seasonal…). "Open a reference to bring it into chat." | Strong retention feature. Cheap to build: a curated library + "use as reference" button. Nashr version = Gulf brands (Salla stores, Snap ads, Ramadan campaigns). |
| `/marketing/performance` (#performance) | Analytics dashboard: date ranges 24h→last year, metric cards ("Add Metric"), trend chart. Empty until GA4/Shopify connected; modal nags "Connect Google Analytics". | Honest empty state: "GA could not be reached, so numbers are incomplete rather than zero." |
| `/marketing/calendar` (#calendar) | Month/week calendar of scheduled content, keyboard shortcuts (←/→, T, V), "Add Content" per day. | Empty until autopilot runs. |
| `/marketing/workspace` (Files) | Table of generated files: name, type, size, date, Download, Delete. | Files are the memory. Users can delete → agent forgets. |
| `/marketing/refer` (Earn credits) | Referral link + code, 50 credits per signup, "Share on social" tab. | Built-in growth loop. |
| `/marketing/governance` | **The trust layer.** Autopilot posting cadence (weekly cap per channel), Pre-post notifications (email N minutes before every scheduled post), "No em-dashes" rewrite toggle, Autonomous learning (weekly per-platform strategy update). | This is how they make "autonomous" feel safe. Nashr must have this before auto-publish ships. |
| `/marketing/integrations` | ~110 integrations in 3 groups: Content Posting (X, LinkedIn, YouTube, TikTok, IG, FB, Pinterest, WordPress, Substack, Webflow, Ghost, Threads, Reddit, Bluesky, Captions.ai, Higgsfield…), Channel Data & Setup (Shopify, GA, GSC, GBP, Google/Meta/TikTok/Amazon/X/Bing/ChatGPT Ads, Klaviyo, Mailchimp, Brevo, Stripe, HubSpot, Zoho, Semrush, Ahrefs, Notion, Airtable, Custom MCP…), More (Gmail, Sheets, Drive, Slack-less but Discord/Teams, Calendly, Figma, Perplexity, Firecrawl, ElevenLabs…). Search box. "Request a New Integration". | Mostly via a connector platform (Composio-style). **Zero Gulf coverage**: no Salla, Zid, Snapchat Ads, WhatsApp, Unifonic, Tap, Moyasar, Tabby. That is Nashr's moat, explicitly. |
| `/marketing/scheduled-jobs` (Tasks) | Recurring tasks with cron-like schedule, timezone, Run now, Active toggle, last/next run. Default: "Weekly Automation Suggestions", Thu 7 AM. | Tasks = agent on a timer. Nashr equivalent: Sunday 06:00 weekly plan, daily 08:00 brief. |
| `/marketing/chat-sessions` | Conversation history with counts. | — |
| SMS (NEW) | Text Helena from your phone. | Nashr equivalent is WhatsApp — and it's a bigger deal in KSA than SMS is in the US. |
| Activate Helena | Paywall → checkout (not opened). Trial 3 days. | Nashr: 7 days / 50 credits. Consider matching their urgency: 3 days + hard outcome promise. |

## 4. Patterns worth copying (mechanism, not pixels)

1. **URL-first onboarding that produces artifacts live.** Show the agent thinking ("Reading website…") and drop files into the workspace one by one.
2. **Files as memory.** Brand profile, guidelines, research, strategy are editable markdown the user can read, download, delete. Transparent and trust-building. Nashr's brand file is a form → make it a visible `brand.md` the user can edit, and let Noor append to it.
3. **Outcome-framed CTA** everywhere: "Grow product search traffic 35% in 90 days" not "Upgrade".
4. **Governance page** before autonomy: caps, pre-post notifications, learning toggle.
5. **Scheduled tasks** users can see, run now, pause.
6. **Content Inspo library** with "bring into chat" — retention + quality anchor.
7. **Referral credits** inside the product.
8. **Chat as the primary surface**, with inbox/calendar/performance as views. Nashr today is form + buttons + inbox; add a chat with Noor that can do everything the buttons do.
9. **Honest empty states** that explain what to connect and why.
10. **Founder email within minutes** of non-activation.

## 5. Where Nashr already wins

- Arabic dialect control, Hijri/Gulf calendar, industry compliance playbooks — Helena wrote a decent KSA profile but has no Snap Ads, WhatsApp, Salla/Zid, Tap, Tabby integrations and no Arabic evaluation loop.
- Reviewer pass (second model) before anything reaches the inbox.
- Mobile number at signup + WhatsApp as the channel.
- Pricing in SAR, local payment rails on the roadmap.

## 6. Where Nashr is behind (priority order)

1. **No chat surface.** Users can only press 6 buttons. → Add "Chat with Noor" (#main) that calls the same generators as tools.
2. **Form-first onboarding.** → URL-first: crawl the site, prefill the brand file, show files landing.
3. **No files/memory view.** → `brand.md`, `strategy.md`, `preferences.md` visible and editable.
4. **No governance page.** Needed before any auto-publish.
5. **No scheduled tasks / calendar.** → Weekly plan on Sunday 06:00, daily brief 08:00 (WhatsApp when API lands, email/in-app before).
6. **No integrations page** (even as "coming soon" with request button) — buyers look for it.
7. **No referral loop.**
8. **No content inspo library** — build a Gulf one; nobody has it.
9. **No performance view** — depends on GA4/Snap/Meta connections.
10. **Trial: 3 days + outcome promise** converts harder than 7 days + credits. Test.

## 7. Suggested 2-week build order for Nashr

Week 1: chat surface with Noor (tools = existing generators) → URL-first onboarding with live file cards → files view → governance page (caps, notifications, learning toggle).
Week 2: scheduled tasks (weekly plan, daily brief via email/in-app) → calendar view of approved items → referral credits → integrations page with Gulf-first list and "request integration" → Gulf content-inspo v0 (50 curated Snap/IG/WhatsApp examples).

Platform approvals (Meta/WhatsApp, Snap, TikTok, Salla, Zid) run in parallel from day 1.
