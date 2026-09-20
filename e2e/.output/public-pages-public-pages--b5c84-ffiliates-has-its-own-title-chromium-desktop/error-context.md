# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: public-pages.spec.ts >> public pages · ar >> /ar/affiliates has its own title
- Location: e2e/public-pages.spec.ts:30:13

# Error details

```
Error: /ar/affiliates must not fall back to the site-wide default title

expect(received).not.toBe(expected) // Object.is equality

Expected: not "نشر — نور، وكيلة تسويق تعمل 24/7 للخليج"
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - generic [ref=e3]:
      - link "نشر" [ref=e4] [cursor=pointer]:
        - /url: /ar
      - navigation "Main" [ref=e6]:
        - link "الوكلاء" [ref=e8] [cursor=pointer]:
          - /url: /ar/agents/noor
        - link "القطاعات" [ref=e12] [cursor=pointer]:
          - /url: /ar#industries
        - link "العملاء" [ref=e15] [cursor=pointer]:
          - /url: /ar/customers
        - link "المؤسسات" [ref=e16] [cursor=pointer]:
          - /url: /ar/enterprise
        - link "الموارد" [ref=e18] [cursor=pointer]:
          - /url: /ar/resources
        - link "الأسعار" [ref=e21] [cursor=pointer]:
          - /url: /ar/pricing
      - generic [ref=e22]:
        - group "اللغة" [ref=e23]:
          - link "العربية" [ref=e24] [cursor=pointer]:
            - /url: /ar/affiliates
            - text: عربي
          - link "English" [ref=e25] [cursor=pointer]:
            - /url: /en/affiliates
            - text: EN
        - link "دخول" [ref=e26] [cursor=pointer]:
          - /url: /ar/app/login
        - link "ابدأ مجاناً" [ref=e27] [cursor=pointer]:
          - /url: /ar/app/signup
  - main [ref=e28]:
    - paragraph [ref=e29]: برنامج الشركاء
    - heading "اكسب 25% متكررة على كل عميل تحيله لنشر." [level=1] [ref=e30]
    - paragraph [ref=e31]: للوكالات والمستشارين وصنّاع المحتوى والنشرات البريدية في الخليج. عميلك يحصل على مسوّق بالذكاء الاصطناعي بلهجته، وأنت تحصل على ربع كل فاتورة، إلى الأبد.
    - generic [ref=e32]:
      - generic [ref=e33]:
        - paragraph [ref=e34]: 25%
        - paragraph [ref=e35]: عمولة متكررة على كل دفعة، مدى حياة العميل
      - generic [ref=e36]:
        - paragraph [ref=e37]: 60 يوماً
        - paragraph [ref=e38]: نافذة الإحالة من الضغط على رابطك
      - generic [ref=e39]:
        - paragraph [ref=e40]: شهرياً
        - paragraph [ref=e41]: دفعات عبر تحويل بنكي، الحد الأدنى 200 ريال
      - generic [ref=e42]:
        - paragraph [ref=e43]: "0"
        - paragraph [ref=e44]: رسوم أو حد أدنى للإحالات
    - generic [ref=e45]:
      - generic [ref=e46]:
        - heading "كيف يعمل" [level=2] [ref=e47]
        - list [ref=e48]:
          - listitem [ref=e49]:
            - generic [ref=e50]: "1."
            - text: قدّم الطلب أدناه. نوافق خلال يوم عمل.
          - listitem [ref=e51]:
            - generic [ref=e52]: "2."
            - text: تستلم رابطك وكودك، ونصوصاً جاهزة للنشر.
          - listitem [ref=e53]:
            - generic [ref=e54]: "3."
            - text: كل من يسجّل عبر رابطك ويشترك خلال 60 يوماً يُحسب لك.
          - listitem [ref=e55]:
            - generic [ref=e56]: "4."
            - text: تستلم 25% من كل دفعة شهرياً عبر تحويل بنكي.
        - heading "القواعد" [level=2] [ref=e57]
        - list [ref=e58]:
          - listitem [ref=e59]: • لا إعلانات مدفوعة على اسم «نشر» أو «نور».
          - listitem [ref=e60]: • لا إحالة ذاتية.
          - listitem [ref=e61]: • 30 يوماً للتحقق من كل دفعة قبل صرف عمولتها.
      - generic [ref=e62]:
        - heading "قدّم طلب الشراكة" [level=2] [ref=e63]
        - textbox "اسمك" [ref=e64]
        - textbox "Email" [ref=e65]
        - textbox "واتساب +966…" [ref=e66]
        - textbox "أين ستروّج؟ (وكالة، يوتيوب، نشرة، لينكدإن…)" [ref=e67]
        - textbox "حجم جمهورك / عدد عملائك" [ref=e68]
        - button "أرسل الطلب" [ref=e69] [cursor=pointer]
  - contentinfo [ref=e70]:
    - generic [ref=e72]:
      - generic [ref=e73]:
        - generic [ref=e74]:
          - paragraph [ref=e75]: نشر
          - paragraph [ref=e76]: وكيلة تسويق تعمل 24/7 — مبنية في الرياض للخليج.
        - navigation "الوكلاء" [ref=e77]:
          - paragraph [ref=e78]: الوكلاء
          - list [ref=e79]:
            - listitem [ref=e80]:
              - link "نور · التسويق" [ref=e81] [cursor=pointer]:
                - /url: /ar/agents/noor
            - listitem [ref=e82]:
              - link "سامي · تمكين المبيعات" [ref=e83] [cursor=pointer]:
                - /url: /ar/agents/sami
            - listitem [ref=e84]:
              - link "رزان · المالية والتسعير والإيرادات" [ref=e85] [cursor=pointer]:
                - /url: /ar/agents/razan
            - listitem [ref=e86]:
              - link "فارس · الدخول للسوق والنمو" [ref=e87] [cursor=pointer]:
                - /url: /ar/agents/faris
            - listitem [ref=e88]:
              - link "دانة · التقارير ولوحات المؤشرات والعروض" [ref=e89] [cursor=pointer]:
                - /url: /ar/agents/dana
            - listitem [ref=e90]:
              - link "ماجد · المستشار التنفيذي" [ref=e91] [cursor=pointer]:
                - /url: /ar/agents/majed
            - listitem [ref=e92]:
              - link "ليان · المنتج والاحتفاظ بالعملاء" [ref=e93] [cursor=pointer]:
                - /url: /ar/agents/layan
        - navigation "القطاعات" [ref=e94]:
          - paragraph [ref=e95]: القطاعات
          - list [ref=e96]:
            - listitem [ref=e97]:
              - link "المتاجر الإلكترونية" [ref=e98] [cursor=pointer]:
                - /url: /ar/for/ecommerce
            - listitem [ref=e99]:
              - link "العقار والمطورون" [ref=e100] [cursor=pointer]:
                - /url: /ar/for/real-estate
            - listitem [ref=e101]:
              - link "المكاتب القانونية" [ref=e102] [cursor=pointer]:
                - /url: /ar/for/legal
            - listitem [ref=e103]:
              - link "الشركات الناشئة" [ref=e104] [cursor=pointer]:
                - /url: /ar/for/startups
            - listitem [ref=e105]:
              - link "العيادات والتجميل" [ref=e106] [cursor=pointer]:
                - /url: /ar/for/clinics
            - listitem [ref=e107]:
              - link "المطاعم والكافيهات" [ref=e108] [cursor=pointer]:
                - /url: /ar/for/restaurants
            - listitem [ref=e109]:
              - link "وكالات التسويق" [ref=e110] [cursor=pointer]:
                - /url: /ar/for/agencies
        - navigation "الموارد" [ref=e111]:
          - paragraph [ref=e112]: الموارد
          - list [ref=e113]:
            - listitem [ref=e114]:
              - link "المدونة والأدلة" [ref=e115] [cursor=pointer]:
                - /url: /ar/blog
            - listitem [ref=e116]:
              - link "أدوات مجانية" [ref=e117] [cursor=pointer]:
                - /url: /ar/tools
            - listitem [ref=e118]:
              - link "مركز المساعدة" [ref=e119] [cursor=pointer]:
                - /url: /ar/help
            - listitem [ref=e120]:
              - link "ما هو وكيل التسويق بالذكاء الاصطناعي؟" [ref=e121] [cursor=pointer]:
                - /url: /ar/ai-marketing-agent
            - listitem [ref=e122]:
              - link "برنامج الشركاء" [ref=e123] [cursor=pointer]:
                - /url: /ar/affiliates
        - navigation "الشركة" [ref=e124]:
          - paragraph [ref=e125]: الشركة
          - list [ref=e126]:
            - listitem [ref=e127]:
              - link "العملاء" [ref=e128] [cursor=pointer]:
                - /url: /ar/customers
            - listitem [ref=e129]:
              - link "المؤسسات" [ref=e130] [cursor=pointer]:
                - /url: /ar/enterprise
            - listitem [ref=e131]:
              - link "الأسعار" [ref=e132] [cursor=pointer]:
                - /url: /ar/pricing
            - listitem [ref=e133]:
              - link "مقارنات" [ref=e134] [cursor=pointer]:
                - /url: /ar/resources#compare
            - listitem [ref=e135]:
              - link "الخصوصية" [ref=e136] [cursor=pointer]:
                - /url: /ar/privacy
            - listitem [ref=e137]:
              - link "الشروط" [ref=e138] [cursor=pointer]:
                - /url: /ar/terms
      - generic [ref=e139]:
        - paragraph [ref=e140]: © 2026 نشر. جميع الحقوق محفوظة.
        - group "اللغة" [ref=e141]:
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
     |                                                                                          ^ Error: /ar/affiliates must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```