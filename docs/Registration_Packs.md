# Platform registration packs — copy, paste, submit

> **Dated record (banner added 2026-10-12).** Written when the site ran on Vercel at `nashr-tau.vercel.app`. Since 2026-10-08 thakeen.com runs on Hostinger from the `production` branch, and the Vercel project is retired (`docs/system/architecture.md` section 6, rules 987-990). Read hosts, callback URLs and "Vercel" steps below as history; whether each platform app already has its `thakeen.com` callback is unverified here. Current state: `docs/system/*`.

## Current values (2026-10-18, rule 2164)

Use this section, not the dated packs below, for hosts, callbacks and key names. It is read from
`src/lib/connectors/registry.ts` and `src/lib/google-signin.ts`; `tests/registration-packs-current.test.ts` fails when
a platform or a key name changes and this table does not.

- App name: `Thakeen` (Arabic, where asked: `ذكين`). Website `https://thakeen.com`. Privacy `https://thakeen.com/ar/privacy`
  (English `/en/privacy`). Terms `https://thakeen.com/ar/terms` (English `/en/terms`).
- Keys go straight from the portal into hPanel (Websites, thakeen.com, Node.js app, Environment variables), never into
  chat or a file. Adding a name to the live site rebuilds it; tell Claude first. The `vercel env add` steps below are history.
- Staging gets the same callback on `https://staging.thakeen.com` once its own app or redirect is added.

| Platform | Callback (redirect) URL | Key names | Scopes the code asks for |
|---|---|---|---|
| X | `https://thakeen.com/api/connect/x/callback` | `X_CLIENT_ID`, `X_CLIENT_SECRET` | `tweet.read tweet.write users.read offline.access` |
| Shopify | `https://thakeen.com/api/connect/shopify/callback` | `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | `read_products read_orders read_checkouts write_content read_customers` |
| Meta (Pages, Instagram) | `https://thakeen.com/api/connect/meta/callback` | `META_APP_ID`, `META_APP_SECRET` (optional `META_CONFIG_ID`) | `pages_show_list pages_manage_posts pages_read_engagement instagram_basic instagram_content_publish business_management` |
| Meta Ads (results), same Meta app | `https://thakeen.com/api/connect/meta_ads/callback` | `META_APP_ID`, `META_APP_SECRET` | `ads_read` |
| Salla | `https://thakeen.com/api/connect/salla/callback` | `SALLA_CLIENT_ID`, `SALLA_CLIENT_SECRET` | `offline_access` |
| Zid | `https://thakeen.com/api/connect/zid/callback` | `ZID_CLIENT_ID`, `ZID_CLIENT_SECRET` | none in the URL |
| LinkedIn | `https://thakeen.com/api/connect/linkedin/callback` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | `openid profile w_member_social` |
| TikTok | `https://thakeen.com/api/connect/tiktok/callback` | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | `user.info.basic video.publish video.upload` |
| Snapchat Ads | `https://thakeen.com/api/connect/snapchat/callback` | `SNAP_CLIENT_ID`, `SNAP_CLIENT_SECRET` | `snapchat-marketing-api` |
| Google (Business Profile, GA4, Search Console) | `https://thakeen.com/api/connect/google/callback` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `business.manage analytics.readonly webmasters.readonly openid email` |
| Google Calendar (Reem), same Google client | `https://thakeen.com/api/connect/gcal/callback` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `openid email calendar.calendarlist.readonly calendar.events.owned.readonly` |
| Outlook Calendar (Reem) | `https://thakeen.com/api/connect/mscal/callback` | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | `openid email offline_access User.Read Calendars.ReadBasic` |
| Sign in with Google, its own client | `https://thakeen.com/api/auth/google/callback` | `GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET` | `openid email profile` |

Names in the dated packs and in `docs/Platform_Access_Playbook.md` that the code does not read: `MS_CLIENT_ID` and
`MS_CLIENT_SECRET` (the code reads `MICROSOFT_CLIENT_*`), `TIKTOK_ADS_APP_ID` and `TIKTOK_ADS_SECRET` (TikTok Ads results
come through Composio, no app of ours). WhatsApp, YouTube, Google Ads, TikTok Ads, LinkedIn Ads, Google Docs and Sheets,
Google Drive, Dropbox and OneDrive need no app of ours: they connect through Composio (checklist job `composio`).

Written 2026-09-27 for the owner. One section per platform: which steps come first, what to type into each field,
and where the keys go. Everything here is registered on the temporary address `https://nashr-tau.vercel.app` (owner
decision, 2026-09-27); after `nashr.ai` is bought, add the same callback on the new domain to every app.

**Portal screens change.** Field names below are the ones these portals used when the playbook was written
(`docs/Platform_Access_Playbook.md`, 2026-09-18). If a screen looks different, send a screenshot and I will map it.

