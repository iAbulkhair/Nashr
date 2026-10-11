# Privacy Policy — Thakeen (ذكين)

> **DRAFT FOR LEGAL REVIEW ONLY. NOT IN FORCE. DO NOT PUBLISH.**
> Written by Claude (a coding assistant, not a lawyer) on 2026-10-11 from the code and documents in the repository, for review by a licensed Saudi lawyer before anything is published.
> - Text in square brackets `[...]` is missing information the founder fills in (company papers are pending). It must never be invented.
> - Notes marked **[Lawyer: ...]** are questions or points that need legal advice. Remove them before publishing.
> - Intended legal references: the Personal Data Protection Law (PDPL) and its Implementing Regulations, the Regulation on Personal Data Transfer outside the Kingdom (issued by SDAIA), and the E-Commerce Law and its regulations. Article numbers are deliberately left out; **[Lawyer: add article references if you see fit]**.
> - The Arabic version (`2026-10-privacy-policy-draft_AR.md`) is the primary text. This English version is a translation for review.
> - Gaps between this text and what the product does today are listed in `docs/legal/2026-10-gap-list.md`. **Do not publish this policy until the gaps marked "before publishing" there are closed.** Otherwise the policy promises things the product does not do.

**Version:** [Draft 0.1] · **Effective date:** [set on publishing] · **Last updated:** [set on publishing]

---

## 1. Who we are (the controller)

Thakeen («ذكين») is a platform that gives small and medium businesses in Saudi Arabia and the Gulf a team of AI marketing agents. It runs on thakeen.com and the web app attached to it.

The controller of your personal data:

| Item | Value |
|---|---|
| Registered legal name | [Company name] |
| Commercial Registration number | [CR number] |
| National address | [Address] |
| VAT number | [VAT number — if any] |
| Email for privacy requests | hello@thakeen.com |
| Data protection officer | [Name and contact — if appointed] |

**[Lawyer: given the nature and size of the business, must Thakeen appoint a data protection officer or register on the National Data Governance Platform?]**

## 2. Scope and our role

This policy covers:
- visitors to thakeen.com and users of its free tools;
- account holders (customers) and the team members they invite;
- partner programme applicants and approved partners;
- anyone who contacts us through the support form, email or WhatsApp.

**We have two roles:**
- We are the **controller** of account, billing, support and partner programme data, and of technical operating data.
- A customer may enter, or bring in from their platforms, personal data about **other people**. Examples: names of meeting attendees from Cal.com or Calendly, the text of public posts and comments, or search queries from Google Search Console. We process that data **on the customer's behalf and on their instructions**. The customer is responsible for having a lawful basis to collect it and share it with us.

