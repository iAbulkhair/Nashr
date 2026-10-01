type Doc = { title: string; updated: string; sections: { h: string; p: string[] }[] };
const updated = "2026-09-29";

export const LEGAL: Record<"ar" | "en", { privacy: Doc; terms: Doc }> = {
  ar: {
    privacy: {
      title: "سياسة الخصوصية", updated: `آخر تحديث: ${updated}`,
      sections: [
        { h: "من نحن", p: ["ذكين (Thakeen) منصة تسويق بالذكاء الاصطناعي للشركات في دول الخليج. هذه السياسة تشرح البيانات التي نجمعها وكيف نستخدمها وحقوقك وفق نظام حماية البيانات الشخصية في المملكة العربية السعودية."] },
        { h: "البيانات التي نجمعها", p: ["بيانات الحساب: الاسم، البريد الإلكتروني، رقم الجوال، كلمة المرور (مشفّرة).", "بيانات العلامة التجارية: موقعك، منتجاتك، جمهورك، أسلوبك، وما تكتبه لنور.", "بيانات المنصات المرتبطة: عند ربط متجر أو حساب (مثل WordPress وWooCommerce وTelegram) نخزّن رموز الوصول أو مفاتيح الربط مشفّرة ونقرأ فقط ما تسمح به الصلاحيات التي وافقت عليها.", "بيانات الاستخدام: الطلبات التي ترسلها لنور، ما تعتمده أو ترفضه، وسجلات تقنية لتشغيل الخدمة."] },
        { h: "كيف نستخدمها", p: ["لتشغيل الخدمة: إنشاء المحتوى، الخطط، الرسائل، والنشر على المنصات التي ربطتها بناءً على أوامرك.", "لتحسين نور لعلامتك: تعديلاتك تُحفظ كتفضيلات خاصة بحسابك فقط.", "لا نبيع بياناتك، ولا يدرّب ذكين نماذج على محتواك. نستخدم مزوّدي ذكاء اصطناعي (Anthropic للنصوص، وfal.ai وkie.ai وHiggsfield للصور والفيديو) وبنية تحتية (Vercel وتخزين الوسائط Vercel Blob، وUpstash، وResend للبريد) لمعالجة البيانات. لتوليد الصور والفيديو نرسل وصف الصورة المبني من منشورك وعلامتك، وصورة المنشور الحالية، إلى fal.ai وkie.ai وHiggsfield. تسمح شروط Higgsfield لها باستخدام المدخلات والمخرجات لتحسين نماذجها، وتسمح شروط kie.ai لها باستخدام المحتوى لتشغيل خدمتها وتحسينها. الصور والفيديو التي يولّدها الفريق مصنوعة بالذكاء الاصطناعي."] },
        { h: "المنصات المرتبطة", p: ["يمكنك فصل أي حساب مرتبط في أي وقت من صفحة التكاملات، وسنحذف رموز الوصول فوراً. لا ننشر شيئاً إلا بطلب منك؛ إعدادات الحوكمة تعتمد العناصر تلقائياً ولا تنشرها."] },
        { h: "الاحتفاظ والحذف", p: ["نحتفظ بالبيانات ما دام حسابك نشطاً. يمكنك حذف حسابك بنفسك من صفحة «حسابك»، فيُحذف حسابك وعلاماتك وملفاتك ومحتواك ورموز الربط فوراً. أما الصور والفيديو المولَّدة فتبقى في تخزين الوسائط (Vercel Blob) بعناوين عامة لا يمكن تخمينها، وبعض الصور لدى fal.ai، ولا يحذفها حذف الحساب؛ وسجلات التوليد تُحذف تلقائياً خلال 14 يوماً. ولطلب تصدير بياناتك أو حذف أي بيانات أخرى، استخدم نموذج الدعم في مركز المساعدة، وننفّذ الطلب خلال 30 يوماً."] },
        { h: "حقوقك", p: ["الوصول، التصحيح، الحذف، الاعتراض على المعالجة، ونقل البيانات. للتواصل: نموذج الدعم في مركز المساعدة أو واتساب +966 55 923 5281."] },
      ],
    },
    terms: {
      title: "شروط الاستخدام", updated: `آخر تحديث: ${updated}`,
      sections: [
        { h: "الخدمة", p: ["ذكين يقدّم وكيلة تسويق بالذكاء الاصطناعي (نور) تنشئ محتوى وخططاً ورسائل، وتنشر على المنصات التي تربطها أنت، وفق موافقتك أو إعدادات الحوكمة."] },
        { h: "مسؤوليتك", p: ["أنت المسؤول عن مراجعة المحتوى قبل نشره، وعن التزامه بأنظمة الإعلان في بلدك (مثل ضوابط وزارة الصحة، هيئة العقار، نظام مكافحة الغش التجاري).", "لا تستخدم الخدمة لمحتوى مخالف أو مضلل أو ينتهك حقوق الغير.", "الحسابات المرتبطة تخضع لشروط منصاتها."] },
        { h: "الاشتراك والكريدت", p: ["الأسعار بالريال السعودي غير شاملة الضريبة. الكريدت يُخصم عند كل توليد وفق الجدول المعلن. الكريدت غير مسترد ولا يُحوَّل. يمكن الإلغاء في أي وقت ويستمر الوصول حتى نهاية الفترة المدفوعة."] },
        { h: "الذكاء الاصطناعي", p: ["المحتوى المولَّد قد يحتوي أخطاء. نور مُوجَّهة بألا تخترع أسعاراً أو ادعاءات، لكن التحقق النهائي مسؤوليتك."] },
        { h: "الملكية", p: ["المحتوى الذي تنشئه نور لحسابك ملك لك. منصة ذكين وبرمجياتها ملك للشركة."] },
        { h: "التغييرات والقانون", p: ["قد نحدّث هذه الشروط ونخطرك. تخضع للأنظمة المعمول بها في المملكة العربية السعودية."] },
      ],
    },
  },
  en: {
    privacy: {
      title: "Privacy Policy", updated: `Last updated: ${updated}`,
      sections: [
        { h: "Who we are", p: ["Thakeen is an AI marketing platform for businesses in the Gulf. This policy explains what we collect, how we use it, and your rights under the Saudi Personal Data Protection Law (PDPL)."] },
        { h: "What we collect", p: ["Account data: name, email, mobile number, password (hashed).", "Brand data: your website, products, audience, tone, and what you tell Noor.", "Connected platforms: when you connect a store or account (such as WordPress, WooCommerce or Telegram) we store access tokens or keys encrypted and read only what the permissions you approved allow.", "Usage data: requests to Noor, what you approve or reject, and technical logs needed to run the service."] },
        { h: "How we use it", p: ["To run the service: create content, plans and messages, and publish to platforms you connected on your instruction.", "To improve Noor for your brand: your edits are stored as preferences for your account only.", "We do not sell your data, and Thakeen does not train models on your content. We use AI providers (Anthropic for text; fal.ai, kie.ai and Higgsfield for images and video) and infrastructure (Vercel and its Vercel Blob media storage, Upstash, and Resend for email) to process data. To generate images and video we send the image description built from your post and brand, and the post's current image, to fal.ai, kie.ai and Higgsfield. Higgsfield's terms allow it to use inputs and outputs to improve its models, and kie.ai's terms allow it to use content to operate and improve its service. Images and videos made by the team are AI-generated."] },
        { h: "Connected platforms", p: ["You can disconnect any account at any time from the Integrations page; tokens are deleted immediately. We publish only when you ask; governance settings can auto-approve items but never publish them."] },
        { h: "Retention and deletion", p: ["We keep data while your account is active. You can delete your account yourself from “Your profile”: your account, brands, files, content and connection tokens are deleted immediately. Generated images and videos stay on our media storage (Vercel Blob) at public addresses that cannot be guessed, and some images at fal.ai; deleting the account does not remove them, and render records expire on their own within 14 days. To request an export of your data, or deletion of anything else, use the support form in the Help Center; we complete requests within 30 days."] },
        { h: "Your rights", p: ["Access, correction, deletion, objection, and portability. Contact us through the support form in the Help Center or WhatsApp +966 55 923 5281."] },
      ],
    },
    terms: {
      title: "Terms of Service", updated: `Last updated: ${updated}`,
      sections: [
        { h: "The service", p: ["Thakeen provides an AI marketing agent (Noor) that creates content, plans and messages and publishes to platforms you connect, subject to your approval or governance settings."] },
        { h: "Your responsibilities", p: ["You review content before publishing and ensure it complies with advertising rules in your country (e.g. MOH, REGA, anti-fraud regulations).", "No unlawful, misleading, or infringing content.", "Connected accounts remain subject to their platforms' terms."] },
        { h: "Subscription and credits", p: ["Prices are in SAR excluding VAT. Credits are deducted per generation as published. Credits are non-refundable and non-transferable. Cancel anytime; access continues to the end of the paid period."] },
        { h: "AI output", p: ["Generated content may contain errors. Noor is instructed not to invent prices or claims, but final verification is your responsibility."] },
        { h: "Ownership", p: ["Content Noor creates for your account is yours. The Thakeen platform and software belong to the company."] },
        { h: "Changes and law", p: ["We may update these terms and will notify you. Governed by the laws of the Kingdom of Saudi Arabia."] },
      ],
    },
  },
};
