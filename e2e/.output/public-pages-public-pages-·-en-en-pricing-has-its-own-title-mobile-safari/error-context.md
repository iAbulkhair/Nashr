# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: public-pages.spec.ts >> public pages · en >> /en/pricing has its own title
- Location: e2e/public-pages.spec.ts:30:13

# Error details

```
Error: /en/pricing must not fall back to the site-wide default title

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
            - /url: /ar/pricing
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/pricing
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
    - generic [ref=e23]:
      - paragraph [ref=e24]: Pricing
      - heading "Cheaper than one hire. Faster than an agency." [level=2] [ref=e25]
      - paragraph [ref=e26]: In Saudi riyals, VAT applied at checkout. Cancel anytime.
      - generic [ref=e27]:
        - generic [ref=e28]: 3-day free trial — no card
        - generic [ref=e29]: Pay yearly, get two months free
      - generic [ref=e30]:
        - article [ref=e31]:
          - heading "Starter" [level=3] [ref=e32]
          - paragraph [ref=e33]: For solo sellers and creators
          - paragraph [ref=e34]:
            - generic [ref=e35]: "149"
            - generic [ref=e36]: SAR / month
          - paragraph [ref=e37]: 200 credits / month
          - list [ref=e38]:
            - listitem [ref=e39]:
              - generic [ref=e41]: 1 brand, 1 seat
            - listitem [ref=e42]:
              - generic [ref=e44]: Social posts + images
            - listitem [ref=e45]:
              - generic [ref=e47]: Arabic SEO articles
            - listitem [ref=e48]:
              - generic [ref=e50]: Snap & Meta campaigns (read + suggest)
            - listitem [ref=e51]:
              - generic [ref=e53]: Weekly WhatsApp brief
            - listitem [ref=e54]:
              - generic [ref=e56]: 10 concurrent tasks
          - link "Start free" [ref=e57]:
            - /url: /en/app/signup
        - article [ref=e58]:
          - heading "Pro" [level=3] [ref=e59]
          - paragraph [ref=e60]: For founders, stores, and clinics
          - paragraph [ref=e61]:
            - generic [ref=e62]: "399"
            - generic [ref=e63]: SAR / month
          - paragraph [ref=e64]: 700 credits / month
          - list [ref=e65]:
            - listitem [ref=e66]:
              - generic [ref=e68]: Everything in Starter
            - listitem [ref=e69]:
              - generic [ref=e71]: Auto ad optimization within your guardrails
            - listitem [ref=e72]:
              - generic [ref=e74]: WhatsApp campaigns + cart recovery
            - listitem [ref=e75]:
              - generic [ref=e77]: Weekly ad audit and waste detection
            - listitem [ref=e78]:
              - generic [ref=e80]: Daily 8 AM brief
            - listitem [ref=e81]:
              - generic [ref=e83]: 70+ Gulf-ready playbooks
            - listitem [ref=e84]:
              - generic [ref=e86]: Extra seats SAR 99 / seat
            - listitem [ref=e87]:
              - generic [ref=e89]: 20 concurrent tasks
          - link "Start free" [ref=e90]:
            - /url: /en/app/signup
        - article [ref=e91]:
          - heading "Agency" [level=3] [ref=e92]
          - paragraph [ref=e93]: For agencies and multi-branch
          - paragraph [ref=e94]:
            - generic [ref=e95]: "799"
            - generic [ref=e96]: SAR / month
          - paragraph [ref=e97]: 2,000 credits / month — rolls over
          - list [ref=e98]:
            - listitem [ref=e99]:
              - generic [ref=e101]: Everything in Pro
            - listitem [ref=e102]:
              - generic [ref=e104]: Multi-brand (5 included)
            - listitem [ref=e105]:
              - generic [ref=e107]: Extra brand SAR 99
            - listitem [ref=e108]:
              - generic [ref=e110]: White-label client reports
            - listitem [ref=e111]:
              - generic [ref=e113]: Team roles and permissions
            - listitem [ref=e114]:
              - generic [ref=e116]: Ad optimization every 2 hours
            - listitem [ref=e117]:
              - generic [ref=e119]: Unlimited tasks
            - listitem [ref=e120]:
              - generic [ref=e122]: MCP and API access
          - link "Start free" [ref=e123]:
            - /url: /en/app/signup
        - article [ref=e124]:
          - heading "Enterprise" [level=3] [ref=e125]
          - paragraph [ref=e126]: For groups and large organizations
          - paragraph [ref=e127]:
            - generic [ref=e128]: Custom
            - generic [ref=e129]: annual billing
          - paragraph [ref=e130]: Custom credits
          - list [ref=e131]:
            - listitem [ref=e132]:
              - generic [ref=e134]: All specialist agents
            - listitem [ref=e135]:
              - generic [ref=e137]: Data hosted inside Saudi Arabia
            - listitem [ref=e138]:
              - generic [ref=e140]: CRM and data warehouse connections
            - listitem [ref=e141]:
              - generic [ref=e143]: Model trained on your brand voice
            - listitem [ref=e144]:
              - generic [ref=e146]: Dedicated success manager
            - listitem [ref=e147]:
              - generic [ref=e149]: 1-hour SLA
            - listitem [ref=e150]:
              - generic [ref=e152]: Unlimited brands and users
          - link "Book a demo" [ref=e153]:
            - /url: /en/app/signup
      - generic [ref=e154]:
        - heading "What does each task cost?" [level=3] [ref=e155]
        - table [ref=e156]:
          - rowgroup [ref=e157]:
            - row [ref=e158]:
              - cell "Social post / ad / WhatsApp message / image" [ref=e159]
              - cell "1" [ref=e160]
            - row [ref=e161]:
              - cell "SEO article / lead qualification card / weekly report" [ref=e162]
              - cell "2" [ref=e163]
            - row [ref=e164]:
              - cell "Unit economics / follow-up cadence" [ref=e165]
              - cell "3" [ref=e166]
            - row [ref=e167]:
              - cell "Sales scripts / pricing review / cash forecast / growth experiments" [ref=e168]
              - cell "4" [ref=e169]
            - row [ref=e170]:
              - cell "Go-to-market plan / board deck / strategy review" [ref=e171]
              - cell "5" [ref=e172]
            - row [ref=e173]:
              - cell "Chatting with the team and onboarding from your URL" [ref=e174]
              - cell "Free" [ref=e175]
    - generic [ref=e178]:
      - paragraph [ref=e179]: FAQ
      - heading "Questions? Good to know." [level=2] [ref=e180]
      - generic [ref=e181]:
        - group [ref=e182]:
          - generic "Can't I just use ChatGPT or Claude?" [ref=e183] [cursor=pointer]:
            - text: Can't I just use ChatGPT or Claude?
            - generic [aria-hidden] [ref=e184]: +
        - group [ref=e185]:
          - generic "Does Noor publish without permission?" [ref=e186] [cursor=pointer]:
            - text: Does Noor publish without permission?
            - generic [aria-hidden] [ref=e187]: +
        - group [ref=e188]:
          - generic "What is the morning brief?" [ref=e189] [cursor=pointer]:
            - text: What is the morning brief?
            - generic [aria-hidden] [ref=e190]: +
        - group [ref=e191]:
          - generic "How long until I see results?" [ref=e192] [cursor=pointer]:
            - text: How long until I see results?
            - generic [aria-hidden] [ref=e193]: +
        - group [ref=e194]:
          - generic "How much does it cost?" [ref=e195] [cursor=pointer]:
            - text: How much does it cost?
            - generic [aria-hidden] [ref=e196]: +
        - group [ref=e197]:
          - generic "What about privacy?" [ref=e198] [cursor=pointer]:
            - text: What about privacy?
            - generic [aria-hidden] [ref=e199]: +
        - group [ref=e200]:
          - generic "Does Noor learn my brand voice?" [ref=e201] [cursor=pointer]:
            - text: Does Noor learn my brand voice?
            - generic [aria-hidden] [ref=e202]: +
        - group [ref=e203]:
          - generic "Can I cancel anytime?" [ref=e204] [cursor=pointer]:
            - text: Can I cancel anytime?
            - generic [aria-hidden] [ref=e205]: +
        - group [ref=e206]:
          - generic "Who else is on the team?" [ref=e207] [cursor=pointer]:
            - text: Who else is on the team?
            - generic [aria-hidden] [ref=e208]: +
    - generic [ref=e210]:
      - heading "While you sleep, Noor markets." [level=2] [ref=e211]
      - paragraph [ref=e212]: 3-day free trial — no card
      - link "Start your free trial" [ref=e213] [cursor=pointer]:
        - /url: /en/app/signup
  - contentinfo [ref=e214]:
    - generic [ref=e216]:
      - generic [ref=e217]:
        - generic [ref=e218]:
          - paragraph [ref=e219]: Nashr
          - paragraph [ref=e220]: A marketing agent that works 24/7 — built in Riyadh for the Gulf.
        - navigation "Agents" [ref=e221]:
          - paragraph [ref=e222]: Agents
          - list [ref=e223]:
            - listitem [ref=e224]:
              - link "Noor · Marketing" [ref=e225]:
                - /url: /en/agents/noor
            - listitem [ref=e226]:
              - link "Sami · Sales enablement" [ref=e227]:
                - /url: /en/agents/sami
            - listitem [ref=e228]:
              - link "Razan · Finance, pricing and revenue" [ref=e229]:
                - /url: /en/agents/razan
            - listitem [ref=e230]:
              - link "Faris · Go-to-market and growth" [ref=e231]:
                - /url: /en/agents/faris
            - listitem [ref=e232]:
              - link "Dana · Reports, dashboards and decks" [ref=e233]:
                - /url: /en/agents/dana
            - listitem [ref=e234]:
              - link "Majed · Executive advisor" [ref=e235]:
                - /url: /en/agents/majed
            - listitem [ref=e236]:
              - link "Layan · Product and retention" [ref=e237]:
                - /url: /en/agents/layan
        - navigation "Industries" [ref=e238]:
          - paragraph [ref=e239]: Industries
          - list [ref=e240]:
            - listitem [ref=e241]:
              - link "E-commerce" [ref=e242]:
                - /url: /en/for/ecommerce
            - listitem [ref=e243]:
              - link "Real estate" [ref=e244]:
                - /url: /en/for/real-estate
            - listitem [ref=e245]:
              - link "Law firms" [ref=e246]:
                - /url: /en/for/legal
            - listitem [ref=e247]:
              - link "Startups" [ref=e248]:
                - /url: /en/for/startups
            - listitem [ref=e249]:
              - link "Clinics & aesthetics" [ref=e250]:
                - /url: /en/for/clinics
            - listitem [ref=e251]:
              - link "Restaurants & cafés" [ref=e252]:
                - /url: /en/for/restaurants
            - listitem [ref=e253]:
              - link "Marketing agencies" [ref=e254]:
                - /url: /en/for/agencies
        - navigation "Resources" [ref=e255]:
          - paragraph [ref=e256]: Resources
          - list [ref=e257]:
            - listitem [ref=e258]:
              - link "Blog and guides" [ref=e259]:
                - /url: /en/blog
            - listitem [ref=e260]:
              - link "Free tools" [ref=e261]:
                - /url: /en/tools
            - listitem [ref=e262]:
              - link "Help center" [ref=e263]:
                - /url: /en/help
            - listitem [ref=e264]:
              - link "What is an AI marketing agent?" [ref=e265]:
                - /url: /en/ai-marketing-agent
            - listitem [ref=e266]:
              - link "Affiliate program" [ref=e267]:
                - /url: /en/affiliates
        - navigation "Company" [ref=e268]:
          - paragraph [ref=e269]: Company
          - list [ref=e270]:
            - listitem [ref=e271]:
              - link "Customers" [ref=e272]:
                - /url: /en/customers
            - listitem [ref=e273]:
              - link "Enterprise" [ref=e274]:
                - /url: /en/enterprise
            - listitem [ref=e275]:
              - link "Pricing" [ref=e276]:
                - /url: /en/pricing
            - listitem [ref=e277]:
              - link "Comparisons" [ref=e278]:
                - /url: /en/resources#compare
            - listitem [ref=e279]:
              - link "Privacy" [ref=e280]:
                - /url: /en/privacy
            - listitem [ref=e281]:
              - link "Terms" [ref=e282]:
                - /url: /en/terms
      - generic [ref=e283]:
        - paragraph [ref=e284]: © 2026 Nashr. All rights reserved.
        - group "Language" [ref=e285]:
          - link "العربية" [ref=e286]:
            - /url: /ar/pricing
            - text: عربي
          - link "English" [ref=e287]:
            - /url: /en/pricing
            - text: EN
  - alert [ref=e288]
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
     |                                                                                          ^ Error: /en/pricing must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```