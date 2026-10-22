# Coverage: per-client AI usage tracking (rules 2900-2909)

Status on 2026-10-22 on branch `claude/thakeen-nashr-bugs-tests-tracking-9eac9c` (from main 49902c1a). The founder asked to track each client's and each user's AI usage. The founder sees every account ranked by what its model calls and renders cost, and each account's split by person, brand, model and day. An owner or admin sees their own month as requests and shares, never a dollar figure (the founder chose "founder + owner"; requests rather than credits because a model call's credit is not one number per call). Release step: expand only (`flows.md` section 107). New keys: eight hashes per account per month and one sorted set per month, all written next to the old counters; old code never reads them. No backfill: months before the release read as empty.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2900 | The four splits and the ranking are written in the same round as the old usage counters, never in a loop (one `Promise.all` in `record`) | `tests/redis-loops.test.ts` (whole-tree scan) | none |
| 2901 | `usageWho(u, scope)` maps the actor to `owner`, `member:{login}`, `support` (impersonation), `app` (bearer token) or `system` (no actor), and the scope to its brand id; nothing comes from a request | `tests/ai-usage-tracking.test.ts` (rule 2901) | none |
| 2902 | One metered call adds calls (only a call that counts) and micro-dollars per person, brand, catalog model (`other` outside it) and UTC day | `tests/ai-usage-tracking.test.ts` (rules 2902-2905) | none |
| 2903 | A missing or malformed person or brand (control characters, over 200 characters) counts as `unknown`, so each split adds up to the account's total | `tests/ai-usage-tracking.test.ts` | none |
| 2904 | `usageMonthKeys` lists the eight hashes and `wipeAccount` deletes them and removes the account from 36 months of the ranking | `tests/ai-usage-tracking.test.ts` (rule 2904); `tests/usage-model.test.ts` (per-account `by:model` allowed, global model/provider counters still never per account) | none |
| 2905 | `usage:_all:{m}:rank` gets each account's model cost (`record`, cost > 0) and render cost (`meterRender`); `rankAccounts` sorts by cost and caps at 500; an anonymous call adds nothing | `tests/ai-usage-tracking.test.ts` | none |
| 2906 | `GET /api/admin/users/{email}` carries `breakdown` (the four splits with cost) and the user sheet shows it | `tests/role-gates.test.ts` (route stays founder-only) | A render test of `UsageBreakdown` |
| 2907 | `GET /api/usage` and Settings → AI usage: owner and admins only (`usage.view`), member 403, signed out 401, bad month 400; the body has requests and shares only, no `usd`; the page and panel hold no dollar figure | `tests/ai-usage-tracking.test.ts` (rules 2907-2908); `tests/role-gates.test.ts`; `tests/uiux-phase3.test.ts` (eleven sections) | An E2E of the settings page with seeded usage |
| 2908 | `GET /api/admin/usage/clients`: founder console only; a customer session is refused; a bad month is 400; rows carry address, plan, calls, model and media cost and margin | `tests/ai-usage-tracking.test.ts`; `tests/role-gates.test.ts` | none |
| 2909 | Every customer-facing model call site passes `usageWho` (chat, generation and its judge, revise, instructions test, onboarding, media prompts, Reem's meeting, free tools) | `tests/ai-usage-tracking.test.ts` (rule 2909, source scan) | A behaviour test per site |

Not counted: the agent-scope classifier (global), the founder's skill test (`ADMIN_TEST_LABEL`) and the golden set (`GOLDEN_EMAIL`).
