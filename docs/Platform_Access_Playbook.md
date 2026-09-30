# Nashr — Platform Access Playbook

How to get Nashr (Noor) connected to every platform. Each entry: what Noor will do, where you register, what to fill, what to send me, expected wait. Ordered by **impact for Gulf customers ÷ time to get**.

Rules that apply everywhere:
- Register everything under the **company** (CR name), not your personal name. Use a company mailbox you control (e.g. hello@ on your domain).
- Redirect/callback URL for every OAuth app: `https://nashr-tau.vercel.app/api/connect/<platform>/callback` (I'll change the host when we buy the domain; use the domain if you buy it first).
- Privacy policy + terms URLs are required by almost everyone. I'll publish `/ar/privacy` and `/ar/terms` so you have something to paste.
- **Never send me secrets in chat.** Put them in Vercel with `vercel env add NAME production` in your Terminal tab, then tell me the variable names exist.
- URLs below are the official entry points as of Sep 2026; if one has moved, search the platform name + "developer portal".

---

## Tier 1 — do this week (fast, high impact)

### 1. Shopify (Partners) — days
**Noor will:** read products, orders, abandoned checkouts; publish blog articles; recover carts.
1. https://partners.shopify.com → Create partner account (company name, email).
2. Partners dashboard → **Apps → Create app → Create app manually**. Name: `Nashr`. App URL: `https://nashr-tau.vercel.app/ar/app/integrations`. Redirect URL: `https://nashr-tau.vercel.app/api/connect/shopify/callback`.
3. Under **API access scopes** request: `read_products, read_orders, read_checkouts, write_content, read_customers`.
4. Copy **Client ID** and **Client secret**.
**Send me:** confirm `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are in Vercel env. Also create a free **development store** in the partner dashboard so we can test.
**Wait:** none for custom install. Public App Store listing later (2–3 weeks review).

### 2. X (Twitter) — 1–3 days
**Noor will:** publish posts and threads, read mentions.
1. https://developer.x.com → Sign up with the company X account (create `@nashr_ai` first).
2. Choose **Basic** tier (~$100/month) — Free tier can't post at volume. Use case: "Marketing automation for SMEs in Saudi Arabia; posts are created by the account owner and published on their behalf after approval."
3. Developer Portal → Project → App → **User authentication settings**: Type = Web App, Callback = `https://nashr-tau.vercel.app/api/connect/x/callback`, Website = `https://nashr-tau.vercel.app`. Scopes: `tweet.read tweet.write users.read offline.access`.
**Send me:** `X_CLIENT_ID`, `X_CLIENT_SECRET` in Vercel env.

### 3. Google (one project unlocks GBP + GA4 + Search Console + YouTube + Google Ads read)
**Noor will:** publish Google Business Profile posts, read GA4 traffic and Search Console keywords, later YouTube Shorts upload and Google Ads read.
1. https://console.cloud.google.com → New project `Nashr`.
2. **APIs & Services → Enable APIs**: `Google Analytics Data API`, `Google Search Console API`, `My Business Business Information API`, `My Business Account Management API`, `YouTube Data API v3`.
3. **OAuth consent screen** → External → App name `Nashr`, support email, logo, privacy `https://nashr-tau.vercel.app/ar/privacy`, terms `/ar/terms`. Scopes: `analytics.readonly`, `webmasters.readonly`, `business.manage`, `youtube.upload`.
4. **Credentials → Create OAuth client ID** → Web application. Redirect: `https://nashr-tau.vercel.app/api/connect/google/callback`.
5. Submit consent screen for **verification** (required for `business.manage` and `youtube.upload`; 1–2 weeks). Until verified we test with up to 100 "test users".
6. GBP API needs a separate **access request form** (Google "Business Profile APIs" prerequisites: verified business, then request quota). Do it from the same project.
**Send me:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` in Vercel env.
**3b. Google Ads developer token:** https://ads.google.com → Tools → API Center → apply for developer token (Basic access; 1–2 weeks). Needs a Manager (MCC) account. Optional until we do ad optimization.

### 4. Meta (one Business + one app unlocks WhatsApp + Instagram + Facebook + Meta Ads) — start now, longest wait
**Noor will:** send WhatsApp briefs/campaigns/cart recovery; publish IG/FB posts; read and (later) adjust Meta Ads.
1. https://business.facebook.com → create **Business Portfolio** `Nashr`. Security Center → **Start verification**: upload CR (السجل التجاري), company phone, website. 2–10 business days. This is the long pole — do it first.
2. https://developers.facebook.com → My Apps → **Create app** → type **Business**. Name `Nashr`. Attach to the Business Portfolio.
3. Add products: **WhatsApp**, **Instagram Graph API**, **Facebook Login for Business**, **Marketing API**.
4. App settings → Basic: privacy URL, terms URL, app icon, category "Business and Pages". Add domain `nashr-tau.vercel.app`. Facebook Login → Valid OAuth redirects: `https://nashr-tau.vercel.app/api/connect/meta/callback` and `https://nashr-tau.vercel.app/api/connect/meta_ads/callback` (the ads-results connection is separate, so its `ads_read` review never blocks Page publishing).
5. **App Review** → request: `whatsapp_business_messaging`, `whatsapp_business_management`, `instagram_basic`, `instagram_content_publish`, `pages_manage_posts`, `pages_read_engagement`, `ads_read`, `ads_management`, `business_management`. Each needs a screencast showing the feature in Nashr — I'll record those once the login flow is built. 1–4 weeks.
6. WhatsApp: in the app's WhatsApp → Getting started, add a **new phone number** for the business (not your personal WhatsApp), verify it, set display name `Nashr`. Each customer later connects their own number via Embedded Signup (that's why we need `whatsapp_business_management`).
**Send me:** `META_APP_ID`, `META_APP_SECRET` in Vercel env, and the Business Portfolio ID.
**Note:** Nashr needs Meta **Tech Provider** status to onboard customers' WhatsApp numbers. Apply under App Dashboard → WhatsApp → Tech Provider once verification passes.

