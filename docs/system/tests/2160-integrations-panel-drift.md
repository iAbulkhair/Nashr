# Coverage: Integrations page drift fix (rules 2160-2169)

Status on 2026-10-18 on branch `claude/api-platform-integrations-ce2972` (cut from main 6b8090a6). The founder console's Integrations page (rules 1540-1544, flows section 69 item 5) had drifted from the code: it asked kie.ai and Higgsfield for `BLOB_READ_WRITE_TOKEN`, which nothing reads since the disk store (rules 1750-1763), so both would read "partial" for ever, and it had no row for Sign in with Google (#376). Rules 2163-2169 are held for this work and unused.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2160 | The kie.ai row needs `KIE_API_KEY` + `MEDIA_DIR`, the Higgsfield row `HIGGSFIELD_API_KEY_ID` + `HIGGSFIELD_API_KEY_SECRET` + `MEDIA_DIR`, matching `src/lib/media/config.ts` (a kie or Higgsfield model is offered only with the store configured). `BLOB_READ_WRITE_TOKEN` is on no row | `tests/integrations-panel-drift.test.ts` (rule 2160) | none |
| 2161 | A `google_signin` row needs `GOOGLE_SIGNIN_CLIENT_ID` + `GOOGLE_SIGNIN_CLIENT_SECRET`, the two names `src/lib/google-signin.ts` reads; the calendar's `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` never turn it on | `tests/integrations-panel-drift.test.ts` (rule 2161) | none |
| 2162 | Every name the page lists is still read somewhere in `src/` outside `src/lib/integration-status.ts` | `tests/integrations-panel-drift.test.ts` (rule 2162, source scan) | none |
