# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: public-pages.spec.ts >> public pages · en >> /en/affiliates has its own title
- Location: e2e/public-pages.spec.ts:30:13

# Error details

```
Error: /en/affiliates must not fall back to the site-wide default title

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
            - /url: /ar/affiliates
            - text: عربي
          - link "English" [ref=e25] [cursor=pointer]:
            - /url: /en/affiliates
            - text: EN
        - link "Log in" [ref=e26] [cursor=pointer]:
          - /url: /en/app/login
        - link "Start free" [ref=e27] [cursor=pointer]:
          - /url: /en/app/signup
  - main [ref=e28]:
    - paragraph [ref=e29]: Partner program
    - heading "Earn 25% recurring on every customer you refer to Nashr." [level=1] [ref=e30]
    - paragraph [ref=e31]: For Gulf agencies, consultants, creators and newsletters. Your client gets an AI marketer in their dialect; you get a quarter of every invoice, forever.
    - generic [ref=e32]:
      - generic [ref=e33]:
        - paragraph [ref=e34]: 25%
        - paragraph [ref=e35]: recurring on every payment, for the life of the customer
      - generic [ref=e36]:
        - paragraph [ref=e37]: 60 days
        - paragraph [ref=e38]: attribution window from click
      - generic [ref=e39]:
        - paragraph [ref=e40]: Monthly
        - paragraph [ref=e41]: payouts by bank transfer, SAR 200 minimum
      - generic [ref=e42]:
        - paragraph [ref=e43]: "0"
        - paragraph [ref=e44]: fees or minimum referrals
    - generic [ref=e45]:
      - generic [ref=e46]:
        - heading "How it works" [level=2] [ref=e47]
        - list [ref=e48]:
          - listitem [ref=e49]:
            - generic [ref=e50]: "1."
            - text: Apply below. We approve within one business day.
          - listitem [ref=e51]:
            - generic [ref=e52]: "2."
            - text: You get your link and code, plus ready-to-post copy.
          - listitem [ref=e53]:
            - generic [ref=e54]: "3."
            - text: Anyone who signs up via your link and subscribes within 60 days counts.
          - listitem [ref=e55]:
            - generic [ref=e56]: "4."
            - text: You receive 25% of every payment, monthly, by bank transfer.
        - heading "Rules" [level=2] [ref=e57]
        - list [ref=e58]:
          - listitem [ref=e59]: • No paid search on the 'Nashr' or 'Noor' brand.
          - listitem [ref=e60]: • No self-referrals.
          - listitem [ref=e61]: • 30-day verification per payment before commission is released.
      - generic [ref=e62]:
        - heading "Apply" [level=2] [ref=e63]
        - textbox "Your name" [ref=e64]
        - textbox "Email" [ref=e65]
        - textbox "WhatsApp +966…" [ref=e66]
        - textbox "Where will you promote? (agency, YouTube, newsletter, LinkedIn…)" [ref=e67]
        - textbox "Audience size / number of clients" [ref=e68]
        - button "Send application" [ref=e69] [cursor=pointer]
  - contentinfo [ref=e70]:
    - generic [ref=e72]:
      - generic [ref=e73]:
        - generic [ref=e74]:
          - paragraph [ref=e75]: Nashr
          - paragraph [ref=e76]: A marketing agent that works 24/7 — built in Riyadh for the Gulf.
        - navigation "Agents" [ref=e77]:
          - paragraph [ref=e78]: Agents
          - list [ref=e79]:
            - listitem [ref=e80]:
              - link "Noor · Marketing" [ref=e81] [cursor=pointer]:
                - /url: /en/agents/noor
            - listitem [ref=e82]:
              - link "Sami · Sales enablement" [ref=e83] [cursor=pointer]:
                - /url: /en/agents/sami
            - listitem [ref=e84]:
              - link "Razan · Finance, pricing and revenue" [ref=e85] [cursor=pointer]:
                - /url: /en/agents/razan
            - listitem [ref=e86]:
              - link "Faris · Go-to-market and growth" [ref=e87] [cursor=pointer]:
                - /url: /en/agents/faris
            - listitem [ref=e88]:
              - link "Dana · Reports, dashboards and decks" [ref=e89] [cursor=pointer]:
                - /url: /en/agents/dana
            - listitem [ref=e90]:
              - link "Majed · Executive advisor" [ref=e91] [cursor=pointer]:
                - /url: /en/agents/majed
            - listitem [ref=e92]:
              - link "Layan · Product and retention" [ref=e93] [cursor=pointer]:
                - /url: /en/agents/layan
        - navigation "Industries" [ref=e94]:
          - paragraph [ref=e95]: Industries
          - list [ref=e96]:
            - listitem [ref=e97]:
              - link "E-commerce" [ref=e98] [cursor=pointer]:
                - /url: /en/for/ecommerce
            - listitem [ref=e99]:
              - link "Real estate" [ref=e100] [cursor=pointer]:
                - /url: /en/for/real-estate
            - listitem [ref=e101]:
              - link "Law firms" [ref=e102] [cursor=pointer]:
                - /url: /en/for/legal
            - listitem [ref=e103]:
              - link "Startups" [ref=e104] [cursor=pointer]:
                - /url: /en/for/startups
            - listitem [ref=e105]:
              - link "Clinics & aesthetics" [ref=e106] [cursor=pointer]:
                - /url: /en/for/clinics
            - listitem [ref=e107]:
              - link "Restaurants & cafés" [ref=e108] [cursor=pointer]:
                - /url: /en/for/restaurants
            - listitem [ref=e109]:
              - link "Marketing agencies" [ref=e110] [cursor=pointer]:
                - /url: /en/for/agencies
        - navigation "Resources" [ref=e111]:
          - paragraph [ref=e112]: Resources
          - list [ref=e113]:
            - listitem [ref=e114]:
              - link "Blog and guides" [ref=e115] [cursor=pointer]:
                - /url: /en/blog
            - listitem [ref=e116]:
              - link "Free tools" [ref=e117] [cursor=pointer]:
                - /url: /en/tools
            - listitem [ref=e118]:
              - link "Help center" [ref=e119] [cursor=pointer]:
                - /url: /en/help
            - listitem [ref=e120]:
              - link "What is an AI marketing agent?" [ref=e121] [cursor=pointer]:
                - /url: /en/ai-marketing-agent
            - listitem [ref=e122]:
              - link "Affiliate program" [ref=e123] [cursor=pointer]:
                - /url: /en/affiliates
        - navigation "Company" [ref=e124]:
          - paragraph [ref=e125]: Company
          - list [ref=e126]:
            - listitem [ref=e127]:
              - link "Customers" [ref=e128] [cursor=pointer]:
                - /url: /en/customers
            - listitem [ref=e129]:
              - link "Enterprise" [ref=e130] [cursor=pointer]:
                - /url: /en/enterprise
            - listitem [ref=e131]:
              - link "Pricing" [ref=e132] [cursor=pointer]:
                - /url: /en/pricing
            - listitem [ref=e133]:
              - link "Comparisons" [ref=e134] [cursor=pointer]:
                - /url: /en/resources#compare
            - listitem [ref=e135]:
              - link "Privacy" [ref=e136] [cursor=pointer]:
                - /url: /en/privacy
            - listitem [ref=e137]:
              - link "Terms" [ref=e138] [cursor=pointer]:
                - /url: /en/terms
      - generic [ref=e139]:
        - paragraph [ref=e140]: © 2026 Nashr. All rights reserved.
        - group "Language" [ref=e141]:
          - link "العربية" [ref=e142] [cursor=pointer]:
            - /url: /ar/affiliates
            - text: عربي
          - link "English" [ref=e143] [cursor=pointer]:
            - /url: /en/affiliates
            - text: EN
  - alert [ref=e144]
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
     |                                                                                          ^ Error: /en/affiliates must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```