### 5. Salla (Partners) — 1–3 weeks
**Noor will:** read products/orders/abandoned carts, publish blog posts, get webhooks for new orders and abandoned carts, and be **listed in the Salla App Store** (main distribution channel).
1. https://salla.partners → Register as partner (company, CR, contact).
2. Dashboard → **My Apps → Create app**. Type: **Public app** (needed for App Store). Name `نشر - Nashr`. Category: Marketing.
3. OAuth: Redirect URL `https://nashr-tau.vercel.app/api/connect/salla/callback`. Scopes: `offline_access, products.read, orders.read, customers.read, abandoned_carts.read, blogs.read_write, webhooks.read_write, settings.read`.
4. Webhooks: I'll register `order.created`, `abandoned.cart`, `product.updated` programmatically; you just enable webhooks in the app.
5. Publish → Salla reviews the app (install + uninstall + data handling). 1–3 weeks. Before publishing we test on the **demo store** partners get.
**Send me:** `SALLA_CLIENT_ID`, `SALLA_CLIENT_SECRET`, `SALLA_WEBHOOK_SECRET` in Vercel env.

### 6. Zid (Partners) — 1–3 weeks
**Noor will:** same as Salla; Zid App Market listing.
1. https://partners.zid.sa → Apply as a partner (company details, CR). Approval email.
2. Partner dashboard → **Apps → Create app**. Redirect: `https://nashr-tau.vercel.app/api/connect/zid/callback`. Scopes: products, orders, customers, abandoned carts, webhooks.
3. Test on Zid's demo store, then submit for App Market review.
**Send me:** `ZID_CLIENT_ID`, `ZID_CLIENT_SECRET` in Vercel env.

### 7. Payments — Moyasar or Tap (pick one) — 3–10 days
**Noor will:** nothing; this is Nashr's own subscription checkout (mada, Apple Pay, cards, STC Pay).
- **Moyasar:** https://moyasar.com → Sign up → upload CR, IBAN letter, ID → approval → Dashboard → API keys. **Send me:** `MOYASAR_SECRET_KEY`, `MOYASAR_PUBLISHABLE_KEY`.
- **Tap:** https://www.tap.company → Sign up → same docs → dashboard → API keys. **Send me:** `TAP_SECRET_KEY`, `TAP_PUBLIC_KEY`.
Until approved: create manual payment links in either dashboard (299 / 499 / 999 SAR since 2026-09-30) and set `PAY_LINK_STARTER/PRO/BUSINESS`. Agency has no pay link: it is sold by contract, and `PAY_LINK_AGENCY` is no longer read.

---

## Tier 2 — next 2–4 weeks

### 8. Snapchat (Marketing API + Public Profile posting)
**Noor will:** read ad performance, adjust budgets within guardrails, later post to Public Profile stories.
1. https://business.snapchat.com → create **Business account** `Nashr` + an Ad Account (needed even for read).
2. https://developers.snap.com → Business dashboard → **Business Details → OAuth Apps → Create**. Name `Nashr`. Redirect `https://nashr-tau.vercel.app/api/connect/snapchat/callback`. Scopes: `snapchat-marketing-api`, `snapchat-profile-api`.
3. Marketing API access requires approval — describe: "agency-style tool managing Snap campaigns for Saudi SMEs; budget changes only within owner-set caps." 2–8 weeks.
**Send me:** `SNAP_CLIENT_ID`, `SNAP_CLIENT_SECRET`.

