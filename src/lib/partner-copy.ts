import { ATTRIBUTION_DAYS, COMMISSION_MONTHS, COMMISSION_PCT, PAYOUT_MIN_SAR } from "./partner-rules";
import { FIRST_MONTH_DISCOUNT_PCT } from "./pricing";

/**
 * The partner page's words (/app/partner, rule 399), Arabic and English. Kept out of app-i18n.ts so the programme's copy
 * lives in one place with its numbers, which all come from src/lib/partner-rules.ts and src/lib/pricing.ts. Safe for
 * client components: both imports are import-free modules.
 */
export const PARTNER_COPY = {
  ar: {
    nav: "الشراكة",
    title: "الشراكة",
    sub: `تكسب ${COMMISSION_PCT}% من كل دفعة يدفعها عميل أحلته، خلال أول ${COMMISSION_MONTHS} أشهر من اشتراكه المدفوع. وعميلك يحصل على خصم ${FIRST_MONTH_DISCOUNT_PCT}% على شهره الأول بكودك.`,
    ownerOnly: "صفحة الشراكة لمالك الحساب فقط.",
    notPartner: "حسابك ليس شريكاً بعد. قدّم طلب الشراكة، وبعد موافقتنا تظهر هنا صفحتك وكودك ورابطك.",
    apply: "قدّم طلب الشراكة",
    code: "كودك", link: "رابطك", copy: "نسخ", copied: "تم النسخ", shareWa: "شارك على واتساب",
    shareTitle: "نص جاهز للمشاركة",
    share: (code: string, link: string) => `أستخدم ذكين، مسوّق بالذكاء الاصطناعي يكتب محتوى علامتك بلهجتها وينتظر موافقتك قبل أي نشر. سجّل من رابطي واحصل على خصم ${FIRST_MONTH_DISCOUNT_PCT}% على شهرك الأول، أو استخدم الكود ${code} عند التسجيل: ${link}`,
    rules: `تُحسب الإحالة إذا دفع العميل أول دفعة خلال ${ATTRIBUTION_DAYS} يوماً من تسجيله عبر رابطك أو كودك. الدفعات شهرياً بتحويل بنكي متى بلغ رصيدك ${PAYOUT_MIN_SAR} ريال. لا تُحسب إحالة نفسك أو فريقك، وتُلغى العمولة إذا أُلغيت الدفعة أو استُردّت.`,
    stats: { referrals: "الإحالات", pending: "رصيد قيد التجميع", payable: "جاهز للصرف", paid: "مدفوع لك" },
    pendingNote: `يصبح الرصيد جاهزاً للصرف من ${PAYOUT_MIN_SAR} ريال.`,
    referrals: "إحالاتك", refsEmpty: "لا إحالات بعد. شارك رابطك أو كودك.",
    refCols: { label: "العميل", signedUp: "تاريخ التسجيل", status: "الحالة", months: "أشهر محسوبة" },
    status: { trial: "تجربة", paid: "مدفوع", lapsed: "انتهت المهلة" },
    ledger: "العمولات", ledgerEmpty: "لا عمولات بعد.",
    ledgerCols: { label: "العميل", date: "تاريخ الدفعة", base: "الدفعة (ريال، دون الضريبة)", sar: "عمولتك (ريال)" },
    voided: "ملغاة",
    payouts: "الدفعات المصروفة", payoutsEmpty: "لا دفعات بعد.",
    payoutCols: { date: "التاريخ", sar: "المبلغ (ريال)", reference: "المرجع" },
    bank: "بيانات التحويل البنكي", bankNote: "نحوّل لك شهرياً على هذا الحساب. يظهر رقم الآيبان مخفياً بعد الحفظ.",
    holder: "اسم صاحب الحساب", iban: "رقم الآيبان (SA…)", save: "احفظ", saved: "تم الحفظ",
    errors: { bad_holder: "اكتب اسم صاحب الحساب.", bad_iban: "رقم آيبان سعودي غير صحيح: يبدأ بـ SA ويتكون من 24 خانة.", slow_down: "محاولات كثيرة. حاول بعد ساعة.", forbidden: "تعديل بيانات البنك لمالك الحساب فقط.", server: "تعذّر الحفظ. حاول مرة أخرى." } as Record<string, string>,
  },
  en: {
    nav: "Partner",
    title: "Partner",
    sub: `You earn ${COMMISSION_PCT}% of every payment a customer you referred makes during their first ${COMMISSION_MONTHS} months of paid subscription. Your customer gets ${FIRST_MONTH_DISCOUNT_PCT}% off their first month with your code.`,
    ownerOnly: "The partner page is for the account owner only.",
    notPartner: "Your account is not a partner yet. Apply, and once we approve you, your page, code and link appear here.",
    apply: "Apply to the partner programme",
    code: "Your code", link: "Your link", copy: "Copy", copied: "Copied", shareWa: "Share on WhatsApp",
    shareTitle: "Ready-to-share text",
    share: (code: string, link: string) => `I use Thakeen, an AI marketer that writes your brand's content in its dialect and waits for your approval before anything is published. Sign up with my link for ${FIRST_MONTH_DISCOUNT_PCT}% off your first month, or use the code ${code} at signup: ${link}`,
    rules: `A referral counts when the customer makes their first payment within ${ATTRIBUTION_DAYS} days of signing up with your link or code. Payouts are monthly by bank transfer once your balance reaches SAR ${PAYOUT_MIN_SAR}. Referring yourself or your own team does not count, and a commission is voided if its payment is voided or refunded.`,
    stats: { referrals: "Referrals", pending: "Pending balance", payable: "Payable", paid: "Paid to you" },
    pendingNote: `A balance becomes payable from SAR ${PAYOUT_MIN_SAR}.`,
    referrals: "Your referrals", refsEmpty: "No referrals yet. Share your link or code.",
    refCols: { label: "Customer", signedUp: "Signed up", status: "Status", months: "Months counted" },
    status: { trial: "Trial", paid: "Paid", lapsed: "Lapsed" },
    ledger: "Commissions", ledgerEmpty: "No commissions yet.",
    ledgerCols: { label: "Customer", date: "Payment date", base: "Payment (SAR, excl. VAT)", sar: "Your commission (SAR)" },
    voided: "voided",
    payouts: "Payouts", payoutsEmpty: "No payouts yet.",
    payoutCols: { date: "Date", sar: "Amount (SAR)", reference: "Reference" },
    bank: "Bank transfer details", bankNote: "We transfer to this account monthly. The IBAN is shown masked after you save it.",
    holder: "Account holder name", iban: "IBAN (SA…)", save: "Save", saved: "Saved",
    errors: { bad_holder: "Enter the account holder's name.", bad_iban: "Not a valid Saudi IBAN: it starts with SA and has 24 characters.", slow_down: "Too many tries. Try again in an hour.", forbidden: "Only the account owner can change bank details.", server: "Could not save. Try again." } as Record<string, string>,
  },
} as const;
