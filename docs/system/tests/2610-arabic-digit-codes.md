# Coverage: authenticator codes typed in Arabic digits (rules 2610-2612)

Status on 2026-10-21 on branch `claude/dhakeen-authenticator-integration-769ac9`. The founder set up the console's second factor (rules 1370-1389) and every code was refused as wrong. An Arabic keyboard types the code as ١٢٣٤٥٦, and `\d` matches only 0-9: in `totpMatch`, in the six-digit checks before it (customer `mfa.ts`, staff `staff-code.ts`, `staff-admin.ts`, the staff sign-in route) and in the console setup field's `pattern`, which blocked the form before it was sent. Release step: expand (no stored shape changes).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2610 | `westernDigits` (`src/lib/verify-client.ts`, import-free and client-safe, already the digit parser of the email-code page and exempt from rule 1584; `typedDigits` now uses it) reads Arabic-Indic ٠-٩ and Persian ۰-۹ as 0-9 and leaves every other character alone; `totpMatch` applies it before its six-digit check, so the same code is accepted in any of the three digit sets and anything but six digits is still refused | `tests/arabic-digit-codes.test.ts` ("rule 2610: …") | — |
| 2611 | The founder console setup (`confirm`) and the code prompt (`verify`) accept a code typed in Arabic or Persian digits; a wrong code in those digits is still `bad_code` and enrols nothing | `tests/arabic-digit-codes.test.ts` ("rule 2611: …") | — |
| 2612 | Customer two-step setup accepts Arabic digits; every server check of a typed authenticator code (customer, staff sign-in, staff fresh code) reads the digits first; the console setup field's `pattern` admits Arabic and Persian digits and the customer confirm button is enabled by them | `tests/arabic-digit-codes.test.ts` ("rule 2612: …", one route run and source checks) | No route run for the staff sign-in step; the `x-admin-otp` header stays 0-9 only (scripts, not typed) |

Rulings:
- Email codes already read Arabic digits (`normalizeCode` in `verify-email.ts`, `typedDigits` in the browser); only authenticator codes missed it.
- The setup field's `pattern` is written with `\u` escapes, so the UI source stays free of Arabic-Indic digits (rule 1584).