**[Lawyer: is this description enough, or do we need a separate Data Processing Agreement attached to the Terms that sets out Thakeen's duties as a processor?]**

## 3. Data we collect

### 3.1 Account and team data
- Name, email address, mobile number (optional) and interface language.
- Password: never stored as text. We store a bcrypt hash of it.
- The email verification code at signup, and the password reset link (valid for one hour).
- Plan, credits, balance, account start date and trial end date.
- Team members: email, name, role and invitations sent, plus a record of who changed which settings and when.

### 3.2 Brand data and content
- Your website address, and the public text we read from its pages during setup.
- Your products and catalogue, audience, brand tone, offers and banned words.
- Workspace files: text notes written by the agents or by you.
- Your chat messages to the agents, the content they generate, and what you approve or reject, with any reasons you type.
- The agents' decision records, your to-dos and meetings with Reem, and the activity log.
- Campaign result files you upload yourself.

### 3.3 Data from platforms you connect
When you connect a store or an account (such as Salla, Zid, WooCommerce, WordPress, Telegram, Meta, X, LinkedIn, TikTok, Google and others offered on the Integrations page):
- We store access tokens or connection keys **encrypted** (AES-256-GCM). When the connection runs through Composio, Composio holds them.
- We read only what the permissions you approved allow, and keep only what the service needs:
  - **Stores:** order counts, revenue, best-selling product names, and the number and value of abandoned carts. We do **not** store your store customers' names, phone numbers, emails or addresses.
  - **Analytics:** Google Analytics and Google Search Console totals, including the public's search queries and your site's pages.
  - **Social and ad accounts:** post results (including the post text), ad account totals and top ads by name.
  - **Booking links (Cal.com, Calendly):** the attendee's name, the event name and its time only. We do **not** read their email, phone or what they typed when booking.

### 3.4 Generated images and video
- The image description built from your post and brand, the post's current image when needed, and the resulting image or video.

### 3.5 Subscription and payment data
- Records of payments, plans, top-up packs and refunds.
- When online payment (Paymob) is switched on, you enter card details at Paymob directly, and card numbers never reach us. If you choose to save your card for the monthly renewal, we keep a **token** issued by Paymob, the last 4 digits and the card type.
- Tax invoice data: [to be completed after VAT registration and e-invoicing].

### 3.6 Partner programme
- Partner link: a first-party cookie `nashr_partner` for 30 days that holds only the partner's code and the time of the click.
- For a referred customer: which partner referred you and when, and your payments, to work out the commission. The partner sees a pseudonymous label instead of your name and email.
- For a partner: what they enter in the application form; when they accepted the programme terms and which version; the bank account holder's name and IBAN; country of residence; and tax number if entered.

### 3.7 Support and contact
- What you type into the support form, contact form or waitlist: name, company, email or mobile, and the message.
- WhatsApp or email conversations with us.

### 3.8 Technical data
- **IP address:** used for usage limits and abuse prevention (for example, the number of signup attempts) and kept in short-lived counters.
- **Bot check:** when Cloudflare Turnstile is switched on for the signup and password reset pages, your browser loads Cloudflare's widget and sends it technical browser data.
- **Usage statistics:** internal counters in our own database, such as how often you generate or approve, and when the account was last active. **We use no third-party analytics or advertising tools on the site or in the app.**
- **Server logs:** technical error logs held by our hosting provider.

### 3.9 Free tools on the website
What you type into the free tools (no account needed) is sent to the AI provider to produce the answer. We use your IP address to cap daily use.

## 4. Why we process your data, and on what basis

| Purpose | Data | Proposed legal basis **[Lawyer: confirm the basis for each purpose]** |
|---|---|---|
| Creating the account, signing in, managing the team | Account and team | Performing the contract you asked for (the Terms) |
| Running the agents: content, plans, messages, images, video | Brand, content, chat | Performing the contract |
| Publishing to platforms you connected and reading their results | Platform data | Performing the contract, on your request, and your consent to each platform's permissions |
| Billing, credits, refunds and tax invoices | Subscription and payment | Performing the contract, and legal obligation (tax and commercial laws) |
| Service messages (email verification, password reset, team invites, Reem's reminders, the daily brief) | Email, name | Performing the contract |
| Awareness messages, trial reminders and offers | Email | [Consent or legitimate interest — Lawyer] |
| Partner programme: working out and paying commission | Partner data | Performing the partner contract, and legal obligation (tax) |
| The `nashr_partner` cookie, to know who referred you | Partner code, click time | [Legitimate interest or consent — Lawyer] |
| Security, abuse and fraud prevention | IP, browser data, logs | Legitimate interest |
| Improving the service with aggregated internal statistics | Usage counters | Legitimate interest |
| Improving the agents for everyone: we use counts of anonymous feedback categories across accounts (never your content, never fewer than 5 workspaces), only for accounts with learning on | Feedback categories and counts, no text | [Legitimate interest or consent — Lawyer] |
| Answering support and requests | Contact data | Performing the contract, or steps you asked for before a contract |
| Complying with requests from competent authorities | What the law requires | Legal obligation |

We do not sell your personal data, and we do not use it for targeted advertising.

## 5. Artificial intelligence

- **Thakeen does not train any model on your data or content.** Your edits are kept as preferences for your account only.
- To run the agents we send the text provider (Anthropic) what each request needs: your message, your brand file, the text read from your website, and totals from your connected platforms.
- To generate images and video we send the image description and the post's current image to the media provider chosen for that model (fal.ai, kie.ai or Higgsfield).
  - **Note:** under their published terms at the time of this draft, Higgsfield's terms allow it to use inputs and outputs to improve its models, and kie.ai's terms allow it to use content to operate and improve its service. **[Founder: re-check both before publishing. Lawyer: is disclosure enough, or do we need explicit consent before using these two providers?]**
- Images and videos made by the team are AI-generated.
- **Nothing is published without your approval.** Governance settings can auto-approve items at your request, but they never publish them. We make no AI decisions that have a legal effect on you.

## 6. Who we share data with

### 6.1 Service providers that process data for us
The full, current list is in Annex A. Our contracts with them limit their processing to providing the service to us. **[Founder: get and file a Data Processing Agreement (DPA) from each provider.]**

### 6.2 Platforms you connect
When you ask us to publish to, or read from, a platform you connected, we send it the content involved. These platforms are not our providers. You deal with them directly, under their own terms and privacy policies.

### 6.3 AI apps you authorise
If you connect your account to an outside AI app through the MCP protocol and authorise it, that app can reach your account's data to the extent you allowed. You can withdraw that permission at any time. The owner's password change also revokes it automatically.

### 6.4 Partners
The partner who referred you sees a pseudonymous label, your signup date, your status and the payment amounts their commission is based on. They never see your name, email or phone.

### 6.5 The Thakeen team
The founder [and any employee authorised later] can reach account data as far as support, billing and security need. They may sign in as you to fix a technical problem; such access is logged. **[Lawyer: must we notify the customer, or ask permission, before each such access?]**

### 6.6 Government authorities
We disclose data when the law requires it, or a competent authority requests it.

### 6.7 Business transfer
[Lawyer: wording for data transfer in a merger, acquisition or sale of the business.]

## 7. Transfer outside the Kingdom

**Thakeen's data is not currently hosted inside the Kingdom.** The service is built on international providers, and most of them probably process data outside the Kingdom. Nothing in our repository documents the processing location of any provider, or the server region of the database or the hosting. **[Founder: confirm each provider's region from its dashboard or its DPA, and fill in the column in Annex A.]**

When we transfer data:
- We send the minimum each purpose needs. For example, your store customers' names and phone numbers never leave the store platform at all.
- We rely on [the legal basis for transfer: an adequacy decision, SDAIA's standard contractual clauses, necessity for performing the contract with you, or your consent — **Lawyer**].
- [We carry out and document a transfer risk assessment where the regulation requires one — **Lawyer: does it apply to us?**]
- Every connection to a provider is encrypted in transit (HTTPS).

## 8. How long we keep data

| Data | Retention |
|---|---|
| Account, brands, files, content, chats and connection tokens | While the account exists. Deleted immediately when the account is deleted |
| Generated images and video | [**Changing — Founder:** today our copy stays on our media storage (Vercel Blob) at public, unguessable addresses, some images stay at fal.ai, and deleting the account does not remove them. The approved design (PR #320) makes it 30 days for every file on Hostinger, with a warning before deletion. Write the final period when it ships] |
| Render records with media providers | Deleted automatically within 14 days on our side; at kie.ai and Higgsfield within 1 to 14 days, depending on the provider |
| Password reset link | One hour |
| Sign-in session (`nashr_session` cookie) | 30 days, or until sign-out or a password change |
| Partner cookie `nashr_partner` | 30 days |
| Usage limit counters (including IP address) | Minutes to one day, depending on the counter |
| Payment records and invoices | [The statutory period for tax and commercial records — Lawyer and accountant], even after the account is deleted |
| Partner bank and tax details | Until the account is deleted; payout records for [the statutory period] |
| Support tickets and contact requests | [Period — Founder; today the newest 2,000 tickets are kept with no set period] |
| Server error logs | [The hosting provider's period — Founder] |
| Trial accounts that were never activated | [Period — Founder and Lawyer] |

When a purpose ends, we delete the data or make it impossible to identify the person, unless a law requires us to keep it.

## 9. Security

Controls in place today:
- Connection tokens and platform keys are encrypted (AES-256-GCM).
- Passwords are hashed (bcrypt).
- HTTPS and HSTS on the site.
- Each customer's data is isolated from every other customer's on every read and write.
- Role-based permissions inside a team.
- Usage limits on public routes.
- Email verification at signup.

We do not claim any security certification. No system is completely secure, and we keep improving our controls. **[Founder: do not add a certification or standard before actually obtaining it.]**

## 10. Your rights

Under the PDPL you have the right to:
1. **Be informed** of how and why we collect your data, and on what basis (this policy).
2. **Access** the data we hold about you.
3. **Obtain a copy** of your data in a readable, clear format.
4. **Correct** your data, or complete or update it. You can edit most account and brand data yourself in the app.
5. **Destruction (deletion)** of your data once it is no longer needed. An account owner can delete the account from "Your profile". The account, team, brands, files, content, chats and connection tokens are then deleted immediately. What the law requires us to keep (such as payment records) remains.
6. **Withdraw consent** where consent is the basis for processing, without affecting processing before the withdrawal. You can also disconnect any connected platform at any time from the Integrations page, and its tokens are deleted immediately.
7. **Complain** to the Saudi Data and AI Authority (SDAIA).

**How to exercise your rights:**
- Write to **hello@thakeen.com** from the email address registered on your account.
- We may ask for proof of identity before acting.
- We reply within [30 days — Lawyer: confirm the deadline and when it can be extended], free of charge.
- A team member (not the account owner) can ask the account owner, or us directly, to delete their data.

## 11. Children

The service is for businesses, not for children. Users must be at least 18 and authorised to act for their business. We do not knowingly collect data from anyone younger; if we learn of it, we delete it. **[Lawyer: is 18 the right threshold? Do we need an explicit age confirmation at signup?]**

## 12. Cookies and local storage

We use only our own first-party cookies. We use no third-party advertising or analytics cookies.

| Name | Purpose | Duration |
|---|---|---|
| `nashr_session` | Keeps you signed in (not readable by scripts) | 30 days |
| `nashr_lang` | Remembers the interface language | One year |
| `nashr_oauth` | Protects the step that connects an outside platform from forgery | 10 minutes |
| `nashr_partner` | Knows which partner referred you | 30 days |
| `nashr_admin`, `nashr_impersonate`, `nashr_return` | Founder console sessions only; never set for customers | Founder's session |
| `nashr_invite_token` (local storage) | Completes acceptance of a team invite | Until accepted |
| `nashr_install_hint_dismissed` (local storage) | Remembers that you closed the app install hint | Until the browser is cleared |
| Cloudflare Turnstile cookies | Checks you are not a bot, on the signup and password reset pages only, when switched on | Per Cloudflare |

**[Lawyer: does the `nashr_partner` cookie, which serves referral attribution rather than running the service, need prior consent or a notice banner?]**

## 13. Marketing messages

We send the service messages your account needs. Any awareness or promotional message carries a clear way to stop it, and we stop as soon as you ask. **[Lawyer: what consent rules apply to marketing by email and WhatsApp? — Founder: there is no unsubscribe link in the code yet; see the gap list.]**

## 14. Data breaches

If personal data is leaked or reached without authorisation:
- We contain it and investigate at once.
- We notify SDAIA within [72 hours of becoming aware — Lawyer: confirm the deadline] where the law requires it.
- We notify you without undue delay if the breach could harm you, and explain what happened, what we did and what you can do.

## 15. Changes to this policy

We may update this policy. Every change is posted on this page with its version date. We notify you of a material change by email or in the app [number] days before it takes effect, and we ask for your consent again where consent is the basis for processing.

## 16. Contact

- Email: **hello@thakeen.com**
- Address: [Address]
- Complaints: you can also complain to the Saudi Data and AI Authority (SDAIA).

---

## Annex A: Service providers (sub-processors)

Source: the code and documents in the repository on 2026-10-11 (`docs/system/architecture.md` section 2.7, `docs/system/variables.md`, `src/lib/*`).

- "Active?" means what the code and documents show. **The founder confirms** the live site's settings before publishing.
- The "Processing location" column is left empty on purpose: **nothing in the repository proves it**.

| Provider | Purpose | Data sent | Active? | Processing location |
|---|---|---|---|---|
| Anthropic | Text models for every agent and the free tools | Messages, brand file, text read from your website, platform totals | Yes | [To confirm] |
| Straitly (model gateway) | Routes model calls through an intermediate gateway | The same data sent to Anthropic | No, unless `LLM_PROVIDER=straitly` is set | [To confirm] |
| Upstash (Redis) | Main database for all account data | Everything in sections 3.1 to 3.8 | Yes | [Database region — to confirm] |
| Upstash (QStash) | Schedules Reem's reminders every 15 minutes | No personal data in the call itself | Yes | [To confirm] |
| Hostinger | Hosts the site, the app and server logs; media storage in future | Everything that passes through the server | Yes (thakeen.com) | [Data centre — to confirm] |
| Vercel (including Vercel Blob) | Stores copies of generated images and video today; the old hosting at nashr-tau.vercel.app | Images and video | Yes today; to be retired (PRs #319 and #320) | [To confirm] |
| Resend | Sends email | Email address, name, message text and links | Yes | [To confirm] |
| fal.ai | Image generation (the default model) | Image description | Yes | [To confirm] |
| kie.ai | Image and video generation (optional models) | Image description and the post's image | Per the allowed model list | [To confirm] |
| Higgsfield | Image and video generation (optional models) | Image description and the post's image | Per the allowed model list | [To confirm] |
| Composio | Connection and publishing intermediary for social, ad and analytics accounts; holds access tokens | Connection tokens, published content, results read | Built in code; inactive until configured | [To confirm] |
| Paymob | Online payment, and the saved card for renewals | Card details (entered at Paymob), amount, email | Built in code; gated off until switched on | [To confirm] |
| Cloudflare Turnstile | Bot check at signup and password reset | Technical browser data and IP address | Built; not active on the live site per the 2026-10-11 review | [To confirm] |
| [Mailbox provider for hello@thakeen.com] | Receives privacy and support requests | What you write in your message | [To confirm] | [To confirm] |
| [WhatsApp — support number] | Support | Your number and messages | Yes | [To confirm] |

**Not our providers, but platforms the customer connects or sends from:** Salla, Zid, Shopify, WooCommerce, WordPress, Telegram, Meta (Facebook, Instagram, Meta Ads), X, LinkedIn, TikTok, Snapchat, Google (Analytics, Search Console, Business Profile, YouTube, Calendar), Microsoft Outlook (Calendar), Klaviyo, Brevo, Odoo, PrestaShop, Cal.com, Calendly.

**We do not use:** third-party analytics tools or advertising pixels. Fonts are served from our own server, not from Google.
