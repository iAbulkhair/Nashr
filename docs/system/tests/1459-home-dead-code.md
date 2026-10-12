# Homepage: the unmounted start form and the CSS only it and the deleted game used are gone (rule 1459)

Status on 2026-10-12 on branch `claude/home-startform-cleanup` (draft PR, based on draft PR #339 because that one deleted `Dictionary.tsx`, the only importer of `StartForm.tsx`; if #339 is merged first this branch rebases onto `main` with no change). Rule 1459 is the first rule of this change; 1460-1469 of the block 1450-1469 stay free. No behaviour of the product changes: the homepage mounts the same six sections, and the app's first-login game (`src/components/app/DictionaryStart.tsx`, `src/lib/dictionary.ts`) is untouched.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1459 | `src/components/home/StartForm.tsx` does not exist (no component, test or script imports it; the public start form is `UrlStart`), and `home.module.css` holds no rule for the classes only it and the deleted `Dictionary.tsx` used (`.start*`, `.dict*`, the step rail, the sector and word pickers, the speech bubble and its `dictPop` keyframes, the samples, the approve box, the previews); `.face`, which `DictionaryStart.tsx` reads as `cast.face`, is still defined | `tests/home-order.test.ts` ("rule 1459"; the file list of "mounts neither the dictionary game nor the old story and truths" now names `StartForm` too) | — |

## Notes

- Removed from `src/components/home/home.module.css`: the start-form block (`.start`, `.startInput`, `.startButton` and their states) and the whole game block from the `قاموس ذكين` comment up to the Prototype D comment, 384 lines in all, except the `.face` circle and its `.doodle` rules.
- Rule 516's row in `docs/system/tests.md` and the homepage paragraph of `docs/system/architecture.md` said `StartForm.tsx` stays, unmounted; both now say it was deleted. The comment in `e2e/auth-flows.spec.ts` named it as a second example of the public start form; it now names only `UrlStart`.
- The plans and specs under `docs/superpowers/` still name `StartForm`: they are dated records of earlier designs and were not edited.

## Not pinned

- That every class left in `home.module.css` is read by some component is not checked by a test; only the removed names are pinned absent. A later sweep can add a "no unreferenced class" check, with the dynamic `fl-<kind>` and `s-<kind>` names listed as exceptions.
