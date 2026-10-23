# Coverage: Playwright browser cache keyed by the runner's OS release, bounded installs (rules 3210-3211)

Status on 2026-10-23. Release pull request #437 failed every mobile-safari test with `libicudata.so.74: cannot open shared object file`: a re-run on an `ubuntu-24.04` runner had saved WebKit under `playwright-Linux-1.63.0-chromium-webkit`, and the next run, on `ubuntu-26.04` while `ubuntu-latest` moves between the two, restored that build, which links the older ICU. The key now also names the OS release read from `/etc/os-release` (`ubuntu24.04`, `ubuntu26.04`), so each release downloads and caches its own browsers. Release step: none, CI only; no stored shape, route or environment variable changes.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3210 | The `Playwright version` step writes `image` (`$ID$VERSION_ID` from `/etc/os-release`) beside `version`, and `Cache Playwright browsers` keys on both (`playwright-{os}-{version}-{image}-chromium-webkit`), so a WebKit built for one Ubuntu release is never restored on another | `tests/ci-workflow.test.ts` (rule 772 Playwright cache case, rule 3210 assertions) | none |

## Rule 3211: bounded, retried browser installs

The first ready run of PR #442 missed the new key, as expected, and `Install Playwright browsers` then ran 24 minutes until the job's 40-minute cap cancelled it: the Ubuntu mirror served packages at about 60 KB/s. The same install took 38 seconds on the same `ubuntu-26.04` image in #437's green run. Both install steps now run `timeout 6m` up to three times, and apt resumes from the packages it already fetched. A slow mirror costs at most 18 minutes and ends in a failed step with a warning per try, never a cancelled job. Release step: none, CI only.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3211 | `Install Playwright browsers` and `Install Playwright system dependencies` each loop `for try in 1 2 3`, run their install under `timeout 6m`, exit 0 on the first success, warn per failed try and exit 1 after the third | `tests/ci-workflow.test.ts` (rule 772 Playwright cache case, rule 3211 assertions) | none |
