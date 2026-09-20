# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: public-pages.spec.ts >> public pages · ar >> /ar/privacy has its own title
- Location: e2e/public-pages.spec.ts:30:13

# Error details

```
Error: /ar/privacy must not fall back to the site-wide default title

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
            - /url: /ar/privacy
            - text: عربي
          - link "English" [ref=e25] [cursor=pointer]:
            - /url: /en/privacy
            - text: EN
        - link "دخول" [ref=e26] [cursor=pointer]:
          - /url: /ar/app/login
        - link "ابدأ مجاناً" [ref=e27] [cursor=pointer]:
          - /url: /ar/app/signup
  - main [ref=e28]:
    - heading "سياسة الخصوصية" [level=1] [ref=e29]
    - paragraph [ref=e30]: "آخر تحديث: 2026-09-17"
    - generic [ref=e31]:
      - heading "من نحن" [level=2] [ref=e32]
      - paragraph [ref=e33]: نشر (Nashr) منصة تسويق بالذكاء الاصطناعي للشركات في دول الخليج. هذه السياسة تشرح البيانات التي نجمعها وكيف نستخدمها وحقوقك وفق نظام حماية البيانات الشخصية في المملكة العربية السعودية.
    - generic [ref=e34]:
      - heading "البيانات التي نجمعها" [level=2] [ref=e35]
      - paragraph [ref=e36]: "بيانات الحساب: الاسم، البريد الإلكتروني، رقم الجوال، كلمة المرور (مشفّرة)."
      - paragraph [ref=e37]: "بيانات العلامة التجارية: موقعك، منتجاتك، جمهورك، أسلوبك، وما تكتبه لنور."
      - paragraph [ref=e38]: "بيانات المنصات المرتبطة: عند ربط متجر أو حساب (سلة، زد، شوبيفاي، X، قوقل، ميتا…) نخزّن رموز الوصول مشفّرة ونقرأ فقط ما تسمح به الصلاحيات التي وافقت عليها."
      - paragraph [ref=e39]: "بيانات الاستخدام: الطلبات التي ترسلها لنور، ما تعتمده أو ترفضه، وسجلات تقنية لتشغيل الخدمة."
    - generic [ref=e40]:
      - heading "كيف نستخدمها" [level=2] [ref=e41]
      - paragraph [ref=e42]: "لتشغيل الخدمة: إنشاء المحتوى، الخطط، الرسائل، والنشر على المنصات التي ربطتها بناءً على أوامرك."
      - paragraph [ref=e43]: "لتحسين نور لعلامتك: تعديلاتك تُحفظ كتفضيلات خاصة بحسابك فقط."
      - paragraph [ref=e44]: لا نبيع بياناتك. لا ندرّب نماذج عامة على محتواك. نستخدم مزوّدي ذكاء اصطناعي (Anthropic) وبنية تحتية (Vercel، Upstash) لمعالجة البيانات وفق اتفاقيات معالجة بيانات.
    - generic [ref=e45]:
      - heading "المنصات المرتبطة" [level=2] [ref=e46]
      - paragraph [ref=e47]: عند ربط حساب عبر OAuth، يمكنك فصله في أي وقت من صفحة التكاملات، وسنحذف رموز الوصول فوراً. نطلب أقل الصلاحيات اللازمة، ولا ننشر شيئاً دون موافقتك أو إعدادات الحوكمة التي ضبطتها.
    - generic [ref=e48]:
      - heading "الاحتفاظ والحذف" [level=2] [ref=e49]
      - paragraph [ref=e50]: نحتفظ بالبيانات ما دام حسابك نشطاً. يمكنك طلب تصدير أو حذف كامل لبياناتك عبر hello@nashr.ai وننفّذ خلال 30 يوماً.
    - generic [ref=e51]:
      - heading "حقوقك" [level=2] [ref=e52]
      - paragraph [ref=e53]: "الوصول، التصحيح، الحذف، الاعتراض على المعالجة، ونقل البيانات. للتواصل: hello@nashr.ai أو واتساب +966 55 923 5281."
  - contentinfo [ref=e54]:
    - generic [ref=e56]:
      - generic [ref=e57]:
        - generic [ref=e58]:
          - paragraph [ref=e59]: نشر
          - paragraph [ref=e60]: وكيلة تسويق تعمل 24/7 — مبنية في الرياض للخليج.
        - navigation "الوكلاء" [ref=e61]:
          - paragraph [ref=e62]: الوكلاء
          - list [ref=e63]:
            - listitem [ref=e64]:
              - link "نور · التسويق" [ref=e65] [cursor=pointer]:
                - /url: /ar/agents/noor
            - listitem [ref=e66]:
              - link "سامي · تمكين المبيعات" [ref=e67] [cursor=pointer]:
                - /url: /ar/agents/sami
            - listitem [ref=e68]:
              - link "رزان · المالية والتسعير والإيرادات" [ref=e69] [cursor=pointer]:
                - /url: /ar/agents/razan
            - listitem [ref=e70]:
              - link "فارس · الدخول للسوق والنمو" [ref=e71] [cursor=pointer]:
                - /url: /ar/agents/faris
            - listitem [ref=e72]:
              - link "دانة · التقارير ولوحات المؤشرات والعروض" [ref=e73] [cursor=pointer]:
                - /url: /ar/agents/dana
            - listitem [ref=e74]:
              - link "ماجد · المستشار التنفيذي" [ref=e75] [cursor=pointer]:
                - /url: /ar/agents/majed
            - listitem [ref=e76]:
              - link "ليان · المنتج والاحتفاظ بالعملاء" [ref=e77] [cursor=pointer]:
                - /url: /ar/agents/layan
        - navigation "القطاعات" [ref=e78]:
          - paragraph [ref=e79]: القطاعات
          - list [ref=e80]:
            - listitem [ref=e81]:
              - link "المتاجر الإلكترونية" [ref=e82] [cursor=pointer]:
                - /url: /ar/for/ecommerce
            - listitem [ref=e83]:
              - link "العقار والمطورون" [ref=e84] [cursor=pointer]:
                - /url: /ar/for/real-estate
            - listitem [ref=e85]:
              - link "المكاتب القانونية" [ref=e86] [cursor=pointer]:
                - /url: /ar/for/legal
            - listitem [ref=e87]:
              - link "الشركات الناشئة" [ref=e88] [cursor=pointer]:
                - /url: /ar/for/startups
            - listitem [ref=e89]:
              - link "العيادات والتجميل" [ref=e90] [cursor=pointer]:
                - /url: /ar/for/clinics
            - listitem [ref=e91]:
              - link "المطاعم والكافيهات" [ref=e92] [cursor=pointer]:
                - /url: /ar/for/restaurants
            - listitem [ref=e93]:
              - link "وكالات التسويق" [ref=e94] [cursor=pointer]:
                - /url: /ar/for/agencies
        - navigation "الموارد" [ref=e95]:
          - paragraph [ref=e96]: الموارد
          - list [ref=e97]:
            - listitem [ref=e98]:
              - link "المدونة والأدلة" [ref=e99] [cursor=pointer]:
                - /url: /ar/blog
            - listitem [ref=e100]:
              - link "أدوات مجانية" [ref=e101] [cursor=pointer]:
                - /url: /ar/tools
            - listitem [ref=e102]:
              - link "مركز المساعدة" [ref=e103] [cursor=pointer]:
                - /url: /ar/help
            - listitem [ref=e104]:
              - link "ما هو وكيل التسويق بالذكاء الاصطناعي؟" [ref=e105] [cursor=pointer]:
                - /url: /ar/ai-marketing-agent
            - listitem [ref=e106]:
              - link "برنامج الشركاء" [ref=e107] [cursor=pointer]:
                - /url: /ar/affiliates
        - navigation "الشركة" [ref=e108]:
          - paragraph [ref=e109]: الشركة
          - list [ref=e110]:
            - listitem [ref=e111]:
              - link "العملاء" [ref=e112] [cursor=pointer]:
                - /url: /ar/customers
            - listitem [ref=e113]:
              - link "المؤسسات" [ref=e114] [cursor=pointer]:
                - /url: /ar/enterprise
            - listitem [ref=e115]:
              - link "الأسعار" [ref=e116] [cursor=pointer]:
                - /url: /ar/pricing
            - listitem [ref=e117]:
              - link "مقارنات" [ref=e118] [cursor=pointer]:
                - /url: /ar/resources#compare
            - listitem [ref=e119]:
              - link "الخصوصية" [ref=e120] [cursor=pointer]:
                - /url: /ar/privacy
            - listitem [ref=e121]:
              - link "الشروط" [ref=e122] [cursor=pointer]:
                - /url: /ar/terms
      - generic [ref=e123]:
        - paragraph [ref=e124]: © 2026 نشر. جميع الحقوق محفوظة.
        - group "اللغة" [ref=e125]:
          - link "العربية" [ref=e126] [cursor=pointer]:
            - /url: /ar/privacy
            - text: عربي
          - link "English" [ref=e127] [cursor=pointer]:
            - /url: /en/privacy
            - text: EN
  - alert [ref=e128]
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
     |                                                                                          ^ Error: /ar/privacy must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```