# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: public-pages.spec.ts >> public pages · en >> /en/pricing renders
- Location: e2e/public-pages.spec.ts:14:11

# Error details

```
Error: /en/pricing must have exactly one h1

expect(locator).toHaveCount(expected) failed

Locator:  locator('h1')
Expected: 1
Received: 0
Timeout:  10000ms

Call log:
  - /en/pricing must have exactly one h1 locator('h1') with timeout 10000ms
  - waiting for locator('h1')
    24 × locator resolved to 0 elements
       - unexpected value "0"

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
            - /url: /ar/pricing
            - text: عربي
          - link "English" [ref=e25] [cursor=pointer]:
            - /url: /en/pricing
            - text: EN
        - link "Log in" [ref=e26] [cursor=pointer]:
          - /url: /en/app/login
        - link "Start free" [ref=e27] [cursor=pointer]:
          - /url: /en/app/signup
  - main [ref=e28]:
    - generic [ref=e30]:
      - paragraph [ref=e31]: Pricing
      - heading "Cheaper than one hire. Faster than an agency." [level=2] [ref=e32]
      - paragraph [ref=e33]: In Saudi riyals, VAT applied at checkout. Cancel anytime.
      - generic [ref=e34]:
        - generic [ref=e35]: 3-day free trial — no card
        - generic [ref=e36]: Pay yearly, get two months free
      - generic [ref=e37]:
        - article [ref=e38]:
          - heading "Starter" [level=3] [ref=e39]
          - paragraph [ref=e40]: For solo sellers and creators
          - paragraph [ref=e41]:
            - generic [ref=e42]: "149"
            - generic [ref=e43]: SAR / month
          - paragraph [ref=e44]: 200 credits / month
          - list [ref=e45]:
            - listitem [ref=e46]:
              - generic [ref=e48]: 1 brand, 1 seat
            - listitem [ref=e49]:
              - generic [ref=e51]: Social posts + images
            - listitem [ref=e52]:
              - generic [ref=e54]: Arabic SEO articles
            - listitem [ref=e55]:
              - generic [ref=e57]: Snap & Meta campaigns (read + suggest)
            - listitem [ref=e58]:
              - generic [ref=e60]: Weekly WhatsApp brief
            - listitem [ref=e61]:
              - generic [ref=e63]: 10 concurrent tasks
          - link "Start free" [ref=e64] [cursor=pointer]:
            - /url: /en/app/signup
        - article [ref=e65]:
          - heading "Pro" [level=3] [ref=e66]
          - paragraph [ref=e67]: For founders, stores, and clinics
          - paragraph [ref=e68]:
            - generic [ref=e69]: "399"
            - generic [ref=e70]: SAR / month
          - paragraph [ref=e71]: 700 credits / month
          - list [ref=e72]:
            - listitem [ref=e73]:
              - generic [ref=e75]: Everything in Starter
            - listitem [ref=e76]:
              - generic [ref=e78]: Auto ad optimization within your guardrails
            - listitem [ref=e79]:
              - generic [ref=e81]: WhatsApp campaigns + cart recovery
            - listitem [ref=e82]:
              - generic [ref=e84]: Weekly ad audit and waste detection
            - listitem [ref=e85]:
              - generic [ref=e87]: Daily 8 AM brief
            - listitem [ref=e88]:
              - generic [ref=e90]: 70+ Gulf-ready playbooks
            - listitem [ref=e91]:
              - generic [ref=e93]: Extra seats SAR 99 / seat
            - listitem [ref=e94]:
              - generic [ref=e96]: 20 concurrent tasks
          - link "Start free" [ref=e97] [cursor=pointer]:
            - /url: /en/app/signup
        - article [ref=e98]:
          - heading "Agency" [level=3] [ref=e99]
          - paragraph [ref=e100]: For agencies and multi-branch
          - paragraph [ref=e101]:
            - generic [ref=e102]: "799"
            - generic [ref=e103]: SAR / month
          - paragraph [ref=e104]: 2,000 credits / month — rolls over
          - list [ref=e105]:
            - listitem [ref=e106]:
              - generic [ref=e108]: Everything in Pro
            - listitem [ref=e109]:
              - generic [ref=e111]: Multi-brand (5 included)
            - listitem [ref=e112]:
              - generic [ref=e114]: Extra brand SAR 99
            - listitem [ref=e115]:
              - generic [ref=e117]: White-label client reports
            - listitem [ref=e118]:
              - generic [ref=e120]: Team roles and permissions
            - listitem [ref=e121]:
              - generic [ref=e123]: Ad optimization every 2 hours
            - listitem [ref=e124]:
              - generic [ref=e126]: Unlimited tasks
            - listitem [ref=e127]:
              - generic [ref=e129]: MCP and API access
          - link "Start free" [ref=e130] [cursor=pointer]:
            - /url: /en/app/signup
        - article [ref=e131]:
          - heading "Enterprise" [level=3] [ref=e132]
          - paragraph [ref=e133]: For groups and large organizations
          - paragraph [ref=e134]:
            - generic [ref=e135]: Custom
            - generic [ref=e136]: annual billing
          - paragraph [ref=e137]: Custom credits
          - list [ref=e138]:
            - listitem [ref=e139]:
              - generic [ref=e141]: All specialist agents
            - listitem [ref=e142]:
              - generic [ref=e144]: Data hosted inside Saudi Arabia
            - listitem [ref=e145]:
              - generic [ref=e147]: CRM and data warehouse connections
            - listitem [ref=e148]:
              - generic [ref=e150]: Model trained on your brand voice
            - listitem [ref=e151]:
              - generic [ref=e153]: Dedicated success manager
            - listitem [ref=e154]:
              - generic [ref=e156]: 1-hour SLA
            - listitem [ref=e157]:
              - generic [ref=e159]: Unlimited brands and users
          - link "Book a demo" [ref=e160] [cursor=pointer]:
            - /url: /en/app/signup
      - generic [ref=e161]:
        - heading "What does each task cost?" [level=3] [ref=e162]
        - table [ref=e163]:
          - rowgroup [ref=e164]:
            - row [ref=e165]:
              - cell "Social post / ad / WhatsApp message / image" [ref=e166]
              - cell "1" [ref=e167]
            - row [ref=e168]:
              - cell "SEO article / lead qualification card / weekly report" [ref=e169]
              - cell "2" [ref=e170]
            - row [ref=e171]:
              - cell "Unit economics / follow-up cadence" [ref=e172]
              - cell "3" [ref=e173]
            - row [ref=e174]:
              - cell "Sales scripts / pricing review / cash forecast / growth experiments" [ref=e175]
              - cell "4" [ref=e176]
            - row [ref=e177]:
              - cell "Go-to-market plan / board deck / strategy review" [ref=e178]
              - cell "5" [ref=e179]
            - row [ref=e180]:
              - cell "Chatting with the team and onboarding from your URL" [ref=e181]
              - cell "Free" [ref=e182]
    - generic [ref=e185]:
      - paragraph [ref=e186]: FAQ
      - heading "Questions? Good to know." [level=2] [ref=e187]
      - generic [ref=e188]:
        - group [ref=e189]:
          - generic "Can't I just use ChatGPT or Claude?" [ref=e190] [cursor=pointer]:
            - text: Can't I just use ChatGPT or Claude?
            - generic [aria-hidden] [ref=e191]: +
        - group [ref=e192]:
          - generic "Does Noor publish without permission?" [ref=e193] [cursor=pointer]:
            - text: Does Noor publish without permission?
            - generic [aria-hidden] [ref=e194]: +
        - group [ref=e195]:
          - generic "What is the morning brief?" [ref=e196] [cursor=pointer]:
            - text: What is the morning brief?
            - generic [aria-hidden] [ref=e197]: +
        - group [ref=e198]:
          - generic "How long until I see results?" [ref=e199] [cursor=pointer]:
            - text: How long until I see results?
            - generic [aria-hidden] [ref=e200]: +
        - group [ref=e201]:
          - generic "How much does it cost?" [ref=e202] [cursor=pointer]:
            - text: How much does it cost?
            - generic [aria-hidden] [ref=e203]: +
        - group [ref=e204]:
          - generic "What about privacy?" [ref=e205] [cursor=pointer]:
            - text: What about privacy?
            - generic [aria-hidden] [ref=e206]: +
        - group [ref=e207]:
          - generic "Does Noor learn my brand voice?" [ref=e208] [cursor=pointer]:
            - text: Does Noor learn my brand voice?
            - generic [aria-hidden] [ref=e209]: +
        - group [ref=e210]:
          - generic "Can I cancel anytime?" [ref=e211] [cursor=pointer]:
            - text: Can I cancel anytime?
            - generic [aria-hidden] [ref=e212]: +
        - group [ref=e213]:
          - generic "Who else is on the team?" [ref=e214] [cursor=pointer]:
            - text: Who else is on the team?
            - generic [aria-hidden] [ref=e215]: +
    - generic [ref=e217]:
      - heading "While you sleep, Noor markets." [level=2] [ref=e218]
      - paragraph [ref=e219]: 3-day free trial — no card
      - link "Start your free trial" [ref=e220] [cursor=pointer]:
        - /url: /en/app/signup
  - contentinfo [ref=e221]:
    - generic [ref=e223]:
      - generic [ref=e224]:
        - generic [ref=e225]:
          - paragraph [ref=e226]: Nashr
          - paragraph [ref=e227]: A marketing agent that works 24/7 — built in Riyadh for the Gulf.
        - navigation "Agents" [ref=e228]:
          - paragraph [ref=e229]: Agents
          - list [ref=e230]:
            - listitem [ref=e231]:
              - link "Noor · Marketing" [ref=e232] [cursor=pointer]:
                - /url: /en/agents/noor
            - listitem [ref=e233]:
              - link "Sami · Sales enablement" [ref=e234] [cursor=pointer]:
                - /url: /en/agents/sami
            - listitem [ref=e235]:
              - link "Razan · Finance, pricing and revenue" [ref=e236] [cursor=pointer]:
                - /url: /en/agents/razan
            - listitem [ref=e237]:
              - link "Faris · Go-to-market and growth" [ref=e238] [cursor=pointer]:
                - /url: /en/agents/faris
            - listitem [ref=e239]:
              - link "Dana · Reports, dashboards and decks" [ref=e240] [cursor=pointer]:
                - /url: /en/agents/dana
            - listitem [ref=e241]:
              - link "Majed · Executive advisor" [ref=e242] [cursor=pointer]:
                - /url: /en/agents/majed
            - listitem [ref=e243]:
              - link "Layan · Product and retention" [ref=e244] [cursor=pointer]:
                - /url: /en/agents/layan
        - navigation "Industries" [ref=e245]:
          - paragraph [ref=e246]: Industries
          - list [ref=e247]:
            - listitem [ref=e248]:
              - link "E-commerce" [ref=e249] [cursor=pointer]:
                - /url: /en/for/ecommerce
            - listitem [ref=e250]:
              - link "Real estate" [ref=e251] [cursor=pointer]:
                - /url: /en/for/real-estate
            - listitem [ref=e252]:
              - link "Law firms" [ref=e253] [cursor=pointer]:
                - /url: /en/for/legal
            - listitem [ref=e254]:
              - link "Startups" [ref=e255] [cursor=pointer]:
                - /url: /en/for/startups
            - listitem [ref=e256]:
              - link "Clinics & aesthetics" [ref=e257] [cursor=pointer]:
                - /url: /en/for/clinics
            - listitem [ref=e258]:
              - link "Restaurants & cafés" [ref=e259] [cursor=pointer]:
                - /url: /en/for/restaurants
            - listitem [ref=e260]:
              - link "Marketing agencies" [ref=e261] [cursor=pointer]:
                - /url: /en/for/agencies
        - navigation "Resources" [ref=e262]:
          - paragraph [ref=e263]: Resources
          - list [ref=e264]:
            - listitem [ref=e265]:
              - link "Blog and guides" [ref=e266] [cursor=pointer]:
                - /url: /en/blog
            - listitem [ref=e267]:
              - link "Free tools" [ref=e268] [cursor=pointer]:
                - /url: /en/tools
            - listitem [ref=e269]:
              - link "Help center" [ref=e270] [cursor=pointer]:
                - /url: /en/help
            - listitem [ref=e271]:
              - link "What is an AI marketing agent?" [ref=e272] [cursor=pointer]:
                - /url: /en/ai-marketing-agent
            - listitem [ref=e273]:
              - link "Affiliate program" [ref=e274] [cursor=pointer]:
                - /url: /en/affiliates
        - navigation "Company" [ref=e275]:
          - paragraph [ref=e276]: Company
          - list [ref=e277]:
            - listitem [ref=e278]:
              - link "Customers" [ref=e279] [cursor=pointer]:
                - /url: /en/customers
            - listitem [ref=e280]:
              - link "Enterprise" [ref=e281] [cursor=pointer]:
                - /url: /en/enterprise
            - listitem [ref=e282]:
              - link "Pricing" [ref=e283] [cursor=pointer]:
                - /url: /en/pricing
            - listitem [ref=e284]:
              - link "Comparisons" [ref=e285] [cursor=pointer]:
                - /url: /en/resources#compare
            - listitem [ref=e286]:
              - link "Privacy" [ref=e287] [cursor=pointer]:
                - /url: /en/privacy
            - listitem [ref=e288]:
              - link "Terms" [ref=e289] [cursor=pointer]:
                - /url: /en/terms
      - generic [ref=e290]:
        - paragraph [ref=e291]: © 2026 Nashr. All rights reserved.
        - group "Language" [ref=e292]:
          - link "العربية" [ref=e293] [cursor=pointer]:
            - /url: /ar/pricing
            - text: عربي
          - link "English" [ref=e294] [cursor=pointer]:
            - /url: /en/pricing
            - text: EN
  - alert [ref=e295]
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
> 23 |         await expect(page.locator("h1"), `${path} must have exactly one h1`).toHaveCount(1);
     |                                                                              ^ Error: /en/pricing must have exactly one h1
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
  34 |           expect(title, `${path} must not fall back to the site-wide default title`).not.toBe(DEFAULT_TITLE[lang]);
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```