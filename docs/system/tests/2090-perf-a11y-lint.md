# Coverage: tooling, lint and measured performance (rules 2090-2101)

Status on 2026-10-17 on branch `claude/wave2-perf-a11y-lint-cced78` (cut from main 50ff790b). This is wave 2e of the supastarter gap study of 2026-10-16, built under the founder's standing order «the best of supastarter in all aspects». The supastarter kit was read for its lint setup only; no code was copied. No route, permission, environment variable or stored shape changed, and no stored-shape release step is needed. See `flows.md` section 86 and `architecture.md` section 2.8. Rules 2102-2109 are free for follow-ups.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2090 | `eslint-plugin-jsx-a11y` is a direct devDependency (it was already installed through `eslint-config-next`, so the lockfile gains only the root entry), and `eslint.config.mjs` applies its recommended set to `src/**/*.tsx` | `tests/lint-ratchet.test.ts` (rule 2090) | none |
| 2091 | Every recommended jsx-a11y rule that is on is an `error`, except the ratcheted ones, which are `warn`. The recommended set's own options are kept. `control-has-associated-label` stays off, as in the recommended set | `tests/lint-ratchet.test.ts` (rule 2091) | A test that the real recommended set maps to the same levels after a plugin upgrade |
| 2092 | `eslint-rules/ratchet.json` names exactly the ratcheted rules (`A11Y_RATCHETED` plus `TYPE_RATCHETED`), each with a positive count; a rule that reaches 0 leaves the file and becomes an error | `tests/lint-ratchet.test.ts` (rule 2092) | none |
| 2093 | Three options, each with a reason in `eslint-rules/tooling-rules.mjs`: `aria-role` `ignoreNonDOM` (a component prop `role`), `label-has-associated-control` `depth: 3` (label, then two spans, then the input), `no-redundant-roles` allows `ul`/`ol` `list` (`list-style: none` drops the role in Safari with VoiceOver) | `tests/lint-ratchet.test.ts` (rule 2093) | A browser test of the VoiceOver claim, which no suite here can run |
| 2094 | Type-aware `no-floating-promises`, `no-misused-promises` and `await-thenable` run on `src/**/*.{ts,tsx}` with `parserOptions.projectService`. Tests, scripts and config files stay on the fast rules | `tests/lint-ratchet.test.ts` (rule 2094) | none |
| 2095 | The same error/warn split: only `TYPE_RATCHETED` rules are warnings. `no-misused-promises` sets `checksVoidReturn.attributes: false` (an `async` handler in a JSX prop is how React code is written); conditionals, arguments and spreads are still checked | `tests/lint-ratchet.test.ts` (rule 2095) | A rule that every `onClick` async handler catches its own failure |
| 2096 | `src` has no lint error, and no ratcheted rule is above its count in `eslint-rules/ratchet.json` (a new violation fails; `node scripts/lint-ratchet.mjs --write` lowers the file after a clean-up) | `tests/lint-ratchet.test.ts` (rule 2096, runs ESLint over `src` through its API, about 20 s) | Fail when a count is below the file, so the ratchet cannot drift loose. Left out because five sessions edit `src` at once |
| 2097 | Floating and misused promises are errors, not ratcheted. Nine fire-and-forget calls in handlers and effects are marked `void`, four `await byOf(...)` on a synchronous function are gone, and the `setTimeout`/`addEventListener` callbacks that returned a promise are wrapped. Ten `await-thenable` hits stay on the ratchet: nine synchronous `byOf(u)`-style values inside `Promise.all` and one `await` in `src/lib/chat.ts` (two of the ten are in that file, which another session is splitting) | `tests/lint-ratchet.test.ts` (rule 2097) | Remove the ten and drop the last type-aware ratchet entry |
| 2098 | The founder skills console gets its words from the page (`pickSkillsDict(appDict[lang])`, `src/lib/skills-admin-dict.ts`); no client component imports `appDict`. The route's own gzip JS fell from 83.7 to 21.8 kB | `tests/lint-ratchet.test.ts` (rule 2098, two tests); `tests/admin-skills.test.ts` | Pass only the keys the editor reads, not whole sub-objects |
| 2099 | `MeetingPanel` loads through `next/dynamic` on the first click on a row. Own gzip JS of the to-do page fell by 1.4 kB | `tests/lint-ratchet.test.ts` (rule 2099) | none |
| 2100 | `scripts/route-sizes.mjs` measures a `next build --webpack` output (Next 16 prints no First Load JS column) and diffs two runs | `tests/lint-ratchet.test.ts` (rule 2100, source scan) | A fixture `.next` folder and a run of the script on it |
| 2101 | The public site ships no raster image: no `<img>` and no `next/image` outside the signed-in inbox and library, which show user media from hosts that are not ours on purpose (`Inbox.tsx` explains) | `tests/lint-ratchet.test.ts` (rule 2101) | none |

## Numbers (webpack build, gzip, same machine)

| | Before (main 50ff790b) | After |
|---|---|---|
| `npm run check`: tsc | 13 s | 13 s |
| `npm run check`: eslint | 18.5 s | 28 s (type-aware rules read the program) |
| `npm run check`: vitest | 37 s (290 files) | 33 s (291 files; the ratchet test lints `src` inside it, about 20 s, in parallel) |
| `npm run check`: whole | about 69 s (stages added up) | 63 s measured |
| eslint warnings | 153 | 192 (29 jsx-a11y and 10 `await-thenable`, all counted by the ratchet) |
| Client JS, all chunks | 945.8 kB | 886.1 kB |
| `/[lang]/admin/skills` own JS | 83.7 kB | 21.8 kB |
| `/[lang]/app/todo` own JS | 43.8 kB | 42.4 kB |
| Runtime shared by every page | 128.9 kB | 128.3 kB |

## Not pinned

- The point-by-point accessibility of the 29 remaining jsx-a11y warnings (modal backdrops, autofocus in dialogs and sign-in forms, two media tags without captions). They are counted, not judged.
- Nothing measures a browser: the numbers are bytes of the build output, not a Lighthouse run.
