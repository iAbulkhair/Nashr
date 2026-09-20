# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: public-pages.spec.ts >> public pages · en >> /en/privacy has its own title
- Location: e2e/public-pages.spec.ts:30:13

# Error details

```
Error: /en/privacy must not fall back to the site-wide default title

expect(received).not.toBe(expected) // Object.is equality

Expected: not "Nashr — Noor, the 24/7 AI marketing agent for the Gulf"
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - generic [ref=e3]:
      - link "Nashr" [ref=e4]:
        - /url: /en
      - generic [ref=e6]:
        - group "Language" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/privacy
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/privacy
            - text: EN
        - link "Start free" [ref=e10] [cursor=pointer]:
          - /url: /en/app/signup
        - group [ref=e11]:
          - generic "Menu" [ref=e12] [cursor=pointer]
          - group [ref=e15]:
            - generic "Agents" [ref=e16] [cursor=pointer]
          - group [ref=e17]:
            - generic "Industries" [ref=e18] [cursor=pointer]
          - group [ref=e19]:
            - generic "Resources" [ref=e20] [cursor=pointer]
  - main [ref=e21]:
    - heading "Privacy Policy" [level=1] [ref=e22]
    - paragraph [ref=e23]: "Last updated: 2026-09-17"
    - generic [ref=e24]:
      - heading "Who we are" [level=2] [ref=e25]
      - paragraph [ref=e26]: Nashr is an AI marketing platform for businesses in the Gulf. This policy explains what we collect, how we use it, and your rights under the Saudi Personal Data Protection Law (PDPL).
    - generic [ref=e27]:
      - heading "What we collect" [level=2] [ref=e28]
      - paragraph [ref=e29]: "Account data: name, email, mobile number, password (hashed)."
      - paragraph [ref=e30]: "Brand data: your website, products, audience, tone, and what you tell Noor."
      - paragraph [ref=e31]: "Connected platforms: when you connect a store or account (Salla, Zid, Shopify, X, Google, Meta…) we store access tokens encrypted and read only what the permissions you approved allow."
      - paragraph [ref=e32]: "Usage data: requests to Noor, what you approve or reject, and technical logs needed to run the service."
    - generic [ref=e33]:
      - heading "How we use it" [level=2] [ref=e34]
      - paragraph [ref=e35]: "To run the service: create content, plans and messages, and publish to platforms you connected on your instruction."
      - paragraph [ref=e36]: "To improve Noor for your brand: your edits are stored as preferences for your account only."
      - paragraph [ref=e37]: We do not sell your data. We do not train general models on your content. We use AI providers (Anthropic) and infrastructure (Vercel, Upstash) under data-processing agreements.
    - generic [ref=e38]:
      - heading "Connected platforms" [level=2] [ref=e39]
      - paragraph [ref=e40]: You can disconnect any account at any time from the Integrations page; tokens are deleted immediately. We request the minimum scopes and never publish without your approval or the governance settings you configured.
    - generic [ref=e41]:
      - heading "Retention and deletion" [level=2] [ref=e42]
      - paragraph [ref=e43]: We keep data while your account is active. Request a full export or deletion at hello@nashr.ai; we complete it within 30 days.
    - generic [ref=e44]:
      - heading "Your rights" [level=2] [ref=e45]
      - paragraph [ref=e46]: Access, correction, deletion, objection, and portability. Contact hello@nashr.ai or WhatsApp +966 55 923 5281.
  - contentinfo [ref=e47]:
    - generic [ref=e49]:
      - generic [ref=e50]:
        - generic [ref=e51]:
          - paragraph [ref=e52]: Nashr
          - paragraph [ref=e53]: A marketing agent that works 24/7 — built in Riyadh for the Gulf.
        - navigation "Agents" [ref=e54]:
          - paragraph [ref=e55]: Agents
          - list [ref=e56]:
            - listitem [ref=e57]:
              - link "Noor · Marketing" [ref=e58]:
                - /url: /en/agents/noor
            - listitem [ref=e59]:
              - link "Sami · Sales enablement" [ref=e60]:
                - /url: /en/agents/sami
            - listitem [ref=e61]:
              - link "Razan · Finance, pricing and revenue" [ref=e62]:
                - /url: /en/agents/razan
            - listitem [ref=e63]:
              - link "Faris · Go-to-market and growth" [ref=e64]:
                - /url: /en/agents/faris
            - listitem [ref=e65]:
              - link "Dana · Reports, dashboards and decks" [ref=e66]:
                - /url: /en/agents/dana
            - listitem [ref=e67]:
              - link "Majed · Executive advisor" [ref=e68]:
                - /url: /en/agents/majed
            - listitem [ref=e69]:
              - link "Layan · Product and retention" [ref=e70]:
                - /url: /en/agents/layan
        - navigation "Industries" [ref=e71]:
          - paragraph [ref=e72]: Industries
          - list [ref=e73]:
            - listitem [ref=e74]:
              - link "E-commerce" [ref=e75]:
                - /url: /en/for/ecommerce
            - listitem [ref=e76]:
              - link "Real estate" [ref=e77]:
                - /url: /en/for/real-estate
            - listitem [ref=e78]:
              - link "Law firms" [ref=e79]:
                - /url: /en/for/legal
            - listitem [ref=e80]:
              - link "Startups" [ref=e81]:
                - /url: /en/for/startups
            - listitem [ref=e82]:
              - link "Clinics & aesthetics" [ref=e83]:
                - /url: /en/for/clinics
            - listitem [ref=e84]:
              - link "Restaurants & cafés" [ref=e85]:
                - /url: /en/for/restaurants
            - listitem [ref=e86]:
              - link "Marketing agencies" [ref=e87]:
                - /url: /en/for/agencies
        - navigation "Resources" [ref=e88]:
          - paragraph [ref=e89]: Resources
          - list [ref=e90]:
            - listitem [ref=e91]:
              - link "Blog and guides" [ref=e92]:
                - /url: /en/blog
            - listitem [ref=e93]:
              - link "Free tools" [ref=e94]:
                - /url: /en/tools
            - listitem [ref=e95]:
              - link "Help center" [ref=e96]:
                - /url: /en/help
            - listitem [ref=e97]:
              - link "What is an AI marketing agent?" [ref=e98]:
                - /url: /en/ai-marketing-agent
            - listitem [ref=e99]:
              - link "Affiliate program" [ref=e100]:
                - /url: /en/affiliates
        - navigation "Company" [ref=e101]:
          - paragraph [ref=e102]: Company
          - list [ref=e103]:
            - listitem [ref=e104]:
              - link "Customers" [ref=e105]:
                - /url: /en/customers
            - listitem [ref=e106]:
              - link "Enterprise" [ref=e107]:
                - /url: /en/enterprise
            - listitem [ref=e108]:
              - link "Pricing" [ref=e109]:
                - /url: /en/pricing
            - listitem [ref=e110]:
              - link "Comparisons" [ref=e111]:
                - /url: /en/resources#compare
            - listitem [ref=e112]:
              - link "Privacy" [ref=e113]:
                - /url: /en/privacy
            - listitem [ref=e114]:
              - link "Terms" [ref=e115]:
                - /url: /en/terms
      - generic [ref=e116]:
        - paragraph [ref=e117]: © 2026 Nashr. All rights reserved.
        - group "Language" [ref=e118]:
          - link "العربية" [ref=e119]:
            - /url: /ar/privacy
            - text: عربي
          - link "English" [ref=e120]:
            - /url: /en/privacy
            - text: EN
  - alert [ref=e121]
```

