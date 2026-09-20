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
      - link "Nashr" [ref=e4]:
        - /url: /en
      - generic [ref=e6]:
        - group "Language" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/terms
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/terms
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
    - heading "Terms of Service" [level=1] [ref=e22]
    - paragraph [ref=e23]: "Last updated: 2026-09-17"
    - generic [ref=e24]:
      - heading "The service" [level=2] [ref=e25]
      - paragraph [ref=e26]: Nashr provides an AI marketing agent (Noor) that creates content, plans and messages and publishes to platforms you connect, subject to your approval or governance settings.
    - generic [ref=e27]:
      - heading "Your responsibilities" [level=2] [ref=e28]
      - paragraph [ref=e29]: You review content before publishing and ensure it complies with advertising rules in your country (e.g. MOH, REGA, anti-fraud regulations).
      - paragraph [ref=e30]: No unlawful, misleading, or infringing content.
      - paragraph [ref=e31]: Connected accounts remain subject to their platforms' terms.
    - generic [ref=e32]:
      - heading "Subscription and credits" [level=2] [ref=e33]
      - paragraph [ref=e34]: Prices are in SAR excluding VAT. Credits are deducted per generation as published. Credits are non-refundable and non-transferable. Cancel anytime; access continues to the end of the paid period.
    - generic [ref=e35]:
      - heading "AI output" [level=2] [ref=e36]
      - paragraph [ref=e37]: Generated content may contain errors. Noor does not invent prices or claims, but final verification is your responsibility.
    - generic [ref=e38]:
      - heading "Ownership" [level=2] [ref=e39]
      - paragraph [ref=e40]: Content Noor creates for your account is yours. The Nashr platform and software belong to the company.
    - generic [ref=e41]:
      - heading "Changes and law" [level=2] [ref=e42]
      - paragraph [ref=e43]: We may update these terms and will notify you. Governed by the laws of the Kingdom of Saudi Arabia.
  - contentinfo [ref=e44]:
    - generic [ref=e46]:
      - generic [ref=e47]:
        - generic [ref=e48]:
          - paragraph [ref=e49]: Nashr
          - paragraph [ref=e50]: A marketing agent that works 24/7 — built in Riyadh for the Gulf.
        - navigation "Agents" [ref=e51]:
          - paragraph [ref=e52]: Agents
          - list [ref=e53]:
            - listitem [ref=e54]:
              - link "Noor · Marketing" [ref=e55]:
                - /url: /en/agents/noor
            - listitem [ref=e56]:
              - link "Sami · Sales enablement" [ref=e57]:
                - /url: /en/agents/sami
            - listitem [ref=e58]:
              - link "Razan · Finance, pricing and revenue" [ref=e59]:
                - /url: /en/agents/razan
            - listitem [ref=e60]:
              - link "Faris · Go-to-market and growth" [ref=e61]:
                - /url: /en/agents/faris
            - listitem [ref=e62]:
              - link "Dana · Reports, dashboards and decks" [ref=e63]:
                - /url: /en/agents/dana
            - listitem [ref=e64]:
              - link "Majed · Executive advisor" [ref=e65]:
                - /url: /en/agents/majed
            - listitem [ref=e66]:
              - link "Layan · Product and retention" [ref=e67]:
                - /url: /en/agents/layan
        - navigation "Industries" [ref=e68]:
          - paragraph [ref=e69]: Industries
          - list [ref=e70]:
            - listitem [ref=e71]:
              - link "E-commerce" [ref=e72]:
                - /url: /en/for/ecommerce
            - listitem [ref=e73]:
              - link "Real estate" [ref=e74]:
                - /url: /en/for/real-estate
            - listitem [ref=e75]:
              - link "Law firms" [ref=e76]:
                - /url: /en/for/legal
            - listitem [ref=e77]:
              - link "Startups" [ref=e78]:
                - /url: /en/for/startups
            - listitem [ref=e79]:
              - link "Clinics & aesthetics" [ref=e80]:
                - /url: /en/for/clinics
            - listitem [ref=e81]:
              - link "Restaurants & cafés" [ref=e82]:
                - /url: /en/for/restaurants
            - listitem [ref=e83]:
              - link "Marketing agencies" [ref=e84]:
                - /url: /en/for/agencies
        - navigation "Resources" [ref=e85]:
          - paragraph [ref=e86]: Resources
          - list [ref=e87]:
            - listitem [ref=e88]:
              - link "Blog and guides" [ref=e89]:
                - /url: /en/blog
            - listitem [ref=e90]:
              - link "Free tools" [ref=e91]:
                - /url: /en/tools
            - listitem [ref=e92]:
              - link "Help center" [ref=e93]:
                - /url: /en/help
            - listitem [ref=e94]:
              - link "What is an AI marketing agent?" [ref=e95]:
                - /url: /en/ai-marketing-agent
            - listitem [ref=e96]:
              - link "Affiliate program" [ref=e97]:
                - /url: /en/affiliates
        - navigation "Company" [ref=e98]:
          - paragraph [ref=e99]: Company
          - list [ref=e100]:
            - listitem [ref=e101]:
              - link "Customers" [ref=e102]:
                - /url: /en/customers
            - listitem [ref=e103]:
              - link "Enterprise" [ref=e104]:
                - /url: /en/enterprise
            - listitem [ref=e105]:
              - link "Pricing" [ref=e106]:
                - /url: /en/pricing
            - listitem [ref=e107]:
              - link "Comparisons" [ref=e108]:
                - /url: /en/resources#compare
            - listitem [ref=e109]:
              - link "Privacy" [ref=e110]:
                - /url: /en/privacy
            - listitem [ref=e111]:
              - link "Terms" [ref=e112]:
                - /url: /en/terms
      - generic [ref=e113]:
        - paragraph [ref=e114]: © 2026 Nashr. All rights reserved.
        - group "Language" [ref=e115]:
          - link "العربية" [ref=e116]:
            - /url: /ar/terms
            - text: عربي
          - link "English" [ref=e117]:
            - /url: /en/terms
            - text: EN
  - alert [ref=e118]
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