# WhatsApp phone number check

Status: proposed, not built. Written 2026-10-13 against `main` at `4c0264b4`. Build order: 5 of 8. Rule numbers are assigned when it is built.

## ملخص

المؤسس يتابع أول عشرين عميلاً شخصياً على واتساب (قرار 5 أكتوبر، لا واتساب آلي)، والفوترة تقرأ رقم الجوال. اليوم الرقم اختياري عند التسجيل، ويكفي أن يكون 9 خانات أو أكثر، والتطبيع (`normalizePhone`) يعرف الأرقام السعودية فقط. المقترح خطوتان بلا أي إرسال آلي: (1) تحقق من الصيغة حسب رمز الدولة للخليج مع رسالة خطأ واضحة، وسؤال «هل هذا رقم واتساب؟» عند التسجيل وفي الإعدادات؛ (2) علامة يضعها المؤسس من لوحته بعد أول رسالة («يعمل» أو «لا يعمل واتساب») مع سبب، وزر يفتح محادثة الرقم في واتساب من لوحة المؤسس فقط. التحقق بالرمز عبر واتساب Business API غير مشمول: يحتاج موافقة Meta وقوالب، ويناقض قرار «لا واتساب آلي» حتى يتغير.

## Goal

Know, for each customer who gave a number, whether it is a well-formed number in the right country and whether the founder's first WhatsApp message reached it, without sending anything automatically.

## Today (checked 2026-10-13)

- `User.phone` (string, may be empty). Signup rejects a non-empty value with fewer than 9 digits (`bad_phone`); `PUT /api/profile` applies the same `phoneOk`. `normalizePhone` turns `05xxxxxxxx` and `5xxxxxxxx` into `+966...`, accepts `00` prefixes, and prefixes `+` to anything else.
- Billing reads the phone for Paymob (`"NA"` when empty).
- `SUPPORT_WHATSAPP` is the support number shown to customers. Composio has a WhatsApp auth config only for message templates sent for Meta's review.

## User flow

1. Signup and Settings > Profile: the phone field shows the country as it reads the number (+966, +971, +965, +974, +973, +968) and a note «رقم واتساب يتواصل معك عليه فريق ذكين» / "the WhatsApp number the Thakeen team reaches you on". Numbers outside those prefixes are accepted as international (E.164 length 8 to 15) with a gentle warning. A tick: "This number is on WhatsApp" (default off, never required).
2. A malformed number shows the reason in the person's language (too short, letters, wrong length for the country) instead of a bare error.
3. Founder console, Users drawer: the number, an "Open in WhatsApp" link (`https://wa.me/<digits>`, built in the browser from the displayed number, opened by the founder), and two buttons: "Reached" / "Not on WhatsApp" with a required short reason. The state and date show in the Users table, so the founder knows who still needs another channel (email).
4. A customer whose number is marked "not on WhatsApp" sees, in Settings, a line asking for a WhatsApp number; nothing is blocked.

## Data shape (rule 679)

Optional new fields on the user record, none of them read by old code:
- `phoneCheck?: { state: "unchecked" | "reached" | "failed"; at: string; by?: string; reason?: string }` set only by the founder route.
- `phoneIsWhatsapp?: boolean` from the customer's tick.
Both are cleared when the phone changes (a new number is "unchecked"). The country is derived on read from the number, never stored. Expand only; no contract step. `wipeAccount` and the data download already include the whole user record.

## Routes and auth

- `POST /api/auth/signup` and `PUT /api/profile`: same routes, stricter validation through one shared function in `src/lib/phone.ts` (keeps `normalizePhone`); the owner's own account only.
- New: `POST /api/admin/phone-check` { email, state, reason }: `adminActor`, then `secondFactorRefusal(req, who)`, the reason through `reasonRefused` (rule 1185), written through `adminAudit`; the target is looked up by the email in the body only to find the account the founder named, and the write happens under `withUserLock`.
- No customer-facing read of another account's phone state.

## Environment variables

None.

## Risks

- A phone number is personal data (PDPL): it appears in the data download and the processor-list text already; do not put it in URLs the server logs. The `wa.me` link is built in the founder's browser only.
- False confidence: a well-formed number can still be wrong or not on WhatsApp; only the founder's manual mark means "reached".
- Over-strict validation blocks real numbers (some GCC mobile ranges change); the rule is length and prefix only, not a carrier table.
- Changing the number must reset the mark, or a new number would inherit "reached".
- Scope creep into automatic sending: out of this spec; it would need a Business API approval and a founder decision against the "no automated WhatsApp" rule.

## Test plan

- Validation table: Saudi `05...`, `+9665...`, `009665...`, UAE `+9715...`, Kuwait `+965...`, Arabic-Indic digits, too short, letters, empty (allowed at signup, as today).
- `normalizePhone` keeps its current outputs for current inputs (regression table).
- Founder route: refuses without the founder session, without the second factor, without a reason; writes an audit row; a changed phone resets `phoneCheck`.
- Old record without the new fields reads as unchecked; a save by old code keeps the fields.

## Rough size

Small: one lib file, two validations switched to it, one admin route, small UI changes in two places and the console drawer, tests and docs. One pull request.
