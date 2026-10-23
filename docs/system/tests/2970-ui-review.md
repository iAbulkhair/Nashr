# Coverage: fixes from the UI review (rules 2970-2977)

Status on 2026-10-22 on branch `claude/thakeen-nashr-review-tests-292d14`. A review of the client components found the defects below. Each one is fixed here with a source-scan test (the repo has no browser test for these screens). Release step: none of them changes a stored shape or a route.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2970 | `WorkspaceProvider` follows a new `initial` (after `router.refresh()`): credits, unread and pending are adjusted during render when the server's number changed, so the rail's balance no longer stays stale after a run, a report, media or a top-up | `tests/ui-review-2970.test.ts` (rule 2970) | a rendered test once the repo has a component test harness |
| 2971 | Reports: `run()` clears `busy` in `finally` and shows the generic failure toast when fetch throws or the answer is not JSON | `tests/ui-review-2970.test.ts` (rule 2971) | none |
| 2972 | Inspiration: "use this" opens the chat only when `/api/chat` answered ok; a dropped connection or another refusal frees the button and shows the generic failure line | `tests/ui-review-2970.test.ts` (rule 2972) | none |
| 2973 | Integrations: `load`, `importProducts`, `selectPage`, `selectOrg`, `postAs`, `selectAdAccount` read replies with `.catch(() => null)` and clear `busy` in `finally` | `tests/ui-review-2970.test.ts` (rule 2973) | none |
| 2974 | Help centre: an undecodable `#hash` opens nothing instead of throwing a `URIError` that crashed the page | `tests/ui-review-2970.test.ts` (rule 2974, also runs the decode guard) | none |
| 2975 | MCP page: "Generate token" checks `res.ok`, blocks a second click while one is in flight (two tokens) and shows an error line instead of a fake token state | `tests/ui-review-2970.test.ts` (rule 2975) | none |
| 2976 | Files: one save at a time (a second PUT got 409 and left a stale conflict banner); Edit clears the conflict; the new-file box never closes the editor of the open file | `tests/ui-review-2970.test.ts` (rule 2976) | none |
| 2977 | Chat: the header's new-conversation button waits for the request in flight and survives a dropped one (a separate path from the rail's buttons, rule 2934); the first conversation-list read has a `catch` | `tests/ui-review-2970.test.ts` (rule 2977) | none |

Known and left: McpPanel keeps its own inline Arabic and English lines (the page takes no dictionary), so its new error line is inline too.
