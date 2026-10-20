# Coverage: edits from an older view (rules 2440-2449)

Status on 2026-10-20 on branch `claude/lucid-faraday-kq261a`. Item 1 of the OpenDots adoption order (`docs/OpenDots_Adoption.md`); flows in `docs/system/flows.md` section 94. Rules 2442-2449 are held for this work and unused.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2440 | A text edit to `PATCH /api/tasks/{id}` that sends `version` is saved only while it is the item's current version (under the task lock); otherwise 409 `changed` with the stored task and nothing saved; an edit without `version` is saved as before | `tests/stale-writes.test.ts` ("rule 2440") | — |
| 2441 | `PUT /api/files` with `baseAt` writes only while the file's `updatedAt` equals it (null: only while no file has the name), under `filelock:`; otherwise 409 `stale` or `exists` with the file as it is now (null when deleted); without `baseAt` as before. The Files page sends it and keeps the typed text on a conflict | `tests/stale-writes.test.ts` ("rule 2441") (server); the page's conflict box is not tested | a render test of `FilesPanel` after a 409 `stale` |
