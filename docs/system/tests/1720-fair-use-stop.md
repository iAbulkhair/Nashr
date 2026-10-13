# Coverage: fair-use stop (rules 1720-1739)

Status on 2026-10-13, branch `claude/fair-use-stop-4fd43a` (draft pull request). Founder decision of 2026-10-13: "no need to lawyer, just stop the service". Flows section 73 (section 72 left for the founding-mechanics change, rules 1700-1719). Permissions rows 240-241 (235-239 left free). Rules 1738-1739 are held for this change and not used.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1720 | The limit: `FAIR_USE_PCT` = 100; limit = (`netPriceSar(priceOf(u))` + top-up packs paid this month net of VAT and refunds, `topupRevenueSar`) × 100%; cost = margin alert's model + media counters × `SAR_PER_USD`; paused when cost ≥ limit (equal pauses) | `tests/fair-use.test.ts` ("the limit") | — |
| 1721 | Applies to paying accounts only (`isPaying`); the trial, a suspended account and a plan without a price are never paused, so the trial is never gated twice | `tests/fair-use.test.ts` ("the limit", "the trial is not gated twice") | — |
| 1722 | Chat: `reserveChatTurn` refuses `fair_use` before the allowance is counted; `POST /api/chat` answers 402 `fair_use`; no message counted, no model call | `tests/fair-use.test.ts` ("POST /api/chat answers 402 fair_use") | A streamed chat turn with the stop |
| 1723 | `generateBatch` refuses `fair_use` after the trial check, before the classifier, the charge and the model; callers answer 402 `{error:"fair_use", resumes}` (generate, spend cards, handoffs), MCP `generate_content` and chat tools the sentence; a routine's outcome `fair_use` counts as skipped | `tests/fair-use.test.ts` ("generateBatch refuses"; source pin) | A routine run that records the `fair_use` outcome |
| 1724 | `renderImage` and `renderVideo` refuse 402 `fair_use` after the trial check, the free placeholder card included | `tests/fair-use.test.ts` ("image and video renders") | — |
| 1725 | `POST /api/onboard`, `/api/onboard/confirm`, `POST /api/instructions/test` and a meeting proposal (`proposeFromMeeting`) refuse 402 `fair_use` before their charge | `tests/fair-use.test.ts` (source pin: gate before the charge) | Each route called end to end on a paused account |
| 1726 | A failed read of the counters lets the request through and logs `fair_use_read_failed`; the gate never throws | `tests/fair-use.test.ts` ("a failed read") | — |
| 1727 | The owner's message: `LimitModal` kind `fair_use`, Arabic and English, owner vs member wording, the top-up button; every panel maps the code | `tests/fair-use.test.ts` ("the owner's message") | A rendered modal |
| 1728 | Reads: one MGET of the two counters; nothing read for an account the stop does not apply to | `tests/fair-use.test.ts` ("the reads") | — |
| 1729 | One founder bell item per account per month (kind `credits`, plan only, `/{lang}/admin/usage#margin`), `setNx` marker `fairuse:alerted:{month}:{hash}` (40 days), no email in the key or the item | `tests/fair-use.test.ts` ("one bell item per account per month") | — |
| 1730 | `POST /api/admin/fair-use {email, action, reason}`: `adminActor` (401), second factor, reason (400), `bad_email` / `bad_action` (400), `not_found` (404), under `withUserLock`, `admin:log` row `fair_use_lift` / `fair_use_clear`, `no-store` | `tests/fair-use.test.ts` (route test and order pin), `tests/role-gates.test.ts` | The 403 `second_factor` answer once a second factor is enrolled |
| 1731 | The lift is `User.fairUseLift = {month, at, by}` and counts for its month only; expand only | `tests/fair-use.test.ts` ("the founder's lift counts for its month only"), `tests/profile-allowlist.test.ts` | — |
| 1732 | MCP `ask_noor` and `generate_content` and the chat tools answer `fairUseText()`; no model call | `tests/fair-use.test.ts` ("MCP ask_noor") | MCP `generate_content` end to end |
| 1733 | The Usage page's Margin table marks rows Paused / Lifted this month (`markFairUse`) with Lift pause / Re-apply buttons (reason form, `adminFetch`) | `tests/fair-use.test.ts` ("the console marks") | A rendered Usage page with a paused row |
| 1734 | Every file that charges credits or reserves a chat turn calls the gate, or is a named exception | `tests/fair-use.test.ts` (source pin) | — |
| 1735 | Docs: flows section 73, permissions rows 240-241, architecture `fair-use.ts` and `fairUseLift`, this file | `tests/fair-use.test.ts` ("the system docs say the same") | — |
| 1736 | Terms: one sentence in "Subscription and credits", both languages; terms date 2026-10-13 | `tests/fair-use.test.ts` ("the terms carry one fair-use sentence") | — |
| 1737 | Not gated: X reads (`x-stats.ts`, X API cost) and model calls that charge no credits (Reem's chat, crawls) | `tests/fair-use.test.ts` (x-stats pin) | — |
