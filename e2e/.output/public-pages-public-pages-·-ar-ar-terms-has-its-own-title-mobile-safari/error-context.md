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
      - link "نشر" [ref=e4]:
        - /url: /ar
      - generic [ref=e6]:
        - group "اللغة" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/terms
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/terms
            - text: EN
        - link "ابدأ مجاناً" [ref=e10] [cursor=pointer]:
          - /url: /ar/app/signup
        - group [ref=e11]:
          - generic "القائمة" [ref=e12] [cursor=pointer]
          - group [ref=e15]:
            - generic "الوكلاء" [ref=e16] [cursor=pointer]
          - group [ref=e17]:
            - generic "القطاعات" [ref=e18] [cursor=pointer]
          - group [ref=e19]:
            - generic "الموارد" [ref=e20] [cursor=pointer]
  - main [ref=e21]:
    - heading "شروط الاستخدام" [level=1] [ref=e22]
    - paragraph [ref=e23]: "آخر تحديث: 2026-09-17"
    - generic [ref=e24]:
      - heading "الخدمة" [level=2] [ref=e25]
      - paragraph [ref=e26]: نشر تقدّم وكيلة تسويق بالذكاء الاصطناعي (نور) تنشئ محتوى وخططاً ورسائل، وتنشر على المنصات التي تربطها أنت، وفق موافقتك أو إعدادات الحوكمة.
    - generic [ref=e27]:
      - heading "مسؤوليتك" [level=2] [ref=e28]
      - paragraph [ref=e29]: أنت المسؤول عن مراجعة المحتوى قبل نشره، وعن التزامه بأنظمة الإعلان في بلدك (مثل ضوابط وزارة الصحة، هيئة العقار، نظام مكافحة الغش التجاري).
      - paragraph [ref=e30]: لا تستخدم الخدمة لمحتوى مخالف أو مضلل أو ينتهك حقوق الغير.
      - paragraph [ref=e31]: الحسابات المرتبطة تخضع لشروط منصاتها.
    - generic [ref=e32]:
      - heading "الاشتراك والكريدت" [level=2] [ref=e33]
      - paragraph [ref=e34]: الأسعار بالريال السعودي غير شاملة الضريبة. الكريدت يُخصم عند كل توليد وفق الجدول المعلن. الكريدت غير مسترد ولا يُحوَّل. يمكن الإلغاء في أي وقت ويستمر الوصول حتى نهاية الفترة المدفوعة.
    - generic [ref=e35]:
      - heading "الذكاء الاصطناعي" [level=2] [ref=e36]
      - paragraph [ref=e37]: المحتوى المولَّد قد يحتوي أخطاء. نور لا تخترع أسعاراً أو ادعاءات، لكن التحقق النهائي مسؤوليتك.
    - generic [ref=e38]:
      - heading "الملكية" [level=2] [ref=e39]
      - paragraph [ref=e40]: المحتوى الذي تنشئه نور لحسابك ملك لك. منصة نشر وبرمجياتها ملك للشركة.
    - generic [ref=e41]:
      - heading "التغييرات والقانون" [level=2] [ref=e42]
      - paragraph [ref=e43]: قد نحدّث هذه الشروط ونخطرك. تخضع للأنظمة المعمول بها في المملكة العربية السعودية.
  - contentinfo [ref=e44]:
    - generic [ref=e46]:
      - generic [ref=e47]:
        - generic [ref=e48]:
          - paragraph [ref=e49]: نشر
          - paragraph [ref=e50]: وكيلة تسويق تعمل 24/7 — مبنية في الرياض للخليج.
        - navigation "الوكلاء" [ref=e51]:
          - paragraph [ref=e52]: الوكلاء
          - list [ref=e53]:
            - listitem [ref=e54]:
              - link "نور · التسويق" [ref=e55]:
                - /url: /ar/agents/noor
            - listitem [ref=e56]:
              - link "سامي · تمكين المبيعات" [ref=e57]:
                - /url: /ar/agents/sami
            - listitem [ref=e58]:
              - link "رزان · المالية والتسعير والإيرادات" [ref=e59]:
                - /url: /ar/agents/razan
            - listitem [ref=e60]:
              - link "فارس · الدخول للسوق والنمو" [ref=e61]:
                - /url: /ar/agents/faris
            - listitem [ref=e62]:
              - link "دانة · التقارير ولوحات المؤشرات والعروض" [ref=e63]:
                - /url: /ar/agents/dana
            - listitem [ref=e64]:
              - link "ماجد · المستشار التنفيذي" [ref=e65]:
                - /url: /ar/agents/majed
            - listitem [ref=e66]:
              - link "ليان · المنتج والاحتفاظ بالعملاء" [ref=e67]:
                - /url: /ar/agents/layan
        - navigation "القطاعات" [ref=e68]:
          - paragraph [ref=e69]: القطاعات
          - list [ref=e70]:
            - listitem [ref=e71]:
              - link "المتاجر الإلكترونية" [ref=e72]:
                - /url: /ar/for/ecommerce
            - listitem [ref=e73]:
              - link "العقار والمطورون" [ref=e74]:
                - /url: /ar/for/real-estate
            - listitem [ref=e75]:
              - link "المكاتب القانونية" [ref=e76]:
                - /url: /ar/for/legal
            - listitem [ref=e77]:
              - link "الشركات الناشئة" [ref=e78]:
                - /url: /ar/for/startups
            - listitem [ref=e79]:
              - link "العيادات والتجميل" [ref=e80]:
                - /url: /ar/for/clinics
            - listitem [ref=e81]:
              - link "المطاعم والكافيهات" [ref=e82]:
                - /url: /ar/for/restaurants
            - listitem [ref=e83]:
              - link "وكالات التسويق" [ref=e84]:
                - /url: /ar/for/agencies
        - navigation "الموارد" [ref=e85]:
          - paragraph [ref=e86]: الموارد
          - list [ref=e87]:
            - listitem [ref=e88]:
              - link "المدونة والأدلة" [ref=e89]:
                - /url: /ar/blog
            - listitem [ref=e90]:
              - link "أدوات مجانية" [ref=e91]:
                - /url: /ar/tools
            - listitem [ref=e92]:
              - link "مركز المساعدة" [ref=e93]:
                - /url: /ar/help
            - listitem [ref=e94]:
              - link "ما هو وكيل التسويق بالذكاء الاصطناعي؟" [ref=e95]:
                - /url: /ar/ai-marketing-agent
            - listitem [ref=e96]:
              - link "برنامج الشركاء" [ref=e97]:
                - /url: /ar/affiliates
        - navigation "الشركة" [ref=e98]:
          - paragraph [ref=e99]: الشركة
          - list [ref=e100]:
            - listitem [ref=e101]:
              - link "العملاء" [ref=e102]:
                - /url: /ar/customers
            - listitem [ref=e103]:
              - link "المؤسسات" [ref=e104]:
                - /url: /ar/enterprise
            - listitem [ref=e105]:
              - link "الأسعار" [ref=e106]:
                - /url: /ar/pricing
            - listitem [ref=e107]:
              - link "مقارنات" [ref=e108]:
                - /url: /ar/resources#compare
            - listitem [ref=e109]:
              - link "الخصوصية" [ref=e110]:
                - /url: /ar/privacy
            - listitem [ref=e111]:
              - link "الشروط" [ref=e112]:
                - /url: /ar/terms
      - generic [ref=e113]:
        - paragraph [ref=e114]: © 2026 نشر. جميع الحقوق محفوظة.
        - group "اللغة" [ref=e115]:
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
     |                                                                                          ^ Error: /ar/terms must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```