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
      - link "نشر" [ref=e4]:
        - /url: /ar
      - generic [ref=e6]:
        - group "اللغة" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/pricing
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/pricing
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
    - generic [ref=e23]:
      - paragraph [ref=e24]: الأسعار
      - heading "أرخص من موظف واحد. أسرع من وكالة." [level=2] [ref=e25]
      - paragraph [ref=e26]: بالريال السعودي، شامل الضريبة عند الدفع. ألغِ في أي وقت.
      - generic [ref=e27]:
        - generic [ref=e28]: تجربة 3 أيام مجاناً — بدون بطاقة
        - generic [ref=e29]: ادفع سنوياً ووفّر شهرين
      - generic [ref=e30]:
        - article [ref=e31]:
          - heading "البداية" [level=3] [ref=e32]
          - paragraph [ref=e33]: للتاجر الفرد والمبدع
          - paragraph [ref=e34]:
            - generic [ref=e35]: "149"
            - generic [ref=e36]: ريال / شهر
          - paragraph [ref=e37]: 200 كريدت شهرياً
          - list [ref=e38]:
            - listitem [ref=e39]:
              - generic [ref=e41]: علامة واحدة، مستخدم واحد
            - listitem [ref=e42]:
              - generic [ref=e44]: منشورات سوشال + صور
            - listitem [ref=e45]:
              - generic [ref=e47]: مقالات SEO بالعربي
            - listitem [ref=e48]:
              - generic [ref=e50]: حملات سناب وميتا (قراءة + اقتراحات)
            - listitem [ref=e51]:
              - generic [ref=e53]: ملخص واتساب أسبوعي
            - listitem [ref=e54]:
              - generic [ref=e56]: 10 مهام متزامنة
          - link "ابدأ مجاناً" [ref=e57]:
            - /url: /ar/app/signup
        - article [ref=e58]:
          - heading "الاحتراف" [level=3] [ref=e59]
          - paragraph [ref=e60]: للمؤسس والمتجر والعيادة
          - paragraph [ref=e61]:
            - generic [ref=e62]: "399"
            - generic [ref=e63]: ريال / شهر
          - paragraph [ref=e64]: 700 كريدت شهرياً
          - list [ref=e65]:
            - listitem [ref=e66]:
              - generic [ref=e68]: كل ما في البداية
            - listitem [ref=e69]:
              - generic [ref=e71]: ضبط الإعلانات تلقائياً ضمن حدودك
            - listitem [ref=e72]:
              - generic [ref=e74]: حملات واتساب + استرجاع السلات
            - listitem [ref=e75]:
              - generic [ref=e77]: تدقيق إعلانات أسبوعي وكشف الهدر
            - listitem [ref=e78]:
              - generic [ref=e80]: ملخص يومي 8 صباحاً
            - listitem [ref=e81]:
              - generic [ref=e83]: 70+ خطة جاهزة خليجية
            - listitem [ref=e84]:
              - generic [ref=e86]: مقاعد إضافية 99 ريال/مقعد
            - listitem [ref=e87]:
              - generic [ref=e89]: 20 مهمة متزامنة
          - link "ابدأ مجاناً" [ref=e90]:
            - /url: /ar/app/signup
        - article [ref=e91]:
          - heading "الوكالة" [level=3] [ref=e92]
          - paragraph [ref=e93]: للوكالات ومتعدد الفروع
          - paragraph [ref=e94]:
            - generic [ref=e95]: "799"
            - generic [ref=e96]: ريال / شهر
          - paragraph [ref=e97]: 2,000 كريدت شهرياً — يترحّل
          - list [ref=e98]:
            - listitem [ref=e99]:
              - generic [ref=e101]: كل ما في الاحتراف
            - listitem [ref=e102]:
              - generic [ref=e104]: علامات متعددة (5 مشمولة)
            - listitem [ref=e105]:
              - generic [ref=e107]: علامة إضافية 99 ريال
            - listitem [ref=e108]:
              - generic [ref=e110]: تقارير بعلامتك للعملاء
            - listitem [ref=e111]:
              - generic [ref=e113]: صلاحيات فريق وأدوار
            - listitem [ref=e114]:
              - generic [ref=e116]: ضبط الإعلانات كل ساعتين
            - listitem [ref=e117]:
              - generic [ref=e119]: مهام غير محدودة
            - listitem [ref=e120]:
              - generic [ref=e122]: وصول MCP و API
          - link "ابدأ مجاناً" [ref=e123]:
            - /url: /ar/app/signup
        - article [ref=e124]:
          - heading "المؤسسات" [level=3] [ref=e125]
          - paragraph [ref=e126]: للمجموعات والجهات الكبيرة
          - paragraph [ref=e127]:
            - generic [ref=e128]: حسب الطلب
            - generic [ref=e129]: فوترة سنوية
          - paragraph [ref=e130]: كريدت مخصص
          - list [ref=e131]:
            - listitem [ref=e132]:
              - generic [ref=e134]: الوكلاء المتخصصون كلهم
            - listitem [ref=e135]:
              - generic [ref=e137]: استضافة البيانات داخل السعودية
            - listitem [ref=e138]:
              - generic [ref=e140]: ربط CRM ومستودع البيانات
            - listitem [ref=e141]:
              - generic [ref=e143]: تدريب نموذج على صوت علامتك
            - listitem [ref=e144]:
              - generic [ref=e146]: مدير نجاح مخصص
            - listitem [ref=e147]:
              - generic [ref=e149]: SLA ساعة واحدة
            - listitem [ref=e150]:
              - generic [ref=e152]: علامات ومستخدمون بلا حد
          - link "احجز عرضاً" [ref=e153]:
            - /url: /ar/app/signup
      - generic [ref=e154]:
        - heading "كم تكلّف كل مهمة؟" [level=3] [ref=e155]
        - table [ref=e156]:
          - rowgroup [ref=e157]:
            - row [ref=e158]:
              - cell "منشور سوشال / إعلان / رسالة واتساب / صورة" [ref=e159]
              - cell "1" [ref=e160]
            - row [ref=e161]:
              - cell "مقال SEO / بطاقة تأهيل / تقرير أسبوعي" [ref=e162]
              - cell "2" [ref=e163]
            - row [ref=e164]:
              - cell "اقتصاديات الوحدة / سلسلة متابعة" [ref=e165]
              - cell "3" [ref=e166]
            - row [ref=e167]:
              - cell "سكربتات مبيعات / مراجعة تسعير / تدفق نقدي / تجارب نمو" [ref=e168]
              - cell "4" [ref=e169]
            - row [ref=e170]:
              - cell "خطة دخول للسوق / عرض مجلس الإدارة / مراجعة استراتيجية" [ref=e171]
              - cell "5" [ref=e172]
            - row [ref=e173]:
              - cell "الدردشة مع الفريق والإعداد من رابط موقعك" [ref=e174]
              - cell "مجاناً" [ref=e175]
    - generic [ref=e178]:
      - paragraph [ref=e179]: الأسئلة الشائعة
      - heading "أسئلة؟ خذ الخلاصة." [level=2] [ref=e180]
      - generic [ref=e181]:
        - group [ref=e182]:
          - generic "ليش ما أستخدم ChatGPT أو Claude مباشرة؟" [ref=e183] [cursor=pointer]:
            - text: ليش ما أستخدم ChatGPT أو Claude مباشرة؟
            - generic [aria-hidden] [ref=e184]: +
        - group [ref=e185]:
          - generic "هل تنشر نور بدون إذني؟" [ref=e186] [cursor=pointer]:
            - text: هل تنشر نور بدون إذني؟
            - generic [aria-hidden] [ref=e187]: +
        - group [ref=e188]:
          - generic "وش يعني ملخص الصباح؟" [ref=e189] [cursor=pointer]:
            - text: وش يعني ملخص الصباح؟
            - generic [aria-hidden] [ref=e190]: +
        - group [ref=e191]:
          - generic "متى أشوف نتائج؟" [ref=e192] [cursor=pointer]:
            - text: متى أشوف نتائج؟
            - generic [aria-hidden] [ref=e193]: +
        - group [ref=e194]:
          - generic "كم تكلّف؟" [ref=e195] [cursor=pointer]:
            - text: كم تكلّف؟
            - generic [aria-hidden] [ref=e196]: +
        - group [ref=e197]:
          - generic "الخصوصية؟" [ref=e198] [cursor=pointer]:
            - text: الخصوصية؟
            - generic [aria-hidden] [ref=e199]: +
        - group [ref=e200]:
          - generic "هل تتعلم صوت علامتي؟" [ref=e201] [cursor=pointer]:
            - text: هل تتعلم صوت علامتي؟
            - generic [aria-hidden] [ref=e202]: +
        - group [ref=e203]:
          - generic "أقدر ألغي؟" [ref=e204] [cursor=pointer]:
            - text: أقدر ألغي؟
            - generic [aria-hidden] [ref=e205]: +
        - group [ref=e206]:
          - generic "من هم بقية الفريق؟" [ref=e207] [cursor=pointer]:
            - text: من هم بقية الفريق؟
            - generic [aria-hidden] [ref=e208]: +
    - generic [ref=e210]:
      - heading "وأنت نايم، نور تسوّق." [level=2] [ref=e211]
      - paragraph [ref=e212]: تجربة 3 أيام مجاناً — بدون بطاقة
      - link "ابدأ تجربتك المجانية" [ref=e213] [cursor=pointer]:
        - /url: /ar/app/signup
  - contentinfo [ref=e214]:
    - generic [ref=e216]:
      - generic [ref=e217]:
        - generic [ref=e218]:
          - paragraph [ref=e219]: نشر
          - paragraph [ref=e220]: وكيلة تسويق تعمل 24/7 — مبنية في الرياض للخليج.
        - navigation "الوكلاء" [ref=e221]:
          - paragraph [ref=e222]: الوكلاء
          - list [ref=e223]:
            - listitem [ref=e224]:
              - link "نور · التسويق" [ref=e225]:
                - /url: /ar/agents/noor
            - listitem [ref=e226]:
              - link "سامي · تمكين المبيعات" [ref=e227]:
                - /url: /ar/agents/sami
            - listitem [ref=e228]:
              - link "رزان · المالية والتسعير والإيرادات" [ref=e229]:
                - /url: /ar/agents/razan
            - listitem [ref=e230]:
              - link "فارس · الدخول للسوق والنمو" [ref=e231]:
                - /url: /ar/agents/faris
            - listitem [ref=e232]:
              - link "دانة · التقارير ولوحات المؤشرات والعروض" [ref=e233]:
                - /url: /ar/agents/dana
            - listitem [ref=e234]:
              - link "ماجد · المستشار التنفيذي" [ref=e235]:
                - /url: /ar/agents/majed
            - listitem [ref=e236]:
              - link "ليان · المنتج والاحتفاظ بالعملاء" [ref=e237]:
                - /url: /ar/agents/layan
        - navigation "القطاعات" [ref=e238]:
          - paragraph [ref=e239]: القطاعات
          - list [ref=e240]:
            - listitem [ref=e241]:
              - link "المتاجر الإلكترونية" [ref=e242]:
                - /url: /ar/for/ecommerce
            - listitem [ref=e243]:
              - link "العقار والمطورون" [ref=e244]:
                - /url: /ar/for/real-estate
            - listitem [ref=e245]:
              - link "المكاتب القانونية" [ref=e246]:
                - /url: /ar/for/legal
            - listitem [ref=e247]:
              - link "الشركات الناشئة" [ref=e248]:
                - /url: /ar/for/startups
            - listitem [ref=e249]:
              - link "العيادات والتجميل" [ref=e250]:
                - /url: /ar/for/clinics
            - listitem [ref=e251]:
              - link "المطاعم والكافيهات" [ref=e252]:
                - /url: /ar/for/restaurants
            - listitem [ref=e253]:
              - link "وكالات التسويق" [ref=e254]:
                - /url: /ar/for/agencies
        - navigation "الموارد" [ref=e255]:
          - paragraph [ref=e256]: الموارد
          - list [ref=e257]:
            - listitem [ref=e258]:
              - link "المدونة والأدلة" [ref=e259]:
                - /url: /ar/blog
            - listitem [ref=e260]:
              - link "أدوات مجانية" [ref=e261]:
                - /url: /ar/tools
            - listitem [ref=e262]:
              - link "مركز المساعدة" [ref=e263]:
                - /url: /ar/help
            - listitem [ref=e264]:
              - link "ما هو وكيل التسويق بالذكاء الاصطناعي؟" [ref=e265]:
                - /url: /ar/ai-marketing-agent
            - listitem [ref=e266]:
              - link "برنامج الشركاء" [ref=e267]:
                - /url: /ar/affiliates
        - navigation "الشركة" [ref=e268]:
          - paragraph [ref=e269]: الشركة
          - list [ref=e270]:
            - listitem [ref=e271]:
              - link "العملاء" [ref=e272]:
                - /url: /ar/customers
            - listitem [ref=e273]:
              - link "المؤسسات" [ref=e274]:
                - /url: /ar/enterprise
            - listitem [ref=e275]:
              - link "الأسعار" [ref=e276]:
                - /url: /ar/pricing
            - listitem [ref=e277]:
              - link "مقارنات" [ref=e278]:
                - /url: /ar/resources#compare
            - listitem [ref=e279]:
              - link "الخصوصية" [ref=e280]:
                - /url: /ar/privacy
            - listitem [ref=e281]:
              - link "الشروط" [ref=e282]:
                - /url: /ar/terms
      - generic [ref=e283]:
        - paragraph [ref=e284]: © 2026 نشر. جميع الحقوق محفوظة.
        - group "اللغة" [ref=e285]:
          - link "العربية" [ref=e286]:
            - /url: /ar/pricing
            - text: عربي
          - link "English" [ref=e287]:
            - /url: /en/pricing
            - text: EN
  - alert [ref=e288]
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