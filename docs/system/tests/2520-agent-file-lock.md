# Coverage: every writer of a workspace file takes its lock (rules 2520-2522)

Status on 2026-10-20 on branch `claude/agent-file-lock`. Closes the gap flows section 95 item 4 named (OpenDots adoption item 1, `docs/system/tests/2440-stale-writes.md`): an agent's or an import's write landing between a person's checked save's read and its write was overwritten without a word. Rules 2523-2529 are held for this work and unused.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2520 | Every `writeFile` takes `filelock:{scope}:{name}`; `writeFileChecked` holds it and writes with `locked: true`, so a person's save from the version they opened and an agent's write at the same moment end either with the person's text in the file and the agent's in the `-imported` sibling, or with `stale` and the agent's text in the file | `tests/stale-writes.test.ts` ("rule 2520": a writer waits for a held lock; 12 concurrent runs) | — |
| 2521 | A writer that is not a checked save waits up to 2 s for the lock, then writes anyway (a lock left by a killed request never fails an import or an agent's write) | `tests/stale-writes.test.ts` ("rule 2521") | — |
| 2522 | An agent's write redirected to the sibling of a person's file takes the sibling's lock too, inside the first (shorter name first: no wait cycle) | `tests/stale-writes.test.ts` ("rule 2522") | — |

## Notes

- All four new tests fail on the code before this change, the concurrent one included, where the agent's text was lost.
- Cost: two more store commands per file write (lock, unlock). The writers are imports, syncs and single agent or person writes, none in a tight loop.
- No stored shape, route, permission or environment variable changes; `filelock:` already existed (rule 2441).
