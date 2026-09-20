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
      - link "نشر" [ref=e4]:
        - /url: /ar
      - generic [ref=e6]:
        - group "اللغة" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/blog
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/blog
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
    - heading "المدونة" [level=1] [ref=e22]
    - list [ref=e23]:
      - listitem [ref=e24]:
        - 'link "الجمعة البيضاء 2026 للمتاجر السعودية: الدليل الكامل" [ref=e25]':
          - /url: /ar/blog/white-friday-saudi-guide-2026
        - paragraph [ref=e26]: "جدول 6 أسابيع: التسخين، قوائم الانتظار، إعادة الاستهداف، واتساب، الميزانيات، وما تفعله بعد الموسم."
        - paragraph [ref=e27]: 2026-09-17
      - listitem [ref=e28]:
        - 'link "استرجاع السلات المتروكة بواتساب: الدليل الكامل 2026" [ref=e29]':
          - /url: /ar/blog/whatsapp-cart-recovery-guide-2026
        - paragraph [ref=e30]: لماذا واتساب يتفوق على الإيميل في الخليج، القوالب المعتمدة، التوقيت 1/24/72، الرسائل الجاهزة، والأرقام المتوقعة.
        - paragraph [ref=e31]: 2026-09-17
      - listitem [ref=e32]:
        - 'link "تسويق الشركات الناشئة على LinkedIn وX في الخليج: الدليل الكامل 2026" [ref=e33]':
          - /url: /ar/blog/startup-marketing-linkedin-x-guide-2026
        - paragraph [ref=e34]: صوت المؤسس، إيقاع أسبوعي، إطلاق منتج بسلسلة، تجارب إعلانية بميزانية صغيرة، والأرقام التي يقرؤها المستثمرون.
        - paragraph [ref=e35]: 2026-09-17
      - listitem [ref=e36]:
        - 'link "إعلانات سناب شات للمتاجر السعودية: الدليل الكامل 2026" [ref=e37]':
          - /url: /ar/blog/snapchat-ads-saudi-guide-2026
        - paragraph [ref=e38]: لماذا سناب أولاً في السعودية، هيكل الحساب، الكرييتف الذي ينجح، الميزانيات، القياس، والأخطاء التي تحرق المال.
        - paragraph [ref=e39]: 2026-09-17
      - listitem [ref=e40]:
        - 'link "تسويق متاجر سلة: الدليل الكامل 2026" [ref=e41]':
          - /url: /ar/blog/salla-store-marketing-guide-2026
        - paragraph [ref=e42]: "من الإعداد إلى الإعلانات: كيف يسوّق تاجر سلة متجره في السعودية بأقل ميزانية — القنوات، الرسائل، المواسم، والأدوات."
        - paragraph [ref=e43]: 2026-09-17
      - listitem [ref=e44]:
        - 'link "تسويق المطاعم والكافيهات في السعودية: الدليل الكامل 2026" [ref=e45]':
          - /url: /ar/blog/restaurant-marketing-saudi-guide-2026
        - paragraph [ref=e46]: Google Business أولاً، أوقات النشر، الردود على المراجعات، تطبيقات التوصيل، محتوى الطبق، والفروع المتعددة.
        - paragraph [ref=e47]: 2026-09-17
      - listitem [ref=e48]:
        - link "كيف تستبدل وكالتك التسويقية بالذكاء الاصطناعي في 2026 — دليل عملي للخليج" [ref=e49]:
          - /url: /ar/blog/replace-your-agency-with-ai
        - paragraph [ref=e50]: الوكالة تكلّفك 5,000–25,000 ريال شهرياً على تنفيذ يومي يمكن لوكيل ذكاء اصطناعي إنجازه بأقل من 1,000. خطة 30 يوماً للانتقال، وما الذي يبقى للبشر.
        - paragraph [ref=e51]: 2026-09-17
      - listitem [ref=e52]:
        - 'link "تسويق العقار والمطورين في السعودية: الدليل الكامل 2026" [ref=e53]':
          - /url: /ar/blog/real-estate-marketing-saudi-guide-2026
        - paragraph [ref=e54]: تسلسل إطلاق المشروع، محتوى تقدّم البناء، الإعلان الملتزم (فال)، تأهيل المستفسرين على واتساب، وقياس تكلفة العميل المؤهل.
        - paragraph [ref=e55]: 2026-09-17
      - listitem [ref=e56]:
        - 'link "تسويق رمضان للمتاجر والمطاعم: الدليل الكامل" [ref=e57]':
          - /url: /ar/blog/ramadan-marketing-guide-2026
        - paragraph [ref=e58]: أوقات النشر بعد الإفطار، حملات العشر الأواخر، بوكسات الإفطار، هدايا العيد، ورسائل واتساب التي تحترم الشهر وتبيع.
        - paragraph [ref=e59]: 2026-09-17
      - listitem [ref=e60]:
        - link "نشر مقابل Enrich Labs — لماذا بنينا وكيلة تسويق للخليج بدل استخدام الأمريكية" [ref=e61]:
          - /url: /ar/blog/nashr-vs-enrich-labs
        - paragraph [ref=e62]: جرّبنا Helena. ممتازة لأمريكا. هذه القصة الكاملة لما لم تفهمه عن سوقنا، وما بنيناه بدلاً منه.
        - paragraph [ref=e63]: 2026-09-17
      - listitem [ref=e64]:
        - 'link "تسويق المكاتب القانونية في السعودية: الدليل الكامل 2026" [ref=e65]':
          - /url: /ar/blog/law-firm-marketing-saudi-guide-2026
        - paragraph [ref=e66]: ما يسمح به الإعلان المهني، LinkedIn وX للمحامين، المحتوى الذي تقتبسه إجابات الذكاء الاصطناعي، وتأهيل الاستشارات على واتساب.
        - paragraph [ref=e67]: 2026-09-17
      - listitem [ref=e68]:
        - 'link "تسويق العيادات في السعودية: الدليل الكامل 2026 (ملتزم بضوابط وزارة الصحة)" [ref=e69]':
          - /url: /ar/blog/clinic-marketing-saudi-guide-2026
        - paragraph [ref=e70]: ما المسموح وما الممنوع في الإعلان الطبي، أفضل القنوات للعيادات ومراكز التجميل والأسنان، محتوى الطبيب، Google Business، والحجز عبر واتساب.
        - paragraph [ref=e71]: 2026-09-17
      - listitem [ref=e72]:
        - link "أفضل 8 وكلاء تسويق بالذكاء الاصطناعي للخليج 2026 — معيار مُعلن" [ref=e73]:
          - /url: /ar/blog/best-ai-marketing-agents-gulf-2026
        - paragraph [ref=e74]: "قيّمنا 8 أدوات على 6 معايير موزونة: التنفيذ المستقل، العربية واللهجات، القنوات الخليجية، الالتزام، التحكم البشري، السعر. نشر تبني إحداها — والمعيار كامل أمامك."
        - paragraph [ref=e75]: 2026-09-17
  - contentinfo [ref=e76]:
    - generic [ref=e78]:
      - generic [ref=e79]:
        - generic [ref=e80]:
          - paragraph [ref=e81]: نشر
          - paragraph [ref=e82]: وكيلة تسويق تعمل 24/7 — مبنية في الرياض للخليج.
        - navigation "الوكلاء" [ref=e83]:
          - paragraph [ref=e84]: الوكلاء
          - list [ref=e85]:
            - listitem [ref=e86]:
              - link "نور · التسويق" [ref=e87]:
                - /url: /ar/agents/noor
            - listitem [ref=e88]:
              - link "سامي · تمكين المبيعات" [ref=e89]:
                - /url: /ar/agents/sami
            - listitem [ref=e90]:
              - link "رزان · المالية والتسعير والإيرادات" [ref=e91]:
                - /url: /ar/agents/razan
            - listitem [ref=e92]:
              - link "فارس · الدخول للسوق والنمو" [ref=e93]:
                - /url: /ar/agents/faris
            - listitem [ref=e94]:
              - link "دانة · التقارير ولوحات المؤشرات والعروض" [ref=e95]:
                - /url: /ar/agents/dana
            - listitem [ref=e96]:
              - link "ماجد · المستشار التنفيذي" [ref=e97]:
                - /url: /ar/agents/majed
            - listitem [ref=e98]:
              - link "ليان · المنتج والاحتفاظ بالعملاء" [ref=e99]:
                - /url: /ar/agents/layan
        - navigation "القطاعات" [ref=e100]:
          - paragraph [ref=e101]: القطاعات
          - list [ref=e102]:
            - listitem [ref=e103]:
              - link "المتاجر الإلكترونية" [ref=e104]:
                - /url: /ar/for/ecommerce
            - listitem [ref=e105]:
              - link "العقار والمطورون" [ref=e106]:
                - /url: /ar/for/real-estate
            - listitem [ref=e107]:
              - link "المكاتب القانونية" [ref=e108]:
                - /url: /ar/for/legal
            - listitem [ref=e109]:
              - link "الشركات الناشئة" [ref=e110]:
                - /url: /ar/for/startups
            - listitem [ref=e111]:
              - link "العيادات والتجميل" [ref=e112]:
                - /url: /ar/for/clinics
            - listitem [ref=e113]:
              - link "المطاعم والكافيهات" [ref=e114]:
                - /url: /ar/for/restaurants
            - listitem [ref=e115]:
              - link "وكالات التسويق" [ref=e116]:
                - /url: /ar/for/agencies
        - navigation "الموارد" [ref=e117]:
          - paragraph [ref=e118]: الموارد
          - list [ref=e119]:
            - listitem [ref=e120]:
              - link "المدونة والأدلة" [ref=e121]:
                - /url: /ar/blog
            - listitem [ref=e122]:
              - link "أدوات مجانية" [ref=e123]:
                - /url: /ar/tools
            - listitem [ref=e124]:
              - link "مركز المساعدة" [ref=e125]:
                - /url: /ar/help
            - listitem [ref=e126]:
              - link "ما هو وكيل التسويق بالذكاء الاصطناعي؟" [ref=e127]:
                - /url: /ar/ai-marketing-agent
            - listitem [ref=e128]:
              - link "برنامج الشركاء" [ref=e129]:
                - /url: /ar/affiliates
        - navigation "الشركة" [ref=e130]:
          - paragraph [ref=e131]: الشركة
          - list [ref=e132]:
            - listitem [ref=e133]:
              - link "العملاء" [ref=e134]:
                - /url: /ar/customers
            - listitem [ref=e135]:
              - link "المؤسسات" [ref=e136]:
                - /url: /ar/enterprise
            - listitem [ref=e137]:
              - link "الأسعار" [ref=e138]:
                - /url: /ar/pricing
            - listitem [ref=e139]:
              - link "مقارنات" [ref=e140]:
                - /url: /ar/resources#compare
            - listitem [ref=e141]:
              - link "الخصوصية" [ref=e142]:
                - /url: /ar/privacy
            - listitem [ref=e143]:
              - link "الشروط" [ref=e144]:
                - /url: /ar/terms
      - generic [ref=e145]:
        - paragraph [ref=e146]: © 2026 نشر. جميع الحقوق محفوظة.
        - group "اللغة" [ref=e147]:
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
     |                                                                                          ^ Error: /ar/blog must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```