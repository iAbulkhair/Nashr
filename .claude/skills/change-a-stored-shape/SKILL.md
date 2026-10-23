---
name: change-a-stored-shape
description: Use when changing the shape of anything stored in Redis (a field, a key, a value type); two releases, expand then contract, with an idempotent script for old data.
---

# Change a stored shape

Redis has no schema, so the schema is the code that reads and writes it. Production holds old data while new code runs. The rule (CLAUDE.md, rule 679, `docs/system/flows.md` "Releases") is two releases:

- Expand: the new code reads the old and the new shape and writes the new one. Old code still reads it or ignores it safely.
- Contract: a later release removes the old reading.

The release PR names the step. A one-time conversion is an idempotent script run after the expand release is live, never at build time.

## Steps

1. List every reader and writer of the record: `grep -rn` the key builder name in `src/lib/keys.ts`, then follow callers. Include crons (`crons.json`), admin panels, `src/lib/privacy-export.ts` and `wipeAccount` in `src/lib/account.ts`.
2. Keys live only in `src/lib/keys.ts` (`wsKey`, `accountKey`, `personKey`, `globalKey`). A new key builder goes there with a doc comment. `tests/key-registry-ratchet.test.ts` caps raw key templates; the count only goes down.
3. Validate on read. `src/lib/stored.ts` has `parseStored` and zod shapes for the main records; add or extend a shape instead of trusting `JSON.parse`. A bad record is skipped or defaulted, never thrown into a page.
4. Expand: add the field as optional, read it with a default derived from the old data, write the new shape on every update. Example of the pattern: `src/lib/notify-prefs.ts` (`{emails, notify?}` read through `readPrefs`). Do not rename a key in the same release; write both for one release if a key must move.
5. Read-modify-write on a record two requests can change goes through a lock (`updateTask` and `taskLock` in `src/lib/brand.ts`). A shape change must not widen a race.
6. Bulk conversion: write an idempotent script under `scripts/`, run with `npx --no-install jiti scripts/<name>.ts` (dry run by default, `--apply` to write). Model it on `scripts/account-ids.ts`. It must be safe to run twice, reads the index of scopes from our own records, and batches with `pmap` from `src/lib/parallel.ts` (never `await db.*` in a loop). The founder says when to run it on live data; the order is dry run, review, then `--apply`.
7. Contract release: only after the script ran everywhere and the expand release has been live for at least one full cycle. Remove the old read, and delete the old keys with a second idempotent script if needed.
8. Account deletion and export: new key families go into `wipeAccount` and `src/lib/privacy-export.ts` in the same release as the write.
9. Docs: key table in `docs/system/architecture.md` section 3, the "Releases" line in the flow, and the release PR description field "stored-shape step: expand or contract" (release-and-env-vars).
10. Tests (write-a-unit-test): a record in the old shape is read correctly; a new write is read by the old reader (simulate by ignoring the new field); the script run twice gives the same result; a second account's data is untouched.

## Checks

`npx vitest run tests/key-registry-ratchet.test.ts` plus your tests, then `npm run check` and `npx next build`.

## Traps

- Doing expand and contract in one release. A rollback then breaks live data (`docs/release/rollback.md`).
- Running a conversion at build or start. It runs once, by hand, after the expand release.
- Parsing a scope string by hand. Use the helpers in `src/lib/brands.ts` and `src/lib/account-id.ts`.
- Deleting old keys in the expand release because the new ones look fine.
