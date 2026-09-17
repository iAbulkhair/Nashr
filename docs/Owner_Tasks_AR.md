# مهام المالك — قائمة متابعة

آخر تحديث: 2026-09-18. أحدّث هذا الملف كل مرة تنفّذ بنداً أو يظهر بند جديد.
- [x] منفّذ  - [ ] مطلوب  - [~] جزئي

كل الأوامر تُنفَّذ في طرفيتك داخل `~/projects/nashr`. لا تلصق أي مفتاح في المحادثة.

## أ. البنية الأساسية
- [x] ربط Vercel بـ GitHub (نشر تلقائي عند push على `main`)
- [x] Upstash Redis (`KV_REST_API_*`)
- [x] `ANTHROPIC_API_KEY`
- [x] `CRON_SECRET`، `CONNECT_SECRET`، `WAITLIST_ADMIN_KEY`، `SUPPORT_WHATSAPP`
- [~] `APP_ORIGIN` موجود لكن يشير لرابط Vercel؛ يُحدَّث بعد الدومين
- [ ] شراء الدومين وربطه بـ Vercel، ثم:
  ```bash
  vercel env add APP_ORIGIN production
  ```
- [ ] `ADMIN_EMAILS` (اختياري؛ الافتراضي hejazy@gmail.com)

## ب. البريد (Resend)
- [ ] إنشاء حساب Resend وتوثيق الدومين
- [ ] `vercel env add RESEND_API_KEY production`
- [ ] `vercel env add MAIL_FROM production` (مثل `Nashr <noor@yourdomain>`)
- [ ] `vercel env add WAITLIST_TO production` (بريد يستقبل تسجيلات قائمة الانتظار)

## ج. الصور (fal.ai)
- [ ] إنشاء حساب fal.ai وأخذ المفتاح
- [ ] `vercel env add FAL_KEY production`

## د. الدفع والفوترة
- [ ] اختيار المزوّد: Moyasar أو Tap (أبلغني بالاختيار لأبني الاشتراكات والويبهوك)
- [ ] مؤقتاً: روابط دفع للخطط
  ```bash
  vercel env add PAY_LINK_STARTER production
  vercel env add PAY_LINK_PRO production
  vercel env add PAY_LINK_AGENCY production
  ```
- [ ] الرقم الضريبي وبيانات المنشأة لفواتير ZATCA (أرسلها لي عند جاهزية الربط)

## هـ. موصلات المنصات (OAuth) — كل واحدة تحتاج تطبيق مطوّر على المنصة
- [ ] Meta (فيسبوك/إنستقرام): `META_APP_ID`، `META_APP_SECRET`
- [ ] Google: `GOOGLE_CLIENT_ID`، `GOOGLE_CLIENT_SECRET`
- [ ] X: `X_CLIENT_ID`، `X_CLIENT_SECRET`
- [ ] TikTok: `TIKTOK_CLIENT_KEY`، `TIKTOK_CLIENT_SECRET`
- [ ] Snap: `SNAP_CLIENT_ID`، `SNAP_CLIENT_SECRET`
- [ ] LinkedIn: `LINKEDIN_CLIENT_ID`، `LINKEDIN_CLIENT_SECRET`
- [ ] سلة: `SALLA_CLIENT_ID`، `SALLA_CLIENT_SECRET`
- [ ] زد: `ZID_CLIENT_ID`، `ZID_CLIENT_SECRET`
- [ ] Shopify: `SHOPIFY_CLIENT_ID`، `SHOPIFY_CLIENT_SECRET`
- ملاحظة: رابط الرجوع (callback) لكل منصة: `{APP_ORIGIN}/api/connect/{provider}/callback`. الدليل: `docs/Platform_Access_Playbook.md` إن وُجد، وإلا اطلبه مني.

## و. اختبارات على الإنتاج (أنت تجرّبها بحسابك)
- [ ] تجربة موصل Telegram (مفتاح بوت من BotFather داخل صفحة التكاملات)
- [ ] ربط Claude بخادم Nashr MCP وتجربة أداة واحدة
- [ ] فتح لوحة المؤسس `/ar/app/admin` والتأكد من الأرقام
- [ ] تجربة "الدخول كالمستخدم" ثم "إنهاء والعودة للوحة"

## ز. محاكاة Helena
- [x] لصق ردود Helena للأسئلة 1 و2
- [ ] لصق ردود Helena للأسئلة 3، 4، 5

## ح. قرارات مطلوبة منك
- [ ] مزوّد الدفع (Moyasar / Tap)
- [ ] اسم الدومين
- [ ] هل نبني توليد الفيديو الآن أم لاحقاً؟
- [ ] موقع ميزة صناعة المحتوى (قل **نجرفان** وأرسل الرابط)

## ط. اختياري لاحقاً
- [ ] Vercel Speed Insights + Better Stack لمراقبة الأداء والتوقف
- [ ] مجموعة ذهبية أسبوعية لتقييم الوكلاء
