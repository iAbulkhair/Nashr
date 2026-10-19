# Coverage: account id separate from the sign-in address, release R1 (rules 1980-1999)

Status on 2026-10-18 on branch `claude/wave3-account-id-r1` (cut from `claude/wave3-multi-org-spec-21c990` 3bb2d3a9, with origin/main 39fd014a merged in). This is the **expand** step (rule 679) of `docs/specs/2026-10-17-account-id.md`, with the nine changes `docs/specs/2026-10-18-multi-org.md` forces on it: the login index names a person (`{kind:"person", pid}`), members get frozen ids, and the session's `acct` is the active workspace. See `flows.md` section 88, `architecture.md` sections 3 and 4(f), `permissions.md` sections 0 and 3.1.

In R1 every account's id equals its first address (`OPAQUE_IDS = false`), so production keys and bytes are unchanged; the new fields (`User.id`, `Member.id`, `login:*`, session `pid`/`acct`, intent `acct`/`billingEmail`, txn `acct`) are ignored by older builds. Tests that need an opaque id opt in (`newOpaqueUser` in `tests/helpers/session.ts`, `createUser(input, { opaque: true })`).

Rules 1987-1990, 1992, 1993, 1997 and 1998 belong to release R2 (the owner move in place, opaque ids on, the old-address hold) and are not built here.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1980 | An account's key is its id: `acct(u) = u.id ?? u.email`. `getAccount(id)` trusts the key it read (a stored id that differs is replaced in memory and logged). An opaque id is `a_` plus 24 base32 characters from `crypto`. No route reads an account with an id from params, a body or a query | `tests/account-id-r1.test.ts` (rule 1980, five tests) | none |
| 1981 | With no index, `getLogin(e)` accepts `user:{e}` only when its `email` is `e` and its id is unset or `e`; with an index, only the account the index names and only while that account's `email` is still `e`. A record holding another address resolves at neither address, and its old sessions end | `tests/account-id-r1.test.ts` (rule 1981, four tests) | Forgot-password on a moved address sends nothing (an end-to-end test through `/api/auth/forgot`) |
| 1982 | Pointers (`memberOf`, the session's `acct`, `users:all`) resolve through `getAccount`; sign-in addresses (signup, invite acceptance, email change, the founder console's user page) through `getLogin`. `getUser` is an alias of `getAccount` | `tests/account-id-r1.test.ts` (rule 1982, source scans; the founder console's seven address routes use `accountByLogin`, and a member's address resolves to no account) | Pin MCP tokens, OAuth codes and feed/booking records by a test through each route, not a scan |
| 1983 | `login:{e}` is written by `claimLogin` under `lock:login:{e}`, after the resolver found nothing (a plain `SET` under the lock: `db.setNx` needs a TTL and the lock already serialises). Two parallel signups give one account and one index; an index a rolled-back build left without an account is replaced. Members get `id` and their own index on creation | `tests/account-id-r1.test.ts` (rule 1983, three tests) | none |
| 1984 | `createSession` writes `pid` (the person) and `acct` (the active workspace: the owner's own account, or a member's team). A session resolves only while `login:{email}` still names its `pid` and its `acct` is the login's workspace. A pre-R1 session (`{email, at}`) of a legacy account reads one account key, as before | `tests/account-id-r1.test.ts` (rule 1984, four tests) | Count Redis rounds, not keys, for the pre-R1 session |
| 1985 | Account keys come from `acct(u)`, never `u.email`: an opaque account is charged on `user:{id}`, the daily roster scopes it by its id, and source scans find no key template or account function fed `u.email`/`user.email`/`owner.email` outside the per-address rate buckets. Deviation from the spec: test accounts are opaque where a test asks for it, not everywhere (switching every fixture is R2 work, when `OPAQUE_IDS` turns on) | `tests/account-id-r1.test.ts` (rule 1985, seven tests, scans widened after the security review: MCP and OAuth slots, grants, billing, notifications, seats, roster, chat counters, referral codes, `memberOf` checks, `afterSignup`'s lock; plus an opaque owner's MCP token and chat counter end to end); `tests/paymob.test.ts` (rule 1991 block) | Run the whole suite once with `OPAQUE_IDS` forced on |
| 1986 | `accountOfScope` and `brandOfScope` in `src/lib/account-id.ts` are the only scope parsers; no other file splits a scope at `#` | `tests/account-id-r1.test.ts` (rule 1986, two tests) | none |
| 1987 | R2: round trip of an owner move in place | not built (R2) | the spec's round-trip test |
| 1988 | R2: a stopped and retried move ends in one account and one login | not built (R2) | the spec's crash-point test |
| 1989 | R2: after a move, the old address signs nothing in | not built (R2) | the spec's test |
| 1990 | R2: two-step, active brand, feed and booking follow the login | not built (R2) | the spec's test |
| 1991 | A Paymob intent stores the account (`acct`, and `email` for older builds) and the address sent to Paymob (`billingEmail`); the callback's email check uses `billingEmail`, the plan and card land on `user:{acct}`. An intent from before R1 still applies | `tests/paymob.test.ts` (rule 1991, two tests) | R2: a renewal after a move sends the new address and charges the same card |
| 1992 | R2: `composioUserId` unchanged by a move | not built (R2) | the spec's test |
| 1993 | R2: crons key by id, mail goes to the new address | partly: `dailyRoster` reads by id (rule 1985 test) | the spec's test after a move |
| 1994 | `scripts/account-ids.ts` (run through jiti; the spec named `.mjs`, `.ts` lets the test import it) is a dry run by default and writes only with `--apply`; it sets missing owner and member ids and missing indexes under their locks, counts an index naming someone else or a record whose address is not its key as a conflict and a roster entry without its member record as an orphan, never overwrites, prints counts only, and awaits no db call in a loop. A second run writes nothing | `tests/account-id-r1.test.ts` (rule 1994, three tests; a member whose stored id is not its address is a conflict with no index, security review M1) | none |
| 1995 | R1 writes only shapes older builds ignore. `LoginIndex` (zod, read through `parseStored`) accepts `{kind:"person", pid}` and the account-id spec's first `{kind:"owner", id}`; anything else is logged and read as no index. `GET /api/profile` sends only the fields it names, never `id` | `tests/account-id-r1.test.ts` (rule 1995, two tests); `tests/profile-allowlist.test.ts` | none |
| 1996 | `OPAQUE_IDS` is a code constant, `false`, not an environment variable; a new account's id is its address. An owner move with data stays refused (`ownerHasData`) | `tests/account-id-r1.test.ts` (rule 1996, two tests) | R2: with it on, signup writes `a_…` |
| 1997 | R2: the old-address hold and revert link | not built (R2) | the spec's test |
| 1998 | R2: an address change with two-step on needs a code | not built (R2) | the spec's test |
| 1999 | `wipeAccount(id)` takes the account id, deletes `user:{id}`, the `users:all` entry, the owner's and every member's login index (only where it names that person), the per-brand `profile:` keys, and writes `{id, email}` to the deletion list. An index naming someone else stays; a signup at the address afterwards is a fresh account | `tests/account-id-r1.test.ts` (rule 1999, four tests); `tests/account-security-wipe.test.ts` | none |

