import { describe, expect, it } from "vitest";
import { spendIntent } from "@/lib/spend-intent";

/**
 * Rule 1510: the deterministic intent check that decides whether a paid chat tool runs straight away. It reads only the
 * owner's own text. A request is a request verb that nothing negates, with a deliverable noun in the same clause, or a
 * clause that opens with a number and a deliverable; an image request is a drawing verb, or a request verb with an image
 * noun. Everything else (a bare "yes", a question about how to write, a negated verb) is not explicit.
 */
describe("rule 1510: explicit paid-work intent, Arabic and English", () => {
  const content = [
    "اكتبي خطة الأسبوع",
    "10 منشورات لليوم الوطني",
    "Write this week's plan",
    "10 posts for National Day",
    "ابغى 3 بوستات عن القهوة",
    "سو لي إعلان",
    "سوّي لي إعلان للعيد",
    "ممكن تكتب لي رسالة واتساب للعملاء",
    "Can you draft three Instagram captions?",
    "جهّز حملة رمضان",
    "وأكتب لي مقال عن التمر",
    "write a follow-up email",
    "3 منشورات إنستقرام تعريفية",
    "ابدأ: رسالتا واتساب للمتابعة",
    "أحتاج تقرير أسبوعي",
    "I need 5 ads for the new menu",
    "مرحبا، اكتب لي منشور عن العرض",
    "راجعي أسعارنا",
    "review our pricing",
  ];
  const notContent = [
    "كيف أكتب منشور جيد؟",
    "لا تكتب منشورات اليوم",
    "لاتسوي اعلان",
    "don't write any posts",
    "do not generate anything, just tell me the plan",
    "نعم",
    "تمام",
    "yes go ahead",
    "what should I post this week?",
    "شو رأيك بالمنشورات؟",
    "how do I write a good caption",
    "مرحبا",
    "how are you, ready?",
    "عندي 3 منشورات في الصندوق",
    "review",
    "خطط",
    "",
  ];
  it.each(content)("content: %s", (t) => expect(spendIntent(t, "content")).toBe(true));
  it.each(notContent)("not content: %s", (t) => expect(spendIntent(t, "content")).toBe(false));

  const image = ["ارسم صورة للمنشور", "draw an image for the post", "سو صورة للبوست", "add a picture to the first post", "أضف صورة", "صمم بوستر", "اعمل تصميم للإعلان"];
  const notImage = ["اكتب منشور", "لا ترسم", "how do I draw", "صورة حلوة", "write a post", "نعم"];
  it.each(image)("image: %s", (t) => expect(spendIntent(t, "image")).toBe(true));
  it.each(notImage)("not image: %s", (t) => expect(spendIntent(t, "image")).toBe(false));

  it("reads text only: anything else is no intent", () => {
    expect(spendIntent(undefined, "content")).toBe(false);
    expect(spendIntent({ text: "write 10 posts" }, "content")).toBe(false);
    expect(spendIntent(["write 10 posts"], "image")).toBe(false);
  });

  it("a negation in one clause does not cancel a request in another", () => {
    expect(spendIntent("لا تنشر شيء. اكتب لي 3 منشورات", "content")).toBe(true);
    expect(spendIntent("Don't publish yet, but write 3 posts", "content")).toBe(true);
  });
});
