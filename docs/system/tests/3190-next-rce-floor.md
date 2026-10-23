# Coverage: next 16.4.1 for three advisories (rule 3190)

Status on 2026-10-23. Hostinger's scanner flagged next 16.3.8 and opened PR #438 (production) and PR #439 (main) with `package.json` only, so `npm ci` failed on the stale lockfile. This change bumps next and eslint-config-next to 16.4.1 (published 2026-10-14, past the 7-day gate of rule 699) and regenerates the lockfile from the existing one in an empty directory with npm 11.10; only the next packages moved and the `@rolldown/binding-linux-*` entries are present. Release step: none, no stored shape changes.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3190 | Every installed copy of next is 16.4.1 or later: GHSA-673q-mjm6-r5xr (critical, RCE in `use cache` functions returning typed arrays), GHSA-2464-fhr4-w9xw (critical, RCE in the Image Optimization API with SVG files), GHSA-p3m5-59mp-jv5r / CVE-2026-94482 (high, App Router Server Actions denial of service). Raises the next floor of rule 662 | `tests/dependency-floors.test.ts` (rules 662, 3190) | none |