## Security review fixes (2026-10-18)

Founder-approved before the PR is marked ready; tests in the `security review of R1 (M1, M2, L1)` block of `tests/account-id-r1.test.ts` (eight tests) and the widened rule 1985 scans.

| Finding | Fix | Test |
|---|---|---|
| M1: a stored member id that is not its address could name another person | `getMember`/`memberPid` use the address while `OPAQUE_IDS` is off (logged, no address in the log); the script counts it as a conflict; signup checks `getMember` under the login lock | three behaviour tests |
| M2: account data keyed by the address | `acct(u)` at every site the review and the widened scan found (flows.md section 88 item 9); the address routes of the founder console resolve with `accountByLogin` | scans, an opaque owner's MCP token and chat counter, `accountByLogin` |
| L1: `releaseLogin` checked and deleted without the login lock | re-read and delete under `lock:login:{e}`; callers holding it pass `locked`/`loginLocked` | an index claimed while the release waits survives; source scan of the callers |

Not fixed (R2 or harmless, listed in the spec's "Applied in R1"): L2, L3, L4, `listPartners` reading `user:` by the referral set's value, referral rows' `email` field, `forgetWishlistUser(address)`.

## Release step

R1 = **expand**. Old code reads every new shape safely (it ignores `id`, `login:*`, `pid`, `acct`, `billingEmail`). The conversion script runs only after R1 is live and only on the founder's yes, dry run first. R2 (contract: opaque ids on, owner move in place, the legacy fallback goes) needs R1 live for 7 days, a script run with 0 conflicts and 0 orphans, the rule 1985 scans clean, and a Paymob check on staging.