# Test source

```ts
  1  | import { test, expect, open, dirFor, LANGS } from "./fixtures/app";
  2  | import { PUBLIC_ROUTES, DEFAULT_TITLE } from "./fixtures/routes";
  3  | 
  4  | /**
  5  |  * Per-route contract for every public marketing page, in both languages: it answers 200, it says which language and
  6  |  * direction it is in, it has exactly one first-level heading, it carries a title that identifies the page rather than
  7  |  * the site, and it loads without a console error or a failed request (both asserted by the `failures` fixture).
  8  |  */
  9  | for (const lang of LANGS) {
  10 |   test.describe(`public pages · ${lang}`, () => {
  11 |     for (const route of PUBLIC_ROUTES) {
  12 |       const path = `/${lang}${route.path}`;
  13 | 
  14 |       test(`${path} renders`, async ({ page, failures }) => {
  15 |         void failures; // the fixture asserts console and network cleanliness at teardown
  16 |         const res = await open(page, path);
  17 |         expect(res.status(), `${path} must answer 200`).toBe(200);
  18 | 
  19 |         const html = page.locator("html");
  20 |         await expect(html).toHaveAttribute("lang", lang);
  21 |         await expect(html).toHaveAttribute("dir", dirFor(lang));
  22 | 
  23 |         await expect(page.locator("h1"), `${path} must have exactly one h1`).toHaveCount(1);
  24 | 
  25 |         const unique = route.unique[lang];
  26 |         await expect(page.locator("body"), `${path} must render its own content`).toContainText(unique);
  27 |       });
  28 | 
  29 |       if (route.ownTitle) {
  30 |         test(`${path} has its own title`, async ({ page }) => {
  31 |           await open(page, path);
  32 |           const title = await page.title();
  33 |           expect(title.length, `${path} must have a title`).toBeGreaterThan(0);
> 34 |           expect(title, `${path} must not fall back to the site-wide default title`).not.toBe(DEFAULT_TITLE[lang]);
     |                                                                                          ^ Error: /en/privacy must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```