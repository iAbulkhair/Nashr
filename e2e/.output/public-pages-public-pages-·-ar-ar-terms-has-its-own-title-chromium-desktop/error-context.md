# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: public-pages.spec.ts >> public pages · ar >> /ar/terms has its own title
- Location: e2e/public-pages.spec.ts:30:13

# Error details

```
Error: /ar/terms must not fall back to the site-wide default title

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
            - /url: /ar/terms
            - text: عربي
          - link "English" [ref=e25] [cursor=pointer]:
            - /url: /en/terms
            - text: EN
        - link "دخول" [ref=e26] [cursor=pointer]:
          - /url: /ar/app/login
        - link "ابدأ مجاناً" [ref=e27] [cursor=pointer]:
          - /url: /ar/app/signup
  - main [ref=e28]:
    - heading "شروط الاستخدام" [level=1] [ref=e29]
    - paragraph [ref=e30]: "آخر تحديث: 2026-09-17"
    - generic [ref=e31]:
      - heading "الخدمة" [level=2] [ref=e32]
      - paragraph [ref=e33]: نشر تقدّم وكيلة تسويق بالذكاء الاصطناعي (نور) تنشئ محتوى وخططاً ورسائل، وتنشر على المنصات التي تربطها أنت، وفق موافقتك أو إعدادات الحوكمة.
    - generic [ref=e34]:
      - heading "مسؤوليتك" [level=2] [ref=e35]
      - paragraph [ref=e36]: أنت المسؤول عن مراجعة المحتوى قبل نشره، وعن التزامه بأنظمة الإعلان في بلدك (مثل ضوابط وزارة الصحة، هيئة العقار، نظام مكافحة الغش التجاري).
      - paragraph [ref=e37]: لا تستخدم الخدمة لمحتوى مخالف أو مضلل أو ينتهك حقوق الغير.
      - paragraph [ref=e38]: الحسابات المرتبطة تخضع لشروط منصاتها.
    - generic [ref=e39]:
      - heading "الاشتراك والكريدت" [level=2] [ref=e40]
      - paragraph [ref=e41]: الأسعار بالريال السعودي غير شاملة الضريبة. الكريدت يُخصم عند كل توليد وفق الجدول المعلن. الكريدت غير مسترد ولا يُحوَّل. يمكن الإلغاء في أي وقت ويستمر الوصول حتى نهاية الفترة المدفوعة.
    - generic [ref=e42]:
      - heading "الذكاء الاصطناعي" [level=2] [ref=e43]
      - paragraph [ref=e44]: المحتوى المولَّد قد يحتوي أخطاء. نور لا تخترع أسعاراً أو ادعاءات، لكن التحقق النهائي مسؤوليتك.
    - generic [ref=e45]:
      - heading "الملكية" [level=2] [ref=e46]
      - paragraph [ref=e47]: المحتوى الذي تنشئه نور لحسابك ملك لك. منصة نشر وبرمجياتها ملك للشركة.
    - generic [ref=e48]:
      - heading "التغييرات والقانون" [level=2] [ref=e49]
      - paragraph [ref=e50]: قد نحدّث هذه الشروط ونخطرك. تخضع للأنظمة المعمول بها في المملكة العربية السعودية.
  - contentinfo [ref=e51]:
    - generic [ref=e53]:
      - generic [ref=e54]:
        - generic [ref=e55]:
          - paragraph [ref=e56]: نشر
          - paragraph [ref=e57]: وكيلة تسويق تعمل 24/7 — مبنية في الرياض للخليج.
        - navigation "الوكلاء" [ref=e58]:
          - paragraph [ref=e59]: الوكلاء
          - list [ref=e60]:
            - listitem [ref=e61]:
              - link "نور · التسويق" [ref=e62] [cursor=pointer]:
                - /url: /ar/agents/noor
            - listitem [ref=e63]:
              - link "سامي · تمكين المبيعات" [ref=e64] [cursor=pointer]:
                - /url: /ar/agents/sami
            - listitem [ref=e65]:
              - link "رزان · المالية والتسعير والإيرادات" [ref=e66] [cursor=pointer]:
                - /url: /ar/agents/razan
            - listitem [ref=e67]:
              - link "فارس · الدخول للسوق والنمو" [ref=e68] [cursor=pointer]:
                - /url: /ar/agents/faris
            - listitem [ref=e69]:
              - link "دانة · التقارير ولوحات المؤشرات والعروض" [ref=e70] [cursor=pointer]:
                - /url: /ar/agents/dana
            - listitem [ref=e71]:
              - link "ماجد · المستشار التنفيذي" [ref=e72] [cursor=pointer]:
                - /url: /ar/agents/majed
            - listitem [ref=e73]:
              - link "ليان · المنتج والاحتفاظ بالعملاء" [ref=e74] [cursor=pointer]:
                - /url: /ar/agents/layan
        - navigation "القطاعات" [ref=e75]:
          - paragraph [ref=e76]: القطاعات
          - list [ref=e77]:
            - listitem [ref=e78]:
              - link "المتاجر الإلكترونية" [ref=e79] [cursor=pointer]:
                - /url: /ar/for/ecommerce
            - listitem [ref=e80]:
              - link "العقار والمطورون" [ref=e81] [cursor=pointer]:
                - /url: /ar/for/real-estate
            - listitem [ref=e82]:
              - link "المكاتب القانونية" [ref=e83] [cursor=pointer]:
                - /url: /ar/for/legal
            - listitem [ref=e84]:
              - link "الشركات الناشئة" [ref=e85] [cursor=pointer]:
                - /url: /ar/for/startups
            - listitem [ref=e86]:
              - link "العيادات والتجميل" [ref=e87] [cursor=pointer]:
                - /url: /ar/for/clinics
            - listitem [ref=e88]:
              - link "المطاعم والكافيهات" [ref=e89] [cursor=pointer]:
                - /url: /ar/for/restaurants
            - listitem [ref=e90]:
              - link "وكالات التسويق" [ref=e91] [cursor=pointer]:
                - /url: /ar/for/agencies
        - navigation "الموارد" [ref=e92]:
          - paragraph [ref=e93]: الموارد
          - list [ref=e94]:
            - listitem [ref=e95]:
              - link "المدونة والأدلة" [ref=e96] [cursor=pointer]:
                - /url: /ar/blog
            - listitem [ref=e97]:
              - link "أدوات مجانية" [ref=e98] [cursor=pointer]:
                - /url: /ar/tools
            - listitem [ref=e99]:
              - link "مركز المساعدة" [ref=e100] [cursor=pointer]:
                - /url: /ar/help
            - listitem [ref=e101]:
              - link "ما هو وكيل التسويق بالذكاء الاصطناعي؟" [ref=e102] [cursor=pointer]:
                - /url: /ar/ai-marketing-agent
            - listitem [ref=e103]:
              - link "برنامج الشركاء" [ref=e104] [cursor=pointer]:
                - /url: /ar/affiliates
        - navigation "الشركة" [ref=e105]:
          - paragraph [ref=e106]: الشركة
          - list [ref=e107]:
            - listitem [ref=e108]:
              - link "العملاء" [ref=e109] [cursor=pointer]:
                - /url: /ar/customers
            - listitem [ref=e110]:
              - link "المؤسسات" [ref=e111] [cursor=pointer]:
                - /url: /ar/enterprise
            - listitem [ref=e112]:
              - link "الأسعار" [ref=e113] [cursor=pointer]:
                - /url: /ar/pricing
            - listitem [ref=e114]:
              - link "مقارنات" [ref=e115] [cursor=pointer]:
                - /url: /ar/resources#compare
            - listitem [ref=e116]:
              - link "الخصوصية" [ref=e117] [cursor=pointer]:
                - /url: /ar/privacy
            - listitem [ref=e118]:
              - link "الشروط" [ref=e119] [cursor=pointer]:
                - /url: /ar/terms
      - generic [ref=e120]:
        - paragraph [ref=e121]: © 2026 نشر. جميع الحقوق محفوظة.
        - group "اللغة" [ref=e122]:
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
     |                                                                                          ^ Error: /ar/terms must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```