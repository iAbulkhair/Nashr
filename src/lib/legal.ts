type Doc = { title: string; updated: string; sections: { h: string; p: string[] }[] };
const updated = "2026-09-17";

export const LEGAL: Record<"ar" | "en", { privacy: Doc; terms: Doc }> = {
  ar: {
    privacy: {
      title: "سياسة الخصوصية", updated: `آخر تحديث: ${updated}`,
      sections: [
        { h: "من نحن", p: ["نشر (Nashr) منصة تسويق بالذكاء الاصطناعي للشركات في دول الخليج. هذه السياسة تشرح البيانات التي نجمعها وكيف نستخدمها وحقوقك وفق نظام حماية البيانات الشخصية في المملكة العربية السعودية."] },
        { h: "البيانات التي نجمعها", p: ["بيانات الحساب: الاسم، البريد الإلكتروني، رقم الجوال، كلمة المرور (مشفّرة).", "بيانات العلامة التجارية: موقعك، منتجاتك، جمهورك، أسلوبك، وما تكتبه لنور.", "بيانات المنصات المرتبطة: عند ربط متجر أو حساب (مثل WordPress وWooCommerce وTelegram) نخزّن رموز الوصول أو مفاتيح الربط مشفّرة ونقرأ فقط ما تسمح به الصلاحيات التي وافقت عليها.", "بيانات الاستخدام: الطلبات التي ترسلها لنور، ما تعتمده أو ترفضه، وسجلات تقنية لتشغيل الخدمة."] },
        { h: "كيف نستخدمها", p: ["لتشغيل الخدمة: إنشاء المحتوى، الخطط، الرسائل، والنشر على المنصات التي ربطتها بناءً على أوامرك.", "لتحسين نور لعلامتك: تعديلاتك تُحفظ كتفضيلات خاصة بحسابك فقط.", "لا نبيع بياناتك. لا ندرّب نماذج عامة على محتواك. نستخدم مزوّدي ذكاء اصطناعي (Anthropic، وfal.ai للصور) وبنية تحتية (Vercel، Upstash، وResend للبريد) لمعالجة البيانات وفق اتفاقيات معالجة بيانات."] },
        { h: "المنصات المرتبطة", p: ["يمكنك فصل أي حساب مرتبط في أي وقت من صفحة التكاملات، وسنحذف رموز الوصول فوراً. لا ننشر شيئاً إلا بطلب منك؛ إعدادات الحوكمة تعتمد العناصر تلقائياً ولا تنشرها."] },
        { h: "الاحتفاظ والحذف", p: ["نحتفظ بالبيانات ما دام حسابك نشطاً. يمكنك طلب تصدير أو حذف كامل لبياناتك عبر نموذج الدعم في مركز المساعدة وننفّذ خلال 30 يوماً."] },
        { h: "حقوقك", p: ["الوصول، التصحيح، الحذف، الاعتراض على المعالجة، ونقل البيانات. للتواصل: نموذج الدعم في مركز المساعدة أو واتساب +966 55 923 5281."] },
      ],
    },
    terms: {
      title: "شروط الاستخدام", updated: `آخر تحديث: ${updated}`,
      sections: [
        { h: "الخدمة", p: ["نشر تقدّم وكيلة تسويق بالذكاء الاصطناعي (نور) تنشئ محتوى وخططاً ورسائل، وتنشر على المنصات التي تربطها أنت، وفق موافقتك أو إعدادات الحوكمة."] },
        { h: "مسؤوليتك", p: ["أنت المسؤول عن مراجعة المحتوى قبل نشره، وعن التزامه بأنظمة الإعلان في بلدك (مثل ضوابط وزارة الصحة، هيئة العقار، نظام مكافحة الغش التجاري).", "لا تستخدم الخدمة لمحتوى مخالف أو مضلل أو ينتهك حقوق الغير.", "الحسابات المرتبطة تخضع لشروط منصاتها."] },
        { h: "الاشتراك والكريدت", p: ["الأسعار بالريال السعودي غير شاملة الضريبة. الكريدت يُخصم عند كل توليد وفق الجدول المعلن. الكريدت غير مسترد ولا يُحوَّل. يمكن الإلغاء في أي وقت ويستمر الوصول حتى نهاية الفترة المدفوعة."] },
        { h: "الذكاء الاصطناعي", p: ["المحتوى المولَّد قد يحتوي أخطاء. نور مُوجَّهة بألا تخترع أسعاراً أو ادعاءات، لكن التحقق النهائي مسؤوليتك."] },
        { h: "الملكية", p: ["المحتوى الذي تنشئه نور لحسابك ملك لك. منصة نشر وبرمجياتها ملك للشركة."] },
        { h: "التغييرات والقانون", p: ["قد نحدّث هذه الشروط ونخطرك. تخضع للأنظمة المعمول بها في المملكة العربية السعودية."] },
      ],
    },
  },
  en: {
    privacy: {
      title: "Privacy Policy", updated: `Last updated: ${updated}`,
      sections: [
        { h: "Who we are", p: ["Nashr is an AI marketing platform for businesses in the Gulf. This policy explains what we collect, how we use it, and your rights under the Saudi Personal Data Protection Law (PDPL)."] },
        { h: "What we collect", p: ["Account data: name, email, mobile number, password (hashed).", "Brand data: your website, products, audience, tone, and what you tell Noor.", "Connected platforms: when you connect a store or account (such as WordPress, WooCommerce or Telegram) we store access tokens or keys encrypted and read only what the permissions you approved allow.", "Usage data: requests to Noor, what you approve or reject, and technical logs needed to run the service."] },
        { h: "How we use it", p: ["To run the service: create content, plans and messages, and publish to platforms you connected on your instruction.", "To improve Noor for your brand: your edits are stored as preferences for your account only.", "We do not sell your data. We do not train general models on your content. We use AI providers (Anthropic, and fal.ai for images) and infrastructure (Vercel, Upstash, and Resend for email) under data-processing agreements."] },
        { h: "Connected platforms", p: ["You can disconnect any account at any time from the Integrations page; tokens are deleted immediately. We publish only when you ask; governance settings can auto-approve items but never publish them."] },
        { h: "Retention and deletion", p: ["We keep data while your account is active. Request a full export or deletion through the support form in the Help Center; we complete it within 30 days."] },
        { h: "Your rights", p: ["Access, correction, deletion, objection, and portability. Contact us through the support form in the Help Center or WhatsApp +966 55 923 5281."] },
      ],
    },
    terms: {
      title: "Terms of Service", updated: `Last updated: ${updated}`,
      sections: [
        { h: "The service", p: ["Nashr provides an AI marketing agent (Noor) that creates content, plans and messages and publishes to platforms you connect, subject to your approval or governance settings."] },
        { h: "Your responsibilities", p: ["You review content before publishing and ensure it complies with advertising rules in your country (e.g. MOH, REGA, anti-fraud regulations).", "No unlawful, misleading, or infringing content.", "Connected accounts remain subject to their platforms' terms."] },
        { h: "Subscription and credits", p: ["Prices are in SAR excluding VAT. Credits are deducted per generation as published. Credits are non-refundable and non-transferable. Cancel anytime; access continues to the end of the paid period."] },
        { h: "AI output", p: ["Generated content may contain errors. Noor is instructed not to invent prices or claims, but final verification is your responsibility."] },
        { h: "Ownership", p: ["Content Noor creates for your account is yours. The Nashr platform and software belong to the company."] },
        { h: "Changes and law", p: ["We may update these terms and will notify you. Governed by the laws of the Kingdom of Saudi Arabia."] },
      ],
    },
  },
};
