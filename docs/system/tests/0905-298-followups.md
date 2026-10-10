# Coverage: follow-ups of the model routing PR #298 (rules 905-908)

Status on 2026-10-10 on branch `claude/298-followups` (from main after #298, #310 and #311): rules 905 and 906 written; the other numbers of the block are claimed by the later commits of the same branch and named in the table as they are written. Rule 904 is open PR #313's.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 905 | `wipeAccount` deletes every conversation of every brand through `deleteConversation`, under the conversation's lock `convlock:{scope}:{id}`, before any third-party grant is revoked and before the account's other keys. A turn's `touchConversation`, a rename or a pick that had read the record before the wipe and writes after it leaves no record, no index entry and no live thread; every id of the index is locked and deleted, past the newest 100, and its lock is released; a lock not taken within its bound throws and the account record, the conversation and the rest are kept, and a retry once the lock is free finishes the wipe | `tests/model-override.test.ts` ("account wipe takes each conversation's lock", a scripted `db.get` hold, 102 conversations, a held lock and fake timers) | — |
| 906 | `PUT /api/models` answers a lock that is not taken in time the same way for both targets: 503 `{ error: "busy" }` with `Retry-After: 1` and nothing written, for the conversation's lock `convlock:` and the brand's `brandlock:`. A brand pick answered 409 `busy` before, the only 409 on the route that meant "try again". The client maps 503 and a 409 `busy` (an older server) to the same "busy" answer | `tests/model-override.test.ts` (a held brand lock and a held conversation lock, fake timers, the brand record unchanged), `tests/model-picker-copy.test.ts` (`pickRefusal` and `sendPick` for 503 and 409 `busy`) | — |

## Notes

- Rule 905 changes the account wipe from "deletes the conversation keys" to "deletes them under the writer lock": the key list in `account.ts` still names `conv:`, `chat:` and `convlock:` for an id `deleteConversation` refuses (a malformed one) and for a lock a dead writer left (10 s TTL).
- The route answers 500 when a conversation cannot be locked (`DELETE /api/account` and the console's `delete` do not catch the throw, as they do not for a failed link revocation); the profile page shows its generic failure and the owner presses again.

## Not pinned

- A conversation created by a request that started before the wipe and writes its record after the wipe read the index (`createConversation` is not under the lock) can leave a record and an index entry. The request must have passed `currentUser()` before the account record was deleted; not scheduled.
