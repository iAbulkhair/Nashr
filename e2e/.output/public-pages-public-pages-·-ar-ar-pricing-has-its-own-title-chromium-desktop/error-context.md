# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: public-pages.spec.ts >> public pages · ar >> /ar/pricing has its own title
- Location: e2e/public-pages.spec.ts:30:13

# Error details

```
Error: /ar/pricing must not fall back to the site-wide default title

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
            - /url: /ar/pricing
            - text: عربي
          - link "English" [ref=e25] [cursor=pointer]:
            - /url: /en/pricing
            - text: EN
        - link "دخول" [ref=e26] [cursor=pointer]:
          - /url: /ar/app/login
        - link "ابدأ مجاناً" [ref=e27] [cursor=pointer]:
          - /url: /ar/app/signup
  - main [ref=e28]:
    - generic [ref=e30]:
      - paragraph [ref=e31]: الأسعار
      - heading "أرخص من موظف واحد. أسرع من وكالة." [level=2] [ref=e32]
      - paragraph [ref=e33]: بالريال السعودي، شامل الضريبة عند الدفع. ألغِ في أي وقت.
      - generic [ref=e34]:
        - generic [ref=e35]: تجربة 3 أيام مجاناً — بدون بطاقة
        - generic [ref=e36]: ادفع سنوياً ووفّر شهرين
      - generic [ref=e37]:
        - article [ref=e38]:
          - heading "البداية" [level=3] [ref=e39]
          - paragraph [ref=e40]: للتاجر الفرد والمبدع
          - paragraph [ref=e41]:
            - generic [ref=e42]: "149"
            - generic [ref=e43]: ريال / شهر
          - paragraph [ref=e44]: 200 كريدت شهرياً
          - list [ref=e45]:
            - listitem [ref=e46]:
              - generic [ref=e48]: علامة واحدة، مستخدم واحد
            - listitem [ref=e49]:
              - generic [ref=e51]: منشورات سوشال + صور
            - listitem [ref=e52]:
              - generic [ref=e54]: مقالات SEO بالعربي
            - listitem [ref=e55]:
              - generic [ref=e57]: حملات سناب وميتا (قراءة + اقتراحات)
            - listitem [ref=e58]:
              - generic [ref=e60]: ملخص واتساب أسبوعي
            - listitem [ref=e61]:
              - generic [ref=e63]: 10 مهام متزامنة
          - link "ابدأ مجاناً" [ref=e64] [cursor=pointer]:
            - /url: /ar/app/signup
        - article [ref=e65]:
          - heading "الاحتراف" [level=3] [ref=e66]
          - paragraph [ref=e67]: للمؤسس والمتجر والعيادة
          - paragraph [ref=e68]:
            - generic [ref=e69]: "399"
            - generic [ref=e70]: ريال / شهر
          - paragraph [ref=e71]: 700 كريدت شهرياً
          - list [ref=e72]:
            - listitem [ref=e73]:
              - generic [ref=e75]: كل ما في البداية
            - listitem [ref=e76]:
              - generic [ref=e78]: ضبط الإعلانات تلقائياً ضمن حدودك
            - listitem [ref=e79]:
              - generic [ref=e81]: حملات واتساب + استرجاع السلات
            - listitem [ref=e82]:
              - generic [ref=e84]: تدقيق إعلانات أسبوعي وكشف الهدر
            - listitem [ref=e85]:
              - generic [ref=e87]: ملخص يومي 8 صباحاً
            - listitem [ref=e88]:
              - generic [ref=e90]: 70+ خطة جاهزة خليجية
            - listitem [ref=e91]:
              - generic [ref=e93]: مقاعد إضافية 99 ريال/مقعد
            - listitem [ref=e94]:
              - generic [ref=e96]: 20 مهمة متزامنة
          - link "ابدأ مجاناً" [ref=e97] [cursor=pointer]:
            - /url: /ar/app/signup
        - article [ref=e98]:
          - heading "الوكالة" [level=3] [ref=e99]
          - paragraph [ref=e100]: للوكالات ومتعدد الفروع
          - paragraph [ref=e101]:
            - generic [ref=e102]: "799"
            - generic [ref=e103]: ريال / شهر
          - paragraph [ref=e104]: 2,000 كريدت شهرياً — يترحّل
          - list [ref=e105]:
            - listitem [ref=e106]:
              - generic [ref=e108]: كل ما في الاحتراف
            - listitem [ref=e109]:
              - generic [ref=e111]: علامات متعددة (5 مشمولة)
            - listitem [ref=e112]:
              - generic [ref=e114]: علامة إضافية 99 ريال
            - listitem [ref=e115]:
              - generic [ref=e117]: تقارير بعلامتك للعملاء
            - listitem [ref=e118]:
              - generic [ref=e120]: صلاحيات فريق وأدوار
            - listitem [ref=e121]:
              - generic [ref=e123]: ضبط الإعلانات كل ساعتين
            - listitem [ref=e124]:
              - generic [ref=e126]: مهام غير محدودة
            - listitem [ref=e127]:
              - generic [ref=e129]: وصول MCP و API
          - link "ابدأ مجاناً" [ref=e130] [cursor=pointer]:
            - /url: /ar/app/signup
        - article [ref=e131]:
          - heading "المؤسسات" [level=3] [ref=e132]
          - paragraph [ref=e133]: للمجموعات والجهات الكبيرة
          - paragraph [ref=e134]:
            - generic [ref=e135]: حسب الطلب
            - generic [ref=e136]: فوترة سنوية
          - paragraph [ref=e137]: كريدت مخصص
          - list [ref=e138]:
            - listitem [ref=e139]:
              - generic [ref=e141]: الوكلاء المتخصصون كلهم
            - listitem [ref=e142]:
              - generic [ref=e144]: استضافة البيانات داخل السعودية
            - listitem [ref=e145]:
              - generic [ref=e147]: ربط CRM ومستودع البيانات
            - listitem [ref=e148]:
              - generic [ref=e150]: تدريب نموذج على صوت علامتك
            - listitem [ref=e151]:
              - generic [ref=e153]: مدير نجاح مخصص
            - listitem [ref=e154]:
              - generic [ref=e156]: SLA ساعة واحدة
            - listitem [ref=e157]:
              - generic [ref=e159]: علامات ومستخدمون بلا حد
          - link "احجز عرضاً" [ref=e160] [cursor=pointer]:
            - /url: /ar/app/signup
      - generic [ref=e161]:
        - heading "كم تكلّف كل مهمة؟" [level=3] [ref=e162]
        - table [ref=e163]:
          - rowgroup [ref=e164]:
            - row [ref=e165]:
              - cell "منشور سوشال / إعلان / رسالة واتساب / صورة" [ref=e166]
              - cell "1" [ref=e167]
            - row [ref=e168]:
              - cell "مقال SEO / بطاقة تأهيل / تقرير أسبوعي" [ref=e169]
              - cell "2" [ref=e170]
            - row [ref=e171]:
              - cell "اقتصاديات الوحدة / سلسلة متابعة" [ref=e172]
              - cell "3" [ref=e173]
            - row [ref=e174]:
              - cell "سكربتات مبيعات / مراجعة تسعير / تدفق نقدي / تجارب نمو" [ref=e175]
              - cell "4" [ref=e176]
            - row [ref=e177]:
              - cell "خطة دخول للسوق / عرض مجلس الإدارة / مراجعة استراتيجية" [ref=e178]
              - cell "5" [ref=e179]
            - row [ref=e180]:
              - cell "الدردشة مع الفريق والإعداد من رابط موقعك" [ref=e181]
              - cell "مجاناً" [ref=e182]
    - generic [ref=e185]:
      - paragraph [ref=e186]: الأسئلة الشائعة
      - heading "أسئلة؟ خذ الخلاصة." [level=2] [ref=e187]
      - generic [ref=e188]:
        - group [ref=e189]:
          - generic "ليش ما أستخدم ChatGPT أو Claude مباشرة؟" [ref=e190] [cursor=pointer]:
            - text: ليش ما أستخدم ChatGPT أو Claude مباشرة؟
            - generic [aria-hidden] [ref=e191]: +
        - group [ref=e192]:
          - generic "هل تنشر نور بدون إذني؟" [ref=e193] [cursor=pointer]:
            - text: هل تنشر نور بدون إذني؟
            - generic [aria-hidden] [ref=e194]: +
        - group [ref=e195]:
          - generic "وش يعني ملخص الصباح؟" [ref=e196] [cursor=pointer]:
            - text: وش يعني ملخص الصباح؟
            - generic [aria-hidden] [ref=e197]: +
        - group [ref=e198]:
          - generic "متى أشوف نتائج؟" [ref=e199] [cursor=pointer]:
            - text: متى أشوف نتائج؟
            - generic [aria-hidden] [ref=e200]: +
        - group [ref=e201]:
          - generic "كم تكلّف؟" [ref=e202] [cursor=pointer]:
            - text: كم تكلّف؟
            - generic [aria-hidden] [ref=e203]: +
        - group [ref=e204]:
          - generic "الخصوصية؟" [ref=e205] [cursor=pointer]:
            - text: الخصوصية؟
            - generic [aria-hidden] [ref=e206]: +
        - group [ref=e207]:
          - generic "هل تتعلم صوت علامتي؟" [ref=e208] [cursor=pointer]:
            - text: هل تتعلم صوت علامتي؟
            - generic [aria-hidden] [ref=e209]: +
        - group [ref=e210]:
          - generic "أقدر ألغي؟" [ref=e211] [cursor=pointer]:
            - text: أقدر ألغي؟
            - generic [aria-hidden] [ref=e212]: +
        - group [ref=e213]:
          - generic "من هم بقية الفريق؟" [ref=e214] [cursor=pointer]:
            - text: من هم بقية الفريق؟
            - generic [aria-hidden] [ref=e215]: +
    - generic [ref=e217]:
      - heading "وأنت نايم، نور تسوّق." [level=2] [ref=e218]
      - paragraph [ref=e219]: تجربة 3 أيام مجاناً — بدون بطاقة
      - link "ابدأ تجربتك المجانية" [ref=e220] [cursor=pointer]:
        - /url: /ar/app/signup
  - contentinfo [ref=e221]:
    - generic [ref=e223]:
      - generic [ref=e224]:
        - generic [ref=e225]:
          - paragraph [ref=e226]: نشر
          - paragraph [ref=e227]: وكيلة تسويق تعمل 24/7 — مبنية في الرياض للخليج.
        - navigation "الوكلاء" [ref=e228]:
          - paragraph [ref=e229]: الوكلاء
          - list [ref=e230]:
            - listitem [ref=e231]:
              - link "نور · التسويق" [ref=e232] [cursor=pointer]:
                - /url: /ar/agents/noor
            - listitem [ref=e233]:
              - link "سامي · تمكين المبيعات" [ref=e234] [cursor=pointer]:
                - /url: /ar/agents/sami
            - listitem [ref=e235]:
              - link "رزان · المالية والتسعير والإيرادات" [ref=e236] [cursor=pointer]:
                - /url: /ar/agents/razan
            - listitem [ref=e237]:
              - link "فارس · الدخول للسوق والنمو" [ref=e238] [cursor=pointer]:
                - /url: /ar/agents/faris
            - listitem [ref=e239]:
              - link "دانة · التقارير ولوحات المؤشرات والعروض" [ref=e240] [cursor=pointer]:
                - /url: /ar/agents/dana
            - listitem [ref=e241]:
              - link "ماجد · المستشار التنفيذي" [ref=e242] [cursor=pointer]:
                - /url: /ar/agents/majed
            - listitem [ref=e243]:
              - link "ليان · المنتج والاحتفاظ بالعملاء" [ref=e244] [cursor=pointer]:
                - /url: /ar/agents/layan
        - navigation "القطاعات" [ref=e245]:
          - paragraph [ref=e246]: القطاعات
          - list [ref=e247]:
            - listitem [ref=e248]:
              - link "المتاجر الإلكترونية" [ref=e249] [cursor=pointer]:
                - /url: /ar/for/ecommerce
            - listitem [ref=e250]:
              - link "العقار والمطورون" [ref=e251] [cursor=pointer]:
                - /url: /ar/for/real-estate
            - listitem [ref=e252]:
              - link "المكاتب القانونية" [ref=e253] [cursor=pointer]:
                - /url: /ar/for/legal
            - listitem [ref=e254]:
              - link "الشركات الناشئة" [ref=e255] [cursor=pointer]:
                - /url: /ar/for/startups
            - listitem [ref=e256]:
              - link "العيادات والتجميل" [ref=e257] [cursor=pointer]:
                - /url: /ar/for/clinics
            - listitem [ref=e258]:
              - link "المطاعم والكافيهات" [ref=e259] [cursor=pointer]:
                - /url: /ar/for/restaurants
            - listitem [ref=e260]:
              - link "وكالات التسويق" [ref=e261] [cursor=pointer]:
                - /url: /ar/for/agencies
        - navigation "الموارد" [ref=e262]:
          - paragraph [ref=e263]: الموارد
          - list [ref=e264]:
            - listitem [ref=e265]:
              - link "المدونة والأدلة" [ref=e266] [cursor=pointer]:
                - /url: /ar/blog
            - listitem [ref=e267]:
              - link "أدوات مجانية" [ref=e268] [cursor=pointer]:
                - /url: /ar/tools
            - listitem [ref=e269]:
              - link "مركز المساعدة" [ref=e270] [cursor=pointer]:
                - /url: /ar/help
            - listitem [ref=e271]:
              - link "ما هو وكيل التسويق بالذكاء الاصطناعي؟" [ref=e272] [cursor=pointer]:
                - /url: /ar/ai-marketing-agent
            - listitem [ref=e273]:
              - link "برنامج الشركاء" [ref=e274] [cursor=pointer]:
                - /url: /ar/affiliates
        - navigation "الشركة" [ref=e275]:
          - paragraph [ref=e276]: الشركة
          - list [ref=e277]:
            - listitem [ref=e278]:
              - link "العملاء" [ref=e279] [cursor=pointer]:
                - /url: /ar/customers
            - listitem [ref=e280]:
              - link "المؤسسات" [ref=e281] [cursor=pointer]:
                - /url: /ar/enterprise
            - listitem [ref=e282]:
              - link "الأسعار" [ref=e283] [cursor=pointer]:
                - /url: /ar/pricing
            - listitem [ref=e284]:
              - link "مقارنات" [ref=e285] [cursor=pointer]:
                - /url: /ar/resources#compare
            - listitem [ref=e286]:
              - link "الخصوصية" [ref=e287] [cursor=pointer]:
                - /url: /ar/privacy
            - listitem [ref=e288]:
              - link "الشروط" [ref=e289] [cursor=pointer]:
                - /url: /ar/terms
      - generic [ref=e290]:
        - paragraph [ref=e291]: © 2026 نشر. جميع الحقوق محفوظة.
        - group "اللغة" [ref=e292]:
          - link "العربية" [ref=e293] [cursor=pointer]:
            - /url: /ar/pricing
            - text: عربي
          - link "English" [ref=e294] [cursor=pointer]:
            - /url: /en/pricing
            - text: EN
  - alert [ref=e295]
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
     |                                                                                          ^ Error: /ar/pricing must not fall back to the site-wide default title
  35 |         });
  36 |       }
  37 |     }
  38 |   });
  39 | }
  40 | 
```