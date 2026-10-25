# Coverage: disconnecting a Composio connection the platform cannot revoke (rules 4270-4272)

Status on 2026-10-25 on branch `claude/composio-revoke-unsupported` (cut from main 13317b8b). Founder report: pressing "Disconnect" on an expired Meta (Facebook Page + Instagram) connection answered "We could not disconnect the account at the platform". Flow in `flows.md` section 11, item 4. Release step: **expand** (no stored shape changes).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 4270 | `composioRevoke` treats `CONNECTED_ACCOUNT_REVOCATION_NOT_SUPPORTED` and `CONNECTED_ACCOUNT_NOT_REVOKABLE` (by error code, class name or message) as "nothing to revoke" and still deletes the account at Composio; every other revoke error (network, 5xx) still rejects so rule 651 keeps the record | yes | `tests/composio.test.ts` ("disconnecting (rule 651)", rule 4270 cases) |
| 4271 | After such a disconnect the stored connection is removed and the account is in `calls.deleted` | yes | same |
| 4272 | A delete failure after an unsupported revoke still returns 502 `revoke_failed` and keeps the record | yes | same |
