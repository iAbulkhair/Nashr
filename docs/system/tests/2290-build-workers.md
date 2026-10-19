# Coverage: build workers capped (rule 2290)

Status on 2026-10-19 on branch `claude/hostinger-build-workers` (cut from main 931404ee). Release #389 (production b31253ef) did not go live: Hostinger build 01a152f2 compiled and type-checked, then started 63 workers for "Collecting page data", hit the hosting account's process limit (`OS can't spawn worker thread: Resource temporarily unavailable (os error 11)`) and aborted with SIGABRT. Next's default is one worker per CPU less one, and the shared build machine reports 64 CPUs. Rules 2291-2299 are held for this work and unused.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2290 | `next.config.ts` sets `experimental.cpus` to 4, so `next build` (and `build:hostinger`) starts at most 4 workers on any machine | `tests/build-workers.test.ts` (the config value is a number from 1 to 4) | none; the proof that it fixes the host is the next Hostinger build finishing |
