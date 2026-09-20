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
      - link "Nashr" [ref=e4]:
        - /url: /en
      - generic [ref=e6]:
        - group "Language" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/blog
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/blog
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
    - heading "Blog" [level=1] [ref=e22]
    - list [ref=e23]:
      - listitem [ref=e24]:
        - 'link "White Friday 2026 for Saudi Stores: The Complete Guide" [ref=e25]':
          - /url: /en/blog/white-friday-saudi-guide-2026
        - paragraph [ref=e26]: "A 6-week schedule: warm-up, waitlists, retargeting, WhatsApp, budgets, and what to do after the season."
        - paragraph [ref=e27]: 2026-09-17
      - listitem [ref=e28]:
        - 'link "WhatsApp Abandoned Cart Recovery: The Complete Guide 2026" [ref=e29]':
          - /url: /en/blog/whatsapp-cart-recovery-guide-2026
        - paragraph [ref=e30]: Why WhatsApp beats email in the Gulf, approved templates, 1/24/72 timing, ready messages, and expected numbers.
        - paragraph [ref=e31]: 2026-09-17
      - listitem [ref=e32]:
        - 'link "Startup Marketing on LinkedIn and X in the Gulf: The Complete Guide 2026" [ref=e33]':
          - /url: /en/blog/startup-marketing-linkedin-x-guide-2026
        - paragraph [ref=e34]: Founder voice, weekly cadence, launching with a thread, small-budget ad experiments, and the numbers investors read.
        - paragraph [ref=e35]: 2026-09-17
      - listitem [ref=e36]:
        - 'link "Snapchat Ads for Saudi Stores: The Complete Guide 2026" [ref=e37]':
          - /url: /en/blog/snapchat-ads-saudi-guide-2026
        - paragraph [ref=e38]: Why Snap first in Saudi, account structure, creative that works, budgets, measurement, and the mistakes that burn money.
        - paragraph [ref=e39]: 2026-09-17
      - listitem [ref=e40]:
        - 'link "Salla Store Marketing: The Complete Guide 2026" [ref=e41]':
          - /url: /en/blog/salla-store-marketing-guide-2026
        - paragraph [ref=e42]: "From setup to ads: how a Salla merchant markets a store in Saudi Arabia on a small budget — channels, messages, seasons, tools."
        - paragraph [ref=e43]: 2026-09-17
      - listitem [ref=e44]:
        - 'link "Restaurant & Café Marketing in Saudi Arabia: The Complete Guide 2026" [ref=e45]':
          - /url: /en/blog/restaurant-marketing-saudi-guide-2026
        - paragraph [ref=e46]: Google Business first, posting times, review replies, delivery apps, dish content, and multi-branch.
        - paragraph [ref=e47]: 2026-09-17
      - listitem [ref=e48]:
        - link "How to Replace Your Marketing Agency with AI in 2026 — a Gulf Playbook" [ref=e49]:
          - /url: /en/blog/replace-your-agency-with-ai
        - paragraph [ref=e50]: Agencies charge SAR 5,000–25,000 a month for daily execution an AI agent does for under 1,000. A 30-day migration plan, and what stays human.
        - paragraph [ref=e51]: 2026-09-17
      - listitem [ref=e52]:
        - 'link "Real Estate & Developer Marketing in Saudi Arabia: The Complete Guide 2026" [ref=e53]':
          - /url: /en/blog/real-estate-marketing-saudi-guide-2026
        - paragraph [ref=e54]: Project launch sequence, construction-progress content, compliant advertising (REGA), WhatsApp lead qualification, and cost per qualified lead.
        - paragraph [ref=e55]: 2026-09-17
      - listitem [ref=e56]:
        - 'link "Ramadan Marketing for Stores and Restaurants: The Complete Guide" [ref=e57]':
          - /url: /en/blog/ramadan-marketing-guide-2026
        - paragraph [ref=e58]: Posting after Iftar, last-ten-nights campaigns, Iftar boxes, Eid gifts, and WhatsApp messages that respect the month and still sell.
        - paragraph [ref=e59]: 2026-09-17
      - listitem [ref=e60]:
        - link "Nashr vs Enrich Labs — why we built a Gulf marketing agent instead of using the American one" [ref=e61]:
          - /url: /en/blog/nashr-vs-enrich-labs
        - paragraph [ref=e62]: We tried Helena. Excellent for America. Here is everything it didn't understand about our market, and what we built instead.
        - paragraph [ref=e63]: 2026-09-17
      - listitem [ref=e64]:
        - 'link "Law Firm Marketing in Saudi Arabia: The Complete Guide 2026" [ref=e65]':
          - /url: /en/blog/law-firm-marketing-saudi-guide-2026
        - paragraph [ref=e66]: What professional advertising allows, LinkedIn and X for lawyers, content that AI answers cite, and consultation intake on WhatsApp.
        - paragraph [ref=e67]: 2026-09-17
      - listitem [ref=e68]:
        - 'link "Clinic Marketing in Saudi Arabia: The Complete Guide 2026 (MOH-compliant)" [ref=e69]':
          - /url: /en/blog/clinic-marketing-saudi-guide-2026
        - paragraph [ref=e70]: What medical advertising allows and forbids, the best channels for clinics, aesthetics and dental, doctor content, Google Business, and WhatsApp booking.
        - paragraph [ref=e71]: 2026-09-17
      - listitem [ref=e72]:
        - link "The 8 Best AI Marketing Agents for the Gulf in 2026 — a published rubric" [ref=e73]:
          - /url: /en/blog/best-ai-marketing-agents-gulf-2026
        - paragraph [ref=e74]: "We scored 8 tools on 6 weighted criteria: autonomous execution, Arabic and dialects, Gulf channels, compliance, human control, price. Nashr builds one of them — the full rubric is here."
        - paragraph [ref=e75]: 2026-09-17
  - contentinfo [ref=e76]:
    - generic [ref=e78]:
      - generic [ref=e79]:
        - generic [ref=e80]:
          - paragraph [ref=e81]: Nashr
          - paragraph [ref=e82]: A marketing agent that works 24/7 — built in Riyadh for the Gulf.
        - navigation "Agents" [ref=e83]:
          - paragraph [ref=e84]: Agents
          - list [ref=e85]:
            - listitem [ref=e86]:
              - link "Noor · Marketing" [ref=e87]:
                - /url: /en/agents/noor
            - listitem [ref=e88]:
              - link "Sami · Sales enablement" [ref=e89]:
                - /url: /en/agents/sami
            - listitem [ref=e90]:
              - link "Razan · Finance, pricing and revenue" [ref=e91]:
                - /url: /en/agents/razan
            - listitem [ref=e92]:
              - link "Faris · Go-to-market and growth" [ref=e93]:
                - /url: /en/agents/faris
            - listitem [ref=e94]:
              - link "Dana · Reports, dashboards and decks" [ref=e95]:
                - /url: /en/agents/dana
            - listitem [ref=e96]:
              - link "Majed · Executive advisor" [ref=e97]:
                - /url: /en/agents/majed
            - listitem [ref=e98]:
              - link "Layan · Product and retention" [ref=e99]:
                - /url: /en/agents/layan
        - navigation "Industries" [ref=e100]:
          - paragraph [ref=e101]: Industries
          - list [ref=e102]:
            - listitem [ref=e103]:
              - link "E-commerce" [ref=e104]:
                - /url: /en/for/ecommerce
            - listitem [ref=e105]:
              - link "Real estate" [ref=e106]:
                - /url: /en/for/real-estate
            - listitem [ref=e107]:
              - link "Law firms" [ref=e108]:
                - /url: /en/for/legal
            - listitem [ref=e109]:
              - link "Startups" [ref=e110]:
                - /url: /en/for/startups
            - listitem [ref=e111]:
              - link "Clinics & aesthetics" [ref=e112]:
                - /url: /en/for/clinics
            - listitem [ref=e113]:
              - link "Restaurants & cafés" [ref=e114]:
                - /url: /en/for/restaurants
            - listitem [ref=e115]:
              - link "Marketing agencies" [ref=e116]:
                - /url: /en/for/agencies
        - navigation "Resources" [ref=e117]:
          - paragraph [ref=e118]: Resources
          - list [ref=e119]:
            - listitem [ref=e120]:
              - link "Blog and guides" [ref=e121]:
                - /url: /en/blog
            - listitem [ref=e122]:
              - link "Free tools" [ref=e123]:
                - /url: /en/tools
            - listitem [ref=e124]:
              - link "Help center" [ref=e125]:
                - /url: /en/help
            - listitem [ref=e126]:
              - link "What is an AI marketing agent?" [ref=e127]:
                - /url: /en/ai-marketing-agent
            - listitem [ref=e128]:
              - link "Affiliate program" [ref=e129]:
                - /url: /en/affiliates
        - navigation "Company" [ref=e130]:
          - paragraph [ref=e131]: Company
          - list [ref=e132]:
            - listitem [ref=e133]:
              - link "Customers" [ref=e134]:
                - /url: /en/customers
            - listitem [ref=e135]:
              - link "Enterprise" [ref=e136]:
                - /url: /en/enterprise
            - listitem [ref=e137]:
              - link "Pricing" [ref=e138]:
                - /url: /en/pricing
            - listitem [ref=e139]:
              - link "Comparisons" [ref=e140]:
                - /url: /en/resources#compare
            - listitem [ref=e141]:
              - link "Privacy" [ref=e142]:
                - /url: /en/privacy
            - listitem [ref=e143]:
              - link "Terms" [ref=e144]:
                - /url: /en/terms
      - generic [ref=e145]:
        - paragraph [ref=e146]: © 2026 Nashr. All rights reserved.
        - group "Language" [ref=e147]:
          - link "العربية" [ref=e148]:
            - /url: /ar/blog
            - text: عربي
          - link "English" [ref=e149]:
            - /url: /en/blog
            - text: EN
  - alert [ref=e150]
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