### 9. TikTok (Content Posting + Marketing API)
**Noor will:** post videos/slideshows to the brand's TikTok; read/adjust TikTok Ads.
1. https://developers.tiktok.com → Register as developer (company). Create app `Nashr`.
2. Add products: **Login Kit**, **Content Posting API** (request `video.publish`, `video.upload`). Redirect `https://nashr-tau.vercel.app/api/connect/tiktok/callback`. Verify domain (they give a TXT/HTML file — send it to me, I'll host it).
3. Submit for review with demo video. Unaudited apps can only post **private** videos — audit takes 1–4 weeks.
4. Ads: https://business-api.tiktok.com/portal → create developer app under TikTok for Business, request `Ads Management` + `Reporting`. Redirect `/api/connect/tiktok-ads/callback`.
**Send me:** `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_ADS_APP_ID`, `TIKTOK_ADS_SECRET`.

### 10. LinkedIn (Company Page posting)
**Noor will:** publish posts to the customer's Company Page and personal profile (startups, law firms, agencies).
1. Create a LinkedIn **Page** for Nashr first (required to create an app).
2. https://www.linkedin.com/developers → Create app → link to the Nashr Page → verify (Page admin clicks verify link).
3. Products → request **Share on LinkedIn** (`w_member_social`) and **Community Management API** (`w_organization_social`, `r_organization_social`) — the latter needs a short access request. Redirect `https://nashr-tau.vercel.app/api/connect/linkedin/callback`.
**Send me:** `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`.

### 11. WordPress (+ WooCommerce) — no approval
**Noor will:** publish SEO articles directly; read WooCommerce products.
- **Self-hosted WordPress:** nothing to register. Each customer creates an **Application Password** (Users → Profile → Application Passwords) and pastes site URL + username + app password in Nashr. I build the connector; you send nothing.
- **WordPress.com:** https://developer.wordpress.com/apps → Create app, redirect `/api/connect/wpcom/callback`. **Send me:** `WPCOM_CLIENT_ID`, `WPCOM_CLIENT_SECRET`.
- **WooCommerce:** customer generates REST keys (WooCommerce → Settings → Advanced → REST API). No registration by you.

### 12. YouTube — covered by the Google project (scope `youtube.upload`), verification required.

### 13. Pinterest — 1–2 weeks
https://developers.pinterest.com → Create app → request **Standard access** (needs a live app + video). Redirect `/api/connect/pinterest/callback`. Scopes `pins:write, boards:read`. **Send me:** `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`. Low priority for Gulf.

### 14. Threads — via the Meta app (add product **Threads API**, permission `threads_content_publish`). Same App Review batch as #4.

### 15. Email marketing
- **Mailchimp:** https://mailchimp.com/developer → Register app, redirect `/api/connect/mailchimp/callback`. **Send me:** `MAILCHIMP_CLIENT_ID`, `MAILCHIMP_CLIENT_SECRET`.
- **Klaviyo / Brevo / beehiiv:** each customer pastes a private API key. Nothing to send.

### 16. SMS — Unifonic (KSA)
https://www.unifonic.com → business account (CR, sender ID registration with CST — 1–2 weeks). **Send me:** `UNIFONIC_APP_SID`, `UNIFONIC_SENDER_ID`. Fallback channel until WhatsApp is approved.

---

## Tier 3 — later / per-customer keys (no registration by you)
Work by the **customer** pasting their own API key, or via an OAuth app we register when a customer asks:
HubSpot, Zoho CRM, Salesforce, Notion, Airtable, Google Sheets/Drive/Calendar/Gmail (add scopes to the Google project), Slack, Discord, Microsoft 365/Teams/Outlook/OneDrive (Azure app registration: https://portal.azure.com → App registrations → redirect `/api/connect/microsoft/callback` → send `MS_CLIENT_ID`, `MS_CLIENT_SECRET`), Stripe (not needed in KSA), Semrush/Ahrefs (customer key), Amazon Ads, Bing Ads/Webmaster, Reddit, Bluesky, Substack, Ghost, Webflow, Framer, Strapi, Kajabi, Calendly, Trello, Asana, ClickUp, Linear, Jira, GitHub, Figma, ElevenLabs, Perplexity, Firecrawl, Tavily, Exa, SerpApi, PostHog, Mixpanel, Metabase, Supabase, Neon, MongoDB, Cloudflare R2, Custom MCP.

All listed as "planned" in the app; the ones with real votes ("I want this") get built first.

---

## What I do on my side (no waiting on you)
- Publish `/privacy` and `/terms` pages (needed for every form above).
- Build the generic OAuth connector framework: `/api/connect/<platform>/start` + `/callback`, encrypted token storage per user, "Connected" badges on the Integrations page.
- Build WordPress self-hosted + WooCommerce connectors now (no approvals needed).
- Record App Review screencasts for Meta/TikTok/Snap once their login flows exist.

## Checklist to send me (one line each when done)
```
SHOPIFY   client id+secret in Vercel ✔ / dev store URL
X         client id+secret ✔
GOOGLE    client id+secret ✔ / consent screen submitted
META      app id+secret ✔ / business verification status / portfolio id
SALLA     client id+secret+webhook secret ✔ / demo store
ZID       client id+secret ✔
PAYMENTS  moyasar or tap keys ✔  (or PAY_LINK_STARTER/PRO/BUSINESS set)
SNAP      client id+secret ✔ / marketing API approval status
TIKTOK    client key+secret ✔ / domain verification file sent
LINKEDIN  client id+secret ✔
WPCOM     client id+secret ✔ (optional)
UNIFONIC  app sid + sender id ✔ (optional)
```
