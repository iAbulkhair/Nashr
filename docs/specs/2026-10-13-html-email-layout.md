# HTML email layout for the mails that still go as plain text

Status: built 2026-10-16 on branch `claude/funny-lehmann-37da27` (rules 1960-1961, `docs/system/tests/1960-mail-logs-tooling.md`): the verify code, the "start" nudge, Noor's brief and the follow-ups have HTML parts. Written 2026-10-13 against `main` at `4c0264b4`. Build order: 1 of 8 (the others reuse this layout). Rule numbers are assigned when it is built.

## ملخص

الرسائل الأولى التي يستلمها العميل (رمز التحقق، تذكير «ابدأ»، ملخص نور الصباحي، المتابعة) ما زالت نصاً خالصاً، بينما إعادة تعيين كلمة المرور ودعوة الفريق وتذكيرات ريم والملاحظات العامة لها قالب HTML موحد (`src/emails/`). المقترح: نكمل القالب الموحد لهذه الأربع، فتصير كل رسالة موجهة للعميل متعددة الأجزاء (نص + HTML) بالعربية من اليمين لليسار. لا تغيير في البيانات المخزنة ولا متغيرات بيئة جديدة. أول رسالة تستحق القالب هي رمز التحقق لأنها أول ما يراه كل عميل جديد. ونقترح صفحة معاينة للرسائل في لوحة المؤسس حتى لا نرسل رسالة تجريبية لكل تعديل.

## Goal

Every message a customer receives carries an HTML part from the one shared layout, with the plain-text part sent as before, word for word. The internal support notification (`src/app/api/support/route.ts`) stays text only: it goes to the founder, not to a customer.

## Today (checked 2026-10-13)

- Built: `src/emails/layout.ts` (tables, `lang` and `dir` on every container, 560 px card), `button.ts`, `html.ts` (escaping, rule 686), `link.ts` (links only into the app, rule 687), templates `resetPassword`, `teamInvite`, `notice`. Rules 685-689 pin them (`tests/mail-templates.test.ts`). `sendEmail(to, subject, text, html?)` sends multipart when `html` is given.
- Already HTML: password reset, team invite, lifecycle notes, Reem's reminder, series warning and evening wrap.
- Still text only, by call site: the verification code (`src/lib/verify-email.ts`, `sendEmail(u.email, m.subject, m.text)`), the day-one nudge (`sendOnce(..., "nudge1", ...)` in `src/app/api/cron/daily/route.ts`), Noor's brief and the follow-up digest (same file, `sendEmail` with `brief.text` and `notifEmailText`).

## User flow

No new screen for customers. They see the same words in the branded layout:
1. Verification code: a heading, the 6-digit code large and left-to-right inside a right-to-left message, the expiry sentence, no button (the code is typed in the app). The code stays in the text part too, so every test and every text-only client still reads it.
2. Nudge: heading, the paragraph, one button to the app.
3. Noor's brief and the follow-up digest: heading, the brief as escaped paragraphs (the model's text is untrusted), one button.
4. Founder console: a preview page that renders each template with sample values next to its plain-text part. Founder only; nothing is sent.

## Data shape

None. No stored field changes, so rule 679 (expand then contract) does not apply and no migration is needed.

## Routes and auth

- No customer route changes.
- New, founder only: `GET /{lang}/admin/mail-preview`, a page behind `requireAdmin()` (404 otherwise) that renders the registry `EMAIL_TEMPLATES` with fixed sample values. It reads nothing from Redis and sends nothing. If a "send me this one" button is wanted later it becomes `POST /api/admin/mail-preview/send` with `adminActor`, `secondFactorRefusal`, a rate limit, and the founder's own address only (never an address from the request).

## Environment variables

None new. Uses `RESEND_API_KEY` and `MAIL_FROM` as today. Click tracking must stay off for the sending domain in Resend (some links carry their token in the fragment).

## Risks

- Outlook for Windows renders with Word: tables only, no grid. The layout already does this.
- A model-written brief can contain markup or a link to another site. It is escaped as text; only constant markup is raw (rule 686); the button href goes through `appLink` (rule 687).
- The code must stay text in both parts (not an image, not only inside a button): screen readers and text clients need it.
- Arabic-Indic digits are accepted when typed back (`normalizeCode`); the mail keeps Latin digits so they copy cleanly.
- Spam score: multipart with a faithful text part is the safer shape. No remote images in v1 (the wordmark is text).

## Test plan

- Add the new templates to `EMAIL_TEMPLATES` in `src/emails/index.ts`, so the existing walk over every template (direction on every container, escaping, links into the app) covers them.
- Verification mail: the text part is unchanged byte for byte; the HTML part holds the code once, in a left-to-right span, no `<script>`, no remote image.
- Brief and follow-up: a title with `<b>` and a task name with `"` come out escaped; a line break becomes `<br>`.
- Call sites: `sendEmail` receives an `html` argument at the four sites; the support route still receives none.
- Preview page: 404 without the founder session; renders every registered template in both languages.

## Rough size

Small: about four template functions and call-site edits, one admin page, one test file and one `docs/system/tests/NNNN-slug.md`. One pull request.
