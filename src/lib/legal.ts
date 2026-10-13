type Doc = { title: string; updated: string; sections: { h: string; p: string[] }[] };
/**
 * The privacy policy changed on 2026-10-12: the processor list matches the services the code uses (Hostinger, Straitly,
 * Composio, Turnstile and Paymob added, Vercel kept only as the media storage), the consent record at signup and the
 * self-serve export (rules 1320-1330), and it names the agent scope log (rule 1415).
 */
const updated = "2026-10-12";
/**
 * The terms changed on their own on 2026-10-02: unused top-up credits can be refunded before they expire (rule 460); and
 * on 2026-10-13: usage may pause past the plan's fair-use limit (rule 1736, src/lib/fair-use.ts).
 */
const termsUpdated = "2026-10-13";
/**
 * The versions a signup accepts (src/lib/consent.ts, rule 1325): each document's own "last updated" day. A change to a
 * document's text moves its day, so a stored consent always names the text that was on the page.
 */
export const PRIVACY_VERSION = updated;
export const TERMS_VERSION = termsUpdated;

export const LEGAL: Record<"ar" | "en", { privacy: Doc; terms: Doc }> = {
  ar: {
    privacy: {
      title: "سياسة الخصوصية", updated: `آخر تحديث: ${updated}`,
      sections: [
        { h: "من نحن", p: ["ذكين (Thakeen) منصة تسويق بالذكاء الاصطناعي للشركات في دول الخليج. هذه السياسة تشرح البيانات التي نجمعها وكيف نستخدمها وحقوقك وفق نظام حماية البيانات الشخصية في المملكة العربية السعودية."] },
        { h: "البيانات التي نجمعها", p: ["بيانات الحساب: الاسم، البريد الإلكتروني، رقم الجوال، كلمة المرور (مشفّرة).", "عند التسجيل نحفظ إصدار شروط الاستخدام وسياسة الخصوصية المعروضين عليك ووقت موافقتك.", "بيانات العلامة التجارية: موقعك، منتجاتك، جمهورك، أسلوبك، وما تكتبه لنور.", "بيانات المنصات المرتبطة: عند ربط متجر أو حساب (مثل WordPress وWooCommerce وTelegram) نخزّن رموز الوصول أو مفاتيح الربط مشفّرة ونقرأ فقط ما تسمح به الصلاحيات التي وافقت عليها.", "بيانات الاستخدام: الطلبات التي ترسلها لنور، ما تعتمده أو ترفضه، وسجلات تقنية لتشغيل الخدمة.", "سجل نطاق الفريق: عندما يخرج طلب أو رد عن عمل الفريق نحفظ أول 200 حرف واسم الموظف والنتيجة لمدة 31 يوماً، ولا يراها إلا المؤسس."] },
        { h: "كيف نستخدمها", p: ["لتشغيل الخدمة: إنشاء المحتوى، الخطط، الرسائل، والنشر على المنصات التي ربطتها بناءً على أوامرك.", "لتحسين نور لعلامتك: تعديلاتك تُحفظ كتفضيلات خاصة بحسابك فقط.", "لا نبيع بياناتك، ولا يدرّب ذكين نماذج على محتواك. تعالج هذه الخدمات البيانات لحسابنا: Hostinger لاستضافة التطبيق؛ وUpstash لتخزين بيانات الحساب ومساحة العمل وجدولة المهام المؤقتة؛ ومزوّدو الذكاء الاصطناعي (Anthropic للنصوص، وfal.ai وkie.ai وHiggsfield للصور والفيديو) لمعالجة المحتوى الذي يعملون عليه، وبوابة Straitly قد تنقل طلبات نماذج النصوص إلى مزوّد النصوص (موقفة افتراضياً ولا تُستخدم إلا إن شغّلناها)؛ وتُحفظ الصور والفيديو في تخزين الوسائط لدينا (Vercel Blob)؛ وResend للبريد؛ وComposio لصلاحيات الحسابات التي تربطها عبره؛ وCloudflare Turnstile لفحص نموذجي التسجيل واستعادة كلمة المرور من البرامج الآلية حين يكون مفعّلاً؛ وPaymob لمعالجة الدفع بالبطاقة حين يُتاح الدفع الإلكتروني. لتوليد الصور والفيديو نرسل وصف الصورة المبني من منشورك وعلامتك، وصورة المنشور الحالية، إلى fal.ai وkie.ai وHiggsfield. تسمح شروط Higgsfield لها باستخدام المدخلات والمخرجات لتحسين نماذجها، وتسمح شروط kie.ai لها باستخدام المحتوى لتشغيل خدمتها وتحسينها. الصور والفيديو التي يولّدها الفريق مصنوعة بالذكاء الاصطناعي."] },
        { h: "المنصات المرتبطة", p: ["يمكنك فصل أي حساب مرتبط في أي وقت من صفحة التكاملات، وسنحذف رموز الوصول فوراً. لا ننشر شيئاً إلا بطلب منك؛ إعدادات الحوكمة تعتمد العناصر تلقائياً ولا تنشرها."] },
        { h: "برنامج الشركاء", p: ["رابط الشريك: عند فتح رابط شريك (/p/الكود) نضع ملف تعريف ارتباط من موقعنا (thakeen_partner) لمدة 30 يوماً، يحفظ كود الشريك ووقت النقر فقط، لنعرف من أحالك إن سجّلت. لا نستخدمه لأي تتبّع آخر.", "إن سجّلت عبر شريك أو بكوده نحفظ في حسابك أي شريك أحالك ومتى، ونسجّل دفعاتك لحساب عمولته. يرى الشريك رمزاً مستعاراً عشوائياً بدلاً من اسمك وبريدك، مع تاريخ تسجيلك وحالتك (تجربة، مدفوع، انتهت المهلة) وعدد الأشهر المحسوبة ومبالغ الدفعات التي تُحسب عليها عمولته، ولا يرى اسمك ولا بريدك ولا رقمك.", "إن كنت شريكاً نحفظ اسم صاحب الحساب البنكي ورقم الآيبان لتحويل عمولاتك فقط. يراهما المؤسس وحده كاملين، وتراهما أنت مخفيين، ولا يُسجَّلان في أي سجل، ويُحذفان مع حسابك.", "ونحفظ معهما دولة إقامتك ورقمك الضريبي إن أدخلته (وهل أخبرتنا أنك مسجّل في ضريبة القيمة المضافة)، لنعرف أي ضريبة نتحمّلها عند تحويل عمولتك (ضريبة القيمة المضافة أو ضريبة الاستقطاع)، ومبالغ هذه الضرائب مع كل تحويل لدفاترنا. ويُحذفان مع حسابك.", "عند تقديم طلب الشراكة نحفظ ما تكتبه في النموذج، ووقت موافقتك على شروط برنامج الشركاء وإصدارها."] },
        { h: "الاحتفاظ والحذف", p: ["نحتفظ بالبيانات ما دام حسابك نشطاً. يمكنك تنزيل نسخة من بياناتك بنفسك من «الإعدادات» ثم «منطقة الخطر» (زر «نزّل بياناتي»): الحساب والموافقة المسجّلة والباقة والكريدت والعلامات والمهام والملفات والمحادثات والحسابات المرتبطة دون رموز الوصول. ويمكنك حذف حسابك بنفسك من الصفحة نفسها، فيُحذف حسابك وعلاماتك وملفاتك ومحتواك ورموز الربط فوراً. أما الصور والفيديو المولَّدة فتبقى في تخزين الوسائط (Vercel Blob) بعناوين عامة لا يمكن تخمينها، وبعض الصور لدى fal.ai، ولا يحذفها حذف الحساب؛ وسجلات التوليد تُحذف تلقائياً خلال 14 يوماً. ولطلب حذف أي بيانات أخرى، استخدم نموذج الدعم في مركز المساعدة، وننفّذ الطلب خلال 30 يوماً.", "يُحذف سجل نطاق الفريق تلقائياً بعد 31 يوماً."] },
        { h: "حقوقك", p: ["الوصول، التصحيح، الحذف، الاعتراض على المعالجة، ونقل البيانات. للتواصل: نموذج الدعم في مركز المساعدة أو واتساب +966 55 923 5281."] },
      ],
    },
    terms: {
      title: "شروط الاستخدام", updated: `آخر تحديث: ${termsUpdated}`,
      sections: [
        { h: "الخدمة", p: ["ذكين يقدّم وكيلة تسويق بالذكاء الاصطناعي (نور) تنشئ محتوى وخططاً ورسائل، وتنشر على المنصات التي تربطها أنت، وفق موافقتك أو إعدادات الحوكمة."] },
        { h: "مسؤوليتك", p: ["أنت المسؤول عن مراجعة المحتوى قبل نشره، وعن التزامه بأنظمة الإعلان في بلدك (مثل ضوابط وزارة الصحة، هيئة العقار، نظام مكافحة الغش التجاري).", "لا تستخدم الخدمة لمحتوى مخالف أو مضلل أو ينتهك حقوق الغير.", "الحسابات المرتبطة تخضع لشروط منصاتها."] },
        { h: "الاشتراك والكريدت", p: ["الأسعار بالريال السعودي غير شاملة الضريبة. الكريدت يُخصم عند كل توليد وفق الجدول المعلن. الكريدت غير مسترد ولا يُحوَّل، إلا أن كريدت باقات الشحن غير المستخدم يمكن استرداده عند الطلب قبل انتهاء صلاحيته. قد يتوقف الاستخدام مؤقتاً إذا تجاوز استخدام الحساب الشهري حد الاستخدام العادل لباقته. يمكن الإلغاء في أي وقت ويستمر الوصول حتى نهاية الفترة المدفوعة."] },
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
        { h: "What we collect", p: ["Account data: name, email, mobile number, password (hashed).", "When you sign up we record which version of the terms of service and of this privacy policy you were shown, and when you agreed.", "Brand data: your website, products, audience, tone, and what you tell Noor.", "Connected platforms: when you connect a store or account (such as WordPress, WooCommerce or Telegram) we store access tokens or keys encrypted and read only what the permissions you approved allow.", "Usage data: requests to Noor, what you approve or reject, and technical logs needed to run the service.", "Agent scope log: when a request or a reply falls outside what the team works on, we keep the first 200 characters, the agent and the verdict for 31 days, visible to the founder only."] },
        { h: "How we use it", p: ["To run the service: create content, plans and messages, and publish to platforms you connected on your instruction.", "To improve Noor for your brand: your edits are stored as preferences for your account only.", "We do not sell your data, and Thakeen does not train models on your content. These services process data for us: Hostinger hosts the app; Upstash stores the account and workspace data and schedules timed jobs; AI providers (Anthropic for text; fal.ai, kie.ai and Higgsfield for images and video) process the content they work on, and the Straitly gateway may carry text-model requests to the text provider (it is off by default and used only if we switch it on); images and videos are kept on our media storage (Vercel Blob); Resend sends email; Composio holds the access for accounts you connect through it; Cloudflare Turnstile checks the sign-up and password-reset forms for automated abuse when it is switched on; Paymob processes card payments when online payment is offered. To generate images and video we send the image description built from your post and brand, and the post's current image, to fal.ai, kie.ai and Higgsfield. Higgsfield's terms allow it to use inputs and outputs to improve its models, and kie.ai's terms allow it to use content to operate and improve its service. Images and videos made by the team are AI-generated."] },
        { h: "Connected platforms", p: ["You can disconnect any account at any time from the Integrations page; tokens are deleted immediately. We publish only when you ask; governance settings can auto-approve items but never publish them."] },
        { h: "Partner programme", p: ["Partner links: opening a partner's link (/p/CODE) sets a first-party cookie (thakeen_partner) for 30 days that holds only the partner's code and the time of the click, so we know who referred you if you sign up. We use it for nothing else.", "If you sign up through a partner or with their code, your account records which partner referred you and when, and we record your payments to work out their commission. The partner sees a random pseudonymous label instead of your name and email, with your signup date, your status (trial, paid, lapsed), the months counted and the payment amounts their commission is based on; never your name, email or phone.", "If you are a partner, we keep the bank account holder's name and the IBAN only to pay your commission. Only the founder sees them in full, you see them masked, they are never written to any log, and they are deleted with your account.", "With them we keep the country you live in and your tax number if you enter one (and whether you told us you are VAT-registered), to know which tax we bear when we pay your commission (VAT or withholding tax), and the amounts of those taxes with each transfer, for our books. They are deleted with your account.", "When you apply to the partner programme we keep what you enter in the form, and when you agreed to the partner programme terms and which version."] },
        { h: "Retention and deletion", p: ["We keep data while your account is active. You can download a copy of your data yourself from Settings, Danger zone (“Download my data”): your account, the recorded consent, plan and credits, brands, tasks, files, conversations, and connected accounts without their access tokens. You can delete your account yourself on the same page: your account, brands, files, content and connection tokens are deleted immediately. Generated images and videos stay on our media storage (Vercel Blob) at public addresses that cannot be guessed, and some images at fal.ai; deleting the account does not remove them, and render records expire on their own within 14 days. To request deletion of anything else, use the support form in the Help Center; we complete requests within 30 days.", "The agent scope log deletes itself after 31 days."] },
        { h: "Your rights", p: ["Access, correction, deletion, objection, and portability. Contact us through the support form in the Help Center or WhatsApp +966 55 923 5281."] },
      ],
    },
    terms: {
      title: "Terms of Service", updated: `Last updated: ${termsUpdated}`,
      sections: [
        { h: "The service", p: ["Thakeen provides an AI marketing agent (Noor) that creates content, plans and messages and publishes to platforms you connect, subject to your approval or governance settings."] },
        { h: "Your responsibilities", p: ["You review content before publishing and ensure it complies with advertising rules in your country (e.g. MOH, REGA, anti-fraud regulations).", "No unlawful, misleading, or infringing content.", "Connected accounts remain subject to their platforms' terms."] },
        { h: "Subscription and credits", p: ["Prices are in SAR excluding VAT. Credits are deducted per generation as published. Credits are non-refundable and non-transferable, except that unused top-up credits can be refunded on request before they expire. Usage may pause when an account's monthly usage exceeds its plan's fair-use limit. Cancel anytime; access continues to the end of the paid period."] },
        { h: "AI output", p: ["Generated content may contain errors. Noor is instructed not to invent prices or claims, but final verification is your responsibility."] },
        { h: "Ownership", p: ["Content Noor creates for your account is yours. The Thakeen platform and software belong to the company."] },
        { h: "Changes and law", p: ["We may update these terms and will notify you. Governed by the laws of the Kingdom of Saudi Arabia."] },
      ],
    },
  },
};
