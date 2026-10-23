---
name: add-or-edit-an-email
description: Use when adding a transactional email template, changing mail copy or layout, or changing how mail is sent in Thakeen.
---

# Add or edit an email

Templates are code in `src/emails`, not files in a mail provider. `src/emails/index.ts` has `EMAIL_TEMPLATES` and `renderEmail`; copy in both languages is in `src/emails/copy.ts` (`COPY`); shared pieces are `layout.ts`, `button.ts`, `html.ts`, `link.ts`, `notice.ts` and `tokens.ts`; the console preview feeds from `samples.ts`. Existing templates: `reset-password`, `team-invite`, `verify-code`, `daily-brief`.

## Steps

1. Add the template id to the id list in `src/emails/index.ts` and write `src/emails/<id>.ts` that returns subject, html and text from a typed context. Use the shared layout and button helpers; do not paste inline styles.
2. Copy: add Arabic and English entries to `COPY` in `src/emails/copy.ts` (add-arabic-and-english-copy). Arabic mail is right-to-left; the layout sets direction from the locale. Subject lines carry no invented numbers or promises.
3. Add a sample to `src/emails/samples.ts`. It is typed as a record over every template id, so the compiler tells you when one is missing. The admin mail preview uses it.
4. Links: build them from `appOrigin()` in `src/lib/origin.ts` so staging links point to staging. Never take a base URL from a request header or body. Escape every dynamic value that goes into html (customer names, brand names); model text is untrusted.
5. Sending: call `sendEmail({ to, subject, text, template, context, locale })` or `sendOnce` (when the event must produce one mail only) from `src/lib/notify.ts`. `mailReady()` needs the provider variables (names `RESEND_API_KEY` and `MAIL_FROM`, values by the founder). `src/lib/mail-provider.ts` has the Resend provider and a console provider; without keys, mail goes to the console outbox, which tests read.
6. Recipient: the signed-in person or a member from our own records. Never a free address from a request without a verify step, and never a loop of `await` sends (use `Promise.all` or `pmap`).
7. Every mail needs a reason to exist for the reader and, for anything that is not strictly account security, an unsubscribe path or a preference (add-a-notification, topics).
8. Tests: `tests/mail-templates.test.ts` renders every template in both locales and checks structure (rules 685-689 and 1960-1964); `tests/mail-once.test.ts` covers `sendOnce`. Add your template to the cases and assert the link, the locale and the escaping.
9. Docs: the mail list in `docs/system/flows.md` and a rule file in `docs/system/tests/`.

## Checks

`npx vitest run tests/mail-templates.test.ts tests/mail-once.test.ts`, then `npm run check`. Look at the rendered html in the console preview in both languages; do not send a real mail to test.

## Traps

- Sending real mail from tests or from your machine with production keys. Tests use the console provider.
- A link that carries a secret token in the query for a reusable page. Single-use and short-lived only.
- Spam-trigger copy or shouting. Plain, short, from a named sender.
- Forgetting the plain-text part. Both parts are required.
