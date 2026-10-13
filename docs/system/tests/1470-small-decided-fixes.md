# Coverage: small decided fixes (rules 1470-1486)

Status on 2026-10-12, branch `claude/small-decided-fixes-bd589f` (draft PR). The founder decided these items earlier and asked on 2026-10-12 for every recommended fix to be built. They come from the 360 study (A-009, D-019) and the leftovers audit (L048, L057, L081, L085, L086, L087, L091). Flows section 67 (renumbered from 64 in the 2026-10-12 build batch: 64-66 were taken by the second factor, privacy and security hardening). Rules 1487-1499 are held for this change and not used. Rule 1486 (routines on by default) was added on the founder's decision of 2026-10-12, confirmed in the session that built it.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1470 | The partner application is open only to people living in Saudi Arabia: `PARTNER_COUNTRIES = ["SA"]`, `partnerCountryOpen`; `POST /api/affiliates` refuses any other or missing country with 400 `country_closed` and stores `country` on the application; the form asks for the country and explains, without sending, when it is not Saudi Arabia | `tests/partners.test.ts` (rules 1470-1471 block, UAE test rewritten), `tests/leads.test.ts` | — |
| 1471 | Bank details save only with a Saudi residence (`country_closed` otherwise); the partner page offers only Saudi Arabia; the terms (version 2026-10-12), the bank note and the affiliates page say Saudi residence, in both languages | `tests/partners.test.ts` (rules 1470-1471 block, rule 416 and the terms tests), `tests/topup-refunds.test.ts` (version) | — |
| 1472 | `currencyOf(zone)` names the brand's currency from its zone (`ZONE_CURRENCY`), SAR for none or unknown | `tests/small-decided-fixes.test.ts` (rules 1472-1473 block) | — |
| 1473 | Task specs, the judge's wording, Razan's persona and the playbooks name `{CURRENCY}`, filled by `taskSpec(type, brand?)`; SAR when the brand has no zone. The generation prompt changed deliberately: the `gen` hashes in `tests/cross-review.test.ts` and `tests/handoffs.test.ts` were updated and say so | `tests/small-decided-fixes.test.ts`, `tests/cross-review.test.ts`, `tests/handoffs.test.ts` | — |
| 1474 | `stalledSignups(users, hasBrand, now)`: accounts at least 24 hours old, not suspended, with no brand file; newest first; the reason is `email_unverified` or `no_brand`; at most 50 rows with the full count | `tests/small-decided-fixes.test.ts` (rules 1474-1475 block) | — |
| 1475 | The founder overview carries `stalled` and the console shows it in a `data-stalled` table, in both languages | `tests/small-decided-fixes.test.ts` (source check) | A rendered Overview with rows |
| 1476 | `providerFault(e)` reads status 402, `billing_error`, `no_balance` or a 4xx balance text as `no_balance`; 429, `rate_limit_error` or `busy` as `rate_limited`; 529 or `overloaded_error` as `overloaded`; through up to three `cause` links; anything else is null | `tests/small-decided-fixes.test.ts` (rules 1476-1478 block) | — |
| 1477 | The customer sees `model_busy` or `model_unavailable` with copy in both languages that names no provider, status or text; chat, generate and onboarding use it, and onboarding no longer sends the error's own message | `tests/small-decided-fixes.test.ts` | — |
| 1478 | One founder audit row (`system`, `provider_{fault}`, target the place) per fault and place an hour, through `db.setNx("providerfault:{fault}:{place}")`; best effort | `tests/small-decided-fixes.test.ts` | — |
| 1479 | `approverStats(decisions, owner, now)`: approvals and publishes count as approved, rejections and edits apart, over the last 30 days; no `by` is the owner's; founder, token and system are left out; rate is approved over approved plus rejected, or null | `tests/small-decided-fixes.test.ts` (rules 1479-1480 block) | — |
| 1480 | The team view carries `approvals` across every brand of the account for the owner and an admin (`team.approvals.view`), never for a plain member; the team page shows one line per person | `tests/small-decided-fixes.test.ts` | — |
| 1481 | `render` keeps a Markdown table's last column with or without the closing pipe | `tests/small-decided-fixes.test.ts` (rule 1481 block) | — |
| 1482 | A blog draft's title is its first H1 wherever it sits, and that H1 leaves the body (`splitTitle`) | `tests/small-decided-fixes.test.ts` (rule 1482 block) | — |
| 1483 | `workspaceLarge(trimmed, fit)` is true when the fit left history out or gave the first call less than `CHAT_FIRST_MIN_OUT` | `tests/small-decided-fixes.test.ts` (rules 1483-1484 block) | — |
| 1484 | A chat reply carries `large: true` when the workspace was large (not on the no-answer cliff, not out of time); the chat shows a quiet hint with a link to the files page | `tests/small-decided-fixes.test.ts` (source check) | A rendered ChatPanel message with `large` |
| 1485 | The upstream pins in `docs/upstreams.json` point at the reviewed commits (agency-agents f99f6aa, paperclip 88b7bbb) | `tests/small-decided-fixes.test.ts` (rule 1485 block) | — |
| 1486 | Routines are on by default for every brand, added brands included: `routineOn(schedule, id)` is false only for a stored `false` (the owner's switch); `dueRoutines`, `runRoutine` and the Scheduled tasks switch read it; the trial, gate, weekly cap, agent cap and credit checks before any charge are unchanged; copy in both languages | `tests/routines.test.ts` (rule 111 block: default on, added brand on, the owner's off kept, the checks still in the runner; the `owner` helper stores off for the routines a test does not name) | — |

## Notes

- Release step: expand only (rule 679). `Application.country` and `ChatMsg.large` are new optional fields, and rule 1486 only changes how a missing routine switch is read; old code ignores them and new code reads records without them. No conversion script. No environment variable added.
- Upstream review (L091): agency-agents has nothing to adopt. Paperclip has two ideas worth a later look, not built: a budget reserve where usage without a known price is blocked by default, and mentions read as context rather than as an assignment.
- Existing partner applications and bank details from outside Saudi Arabia are not touched; they stay readable and payable as before. Only new applications and new bank details are checked.
- Media providers still report a spent balance as `media_failed` and trip the breaker; rule 1476 classifies a media `ProviderError` but the media routes were not changed.

## Not pinned

- D-019's full-workspace golden case costs model credits and needs a golden run; only the hint is pinned.
- That a real Anthropic or gateway error has these shapes is read off the SDK's types, not a live call.
