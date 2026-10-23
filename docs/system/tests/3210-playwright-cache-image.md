# Coverage: Playwright browser cache keyed by the runner's OS release (rule 3210)

Status on 2026-10-23. Release pull request #437 failed every mobile-safari test with `libicudata.so.74: cannot open shared object file`: a re-run on an `ubuntu-24.04` runner had saved WebKit under `playwright-Linux-1.63.0-chromium-webkit`, and the next run, on `ubuntu-26.04` while `ubuntu-latest` moves between the two, restored that build, which links the older ICU. The key now also names the OS release read from `/etc/os-release` (`ubuntu24.04`, `ubuntu26.04`), so each release downloads and caches its own browsers. Release step: none, CI only; no stored shape, route or environment variable changes.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3210 | The `Playwright version` step writes `image` (`$ID$VERSION_ID` from `/etc/os-release`) beside `version`, and `Cache Playwright browsers` keys on both (`playwright-{os}-{version}-{image}-chromium-webkit`), so a WebKit built for one Ubuntu release is never restored on another | `tests/ci-workflow.test.ts` (rule 772 Playwright cache case, rule 3210 assertions) | none |
