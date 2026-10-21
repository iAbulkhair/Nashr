# Plan: account id R2, built behind `OPAQUE_IDS` (2026-10-21)

Spec: `docs/specs/2026-10-17-account-id.md` (section 6, decisions D1-D5, "R2 enable" row, "Left for R2" list), with
`docs/specs/2026-10-18-multi-org.md` decision 11 (R2 turns on together with M2). Branch `claude/wave3a-account-id-r2`
from main fe37b1d5. Founder instruction (2026-10-21): "dont wait 26 Oct, build them all in parallel with subagents".

This branch is the **expand** step only. `OPAQUE_IDS` stays `false` and `MULTI_ORG` stays `false`: production behaviour
does not change. Every new path runs only when `OPAQUE_IDS` is true; tests force it on with
`vi.mock("@/lib/account-id", ...)`. The one-line flip is a separate PR made later by the controller.

Rule 1985's widened scans were checked clean first (49/49 in `tests/account-id-r1.test.ts`).

## Tasks

1. **createUser honours the constant, and L3** (`src/lib/auth.ts`, `src/lib/team.ts`, `src/lib/verify-email.ts`).
   A new account's id is opaque when `OPAQUE_IDS` is on (today only `opaque` or M2 make one). L3: an address whose
   `user:{e}`, `person:{e}` or `member:{e}` still holds a record (the old key of an account that moved in place) never
   gets an address-derived id: `createUser` makes an opaque id, a legacy invite accept refuses `unavailable`, the member
   move and the R1 owner copy refuse `exists`. Rule 2740.
2. **The move in place** (new `src/lib/email-move.ts`, used by `src/lib/email-change.ts` and `moveUnverifiedAccount`).
   Under both `lock:login` (alphabetical), `lock:person:{pid}` (60 s) and then each owned account's `lock:user`: re-check
   the gate and the 3-a-day limit, claim `login:{to}`, write every owned account (`email`, fresh `sessionsAfter`,
   `emailMoves`, proof), then the person row, carry the per-login state (two-step, Google link, `activebrand:{login}`,
   the legacy feed and booking pointers with their records' `login`, the calendar link's `login`), drop the target's
   leftovers and the old login's state, release `login:{old}`. No copy, no wipe, no change to the id, `users:all`,
   scopes, referral or partner keys. Owners (legacy, opaque) and `p_` persons move this way; a legacy member record
   keeps R1's copy (`moveMemberLogin`, spec: "Members unchanged"). A partner's address is refused (`partner`: the
   programme is keyed by the address; support moves it). Rules 2741, 2742.
3. **`ownerHasData`**: applies only while `OPAQUE_IDS` is off (the R1 copy would lose data). Not deleted in this branch:
   deleting it while the constant is off would let the copy path wipe work. It and its copy go in the contract release
   after the flip. Rule 2746.
4. **D1 hold and revert** (`src/lib/email-hold.ts`, `POST /api/auth/email-revert`, `ResetForm`). A proved move writes
   `emailhold:{old}` (30 days) and a single-use revert token `emailrevert:{sha256}` (7 days) mailed to the old address.
   The hold refuses the address to signup, Google sign-up, invite acceptance and address-change targets of anyone else
   while the person exists. The revert moves the person back in place, ends every session, sets a random password and
   hands back a one-hour reset token, drops two-step, passkeys and the Google link added after the move, and stamps
   `emailreverted:{pid}` so a token of a later move is dead. The typo fix writes no hold. IP rate limit on the route.
   Rules 2743, 2744.
5. **D2**: with `OPAQUE_IDS` on, starting an address change on a login with two-step on needs its code
   (`mfa_required`, `checkMfaCode`); the settings card asks for it. Rule 2745.
6. **Left for R2**: L2 (`claimIfAbsent` re-checks under the lock), the script treats a moved or opaque account as
   indexed, not a conflict; L4 (`signsIn` on the console's user rows); `listPartners` and `partnerDashboard` read
   accounts through `getAccount`/`accountByLogin`; referral rows carry `id` (and `email` for older builds); the wishlist
   keys by `acct(u)` and `wipeAccount` forgets by id and by address. Rules 2747, 2748.
7. **Both flags together**: a test with `OPAQUE_IDS` and `MULTI_ORG` mocked on: a signup makes a `p_` person and an `a_`
   account, the person moves in place, signs in at the new address, the old one signs nothing in. Rule 2749.
8. **Docs**: flows.md 88.2, architecture.md (keys `emailhold:`, `emailrevert:`, `emailreverted:`; the move), permissions.md
   (the revert route), `docs/system/tests/1980-account-id-r1.md` rows, new `docs/system/tests/2740-account-id-r2.md`.

## Files

`src/lib/{auth,email-move,email-hold,email-change,verify-email,team,google-signin,keys,partners,referral,wishlist,account}.ts`,
`src/app/api/auth/email-revert/route.ts`, `src/app/api/account/email/route.ts`, `src/app/api/auth/signup/route.ts`,
`src/app/api/admin/plan/route.ts`, `src/components/app/AuthForm.tsx`, `src/components/app/settings/EmailChange.tsx`,
`src/components/admin/Users.tsx`, `scripts/account-ids.ts`, `tests/account-id-r2.test.ts`.

## Rules pinned

1981, 1987-1990, 1992, 1993, 1996-1999 (account-id, R2 half), 2112/2117/2132 where the move touches persons, and the new
2740-2749.

## Release step

Expand (rule 679), constant off. Rollback floor unchanged: nothing this branch writes while `OPAQUE_IDS` is off is new
(the only always-on changes are read-side: referral rows gain an `id` field older builds ignore, the wishlist key is the
same bytes for every account that exists, the console rows gain `signsIn`).

The later flip PR carries "rollback floor: R1" and "rollback floor: M1". Preconditions for the flip (not for merging
this branch): R1 live 7 days (on or after 2026-10-26), `scripts/account-ids.ts` reports 0 conflicts, and the Paymob or
Geidea saved-card check of spec section 7 passes on staging.

## Rollback

Revert this branch: nothing to clean, because nothing new is written while the constant is off. After the flip, a
rollback below this release is unsafe for a moved account (an R1 build has no L3 guard and would write `user:{old}`);
the flip PR's floor is therefore this release, not R1, for any account that moved (recorded in the report).
