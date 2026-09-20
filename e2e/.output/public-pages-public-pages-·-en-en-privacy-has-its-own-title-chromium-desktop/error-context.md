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
      - link "Nashr" [ref=e4] [cursor=pointer]:
        - /url: /en
      - navigation "Main" [ref=e6]:
        - link "Agents" [ref=e8] [cursor=pointer]:
          - /url: /en/agents/noor
        - link "Industries" [ref=e12] [cursor=pointer]:
          - /url: /en#industries
        - link "Customers" [ref=e15] [cursor=pointer]:
          - /url: /en/customers
        - link "Enterprise" [ref=e16] [cursor=pointer]:
          - /url: /en/enterprise
        - link "Resources" [ref=e18] [cursor=pointer]:
          - /url: /en/resources
        - link "Pricing" [ref=e21] [cursor=pointer]:
          - /url: /en/pricing
      - generic [ref=e22]:
        - group "Language" [ref=e23]:
          - link "العربية" [ref=e24] [cursor=pointer]:
            - /url: /ar/privacy
            - text: عربي
          - link "English" [ref=e25] [cursor=pointer]:
            - /url: /en/privacy
            - text: EN
        - link "Log in" [ref=e26] [cursor=pointer]:
          - /url: /en/app/login
        - link "Start free" [ref=e27] [cursor=pointer]:
          - /url: /en/app/signup
  - main [ref=e28]:
    - heading "Privacy Policy" [level=1] [ref=e29]
    - paragraph [ref=e30]: "Last updated: 2026-09-17"
    - generic [ref=e31]:
      - heading "Who we are" [level=2] [ref=e32]
      - paragraph [ref=e33]: Nashr is an AI marketing platform for businesses in the Gulf. This policy explains what we collect, how we use it, and your rights under the Saudi Personal Data Protection Law (PDPL).
    - generic [ref=e34]:
      - heading "What we collect" [level=2] [ref=e35]
      - paragraph [ref=e36]: "Account data: name, email, mobile number, password (hashed)."
      - paragraph [ref=e37]: "Brand data: your website, products, audience, tone, and what you tell Noor."
      - paragraph [ref=e38]: "Connected platforms: when you connect a store or account (Salla, Zid, Shopify, X, Google, Meta…) we store access tokens encrypted and read only what the permissions you approved allow."
      - paragraph [ref=e39]: "Usage data: requests to Noor, what you approve or reject, and technical logs needed to run the service."
    - generic [ref=e40]:
      - heading "How we use it" [level=2] [ref=e41]
      - paragraph [ref=e42]: "To run the service: create content, plans and messages, and publish to platforms you connected on your instruction."
      - paragraph [ref=e43]: "To improve Noor for your brand: your edits are stored as preferences for your account only."
      - paragraph [ref=e44]: We do not sell your data. We do not train general models on your content. We use AI providers (Anthropic) and infrastructure (Vercel, Upstash) under data-processing agreements.
    - generic [ref=e45]:
      - heading "Connected platforms" [level=2] [ref=e46]
      - paragraph [ref=e47]: You can disconnect any account at any time from the Integrations page; tokens are deleted immediately. We request the minimum scopes and never publish without your approval or the governance settings you configured.
    - generic [ref=e48]:
      - heading "Retention and deletion" [level=2] [ref=e49]
      - paragraph [ref=e50]: We keep data while your account is active. Request a full export or deletion at hello@nashr.ai; we complete it within 30 days.
    - generic [ref=e51]:
      - heading "Your rights" [level=2] [ref=e52]
      - paragraph [ref=e53]: Access, correction, deletion, objection, and portability. Contact hello@nashr.ai or WhatsApp +966 55 923 5281.
  - contentinfo [ref=e54]:
    - generic [ref=e56]:
      - generic [ref=e57]:
        - generic [ref=e58]:
          - paragraph [ref=e59]: Nashr
          - paragraph [ref=e60]: A marketing agent that works 24/7 — built in Riyadh for the Gulf.
        - navigation "Agents" [ref=e61]:
          - paragraph [ref=e62]: Agents
          - list [ref=e63]:
            - listitem [ref=e64]:
              - link "Noor · Marketing" [ref=e65] [cursor=pointer]:
                - /url: /en/agents/noor
            - listitem [ref=e66]:
              - link "Sami · Sales enablement" [ref=e67] [cursor=pointer]:
                - /url: /en/agents/sami
            - listitem [ref=e68]:
              - link "Razan · Finance, pricing and revenue" [ref=e69] [cursor=pointer]:
                - /url: /en/agents/razan
            - listitem [ref=e70]:
              - link "Faris · Go-to-market and growth" [ref=e71] [cursor=pointer]:
                - /url: /en/agents/faris
            - listitem [ref=e72]:
              - link "Dana · Reports, dashboards and decks" [ref=e73] [cursor=pointer]:
                - /url: /en/agents/dana
            - listitem [ref=e74]:
              - link "Majed · Executive advisor" [ref=e75] [cursor=pointer]:
                - /url: /en/agents/majed
            - listitem [ref=e76]:
              - link "Layan · Product and retention" [ref=e77] [cursor=pointer]:
                - /url: /en/agents/layan
        - navigation "Industries" [ref=e78]:
          - paragraph [ref=e79]: Industries
          - list [ref=e80]:
            - listitem [ref=e81]:
              - link "E-commerce" [ref=e82] [cursor=pointer]:
                - /url: /en/for/ecommerce
            - listitem [ref=e83]:
              - link "Real estate" [ref=e84] [cursor=pointer]:
                - /url: /en/for/real-estate
            - listitem [ref=e85]:
              - link "Law firms" [ref=e86] [cursor=pointer]:
                - /url: /en/for/legal
            - listitem [ref=e87]:
              - link "Startups" [ref=e88] [cursor=pointer]:
                - /url: /en/for/startups
            - listitem [ref=e89]:
              - link "Clinics & aesthetics" [ref=e90] [cursor=pointer]:
                - /url: /en/for/clinics
            - listitem [ref=e91]:
              - link "Restaurants & cafés" [ref=e92] [cursor=pointer]:
                - /url: /en/for/restaurants
            - listitem [ref=e93]:
              - link "Marketing agencies" [ref=e94] [cursor=pointer]:
                - /url: /en/for/agencies
        - navigation "Resources" [ref=e95]:
          - paragraph [ref=e96]: Resources
          - list [ref=e97]:
            - listitem [ref=e98]:
              - link "Blog and guides" [ref=e99] [cursor=pointer]:
                - /url: /en/blog
            - listitem [ref=e100]:
              - link "Free tools" [ref=e101] [cursor=pointer]:
                - /url: /en/tools
            - listitem [ref=e102]:
              - link "Help center" [ref=e103] [cursor=pointer]:
                - /url: /en/help
            - listitem [ref=e104]:
              - link "What is an AI marketing agent?" [ref=e105] [cursor=pointer]:
                - /url: /en/ai-marketing-agent
            - listitem [ref=e106]:
              - link "Affiliate program" [ref=e107] [cursor=pointer]:
                - /url: /en/affiliates
        - navigation "Company" [ref=e108]:
          - paragraph [ref=e109]: Company
          - list [ref=e110]:
            - listitem [ref=e111]:
              - link "Customers" [ref=e112] [cursor=pointer]:
                - /url: /en/customers
            - listitem [ref=e113]:
              - link "Enterprise" [ref=e114] [cursor=pointer]:
                - /url: /en/enterprise
            - listitem [ref=e115]:
              - link "Pricing" [ref=e116] [cursor=pointer]:
                - /url: /en/pricing
            - listitem [ref=e117]:
              - link "Comparisons" [ref=e118] [cursor=pointer]:
                - /url: /en/resources#compare
            - listitem [ref=e119]:
              - link "Privacy" [ref=e120] [cursor=pointer]:
                - /url: /en/privacy
            - listitem [ref=e121]:
              - link "Terms" [ref=e122] [cursor=pointer]:
                - /url: /en/terms
      - generic [ref=e123]:
        - paragraph [ref=e124]: © 2026 Nashr. All rights reserved.
        - group "Language" [ref=e125]:
          - link "العربية" [ref=e126] [cursor=pointer]:
            - /url: /ar/privacy
            - text: عربي
          - link "English" [ref=e127] [cursor=pointer]:
            - /url: /en/privacy
            - text: EN
  - alert [ref=e128]
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