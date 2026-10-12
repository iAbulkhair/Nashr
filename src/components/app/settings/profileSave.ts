import type { Lang } from "@/lib/i18n";

/** What PUT /api/profile answers: the stored values on 200, the refused field on 400, `busy` on 409 (nothing written). */
export type ProfileSaved = {
  ok?: boolean;
  error?: "required" | "bad_phone" | "read_only" | "busy";
  field?: string;
  saved?: { me: { name: string; lang: Lang }; phone?: string; brand?: { name: string; website: string; sitemap?: string; valueProp?: string; social?: Record<string, string> } | null };
};

/** The outcome of one card's PUT /api/profile: saved with the stored values, refused before any write, or unknown. */
export type ProfileOutcome = { kind: "saved"; saved: NonNullable<ProfileSaved["saved"]> } | { kind: "refused"; text: string; field?: string } | { kind: "unknown"; text: string };

/**
 * One settings card's save through PUT /api/profile (rule 1142): only the fields this card holds are sent, so a role may
 * save every card it owns and the route never sees a field from another card. The refusals the route names (403, 400 with
 * the field, 409 busy) come before any write and say "nothing was saved"; any other failure may come after part of a
 * write, so it never says that and the caller re-reads what is stored.
 */
export async function saveProfile(body: Record<string, string>, lang: Lang, forbidden: string): Promise<ProfileOutcome> {
  const ar = lang === "ar";
  const res = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const j = ((await res?.json().catch(() => ({}))) ?? {}) as ProfileSaved;
  if (res?.ok && j.ok && j.saved) return { kind: "saved", saved: j.saved };
  const refused = res?.status === 403 ? forbidden
    : j.error === "bad_phone" ? (ar ? "رقم الجوال غير صحيح: اكتب 9 أرقام على الأقل. لم يُحفظ شيء." : "That mobile number is not valid: use at least 9 digits. Nothing was saved.")
    : j.error === "required" && j.field === "phone" ? (ar ? "أضف رقم جوالك أولاً في بطاقة «رقم الجوال»: حفظ أي تغيير يحتاجه. لم يُحفظ شيء." : "Add your mobile number first, in the Phone card: every save needs it. Nothing was saved.")
    : j.error === "read_only" && j.field === "email" ? (ar ? "البريد هو اسم الدخول ولا يتغيّر من هنا. لم يُحفظ شيء." : "The email is your login and cannot be changed here. Nothing was saved.")
    : j.error === "required" && j.field === "business" ? (ar ? "اسم النشاط مطلوب. لم يُحفظ شيء." : "Business name is required. Nothing was saved.")
    : j.error === "required" && j.field === "name" ? (ar ? "الاسم الكامل مطلوب. لم يُحفظ شيء." : "Full name is required. Nothing was saved.")
    : j.error === "busy" ? (ar ? "تغيير آخر على هذا الحساب كان قيد الحفظ. لم يُحفظ شيء، حاول بعد لحظات." : "Another change to this account was being saved. Nothing was saved; try again in a moment.")
    : null;
  if (refused) return { kind: "refused", text: refused, field: j.field };
  return { kind: "unknown", text: ar ? "تعذّر التأكد من الحفظ. تعرض البطاقة الآن ما هو محفوظ؛ راجعها وحاول مرة أخرى إن لزم." : "Could not confirm the save. The card now shows what is stored; check it and try again if needed." };
}

/** GET /api/profile, for a card to show what is stored after a save it could not confirm. */
export const readProfile = () => fetch("/api/profile", { cache: "no-store" }).then((x) => x.json() as Promise<{ ok?: boolean; me?: { name: string; lang: Lang }; user?: { phone?: string }; brand?: NonNullable<ProfileSaved["saved"]>["brand"] }>);
