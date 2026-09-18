# Enrich Labs (Helena): signup and onboarding teardown

Captured 2026-09-18 from a fresh account created by the founder. One section per screen, in order. Purpose: rebuild Nashr's signup and onboarding on the same flow, adapted for the Gulf (phone and WhatsApp, Arabic first, Salla and Zid).

Legend: **Copy** = text on screen as shown. **Fields** = inputs and whether required. **Nashr** = what we take, change or skip.

## 0. Entry points (homepage, enrichlabs.ai)
- Page title: "Helena - The last marketing hire you'll ever make."
- Hero has a URL-first input: placeholder "Enter your website URL", submit button "Continue with this website". The visitor gives a website before any account form.
- Header link "Start free" goes to `agent.enrichlabs.ai/marketing/register` and carries attribution parameters (landing source, visitor id, homepage experiment and variant), so they A/B test the hero and attribute signups to it.
- Secondary hook on the page: "Marketing tools, no signup needed" (free tools as a no-friction entry).
- **Nashr:** we already have URL-first brand import and free tools. Missing: the URL box in the marketing hero that carries the URL into signup, and signup attribution parameters saved on the user record.

## 1. Register (agent.enrichlabs.ai/marketing/register)
Source: read unstyled from the in-app browser (its scripts and images were blocked there), so layout is unknown; copy and fields are exact.
- **Copy:** logo "Helena". H1 "Meet Helena, your first self-improving AI marketer". Sub: "SEO, ads, social, and email – running while you sleep, reporting back every morning." One testimonial line with a name under it. Trust row "BUILT BY THE TEAM FROM" + six company logos. Footer: "Already have an account? Log in" and "By continuing, you agree to our Terms of Service and Privacy Policy."
- **Fields:** button "Continue with Google"; divider "or continue with"; one input "Work email" (placeholder name@company.com); button "Start Free". No name, no phone, no password on the first screen.
- **What the loaded script names reveal:** a password step with a live requirements list comes after the email; an app-language selector exists; tracking is Mixpanel + GA4 + Meta Pixel; affiliate attribution through Rewardful.
- **Nashr:** today we ask name, phone, email and password on one screen. Take: email-only first step, Google sign-in, one testimonial and a trust row beside the form, legal line under the button. Change: keep phone, but ask for it later (WhatsApp step in onboarding), not on the first screen.

## 2. Between register and first session (NOT captured)
The founder completed these steps himself (password, any email verification, website URL, any questions, any waiting screen). I only attached after login, so their copy and order are unknown. To fill in from the founder's memory or a second fresh signup.

## 3. First session: the onboarding IS a chat (agent.enrichlabs.ai/marketing)
There is no brand form. The account lands in the normal workspace, inside a conversation auto-named "Getting started", and Helena does the onboarding work in front of the user.
- **Sequence in the thread:**
  1. Helena: "Let me take a look at your site and start putting things together."
  2. Live status lines while she works: "Reading website content" (twice), "Checking the time", "Searching the web".
  3. Five workspace files, each rendered as a collapsible card (icon, file name, "File", "Saved", full Markdown body, buttons Collapse / Copy / Share): `business-profile.md` (executive summary, offerings, audiences, value proposition), `brand-guidelines.md` (colour palette with hex codes, fonts and font scale read from the site, tone of voice, messaging principles), `immediate-money-opportunities.md` (a table of grants, ad credits and tracking fixes with status "Needs verification" / "Verified actionable", localised to Saudi: Monsha'at is named), `market-research.md` (ecosystem, market dynamics, competitor positioning matrix), `strategy.md` (objectives and a recommended action plan).
  4. A plan card: "Here's your plan" / "Tap + to add a task to your scheduled tasks." with three concrete, quantified tasks (fix N lead-capture gaps, publish N SEO guides over 14 days, draft N LinkedIn posts), each with an "Add task" button, plus "Skip".
  5. Closing message summarising what was done ("analyzed your website, established your brand guidelines, conducted market research ... created 5 practical workspace strategy files") and a question: "what would you like to tackle first?"
- **Sticky activation bar above the composer:** a quantified promise ("Grow your organic traffic 35% in 90 days"), button "Activate Helena", and "First up: <first plan task>".
- **Header of the thread:** conversation title (click to rename), "SMS NEW" button, "Share".
- **Right panel on first login:** Metrics tiles locked behind "Connect now" (active users, sessions, Meta ad spend); Channels with "Add channel"; Task Feed with two scheduled tasks already created for the user ("Weekly Automation Suggestions", "Weekly Quick Win Insights") and "Manage all"; Brand Assets & Knowledge listing the new files plus a nudge "Upload your logo: improves brand accuracy in creatives".
- **Sidebar:** workspace name taken from the site, channels (# main, # content-inspo, # performance, # calendar), direct message to Helena with "+ New", chat history with search, Files, Earn credits, Governance (NEW), Integrations, Contact Us, account menu.
- **Why it works:** zero form fields after the URL; value (five real documents about the user's own business) arrives before any ask; the plan turns into scheduled tasks with one tap; the only paid ask ("Activate Helena") appears after the value, tied to a specific outcome and a named first task.
- **Nashr today:** `/app/onboarding` is a single long brand form (`BrandForm.tsx`). We already have the pieces Enrich uses (URL brand import, SSE status lines, workspace files, scheduled tasks, approvals, a "Hire Noor" block) but they are not chained into a first-run conversation.
- **Nashr target:** after signup ask only for the website (or Instagram handle or store link for businesses with no site), open a "البداية" conversation, and have Noor run the chain live: read the site, write the brand file plus 4 workspace files (business profile, brand guidelines, market and competitors, 30-day strategy; the "money opportunities" file becomes Gulf programs: Monsha'at, ad credits, Salla/Zid app perks, marked "needs verification"), then a 3-task plan with "add task" buttons, then the activation bar. Phone and WhatsApp are asked inside the chat after the files, not on the signup form. Onboarding generation is free (not charged to trial credits).

## 4. What Nashr shipped from this (2026-09-18)
- **Hero:** URL-first form on the marketing homepage; the URL travels to signup (`/app/signup?url=`) and from there straight into the first run.
- **Signup:** email first, then name and password with a live requirements list; trial terms and the legal line under the button. Phone removed from signup. Not copied: Google sign-in (needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and a sign-in route) and the testimonial (we have no real one yet, so none is shown).
- **One question:** `/app/start` asks only for the website (or Instagram, Salla or Zid link); the manual brand form stays as a fallback link.
- **First run inside the thread:** `/app/chat?onboard=<url>` opens "Getting started"; `POST /api/onboard` streams status lines and persists every message. Noor writes five files (`brand.md`, `brand-guidelines.md` with colours and fonts detected by the crawler, `opportunities.md`, `market-research.md`, `strategy.md`), shown as collapsible file cards with copy.
- **Plan card:** three quantified starter tasks with "add task" and "start now" (start sends the task to Noor in the same thread); state kept in `onboardplan:{scope}` via `/api/onboard/plan`.
- **Activation bar** for trial accounts: an output goal (items shipped, never a results promise like Enrich's traffic claim), the first task, and "Activate Noor" linking to billing.
- **WhatsApp card** after the plan: optional phone, saved through `/api/profile`.
- Onboarding stays free: no credits charged. A per-workspace lock stops a reload from starting a second run.
- **Still unknown:** Enrich's screens between register and first session (section 2).
