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
      - link "نشر" [ref=e4]:
        - /url: /ar
      - generic [ref=e6]:
        - group "اللغة" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/privacy
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/privacy
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
    - heading "سياسة الخصوصية" [level=1] [ref=e22]
    - paragraph [ref=e23]: "آخر تحديث: 2026-09-17"
    - generic [ref=e24]:
      - heading "من نحن" [level=2] [ref=e25]
      - paragraph [ref=e26]: نشر (Nashr) منصة تسويق بالذكاء الاصطناعي للشركات في دول الخليج. هذه السياسة تشرح البيانات التي نجمعها وكيف نستخدمها وحقوقك وفق نظام حماية البيانات الشخصية في المملكة العربية السعودية.
    - generic [ref=e27]:
      - heading "البيانات التي نجمعها" [level=2] [ref=e28]
      - paragraph [ref=e29]: "بيانات الحساب: الاسم، البريد الإلكتروني، رقم الجوال، كلمة المرور (مشفّرة)."
      - paragraph [ref=e30]: "بيانات العلامة التجارية: موقعك، منتجاتك، جمهورك، أسلوبك، وما تكتبه لنور."
      - paragraph [ref=e31]: "بيانات المنصات المرتبطة: عند ربط متجر أو حساب (سلة، زد، شوبيفاي، X، قوقل، ميتا…) نخزّن رموز الوصول مشفّرة ونقرأ فقط ما تسمح به الصلاحيات التي وافقت عليها."
      - paragraph [ref=e32]: "بيانات الاستخدام: الطلبات التي ترسلها لنور، ما تعتمده أو ترفضه، وسجلات تقنية لتشغيل الخدمة."
    - generic [ref=e33]:
      - heading "كيف نستخدمها" [level=2] [ref=e34]
      - paragraph [ref=e35]: "لتشغيل الخدمة: إنشاء المحتوى، الخطط، الرسائل، والنشر على المنصات التي ربطتها بناءً على أوامرك."
      - paragraph [ref=e36]: "لتحسين نور لعلامتك: تعديلاتك تُحفظ كتفضيلات خاصة بحسابك فقط."
      - paragraph [ref=e37]: لا نبيع بياناتك. لا ندرّب نماذج عامة على محتواك. نستخدم مزوّدي ذكاء اصطناعي (Anthropic) وبنية تحتية (Vercel، Upstash) لمعالجة البيانات وفق اتفاقيات معالجة بيانات.
    - generic [ref=e38]:
      - heading "المنصات المرتبطة" [level=2] [ref=e39]
      - paragraph [ref=e40]: عند ربط حساب عبر OAuth، يمكنك فصله في أي وقت من صفحة التكاملات، وسنحذف رموز الوصول فوراً. نطلب أقل الصلاحيات اللازمة، ولا ننشر شيئاً دون موافقتك أو إعدادات الحوكمة التي ضبطتها.
    - generic [ref=e41]:
      - heading "الاحتفاظ والحذف" [level=2] [ref=e42]
      - paragraph [ref=e43]: نحتفظ بالبيانات ما دام حسابك نشطاً. يمكنك طلب تصدير أو حذف كامل لبياناتك عبر hello@nashr.ai وننفّذ خلال 30 يوماً.
    - generic [ref=e44]:
      - heading "حقوقك" [level=2] [ref=e45]
      - paragraph [ref=e46]: "الوصول، التصحيح، الحذف، الاعتراض على المعالجة، ونقل البيانات. للتواصل: hello@nashr.ai أو واتساب +966 55 923 5281."
  - contentinfo [ref=e47]:
    - generic [ref=e49]:
      - generic [ref=e50]:
        - generic [ref=e51]:
          - paragraph [ref=e52]: نشر
          - paragraph [ref=e53]: وكيلة تسويق تعمل 24/7 — مبنية في الرياض للخليج.
        - navigation "الوكلاء" [ref=e54]:
          - paragraph [ref=e55]: الوكلاء
          - list [ref=e56]:
            - listitem [ref=e57]:
              - link "نور · التسويق" [ref=e58]:
                - /url: /ar/agents/noor
            - listitem [ref=e59]:
              - link "سامي · تمكين المبيعات" [ref=e60]:
                - /url: /ar/agents/sami
            - listitem [ref=e61]:
              - link "رزان · المالية والتسعير والإيرادات" [ref=e62]:
                - /url: /ar/agents/razan
            - listitem [ref=e63]:
              - link "فارس · الدخول للسوق والنمو" [ref=e64]:
                - /url: /ar/agents/faris
            - listitem [ref=e65]:
              - link "دانة · التقارير ولوحات المؤشرات والعروض" [ref=e66]:
                - /url: /ar/agents/dana
            - listitem [ref=e67]:
              - link "ماجد · المستشار التنفيذي" [ref=e68]:
                - /url: /ar/agents/majed
            - listitem [ref=e69]:
              - link "ليان · المنتج والاحتفاظ بالعملاء" [ref=e70]:
                - /url: /ar/agents/layan
        - navigation "القطاعات" [ref=e71]:
          - paragraph [ref=e72]: القطاعات
          - list [ref=e73]:
            - listitem [ref=e74]:
              - link "المتاجر الإلكترونية" [ref=e75]:
                - /url: /ar/for/ecommerce
            - listitem [ref=e76]:
              - link "العقار والمطورون" [ref=e77]:
                - /url: /ar/for/real-estate
            - listitem [ref=e78]:
              - link "المكاتب القانونية" [ref=e79]:
                - /url: /ar/for/legal
            - listitem [ref=e80]:
              - link "الشركات الناشئة" [ref=e81]:
                - /url: /ar/for/startups
            - listitem [ref=e82]:
              - link "العيادات والتجميل" [ref=e83]:
                - /url: /ar/for/clinics
            - listitem [ref=e84]:
              - link "المطاعم والكافيهات" [ref=e85]:
                - /url: /ar/for/restaurants
            - listitem [ref=e86]:
              - link "وكالات التسويق" [ref=e87]:
                - /url: /ar/for/agencies
        - navigation "الموارد" [ref=e88]:
          - paragraph [ref=e89]: الموارد
          - list [ref=e90]:
            - listitem [ref=e91]:
              - link "المدونة والأدلة" [ref=e92]:
                - /url: /ar/blog
            - listitem [ref=e93]:
              - link "أدوات مجانية" [ref=e94]:
                - /url: /ar/tools
            - listitem [ref=e95]:
              - link "مركز المساعدة" [ref=e96]:
                - /url: /ar/help
            - listitem [ref=e97]:
              - link "ما هو وكيل التسويق بالذكاء الاصطناعي؟" [ref=e98]:
                - /url: /ar/ai-marketing-agent
            - listitem [ref=e99]:
              - link "برنامج الشركاء" [ref=e100]:
                - /url: /ar/affiliates
        - navigation "الشركة" [ref=e101]:
          - paragraph [ref=e102]: الشركة
          - list [ref=e103]:
            - listitem [ref=e104]:
              - link "العملاء" [ref=e105]:
                - /url: /ar/customers
            - listitem [ref=e106]:
              - link "المؤسسات" [ref=e107]:
                - /url: /ar/enterprise
            - listitem [ref=e108]:
              - link "الأسعار" [ref=e109]:
                - /url: /ar/pricing
            - listitem [ref=e110]:
              - link "مقارنات" [ref=e111]:
                - /url: /ar/resources#compare
            - listitem [ref=e112]:
              - link "الخصوصية" [ref=e113]:
                - /url: /ar/privacy
            - listitem [ref=e114]:
              - link "الشروط" [ref=e115]:
                - /url: /ar/terms
      - generic [ref=e116]:
        - paragraph [ref=e117]: © 2026 نشر. جميع الحقوق محفوظة.
        - group "اللغة" [ref=e118]:
          - link "العربية" [ref=e119]:
            - /url: /ar/privacy
            - text: عربي
          - link "English" [ref=e120]:
            - /url: /en/privacy
            - text: EN
  - alert [ref=e121]
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