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
      - link "Nashr" [ref=e4]:
        - /url: /en
      - generic [ref=e6]:
        - group "Language" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/affiliates
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/affiliates
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
    - paragraph [ref=e22]: Partner program
    - heading "Earn 25% recurring on every customer you refer to Nashr." [level=1] [ref=e23]
    - paragraph [ref=e24]: For Gulf agencies, consultants, creators and newsletters. Your client gets an AI marketer in their dialect; you get a quarter of every invoice, forever.
    - generic [ref=e25]:
      - generic [ref=e26]:
        - paragraph [ref=e27]: 25%
        - paragraph [ref=e28]: recurring on every payment, for the life of the customer
      - generic [ref=e29]:
        - paragraph [ref=e30]: 60 days
        - paragraph [ref=e31]: attribution window from click
      - generic [ref=e32]:
        - paragraph [ref=e33]: Monthly
        - paragraph [ref=e34]: payouts by bank transfer, SAR 200 minimum
      - generic [ref=e35]:
        - paragraph [ref=e36]: "0"
        - paragraph [ref=e37]: fees or minimum referrals
    - generic [ref=e38]:
      - generic [ref=e39]:
        - heading "How it works" [level=2] [ref=e40]
        - list [ref=e41]:
          - listitem [ref=e42]:
            - generic [ref=e43]: "1."
            - text: Apply below. We approve within one business day.
          - listitem [ref=e44]:
            - generic [ref=e45]: "2."
            - text: You get your link and code, plus ready-to-post copy.
          - listitem [ref=e46]:
            - generic [ref=e47]: "3."
            - text: Anyone who signs up via your link and subscribes within 60 days counts.
          - listitem [ref=e48]:
            - generic [ref=e49]: "4."
            - text: You receive 25% of every payment, monthly, by bank transfer.
        - heading "Rules" [level=2] [ref=e50]
        - list [ref=e51]:
          - listitem [ref=e52]: • No paid search on the 'Nashr' or 'Noor' brand.
          - listitem [ref=e53]: • No self-referrals.
          - listitem [ref=e54]: • 30-day verification per payment before commission is released.
      - generic [ref=e55]:
        - heading "Apply" [level=2] [ref=e56]
        - textbox "Your name" [ref=e57]
        - textbox "Email" [ref=e58]
        - textbox "WhatsApp +966…" [ref=e59]
        - textbox "Where will you promote? (agency, YouTube, newsletter, LinkedIn…)" [ref=e60]
        - textbox "Audience size / number of clients" [ref=e61]
        - button "Send application" [ref=e62] [cursor=pointer]
  - contentinfo [ref=e63]:
    - generic [ref=e65]:
      - generic [ref=e66]:
        - generic [ref=e67]:
          - paragraph [ref=e68]: Nashr
          - paragraph [ref=e69]: A marketing agent that works 24/7 — built in Riyadh for the Gulf.
        - navigation "Agents" [ref=e70]:
          - paragraph [ref=e71]: Agents
          - list [ref=e72]:
            - listitem [ref=e73]:
              - link "Noor · Marketing" [ref=e74]:
                - /url: /en/agents/noor
            - listitem [ref=e75]:
              - link "Sami · Sales enablement" [ref=e76]:
                - /url: /en/agents/sami
            - listitem [ref=e77]:
              - link "Razan · Finance, pricing and revenue" [ref=e78]:
                - /url: /en/agents/razan
            - listitem [ref=e79]:
              - link "Faris · Go-to-market and growth" [ref=e80]:
                - /url: /en/agents/faris
            - listitem [ref=e81]:
              - link "Dana · Reports, dashboards and decks" [ref=e82]:
                - /url: /en/agents/dana
            - listitem [ref=e83]:
              - link "Majed · Executive advisor" [ref=e84]:
                - /url: /en/agents/majed
            - listitem [ref=e85]:
              - link "Layan · Product and retention" [ref=e86]:
                - /url: /en/agents/layan
        - navigation "Industries" [ref=e87]:
          - paragraph [ref=e88]: Industries
          - list [ref=e89]:
            - listitem [ref=e90]:
              - link "E-commerce" [ref=e91]:
                - /url: /en/for/ecommerce
            - listitem [ref=e92]:
              - link "Real estate" [ref=e93]:
                - /url: /en/for/real-estate
            - listitem [ref=e94]:
              - link "Law firms" [ref=e95]:
                - /url: /en/for/legal
            - listitem [ref=e96]:
              - link "Startups" [ref=e97]:
                - /url: /en/for/startups
            - listitem [ref=e98]:
              - link "Clinics & aesthetics" [ref=e99]:
                - /url: /en/for/clinics
            - listitem [ref=e100]:
              - link "Restaurants & cafés" [ref=e101]:
                - /url: /en/for/restaurants
            - listitem [ref=e102]:
              - link "Marketing agencies" [ref=e103]:
                - /url: /en/for/agencies
        - navigation "Resources" [ref=e104]:
          - paragraph [ref=e105]: Resources
          - list [ref=e106]:
            - listitem [ref=e107]:
              - link "Blog and guides" [ref=e108]:
                - /url: /en/blog
            - listitem [ref=e109]:
              - link "Free tools" [ref=e110]:
                - /url: /en/tools
            - listitem [ref=e111]:
              - link "Help center" [ref=e112]:
                - /url: /en/help
            - listitem [ref=e113]:
              - link "What is an AI marketing agent?" [ref=e114]:
                - /url: /en/ai-marketing-agent
            - listitem [ref=e115]:
              - link "Affiliate program" [ref=e116]:
                - /url: /en/affiliates
        - navigation "Company" [ref=e117]:
          - paragraph [ref=e118]: Company
          - list [ref=e119]:
            - listitem [ref=e120]:
              - link "Customers" [ref=e121]:
                - /url: /en/customers
            - listitem [ref=e122]:
              - link "Enterprise" [ref=e123]:
                - /url: /en/enterprise
            - listitem [ref=e124]:
              - link "Pricing" [ref=e125]:
                - /url: /en/pricing
            - listitem [ref=e126]:
              - link "Comparisons" [ref=e127]:
                - /url: /en/resources#compare
            - listitem [ref=e128]:
              - link "Privacy" [ref=e129]:
                - /url: /en/privacy
            - listitem [ref=e130]:
              - link "Terms" [ref=e131]:
                - /url: /en/terms
      - generic [ref=e132]:
        - paragraph [ref=e133]: © 2026 Nashr. All rights reserved.
        - group "Language" [ref=e134]:
          - link "العربية" [ref=e135]:
            - /url: /ar/affiliates
            - text: عربي
          - link "English" [ref=e136]:
            - /url: /en/affiliates
            - text: EN
  - alert [ref=e137]
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