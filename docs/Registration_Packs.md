# Platform registration packs — copy, paste, submit

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

**What works once connected:** product import into the brand's `products.md`, and articles published as blog drafts.

1. Go to **partners.shopify.com** → create a Partner account (your name, company, email).
2. **Stores → Add store → Development store.** Name: `nashr-test`. This is the free store you test on.
3. **Apps → Create app → Create app manually.**
   | Field | Value |
   |---|---|
   | App name | `Nashr` |
   | App URL | `https://nashr-tau.vercel.app/en/app/integrations` |
   | Allowed redirection URL(s) | `https://nashr-tau.vercel.app/api/connect/shopify/callback` |
4. **API access / scopes:** `read_products, read_orders, read_checkouts, write_content, read_customers`
5. Copy **Client ID** and **Client secret**, then in your terminal:
   ```bash
   vercel env add SHOPIFY_CLIENT_ID production --scope asbunat
   vercel env add SHOPIFY_CLIENT_SECRET production --scope asbunat
   ```
6. Redeploy. In Nashr → Integrations → Shopify → enter `nashr-test.myshopify.com` → approve on Shopify.
7. Test: **Import products** (add 2–3 products to the dev store first), then approve an article in the inbox and click
   **Publish to Shopify**; it should appear as a hidden blog draft in the store.

**Later:** listing on the Shopify App Store needs a review (about 2–3 weeks). Until then the app can be installed on
stores you invite. Tell me before you submit the listing.

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

**What works once connected:** nothing yet. I am building product import, orders and abandoned carts; it is testable
on Salla's demo store the day you send the keys, without waiting for Salla's public review.

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

## 4. Meta (Facebook, Instagram, WhatsApp) — start verification today, submit review later

**What works once connected:** nothing yet. Meta's app review requires a screencast of the working feature, so the
review can only be submitted after I build Instagram/Facebook publishing. What you can and should start **today** is
business verification, which is the slowest part (2–10 business days).

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
7. Copy **App ID** and **App Secret**:
   ```bash
   vercel env add META_APP_ID production --scope asbunat
   vercel env add META_APP_SECRET production --scope asbunat
   ```
8. **Roles → add yourself as a tester** so you can connect your own page before any review.

### Later (after I build publishing): app review
Permissions to request then: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`,
`instagram_content_publish`, `business_management`. WhatsApp and ads permissions come later, with their own features.
I will record the screencasts for each permission. Do not request permissions for features that do not exist: Meta
rejects the whole submission.

---

## After each platform

Tick its row in `docs/Owner_Tasks_AR.md` §هـ with the date, and tell me: "X keys are in" is enough. I then check the
connect flow against production logs and fix anything before a customer sees it.
