# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: public-pages.spec.ts >> public pages · en >> /en/blog has its own title
- Location: e2e/public-pages.spec.ts:30:13

# Error details

```
Error: /en/blog must not fall back to the site-wide default title

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
            - /url: /ar/blog
            - text: عربي
          - link "English" [ref=e25] [cursor=pointer]:
            - /url: /en/blog
            - text: EN
        - link "Log in" [ref=e26] [cursor=pointer]:
          - /url: /en/app/login
        - link "Start free" [ref=e27] [cursor=pointer]:
          - /url: /en/app/signup
  - main [ref=e28]:
    - heading "Blog" [level=1] [ref=e29]
    - list [ref=e30]:
      - listitem [ref=e31]:
        - 'link "White Friday 2026 for Saudi Stores: The Complete Guide" [ref=e32] [cursor=pointer]':
          - /url: /en/blog/white-friday-saudi-guide-2026
        - paragraph [ref=e33]: "A 6-week schedule: warm-up, waitlists, retargeting, WhatsApp, budgets, and what to do after the season."
        - paragraph [ref=e34]: 2026-09-17
      - listitem [ref=e35]:
        - 'link "WhatsApp Abandoned Cart Recovery: The Complete Guide 2026" [ref=e36] [cursor=pointer]':
          - /url: /en/blog/whatsapp-cart-recovery-guide-2026
        - paragraph [ref=e37]: Why WhatsApp beats email in the Gulf, approved templates, 1/24/72 timing, ready messages, and expected numbers.
        - paragraph [ref=e38]: 2026-09-17
      - listitem [ref=e39]:
        - 'link "Startup Marketing on LinkedIn and X in the Gulf: The Complete Guide 2026" [ref=e40] [cursor=pointer]':
          - /url: /en/blog/startup-marketing-linkedin-x-guide-2026
        - paragraph [ref=e41]: Founder voice, weekly cadence, launching with a thread, small-budget ad experiments, and the numbers investors read.
        - paragraph [ref=e42]: 2026-09-17
      - listitem [ref=e43]:
        - 'link "Snapchat Ads for Saudi Stores: The Complete Guide 2026" [ref=e44] [cursor=pointer]':
          - /url: /en/blog/snapchat-ads-saudi-guide-2026
        - paragraph [ref=e45]: Why Snap first in Saudi, account structure, creative that works, budgets, measurement, and the mistakes that burn money.
        - paragraph [ref=e46]: 2026-09-17
      - listitem [ref=e47]:
        - 'link "Salla Store Marketing: The Complete Guide 2026" [ref=e48] [cursor=pointer]':
          - /url: /en/blog/salla-store-marketing-guide-2026
        - paragraph [ref=e49]: "From setup to ads: how a Salla merchant markets a store in Saudi Arabia on a small budget — channels, messages, seasons, tools."
        - paragraph [ref=e50]: 2026-09-17
      - listitem [ref=e51]:
        - 'link "Restaurant & Café Marketing in Saudi Arabia: The Complete Guide 2026" [ref=e52] [cursor=pointer]':
          - /url: /en/blog/restaurant-marketing-saudi-guide-2026
        - paragraph [ref=e53]: Google Business first, posting times, review replies, delivery apps, dish content, and multi-branch.
        - paragraph [ref=e54]: 2026-09-17
      - listitem [ref=e55]:
        - link "How to Replace Your Marketing Agency with AI in 2026 — a Gulf Playbook" [ref=e56] [cursor=pointer]:
          - /url: /en/blog/replace-your-agency-with-ai
        - paragraph [ref=e57]: Agencies charge SAR 5,000–25,000 a month for daily execution an AI agent does for under 1,000. A 30-day migration plan, and what stays human.
        - paragraph [ref=e58]: 2026-09-17
      - listitem [ref=e59]:
        - 'link "Real Estate & Developer Marketing in Saudi Arabia: The Complete Guide 2026" [ref=e60] [cursor=pointer]':
          - /url: /en/blog/real-estate-marketing-saudi-guide-2026
        - paragraph [ref=e61]: Project launch sequence, construction-progress content, compliant advertising (REGA), WhatsApp lead qualification, and cost per qualified lead.
        - paragraph [ref=e62]: 2026-09-17
      - listitem [ref=e63]:
        - 'link "Ramadan Marketing for Stores and Restaurants: The Complete Guide" [ref=e64] [cursor=pointer]':
          - /url: /en/blog/ramadan-marketing-guide-2026
        - paragraph [ref=e65]: Posting after Iftar, last-ten-nights campaigns, Iftar boxes, Eid gifts, and WhatsApp messages that respect the month and still sell.
        - paragraph [ref=e66]: 2026-09-17
      - listitem [ref=e67]:
        - link "Nashr vs Enrich Labs — why we built a Gulf marketing agent instead of using the American one" [ref=e68] [cursor=pointer]:
          - /url: /en/blog/nashr-vs-enrich-labs
        - paragraph [ref=e69]: We tried Helena. Excellent for America. Here is everything it didn't understand about our market, and what we built instead.
        - paragraph [ref=e70]: 2026-09-17
      - listitem [ref=e71]:
        - 'link "Law Firm Marketing in Saudi Arabia: The Complete Guide 2026" [ref=e72] [cursor=pointer]':
          - /url: /en/blog/law-firm-marketing-saudi-guide-2026
        - paragraph [ref=e73]: What professional advertising allows, LinkedIn and X for lawyers, content that AI answers cite, and consultation intake on WhatsApp.
        - paragraph [ref=e74]: 2026-09-17
      - listitem [ref=e75]:
        - 'link "Clinic Marketing in Saudi Arabia: The Complete Guide 2026 (MOH-compliant)" [ref=e76] [cursor=pointer]':
          - /url: /en/blog/clinic-marketing-saudi-guide-2026
        - paragraph [ref=e77]: What medical advertising allows and forbids, the best channels for clinics, aesthetics and dental, doctor content, Google Business, and WhatsApp booking.
        - paragraph [ref=e78]: 2026-09-17
      - listitem [ref=e79]:
        - link "The 8 Best AI Marketing Agents for the Gulf in 2026 — a published rubric" [ref=e80] [cursor=pointer]:
          - /url: /en/blog/best-ai-marketing-agents-gulf-2026
        - paragraph [ref=e81]: "We scored 8 tools on 6 weighted criteria: autonomous execution, Arabic and dialects, Gulf channels, compliance, human control, price. Nashr builds one of them — the full rubric is here."
        - paragraph [ref=e82]: 2026-09-17
  - contentinfo [ref=e83]:
    - generic [ref=e85]:
      - generic [ref=e86]:
        - generic [ref=e87]:
          - paragraph [ref=e88]: Nashr
          - paragraph [ref=e89]: A marketing agent that works 24/7 — built in Riyadh for the Gulf.
        - navigation "Agents" [ref=e90]:
          - paragraph [ref=e91]: Agents
          - list [ref=e92]:
            - listitem [ref=e93]:
              - link "Noor · Marketing" [ref=e94] [cursor=pointer]:
                - /url: /en/agents/noor
            - listitem [ref=e95]:
              - link "Sami · Sales enablement" [ref=e96] [cursor=pointer]:
                - /url: /en/agents/sami
            - listitem [ref=e97]:
              - link "Razan · Finance, pricing and revenue" [ref=e98] [cursor=pointer]:
                - /url: /en/agents/razan
            - listitem [ref=e99]:
              - link "Faris · Go-to-market and growth" [ref=e100] [cursor=pointer]:
                - /url: /en/agents/faris
            - listitem [ref=e101]:
              - link "Dana · Reports, dashboards and decks" [ref=e102] [cursor=pointer]:
                - /url: /en/agents/dana
            - listitem [ref=e103]:
              - link "Majed · Executive advisor" [ref=e104] [cursor=pointer]:
                - /url: /en/agents/majed
            - listitem [ref=e105]:
              - link "Layan · Product and retention" [ref=e106] [cursor=pointer]:
                - /url: /en/agents/layan
        - navigation "Industries" [ref=e107]:
          - paragraph [ref=e108]: Industries
          - list [ref=e109]:
            - listitem [ref=e110]:
              - link "E-commerce" [ref=e111] [cursor=pointer]:
                - /url: /en/for/ecommerce
            - listitem [ref=e112]:
              - link "Real estate" [ref=e113] [cursor=pointer]:
                - /url: /en/for/real-estate
            - listitem [ref=e114]:
              - link "Law firms" [ref=e115] [cursor=pointer]:
                - /url: /en/for/legal
            - listitem [ref=e116]:
              - link "Startups" [ref=e117] [cursor=pointer]:
                - /url: /en/for/startups
            - listitem [ref=e118]:
              - link "Clinics & aesthetics" [ref=e119] [cursor=pointer]:
                - /url: /en/for/clinics
            - listitem [ref=e120]:
              - link "Restaurants & cafés" [ref=e121] [cursor=pointer]:
                - /url: /en/for/restaurants
            - listitem [ref=e122]:
              - link "Marketing agencies" [ref=e123] [cursor=pointer]:
                - /url: /en/for/agencies
        - navigation "Resources" [ref=e124]:
          - paragraph [ref=e125]: Resources
          - list [ref=e126]:
            - listitem [ref=e127]:
              - link "Blog and guides" [ref=e128] [cursor=pointer]:
                - /url: /en/blog
            - listitem [ref=e129]:
              - link "Free tools" [ref=e130] [cursor=pointer]:
                - /url: /en/tools
            - listitem [ref=e131]:
              - link "Help center" [ref=e132] [cursor=pointer]:
                - /url: /en/help
            - listitem [ref=e133]:
              - link "What is an AI marketing agent?" [ref=e134] [cursor=pointer]:
                - /url: /en/ai-marketing-agent
            - listitem [ref=e135]:
              - link "Affiliate program" [ref=e136] [cursor=pointer]:
                - /url: /en/affiliates
        - navigation "Company" [ref=e137]:
          - paragraph [ref=e138]: Company
          - list [ref=e139]:
            - listitem [ref=e140]:
              - link "Customers" [ref=e141] [cursor=pointer]:
                - /url: /en/customers
            - listitem [ref=e142]:
              - link "Enterprise" [ref=e143] [cursor=pointer]:
                - /url: /en/enterprise
            - listitem [ref=e144]:
              - link "Pricing" [ref=e145] [cursor=pointer]:
                - /url: /en/pricing
            - listitem [ref=e146]:
              - link "Comparisons" [ref=e147] [cursor=pointer]:
                - /url: /en/resources#compare
            - listitem [ref=e148]:
              - link "Privacy" [ref=e149] [cursor=pointer]:
                - /url: /en/privacy
            - listitem [ref=e150]:
              - link "Terms" [ref=e151] [cursor=pointer]:
                - /url: /en/terms
      - generic [ref=e152]:
        - paragraph [ref=e153]: © 2026 Nashr. All rights reserved.
        - group "Language" [ref=e154]:
          - link "العربية" [ref=e155] [cursor=pointer]:
            - /url: /ar/blog
            - text: عربي
          - link "English" [ref=e156] [cursor=pointer]:
            - /url: /en/blog
            - text: EN
  - alert [ref=e157]
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
     |                                                                                          ^ Error: /en/blog must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```