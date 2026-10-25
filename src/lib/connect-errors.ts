import type { Lang } from "./i18n";

/**
 * What the Connections page says when a connect action or a provider's redirect fails (rule 976). The routes under
 * /api/connect answer short codes (`{ error: "unknown_page" }`, or `?error=invalid_state` on the way back from a provider);
 * the page showed them raw, in `alert()` and in the flash. A code not listed here (a provider's own string, or an
 * exception message the callback passes on) gets the generic line, so no raw code ever reaches the screen.
 */
export const CONNECT_ERROR_CODES = [
  "verify_failed", "unknown_provider", "slow_down", "composio_rate_limited", "not_connected", "bad_value", "bad_action",
  "unknown_property", "unknown_project", "unknown_page", "unknown_org", "unknown_account", "no_page", "shop_required", "bad_shop", "bad_hmac",
  "revoke_failed", "provider_not_configured", "zid_access_denied", "invalid_state", "session_mismatch", "forbidden",
  "token_failed", "provider_error", "access_denied", "connect_failed", "busy",
] as const;
export type ConnectErrorCode = (typeof CONNECT_ERROR_CODES)[number];

type Messages = Record<ConnectErrorCode, string> & { generic: string };

export const CONNECT_ERRORS: Record<Lang, Messages> = {
  ar: {
    verify_failed: "فشل التحقق. راجع البيانات وحاول مرة أخرى.",
    unknown_provider: "هذه المنصة غير متاحة للربط.",
    slow_down: "محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.",
    busy: "تحديث آخر لهذا الربط يجري الآن. حاول بعد ثوانٍ.",
    composio_rate_limited: "محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.",
    not_connected: "هذا الحساب غير مربوط الآن. اربطه أولاً.",
    bad_value: "القيمة المختارة غير صالحة. حدّث الصفحة واختر مرة أخرى.",
    bad_action: "تعذّر تنفيذ الطلب. حدّث الصفحة وحاول مرة أخرى.",
    unknown_property: "لم نجد هذا الحساب في Google. حدّث القائمة واختر مرة أخرى.",
    unknown_project: "لم نجد هذا المشروع في PostHog. حدّث القائمة واختر مرة أخرى.",
    unknown_page: "لم نجد هذه الصفحة في حسابك. حدّث القائمة واختر مرة أخرى.",
    unknown_org: "لم نجد صفحة الشركة هذه في حسابك. حدّث القائمة واختر مرة أخرى.",
    unknown_account: "لم نجد هذا الحساب الإعلاني. حدّث القائمة واختر مرة أخرى.",
    no_page: "لا توجد صفحة مختارة بعد. اختر صفحة أولاً.",
    shop_required: "اكتب عنوان متجرك أولاً.",
    bad_shop: "عنوان المتجر غير صحيح. راجعه وحاول مرة أخرى.",
    bad_hmac: "تعذّر التحقق من رد المتجر. ابدأ الربط من جديد.",
    revoke_failed: "لم نتمكن من فصل الحساب عند المنصة. حاول مرة أخرى.",
    provider_not_configured: "ربط هذه المنصة غير مفعّل بعد.",
    zid_access_denied: "زد رفض الطلب: تأكد أن تطبيقك في بوابة شركاء زد يملك صلاحية القراءة لهذه البيانات، ثم اربط المتجر مجدداً.",
    invalid_state: "انتهت صلاحية طلب الربط. ابدأ الربط من جديد.",
    session_mismatch: "بدأ الربط من جلسة أخرى. ابدأه من جديد من هذه الصفحة.",
    forbidden: "ربط المنصات للمالك والمسؤول فقط.",
    token_failed: "رفضت المنصة إكمال الربط. ابدأه من جديد.",
    provider_error: "ردّت المنصة بخطأ. حاول مرة أخرى بعد قليل.",
    access_denied: "أُلغي الربط من صفحة المنصة. لم يُربط شيء.",
    connect_failed: "تعذّر الربط. حاول مرة أخرى.",
    generic: "تعذّر الربط. حاول مرة أخرى.",
  },
  en: {
    verify_failed: "Verification failed. Check the details and try again.",
    unknown_provider: "This platform is not available to connect.",
    slow_down: "Too many tries. Wait a little, then try again.",
    busy: "Another refresh of this connection is running. Try again in a few seconds.",
    composio_rate_limited: "Too many tries. Wait a little, then try again.",
    not_connected: "This account is not connected right now. Connect it first.",
    bad_value: "That choice is not valid. Refresh the page and choose again.",
    bad_action: "That could not be done. Refresh the page and try again.",
    unknown_property: "We could not find this Google property. Refresh the list and choose again.",
    unknown_project: "We could not find this PostHog project. Refresh the list and choose again.",
    unknown_page: "We could not find this Page in your account. Refresh the list and choose again.",
    unknown_org: "We could not find this company page in your account. Refresh the list and choose again.",
    unknown_account: "We could not find this ad account. Refresh the list and choose again.",
    no_page: "No Page is chosen yet. Choose one first.",
    shop_required: "Enter your store address first.",
    bad_shop: "The store address is not right. Check it and try again.",
    bad_hmac: "We could not verify the store's reply. Start connecting again.",
    revoke_failed: "We could not disconnect the account at the platform. Try again.",
    provider_not_configured: "Connecting this platform is not switched on yet.",
    zid_access_denied: "Zid refused: make sure your app in the Zid partner portal has read access to this data, then connect the store again.",
    invalid_state: "The connect request expired. Start connecting again.",
    session_mismatch: "Connecting started in another session. Start it again from this page.",
    forbidden: "Only the owner and admins can connect platforms.",
    token_failed: "The platform would not finish connecting. Start again.",
    provider_error: "The platform answered with an error. Try again in a little while.",
    access_denied: "Connecting was cancelled on the platform's page. Nothing was connected.",
    connect_failed: "Could not connect. Try again.",
    generic: "Could not connect. Try again.",
  },
};

/** The message for a code from a connect route or redirect; anything unknown, empty or odd is the generic line. */
export function connectError(lang: Lang, code: unknown): string {
  const M = CONNECT_ERRORS[lang];
  return typeof code === "string" && (CONNECT_ERROR_CODES as readonly string[]).includes(code) ? M[code as ConnectErrorCode] : M.generic;
}
