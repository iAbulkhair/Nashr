# Coverage: repository tooling (rules 3170-3174)

Status on 2026-10-23 on branch `claude/sup-repo-tooling`. Small tooling changes taken from the Supastarter template: `.editorconfig`, an `engines` field, a real README and a local coverage command. Rules 3175-3179 are reserved and unused. Release step: none: no stored shape changes.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3170 | `package.json` declares `engines.node` as `>=22`, the Node version CI uses (`setup-node` 22, rule 1017) and the one Hostinger builds with (`docs/system/architecture.md`) | `tests/repo-tooling.test.ts` (rule 3170) | none |
| 3171 | `npm run test:coverage` exists (`vitest run --coverage`) and `@vitest/coverage-v8` is a devDependency on the same major.minor as `vitest`; the output folder `coverage` is in `.gitignore` | `tests/repo-tooling.test.ts` (rule 3171) | none |
| 3172 | The coverage command stays out of CI: no workflow under `.github/workflows` mentions `test:coverage` or `--coverage` (CI minutes are paid, rule 772) | `tests/repo-tooling.test.ts` (rule 3172) | none |
| 3173 | The lockfile keeps the optional platform bindings (`@rolldown/binding-linux-*`), so `npm ci` on Linux works; after any dependency change it is regenerated from `package.json` alone in an empty directory (`npm install --package-lock-only --ignore-scripts`, npm 11.10 or later) | `tests/repo-tooling.test.ts` (rule 3173) | none |
| 3174 | `.editorconfig` states the style the code already has (UTF-8, LF, two spaces, final newline) and every path the README names exists | `tests/repo-tooling.test.ts` (rule 3174) | none |

Proof on 2026-10-23: the lockfile was regenerated in an empty directory with npm 11.21.1, which resolved `vitest` and `@vitest/coverage-v8` both to 5.0.5 (the regeneration re-resolves every range, so other packages moved within their ranges too); `npm ci` from it succeeds and `npm run test:coverage` runs. `.npmrc` install-script behaviour is not changed.
