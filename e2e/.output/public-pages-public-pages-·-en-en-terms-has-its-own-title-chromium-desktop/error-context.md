# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: public-pages.spec.ts >> public pages · en >> /en/terms has its own title
- Location: e2e/public-pages.spec.ts:30:13

# Error details

```
Error: /en/terms must not fall back to the site-wide default title

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
            - /url: /ar/terms
            - text: عربي
          - link "English" [ref=e25] [cursor=pointer]:
            - /url: /en/terms
            - text: EN
        - link "Log in" [ref=e26] [cursor=pointer]:
          - /url: /en/app/login
        - link "Start free" [ref=e27] [cursor=pointer]:
          - /url: /en/app/signup
  - main [ref=e28]:
    - heading "Terms of Service" [level=1] [ref=e29]
    - paragraph [ref=e30]: "Last updated: 2026-09-17"
    - generic [ref=e31]:
      - heading "The service" [level=2] [ref=e32]
      - paragraph [ref=e33]: Nashr provides an AI marketing agent (Noor) that creates content, plans and messages and publishes to platforms you connect, subject to your approval or governance settings.
    - generic [ref=e34]:
      - heading "Your responsibilities" [level=2] [ref=e35]
      - paragraph [ref=e36]: You review content before publishing and ensure it complies with advertising rules in your country (e.g. MOH, REGA, anti-fraud regulations).
      - paragraph [ref=e37]: No unlawful, misleading, or infringing content.
      - paragraph [ref=e38]: Connected accounts remain subject to their platforms' terms.
    - generic [ref=e39]:
      - heading "Subscription and credits" [level=2] [ref=e40]
      - paragraph [ref=e41]: Prices are in SAR excluding VAT. Credits are deducted per generation as published. Credits are non-refundable and non-transferable. Cancel anytime; access continues to the end of the paid period.
    - generic [ref=e42]:
      - heading "AI output" [level=2] [ref=e43]
      - paragraph [ref=e44]: Generated content may contain errors. Noor does not invent prices or claims, but final verification is your responsibility.
    - generic [ref=e45]:
      - heading "Ownership" [level=2] [ref=e46]
      - paragraph [ref=e47]: Content Noor creates for your account is yours. The Nashr platform and software belong to the company.
    - generic [ref=e48]:
      - heading "Changes and law" [level=2] [ref=e49]
      - paragraph [ref=e50]: We may update these terms and will notify you. Governed by the laws of the Kingdom of Saudi Arabia.
  - contentinfo [ref=e51]:
    - generic [ref=e53]:
      - generic [ref=e54]:
        - generic [ref=e55]:
          - paragraph [ref=e56]: Nashr
          - paragraph [ref=e57]: A marketing agent that works 24/7 — built in Riyadh for the Gulf.
        - navigation "Agents" [ref=e58]:
          - paragraph [ref=e59]: Agents
          - list [ref=e60]:
            - listitem [ref=e61]:
              - link "Noor · Marketing" [ref=e62] [cursor=pointer]:
                - /url: /en/agents/noor
            - listitem [ref=e63]:
              - link "Sami · Sales enablement" [ref=e64] [cursor=pointer]:
                - /url: /en/agents/sami
            - listitem [ref=e65]:
              - link "Razan · Finance, pricing and revenue" [ref=e66] [cursor=pointer]:
                - /url: /en/agents/razan
            - listitem [ref=e67]:
              - link "Faris · Go-to-market and growth" [ref=e68] [cursor=pointer]:
                - /url: /en/agents/faris
            - listitem [ref=e69]:
              - link "Dana · Reports, dashboards and decks" [ref=e70] [cursor=pointer]:
                - /url: /en/agents/dana
            - listitem [ref=e71]:
              - link "Majed · Executive advisor" [ref=e72] [cursor=pointer]:
                - /url: /en/agents/majed
            - listitem [ref=e73]:
              - link "Layan · Product and retention" [ref=e74] [cursor=pointer]:
                - /url: /en/agents/layan
        - navigation "Industries" [ref=e75]:
          - paragraph [ref=e76]: Industries
          - list [ref=e77]:
            - listitem [ref=e78]:
              - link "E-commerce" [ref=e79] [cursor=pointer]:
                - /url: /en/for/ecommerce
            - listitem [ref=e80]:
              - link "Real estate" [ref=e81] [cursor=pointer]:
                - /url: /en/for/real-estate
            - listitem [ref=e82]:
              - link "Law firms" [ref=e83] [cursor=pointer]:
                - /url: /en/for/legal
            - listitem [ref=e84]:
              - link "Startups" [ref=e85] [cursor=pointer]:
                - /url: /en/for/startups
            - listitem [ref=e86]:
              - link "Clinics & aesthetics" [ref=e87] [cursor=pointer]:
                - /url: /en/for/clinics
            - listitem [ref=e88]:
              - link "Restaurants & cafés" [ref=e89] [cursor=pointer]:
                - /url: /en/for/restaurants
            - listitem [ref=e90]:
              - link "Marketing agencies" [ref=e91] [cursor=pointer]:
                - /url: /en/for/agencies
        - navigation "Resources" [ref=e92]:
          - paragraph [ref=e93]: Resources
          - list [ref=e94]:
            - listitem [ref=e95]:
              - link "Blog and guides" [ref=e96] [cursor=pointer]:
                - /url: /en/blog
            - listitem [ref=e97]:
              - link "Free tools" [ref=e98] [cursor=pointer]:
                - /url: /en/tools
            - listitem [ref=e99]:
              - link "Help center" [ref=e100] [cursor=pointer]:
                - /url: /en/help
            - listitem [ref=e101]:
              - link "What is an AI marketing agent?" [ref=e102] [cursor=pointer]:
                - /url: /en/ai-marketing-agent
            - listitem [ref=e103]:
              - link "Affiliate program" [ref=e104] [cursor=pointer]:
                - /url: /en/affiliates
        - navigation "Company" [ref=e105]:
          - paragraph [ref=e106]: Company
          - list [ref=e107]:
            - listitem [ref=e108]:
              - link "Customers" [ref=e109] [cursor=pointer]:
                - /url: /en/customers
            - listitem [ref=e110]:
              - link "Enterprise" [ref=e111] [cursor=pointer]:
                - /url: /en/enterprise
            - listitem [ref=e112]:
              - link "Pricing" [ref=e113] [cursor=pointer]:
                - /url: /en/pricing
            - listitem [ref=e114]:
              - link "Comparisons" [ref=e115] [cursor=pointer]:
                - /url: /en/resources#compare
            - listitem [ref=e116]:
              - link "Privacy" [ref=e117] [cursor=pointer]:
                - /url: /en/privacy
            - listitem [ref=e118]:
              - link "Terms" [ref=e119] [cursor=pointer]:
                - /url: /en/terms
      - generic [ref=e120]:
        - paragraph [ref=e121]: © 2026 Nashr. All rights reserved.
        - group "Language" [ref=e122]:
          - link "العربية" [ref=e123] [cursor=pointer]:
            - /url: /ar/terms
            - text: عربي
          - link "English" [ref=e124] [cursor=pointer]:
            - /url: /en/terms
            - text: EN
  - alert [ref=e125]
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
     |                                                                                          ^ Error: /en/terms must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```