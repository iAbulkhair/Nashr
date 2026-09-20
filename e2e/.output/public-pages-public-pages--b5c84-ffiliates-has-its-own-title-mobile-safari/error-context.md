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
      - link "نشر" [ref=e4]:
        - /url: /ar
      - generic [ref=e6]:
        - group "اللغة" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/affiliates
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/affiliates
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
    - paragraph [ref=e22]: برنامج الشركاء
    - heading "اكسب 25% متكررة على كل عميل تحيله لنشر." [level=1] [ref=e23]
    - paragraph [ref=e24]: للوكالات والمستشارين وصنّاع المحتوى والنشرات البريدية في الخليج. عميلك يحصل على مسوّق بالذكاء الاصطناعي بلهجته، وأنت تحصل على ربع كل فاتورة، إلى الأبد.
    - generic [ref=e25]:
      - generic [ref=e26]:
        - paragraph [ref=e27]: 25%
        - paragraph [ref=e28]: عمولة متكررة على كل دفعة، مدى حياة العميل
      - generic [ref=e29]:
        - paragraph [ref=e30]: 60 يوماً
        - paragraph [ref=e31]: نافذة الإحالة من الضغط على رابطك
      - generic [ref=e32]:
        - paragraph [ref=e33]: شهرياً
        - paragraph [ref=e34]: دفعات عبر تحويل بنكي، الحد الأدنى 200 ريال
      - generic [ref=e35]:
        - paragraph [ref=e36]: "0"
        - paragraph [ref=e37]: رسوم أو حد أدنى للإحالات
    - generic [ref=e38]:
      - generic [ref=e39]:
        - heading "كيف يعمل" [level=2] [ref=e40]
        - list [ref=e41]:
          - listitem [ref=e42]:
            - generic [ref=e43]: "1."
            - text: قدّم الطلب أدناه. نوافق خلال يوم عمل.
          - listitem [ref=e44]:
            - generic [ref=e45]: "2."
            - text: تستلم رابطك وكودك، ونصوصاً جاهزة للنشر.
          - listitem [ref=e46]:
            - generic [ref=e47]: "3."
            - text: كل من يسجّل عبر رابطك ويشترك خلال 60 يوماً يُحسب لك.
          - listitem [ref=e48]:
            - generic [ref=e49]: "4."
            - text: تستلم 25% من كل دفعة شهرياً عبر تحويل بنكي.
        - heading "القواعد" [level=2] [ref=e50]
        - list [ref=e51]:
          - listitem [ref=e52]: • لا إعلانات مدفوعة على اسم «نشر» أو «نور».
          - listitem [ref=e53]: • لا إحالة ذاتية.
          - listitem [ref=e54]: • 30 يوماً للتحقق من كل دفعة قبل صرف عمولتها.
      - generic [ref=e55]:
        - heading "قدّم طلب الشراكة" [level=2] [ref=e56]
        - textbox "اسمك" [ref=e57]
        - textbox "Email" [ref=e58]
        - textbox "واتساب +966…" [ref=e59]
        - textbox "أين ستروّج؟ (وكالة، يوتيوب، نشرة، لينكدإن…)" [ref=e60]
        - textbox "حجم جمهورك / عدد عملائك" [ref=e61]
        - button "أرسل الطلب" [ref=e62] [cursor=pointer]
  - contentinfo [ref=e63]:
    - generic [ref=e65]:
      - generic [ref=e66]:
        - generic [ref=e67]:
          - paragraph [ref=e68]: نشر
          - paragraph [ref=e69]: وكيلة تسويق تعمل 24/7 — مبنية في الرياض للخليج.
        - navigation "الوكلاء" [ref=e70]:
          - paragraph [ref=e71]: الوكلاء
          - list [ref=e72]:
            - listitem [ref=e73]:
              - link "نور · التسويق" [ref=e74]:
                - /url: /ar/agents/noor
            - listitem [ref=e75]:
              - link "سامي · تمكين المبيعات" [ref=e76]:
                - /url: /ar/agents/sami
            - listitem [ref=e77]:
              - link "رزان · المالية والتسعير والإيرادات" [ref=e78]:
                - /url: /ar/agents/razan
            - listitem [ref=e79]:
              - link "فارس · الدخول للسوق والنمو" [ref=e80]:
                - /url: /ar/agents/faris
            - listitem [ref=e81]:
              - link "دانة · التقارير ولوحات المؤشرات والعروض" [ref=e82]:
                - /url: /ar/agents/dana
            - listitem [ref=e83]:
              - link "ماجد · المستشار التنفيذي" [ref=e84]:
                - /url: /ar/agents/majed
            - listitem [ref=e85]:
              - link "ليان · المنتج والاحتفاظ بالعملاء" [ref=e86]:
                - /url: /ar/agents/layan
        - navigation "القطاعات" [ref=e87]:
          - paragraph [ref=e88]: القطاعات
          - list [ref=e89]:
            - listitem [ref=e90]:
              - link "المتاجر الإلكترونية" [ref=e91]:
                - /url: /ar/for/ecommerce
            - listitem [ref=e92]:
              - link "العقار والمطورون" [ref=e93]:
                - /url: /ar/for/real-estate
            - listitem [ref=e94]:
              - link "المكاتب القانونية" [ref=e95]:
                - /url: /ar/for/legal
            - listitem [ref=e96]:
              - link "الشركات الناشئة" [ref=e97]:
                - /url: /ar/for/startups
            - listitem [ref=e98]:
              - link "العيادات والتجميل" [ref=e99]:
                - /url: /ar/for/clinics
            - listitem [ref=e100]:
              - link "المطاعم والكافيهات" [ref=e101]:
                - /url: /ar/for/restaurants
            - listitem [ref=e102]:
              - link "وكالات التسويق" [ref=e103]:
                - /url: /ar/for/agencies
        - navigation "الموارد" [ref=e104]:
          - paragraph [ref=e105]: الموارد
          - list [ref=e106]:
            - listitem [ref=e107]:
              - link "المدونة والأدلة" [ref=e108]:
                - /url: /ar/blog
            - listitem [ref=e109]:
              - link "أدوات مجانية" [ref=e110]:
                - /url: /ar/tools
            - listitem [ref=e111]:
              - link "مركز المساعدة" [ref=e112]:
                - /url: /ar/help
            - listitem [ref=e113]:
              - link "ما هو وكيل التسويق بالذكاء الاصطناعي؟" [ref=e114]:
                - /url: /ar/ai-marketing-agent
            - listitem [ref=e115]:
              - link "برنامج الشركاء" [ref=e116]:
                - /url: /ar/affiliates
        - navigation "الشركة" [ref=e117]:
          - paragraph [ref=e118]: الشركة
          - list [ref=e119]:
            - listitem [ref=e120]:
              - link "العملاء" [ref=e121]:
                - /url: /ar/customers
            - listitem [ref=e122]:
              - link "المؤسسات" [ref=e123]:
                - /url: /ar/enterprise
            - listitem [ref=e124]:
              - link "الأسعار" [ref=e125]:
                - /url: /ar/pricing
            - listitem [ref=e126]:
              - link "مقارنات" [ref=e127]:
                - /url: /ar/resources#compare
            - listitem [ref=e128]:
              - link "الخصوصية" [ref=e129]:
                - /url: /ar/privacy
            - listitem [ref=e130]:
              - link "الشروط" [ref=e131]:
                - /url: /ar/terms
      - generic [ref=e132]:
        - paragraph [ref=e133]: © 2026 نشر. جميع الحقوق محفوظة.
        - group "اللغة" [ref=e134]:
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
     |                                                                                          ^ Error: /ar/affiliates must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```