**Never paste a secret into chat or into this file.** Keys go straight from the portal into your own terminal:

```bash
vercel env add NAME production --scope asbunat
```

then redeploy (Vercel → project `nashr` → Deployments → latest → Redeploy), because env changes reach only new
deployments.

## Shared values (used by every pack)

| Field | Value |
|---|---|
| App name | `Nashr` (Arabic, where asked: `نشر`) |
| Company / developer | your company name as on the commercial registration |
| Website | `https://nashr-tau.vercel.app` |
| Privacy policy | `https://nashr-tau.vercel.app/en/privacy` |
| Terms of service | `https://nashr-tau.vercel.app/en/terms` |
| Support contact | the support WhatsApp number (see #138: use the business number once you have it) |
| Category | Marketing / Business |
| App icon | **Missing:** the repo has no square logo. Export a 1024×1024 PNG of the Nashr mark before you start; every portal asks for one |

**Short description (EN, 1 line):**
> Nashr is an AI marketing assistant for Gulf businesses. It drafts posts and articles that the business owner reviews, and publishes only what the owner approves.

**Short description (AR):**
> نشر مساعد تسويق بالذكاء الاصطناعي للأعمال في الخليج. يكتب مسودات المنشورات والمقالات، ويراجعها صاحب النشاط، ولا يُنشر إلا ما يعتمده.

**Long description / use case (EN, for reviewers):**
> Nashr helps small and medium businesses in Saudi Arabia and the Gulf plan and write their marketing content in Arabic and English. The business owner connects their own account through OAuth. Nashr drafts content into an approval inbox; nothing is published until the owner opens the item, approves it and clicks Publish (or explicitly asks the assistant to publish that approved item). Nashr never posts on its own schedule, never sends direct messages, never follows, likes or replies on the owner's behalf, and never reads or stores other users' data. Tokens are encrypted at rest (AES-256-GCM), used only when the owner publishes an approved item or imports their own products, and deleted when the owner disconnects or deletes their account.

Every sentence above is true of the code today (`src/app/api/publish/[id]/route.ts`, `src/lib/connectors/`). Do not
add features to it that are not built: reviewers test what you describe.

---

## 1. Shopify — about 1 hour, no review needed to test

**What works once connected:** product import into the brand's `products.md`, articles published as blog drafts, and a
sales sync: last 30 days of orders and abandoned checkouts, as totals with no customer details, shown on Reports and read
by Noor (built 2026-09-28).

1. Go to **partners.shopify.com** → create a Partner account (your name, company, email).
2. **Stores → Add store → Development store.** Name: `nashr-test`. This is the free store you test on.
3. **Apps → Create app → Create app manually.**
   | Field | Value |
   |---|---|
   | App name | `Nashr` |
   | App URL | `https://nashr-tau.vercel.app/en/app/integrations` |
   | Allowed redirection URL(s) | `https://nashr-tau.vercel.app/api/connect/shopify/callback` |
4. **API access / scopes:** `read_products, read_orders, read_checkouts, write_content, read_customers`
   **Protected customer data access** (same app, API access section): request access for **orders** at the first
   level only, with no customer fields (name, email, phone, address). Reason to give: "Totals of the merchant's own
   orders and abandoned checkouts (count, revenue, top products) for their marketing reports; no customer fields are
   read or stored." Without it Shopify refuses order reads and Nashr shows a message saying so. On development stores
   this is a setting, not a review; the review comes with the App Store listing.
5. Copy **Client ID** and **Client secret**, then in your terminal:
   ```bash
   vercel env add SHOPIFY_CLIENT_ID production --scope asbunat
   vercel env add SHOPIFY_CLIENT_SECRET production --scope asbunat
   ```
6. Redeploy. In Nashr → Integrations → Shopify → enter `nashr-test.myshopify.com` → approve on Shopify.
7. Test: **Import products** (add 2–3 products to the dev store first), then approve an article in the inbox and click
   **Publish to Shopify**; it should appear as a hidden blog draft in the store.
8. Sales test: place 2–3 test orders on the dev store (Bogus Gateway) and leave one checkout at the payment step,
   then Reports → **Sync from Shopify**. The card should show the orders, the sales, and one abandoned checkout.

**Later:** listing on the Shopify App Store needs a review (about 2–3 weeks). Until then the app can be installed on
stores you invite. Nashr already calls Shopify only through the GraphQL Admin API (version 2026-07), which Shopify
requires for new public apps (moved 2026-09-28). Shopify retires each API version about a year after release, so the
version needs a bump roughly every year. Tell me before you submit the listing.

---

## 2. X — about 1 day, paid tier required to post

**What works once connected:** posting an approved social item as a tweet; the token refreshes itself.

**Decide first:** posting through the API needs a paid access tier. It was about **$100/month (Basic)** when the playbook
was written; check the current price at developer.x.com before you pay.

1. Create the company X account first (e.g. `@nashr_ai`) and log in with it.
2. Go to **developer.x.com** → sign up for developer access → choose the paid tier.
3. **Use case text** (the portal asks for a description of how you will use the API; paste this):
   > Nashr is a marketing assistant for small businesses in Saudi Arabia. A business owner connects their own X account with OAuth 2.0. Nashr drafts posts; the owner reviews each one in an approval inbox and publishes it with a click. We only create posts the owner has approved, on the owner's own account. We do not read timelines, send DMs, follow, like, reply, or collect data about other users. Tokens are encrypted and deleted when the owner disconnects.
4. **Project → App → User authentication settings:**
   | Field | Value |
   |---|---|
   | App permissions | Read and write |
   | Type of App | Web App, Automated App or Bot → **Web App** (confidential client) |
   | Callback URI / Redirect URL | `https://nashr-tau.vercel.app/api/connect/x/callback` |
   | Website URL | `https://nashr-tau.vercel.app` |
   | Terms / Privacy | the URLs from the shared table |
5. Copy the **OAuth 2.0 Client ID** and **Client Secret** (not the API key/secret, which is OAuth 1.0a):
   ```bash
   vercel env add X_CLIENT_ID production --scope asbunat
   vercel env add X_CLIENT_SECRET production --scope asbunat
   ```
6. Redeploy → Nashr → Integrations → X → approve → the card shows `@yourhandle`.
7. Test: approve one X post in the inbox → **Publish to X** → it appears on the account.

Scopes Nashr asks for (nothing to tick; sent at connect time): `tweet.read tweet.write users.read offline.access`.

---

## 3. Salla — 1 day to apply, test on the demo store immediately

**What works once connected:** product import into the brand's `products.md`, and the store name on the Integrations
card (built 2026-09-27), and a sales sync: last 30 days of orders and the open abandoned carts, as totals with no
customer details, shown on Reports and read by Noor (built 2026-09-28). It is testable on Salla's demo store the day you send
the keys, without waiting for Salla's public review.

**Needs:** commercial registration (#47).

1. Go to **salla.partners** → register as a partner (company, CR, contact person).
2. **My Apps → Create app.**
   | Field | Value |
   |---|---|
   | App name | `نشر - Nashr` |
   | App type | **Public app** (needed for the Salla App Store later) |
   | Category | Marketing |
   | Description | the Arabic short description above |
   | Callback / Redirect URL | `https://nashr-tau.vercel.app/api/connect/salla/callback` |
   | Website, privacy, terms | shared table |
3. **Scopes / permissions:** tick read access for **Products, Orders, Customers, Abandoned carts, Store settings**, plus
   **offline access** (so the connection survives). Leave write permissions off for now; I will ask for blog write when
   that feature is built.
4. **Webhooks:** leave off for now.
5. Copy Client ID and Client Secret:
   ```bash
   vercel env add SALLA_CLIENT_ID production --scope asbunat
   vercel env add SALLA_CLIENT_SECRET production --scope asbunat
   ```
6. **Do not submit for publishing yet.** Tell me the keys are in; I test on the demo store first, then we submit.

---

## 4. Meta (Facebook, Instagram) — start verification today, test as a tester, then submit review

**What works once connected (built 2026-09-28):** publishing an approved post to the Facebook Page you choose, and to
the Instagram professional account linked to that Page when the post has a generated image (Instagram takes no
text-only posts). Before app review this works for people with a role on the app (step 8), which is enough to test
and to record the review screencasts. Business verification is the slowest part (2–10 business days): start it today.

**Needs:** commercial registration (#47), a company phone number, and the website.

### Today: business verification
1. **business.facebook.com** → create a **Business Portfolio** named `Nashr` (or the legal company name).
2. **Settings → Security Center → Start verification.** Upload the CR, enter the legal name exactly as on the CR, the
   company phone and website `https://nashr-tau.vercel.app`.
3. Add a second admin you trust, so the portfolio is never locked to one login.

### Today: create the app (no review yet)
4. **developers.facebook.com → My Apps → Create app** → use case / type **Business**. Name `Nashr`. Attach it to the
   Business Portfolio from step 1.
5. **App settings → Basic:**
   | Field | Value |
   |---|---|
   | App domains | `nashr-tau.vercel.app` |
   | Privacy policy URL | shared table |
   | Terms of service URL | shared table |
   | App icon | the 1024×1024 PNG |
   | Category | Business and pages |
6. Add the product **Facebook Login for Business** → **Valid OAuth Redirect URIs:**
   `https://nashr-tau.vercel.app/api/connect/meta/callback`
   If the product asks for a **configuration**, create one with the six permissions listed under "App review" below
   and the token type **User access token**, then add its id as `META_CONFIG_ID` (same command as step 7). Without a
   configuration Nashr sends the permissions itself.
7. Copy **App ID** and **App Secret**:
   ```bash
   vercel env add META_APP_ID production --scope asbunat
   vercel env add META_APP_SECRET production --scope asbunat
   ```
8. **Roles → add yourself as a tester** so you can connect your own page before any review.
9. Your Instagram account must be a **professional** account (Business or Creator) **linked to the Facebook Page**
   (Instagram app → Settings → Account type; then Page settings → Linked accounts). A personal account cannot be
   published to through the API.
10. Test: Nashr → Integrations → Instagram → Connect → approve. The card shows the Page and `@account`; with several
    Pages, a list lets you pick one. Then in the inbox: an Instagram post → **Generate image** → **Publish to
    instagram**, and another → **Publish to facebook**.

### After business verification: app review
Permissions to request: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`,
`instagram_content_publish`, `business_management`. Nashr asks for exactly these six and nothing else; WhatsApp and
ads permissions come later, with their own features. Do not request permissions for features that do not exist: Meta
rejects the whole submission.

**Screencasts** are recorded on your screen, logged in as a tester (I cannot record them from here). One recording
can cover all six if it shows, in order: Integrations → Connect Instagram → the Meta consent screen listing the
permissions → back in Nashr, the card with the Page name and `@account` (pages_show_list, business_management,
instagram_basic) → the inbox: approve a post, generate its image, **Publish to instagram**, then open the post on
Instagram (instagram_content_publish) → **Publish to facebook** on another post, then open it on the Page
(pages_manage_posts, pages_read_engagement). Keep the app language English for the recording; reviewers ask for it.

---

## 5. Zid — register as a partner, test on your own store

**What works once connected (built 2026-09-28):** product import into the brand's `products.md`; the store name on
the Integrations card; and a sales sync — the last 30 days of orders and the open abandoned carts, as totals with no
customer details — shown on Reports, read by Noor, by Dana's reports (STORE DATA) and by the cart-recovery drafts.

**Needs:** a Zid partner account. Zid will probably ask for the commercial registration (#47); I could not confirm
that from here.

1. Open Zid's partner portal (the **Partners / App Market** link on zid.sa) → register as a partner.
2. **Create app.**
   | Field | Value |
   |---|---|
   | App name | `نشر - Nashr` |
   | Category | Marketing |
   | Description | the Arabic short description above |
   | Redirect / Callback URL | `https://nashr-tau.vercel.app/api/connect/zid/callback` |
   | Website, privacy, terms | shared table |
3. **Scopes / permissions — read only, tick all four:**
   | Permission | What it enables in Nashr | Without it |
   |---|---|---|
   | **Account / store profile** (read) | the store id Nashr sends on every Zid call, and the store name on the card | the card shows no store name and calls go without the store id; Zid's SDK treats it as optional, but some integrations report refusals without it |
   | **Products** (read) | product import into `products.md` | import answers "Zid refused" (not "reconnect": a new connection does not add a permission) |
   | **Orders** (read) | orders, revenue and best sellers in the sales sync | the sync answers "Zid refused to read orders" and saves nothing |
   | **Abandoned carts** (read) | open carts, their value, products most often left, cart-recovery drafts | orders still sync; carts show as "not available" (unknown, not zero) |

   The abandoned-carts permission is reported as `abandoned_carts.read`, but only in search summaries of Zid's docs
   (docs.zid.sa is not reachable from here), and the portal may label all four differently. Tick the read permission
   for each of the four areas, whatever it is called, and leave every write permission off. If a permission is
   missing later, add it in the portal and connect the store again from Integrations.
4. **Webhooks:** leave off for now. Nashr reads on demand when you press **Sync from Zid** on Reports.
5. Copy Client ID and Client Secret:
   ```bash
   vercel env add ZID_CLIENT_ID production --scope asbunat
   vercel env add ZID_CLIENT_SECRET production --scope asbunat
   ```
6. **Test before publishing:** connect your own Zid store (or a development store, if the portal offers one) from
   Integrations, press **Import products**, then **Sync from Zid** on Reports, and compare the orders and revenue with
   Zid's own dashboard for the same 30 days. Tell me the numbers; the order and cart formats were built from Zid's
   official SDK, not from a live store, so this first comparison is the real check.

**Limits to know:** Zid allows 60 API requests a minute per store; one sync uses about 28 at most. The sync reads up
to 500 orders (then shows "500 or more") and up to 300 open carts.

---

## After each platform

Tick its row in `docs/Owner_Tasks_AR.md` §هـ with the date, and tell me: "X keys are in" is enough. I then check the
connect flow against production logs and fix anything before a customer sees it.
