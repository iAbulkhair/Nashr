# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: public-pages.spec.ts >> public pages · ar >> /ar/blog has its own title
- Location: e2e/public-pages.spec.ts:30:13

# Error details

```
Error: /ar/blog must not fall back to the site-wide default title

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
            - /url: /ar/blog
            - text: عربي
          - link "English" [ref=e25] [cursor=pointer]:
            - /url: /en/blog
            - text: EN
        - link "دخول" [ref=e26] [cursor=pointer]:
          - /url: /ar/app/login
        - link "ابدأ مجاناً" [ref=e27] [cursor=pointer]:
          - /url: /ar/app/signup
  - main [ref=e28]:
    - heading "المدونة" [level=1] [ref=e29]
    - list [ref=e30]:
      - listitem [ref=e31]:
        - 'link "الجمعة البيضاء 2026 للمتاجر السعودية: الدليل الكامل" [ref=e32] [cursor=pointer]':
          - /url: /ar/blog/white-friday-saudi-guide-2026
        - paragraph [ref=e33]: "جدول 6 أسابيع: التسخين، قوائم الانتظار، إعادة الاستهداف، واتساب، الميزانيات، وما تفعله بعد الموسم."
        - paragraph [ref=e34]: 2026-09-17
      - listitem [ref=e35]:
        - 'link "استرجاع السلات المتروكة بواتساب: الدليل الكامل 2026" [ref=e36] [cursor=pointer]':
          - /url: /ar/blog/whatsapp-cart-recovery-guide-2026
        - paragraph [ref=e37]: لماذا واتساب يتفوق على الإيميل في الخليج، القوالب المعتمدة، التوقيت 1/24/72، الرسائل الجاهزة، والأرقام المتوقعة.
        - paragraph [ref=e38]: 2026-09-17
      - listitem [ref=e39]:
        - 'link "تسويق الشركات الناشئة على LinkedIn وX في الخليج: الدليل الكامل 2026" [ref=e40] [cursor=pointer]':
          - /url: /ar/blog/startup-marketing-linkedin-x-guide-2026
        - paragraph [ref=e41]: صوت المؤسس، إيقاع أسبوعي، إطلاق منتج بسلسلة، تجارب إعلانية بميزانية صغيرة، والأرقام التي يقرؤها المستثمرون.
        - paragraph [ref=e42]: 2026-09-17
      - listitem [ref=e43]:
        - 'link "إعلانات سناب شات للمتاجر السعودية: الدليل الكامل 2026" [ref=e44] [cursor=pointer]':
          - /url: /ar/blog/snapchat-ads-saudi-guide-2026
        - paragraph [ref=e45]: لماذا سناب أولاً في السعودية، هيكل الحساب، الكرييتف الذي ينجح، الميزانيات، القياس، والأخطاء التي تحرق المال.
        - paragraph [ref=e46]: 2026-09-17
      - listitem [ref=e47]:
        - 'link "تسويق متاجر سلة: الدليل الكامل 2026" [ref=e48] [cursor=pointer]':
          - /url: /ar/blog/salla-store-marketing-guide-2026
        - paragraph [ref=e49]: "من الإعداد إلى الإعلانات: كيف يسوّق تاجر سلة متجره في السعودية بأقل ميزانية — القنوات، الرسائل، المواسم، والأدوات."
        - paragraph [ref=e50]: 2026-09-17
      - listitem [ref=e51]:
        - 'link "تسويق المطاعم والكافيهات في السعودية: الدليل الكامل 2026" [ref=e52] [cursor=pointer]':
          - /url: /ar/blog/restaurant-marketing-saudi-guide-2026
        - paragraph [ref=e53]: Google Business أولاً، أوقات النشر، الردود على المراجعات، تطبيقات التوصيل، محتوى الطبق، والفروع المتعددة.
        - paragraph [ref=e54]: 2026-09-17
      - listitem [ref=e55]:
        - link "كيف تستبدل وكالتك التسويقية بالذكاء الاصطناعي في 2026 — دليل عملي للخليج" [ref=e56] [cursor=pointer]:
          - /url: /ar/blog/replace-your-agency-with-ai
        - paragraph [ref=e57]: الوكالة تكلّفك 5,000–25,000 ريال شهرياً على تنفيذ يومي يمكن لوكيل ذكاء اصطناعي إنجازه بأقل من 1,000. خطة 30 يوماً للانتقال، وما الذي يبقى للبشر.
        - paragraph [ref=e58]: 2026-09-17
      - listitem [ref=e59]:
        - 'link "تسويق العقار والمطورين في السعودية: الدليل الكامل 2026" [ref=e60] [cursor=pointer]':
          - /url: /ar/blog/real-estate-marketing-saudi-guide-2026
        - paragraph [ref=e61]: تسلسل إطلاق المشروع، محتوى تقدّم البناء، الإعلان الملتزم (فال)، تأهيل المستفسرين على واتساب، وقياس تكلفة العميل المؤهل.
        - paragraph [ref=e62]: 2026-09-17
      - listitem [ref=e63]:
        - 'link "تسويق رمضان للمتاجر والمطاعم: الدليل الكامل" [ref=e64] [cursor=pointer]':
          - /url: /ar/blog/ramadan-marketing-guide-2026
        - paragraph [ref=e65]: أوقات النشر بعد الإفطار، حملات العشر الأواخر، بوكسات الإفطار، هدايا العيد، ورسائل واتساب التي تحترم الشهر وتبيع.
        - paragraph [ref=e66]: 2026-09-17
      - listitem [ref=e67]:
        - link "نشر مقابل Enrich Labs — لماذا بنينا وكيلة تسويق للخليج بدل استخدام الأمريكية" [ref=e68] [cursor=pointer]:
          - /url: /ar/blog/nashr-vs-enrich-labs
        - paragraph [ref=e69]: جرّبنا Helena. ممتازة لأمريكا. هذه القصة الكاملة لما لم تفهمه عن سوقنا، وما بنيناه بدلاً منه.
        - paragraph [ref=e70]: 2026-09-17
      - listitem [ref=e71]:
        - 'link "تسويق المكاتب القانونية في السعودية: الدليل الكامل 2026" [ref=e72] [cursor=pointer]':
          - /url: /ar/blog/law-firm-marketing-saudi-guide-2026
        - paragraph [ref=e73]: ما يسمح به الإعلان المهني، LinkedIn وX للمحامين، المحتوى الذي تقتبسه إجابات الذكاء الاصطناعي، وتأهيل الاستشارات على واتساب.
        - paragraph [ref=e74]: 2026-09-17
      - listitem [ref=e75]:
        - 'link "تسويق العيادات في السعودية: الدليل الكامل 2026 (ملتزم بضوابط وزارة الصحة)" [ref=e76] [cursor=pointer]':
          - /url: /ar/blog/clinic-marketing-saudi-guide-2026
        - paragraph [ref=e77]: ما المسموح وما الممنوع في الإعلان الطبي، أفضل القنوات للعيادات ومراكز التجميل والأسنان، محتوى الطبيب، Google Business، والحجز عبر واتساب.
        - paragraph [ref=e78]: 2026-09-17
      - listitem [ref=e79]:
        - link "أفضل 8 وكلاء تسويق بالذكاء الاصطناعي للخليج 2026 — معيار مُعلن" [ref=e80] [cursor=pointer]:
          - /url: /ar/blog/best-ai-marketing-agents-gulf-2026
        - paragraph [ref=e81]: "قيّمنا 8 أدوات على 6 معايير موزونة: التنفيذ المستقل، العربية واللهجات، القنوات الخليجية، الالتزام، التحكم البشري، السعر. نشر تبني إحداها — والمعيار كامل أمامك."
        - paragraph [ref=e82]: 2026-09-17
  - contentinfo [ref=e83]:
    - generic [ref=e85]:
      - generic [ref=e86]:
        - generic [ref=e87]:
          - paragraph [ref=e88]: نشر
          - paragraph [ref=e89]: وكيلة تسويق تعمل 24/7 — مبنية في الرياض للخليج.
        - navigation "الوكلاء" [ref=e90]:
          - paragraph [ref=e91]: الوكلاء
          - list [ref=e92]:
            - listitem [ref=e93]:
              - link "نور · التسويق" [ref=e94] [cursor=pointer]:
                - /url: /ar/agents/noor
            - listitem [ref=e95]:
              - link "سامي · تمكين المبيعات" [ref=e96] [cursor=pointer]:
                - /url: /ar/agents/sami
            - listitem [ref=e97]:
              - link "رزان · المالية والتسعير والإيرادات" [ref=e98] [cursor=pointer]:
                - /url: /ar/agents/razan
            - listitem [ref=e99]:
              - link "فارس · الدخول للسوق والنمو" [ref=e100] [cursor=pointer]:
                - /url: /ar/agents/faris
            - listitem [ref=e101]:
              - link "دانة · التقارير ولوحات المؤشرات والعروض" [ref=e102] [cursor=pointer]:
                - /url: /ar/agents/dana
            - listitem [ref=e103]:
              - link "ماجد · المستشار التنفيذي" [ref=e104] [cursor=pointer]:
                - /url: /ar/agents/majed
            - listitem [ref=e105]:
              - link "ليان · المنتج والاحتفاظ بالعملاء" [ref=e106] [cursor=pointer]:
                - /url: /ar/agents/layan
        - navigation "القطاعات" [ref=e107]:
          - paragraph [ref=e108]: القطاعات
          - list [ref=e109]:
            - listitem [ref=e110]:
              - link "المتاجر الإلكترونية" [ref=e111] [cursor=pointer]:
                - /url: /ar/for/ecommerce
            - listitem [ref=e112]:
              - link "العقار والمطورون" [ref=e113] [cursor=pointer]:
                - /url: /ar/for/real-estate
            - listitem [ref=e114]:
              - link "المكاتب القانونية" [ref=e115] [cursor=pointer]:
                - /url: /ar/for/legal
            - listitem [ref=e116]:
              - link "الشركات الناشئة" [ref=e117] [cursor=pointer]:
                - /url: /ar/for/startups
            - listitem [ref=e118]:
              - link "العيادات والتجميل" [ref=e119] [cursor=pointer]:
                - /url: /ar/for/clinics
            - listitem [ref=e120]:
              - link "المطاعم والكافيهات" [ref=e121] [cursor=pointer]:
                - /url: /ar/for/restaurants
            - listitem [ref=e122]:
              - link "وكالات التسويق" [ref=e123] [cursor=pointer]:
                - /url: /ar/for/agencies
        - navigation "الموارد" [ref=e124]:
          - paragraph [ref=e125]: الموارد
          - list [ref=e126]:
            - listitem [ref=e127]:
              - link "المدونة والأدلة" [ref=e128] [cursor=pointer]:
                - /url: /ar/blog
            - listitem [ref=e129]:
              - link "أدوات مجانية" [ref=e130] [cursor=pointer]:
                - /url: /ar/tools
            - listitem [ref=e131]:
              - link "مركز المساعدة" [ref=e132] [cursor=pointer]:
                - /url: /ar/help
            - listitem [ref=e133]:
              - link "ما هو وكيل التسويق بالذكاء الاصطناعي؟" [ref=e134] [cursor=pointer]:
                - /url: /ar/ai-marketing-agent
            - listitem [ref=e135]:
              - link "برنامج الشركاء" [ref=e136] [cursor=pointer]:
                - /url: /ar/affiliates
        - navigation "الشركة" [ref=e137]:
          - paragraph [ref=e138]: الشركة
          - list [ref=e139]:
            - listitem [ref=e140]:
              - link "العملاء" [ref=e141] [cursor=pointer]:
                - /url: /ar/customers
            - listitem [ref=e142]:
              - link "المؤسسات" [ref=e143] [cursor=pointer]:
                - /url: /ar/enterprise
            - listitem [ref=e144]:
              - link "الأسعار" [ref=e145] [cursor=pointer]:
                - /url: /ar/pricing
            - listitem [ref=e146]:
              - link "مقارنات" [ref=e147] [cursor=pointer]:
                - /url: /ar/resources#compare
            - listitem [ref=e148]:
              - link "الخصوصية" [ref=e149] [cursor=pointer]:
                - /url: /ar/privacy
            - listitem [ref=e150]:
              - link "الشروط" [ref=e151] [cursor=pointer]:
                - /url: /ar/terms
      - generic [ref=e152]:
        - paragraph [ref=e153]: © 2026 نشر. جميع الحقوق محفوظة.
        - group "اللغة" [ref=e154]:
          - link "العربية" [ref=e155] [cursor=pointer]:
            - /url: /ar/blog
            - text: عربي
          - link "English" [ref=e156] [cursor=pointer]:
            - /url: /en/blog
            - text: EN
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
     |                                                                                          ^ Error: /ar/blog must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```