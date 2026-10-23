# Coverage: Playwright browser cache keyed by the runner's OS release, bounded installs (rules 3210-3211)

Status on 2026-10-23. Release pull request #437 failed every mobile-safari test with `libicudata.so.74: cannot open shared object file`: a re-run on an `ubuntu-24.04` runner had saved WebKit under `playwright-Linux-1.63.0-chromium-webkit`, and the next run, on `ubuntu-26.04` while `ubuntu-latest` moves between the two, restored that build, which links the older ICU. The key now also names the OS release read from `/etc/os-release` (`ubuntu24.04`, `ubuntu26.04`), so each release downloads and caches its own browsers. Release step: none, CI only; no stored shape, route or environment variable changes.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3210 | The `Playwright version` step writes `image` (`$ID$VERSION_ID` from `/etc/os-release`) beside `version`, and `Cache Playwright browsers` keys on both (`playwright-{os}-{version}-{image}-chromium-webkit`), so a WebKit built for one Ubuntu release is never restored on another | `tests/ci-workflow.test.ts` (rule 772 Playwright cache case, rule 3210 assertions) | none |

## Rule 3211: bounded browser and system-package installs

The first ready run of PR #442 missed the new key, as expected, and `Install Playwright browsers` (then `install --with-deps`) ran 24 minutes until the job's 40-minute cap cancelled it: the runner's Azure Ubuntu mirror in westus3 served the 142 MB of WebKit system packages at about 40-60 KB/s. The same install took 38 seconds on the same `ubuntu-26.04` image in #437's green run. A first fix that retried `timeout 6m npx playwright install --with-deps` three times failed in 6 minutes: `timeout` ran as the runner user, killed `npx` but not the root `apt-get` under it, and that apt-get kept the dpkg lock, so tries 2 and 3 stopped at once.

Now the two halves are separate. `Install Playwright browsers` (cache miss only) downloads from Playwright's CDN with `timeout 5m`, two tries, and no apt work. `Install Playwright system dependencies` runs on every end-to-end run, as root under `timeout --kill-after=30s 6m`, three tries. After a failed try it kills any `apt-get` left, runs `dpkg --configure -a` and points apt from `azure.archive.ubuntu.com` to `archive.ubuntu.com` for the next try. A slow mirror ends in a failed step with a warning per try, never a cancelled job. Release step: none, CI only.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3211 | `Install Playwright browsers` runs on a cache miss only: `for try in 1 2`, `timeout 5m npx playwright install chromium webkit`, no `--with-deps` or `sudo`. `Install Playwright system dependencies` runs on every end-to-end run: `for try in 1 2 3`, `sudo env "PATH=$PATH" timeout --kill-after=30s 6m npx playwright install-deps chromium webkit`. After a failed try, in order: a warning, `pkill -x apt-get`, `dpkg --configure -a`, then a sed from `azure.archive.ubuntu.com` to `archive.ubuntu.com` over `/etc/apt/apt-mirrors.txt` and the sources files. Each step exits 1 after its last try | `tests/ci-workflow.test.ts` (rule 772 Playwright cache case, rule 3211 assertions) | A runner-level check that the mirror switch reaches apt; only a slow-mirror run can show it |
