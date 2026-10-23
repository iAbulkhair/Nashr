---
name: add-a-workspace-scoped-feature
description: Use when a new feature stores or reads data per workspace (brand), per account, or per person, so tenant isolation holds. The core of every Thakeen change.
---

# Add a workspace-scoped feature

Thakeen is multi-tenant by key naming, not by a database column. A record belongs to a tenant only because its Redis key carries the caller's scope. Read `CLAUDE.md` "Tenant isolation", `docs/system/permissions.md` section 3 and `docs/system/architecture.md` section 3 first.

## Pick the level of the record

| Level | Meaning | Key builder in `src/lib/keys.ts` | Taken from |
|---|---|---|---|
| Workspace (a brand) | tasks, files, conversations, brand, connections, plans | `wsKey.*` takes a `Scope` | `sc(u)` |
| Account | billing, team, credits, notification digest | `accountKey.*` | `acct(u)` |
| Login or person | sessions, passkeys, per-person choices | `accountKey` (login), `personKey` | the session only |
| Global | tokens, indexes, rate buckets | `globalKey.*` | a random token or nothing |

A `Scope` is a branded string only `sc(u)` (`src/lib/auth.ts`), `workspaceScope` or `storedScope` can make. A raw string from a request does not type-check, and that is the point.

## Steps

1. Add the key builder to the right group in `src/lib/keys.ts` with a one-line doc comment (type, owner, TTL). Never write a raw template such as `` `thing:${x}` `` elsewhere: `tests/key-registry-ratchet.test.ts` counts them and the count only goes down.
2. Write the access functions in a new `src/lib/<feature>.ts`. They take `scope: Scope` (or `AccountId`) as the first argument, never an email or id string. A record that two requests can change is written through a lock key and a read-modify-write function (see `updateTask` in `src/lib/brand.ts` and its `taskLock` key).
3. The route uses `handler({ auth: "user", ... })` (add-an-api-route) and passes `scope` from the context into the library. The brand in the URL or `x-thakeen-brand` header (`BRAND_HEADER` in `src/lib/brand-path.ts`) is only a selector among the account's own active brands, checked by `resolveSession`. A workspace handle (`x-thakeen-ws`, `w/{handle}` in the path) is also only a selector, never an id.
4. A page under the brand goes in `src/app/[lang]/app/b/[brand]/<section>/page.tsx` and its section name is added to `BRAND_SECTIONS` in `src/lib/brand-path.ts`; build links with `appHref` so the workspace and brand segments survive. The page reads `currentUser()` and `sc(u)` on the server and redirects to login when there is no user.
5. Role: pick or add the action in `MIN_ROLE` (`src/lib/roles.ts`) and call `forbid(u, action)` or `can(u, action)`. Members may read what the owner allows; destructive or money actions are owner-only.
6. Deletion and export: add the new key family to `wipeAccount` in `src/lib/account.ts` (account deletion must leave nothing) and, if the owner should get it back, to the export in `src/lib/privacy-export.ts`. A loop over scopes uses `pmap`, never `await db.*` in a `for`.
7. Docs in the same commit: the key row in `docs/system/architecture.md` section 3, the permission row in `docs/system/permissions.md`, the flow in `docs/system/flows.md`.
8. Tests (write-a-unit-test): the happy path, then a second account that tries every door to the first one's record and must get the same answer as for a missing id (404). Model it on `tests/routes-isolation.test.ts` and `e2e/tenant-isolation.spec.ts`.

## Checks

`npx vitest run tests/key-registry-ratchet.test.ts tests/routes-isolation.test.ts tests/<your>.test.ts`, then `npm run check`.

## Traps

- `storedScope` and `storedAccountId` on a value from the request. They are for values read back from our own records, and none may be called under `src/app`.
- A cron that loops over every account: read the index of scopes from our records, never from a request, and batch with `pmap`.
- A new field on a stored record is a stored-shape change (change-a-stored-shape): two releases, expand then contract.
- Forgetting the legacy and the opaque account shape: an account id may be the owner's address or an `a_` id, and a scope is `email` or `email#brandId`. Do not parse a scope by hand; use the helpers in `src/lib/brands.ts` and `src/lib/account-id.ts`.
- The multi-workspace switch (`MULTI_ORG`, `src/lib/multi-org.ts`) changes who may reach which account. Test your route with `TEST_PERSONS=legacy` too (see `tests/helpers/session.ts`), as CI runs both shapes on a ready PR.
