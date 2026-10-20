# Coverage: the brand id in app URLs (rules 885-899)

Status on 2026-10-20 on branch `claude/brand-parts-bc-29277a`: built from `docs/superpowers/plans/2026-10-20-brand-url.md` (spec: `docs/superpowers/specs/2026-10-09-admin-shell-and-brand-workspaces-design.md` Part C). Task 1 adds the pure helpers only (rules 889-890); Task 2 the brand selector in `resolveSession` (rule 886); later tasks add rows here as they land. No page, route or link sends the header yet (the proxy and `api()` callers come in Tasks 3 and 5).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 885 | Reserved for the brand guard (proxy) (later task) | — | — |
| 886 | `currentUser()` and `currentUserUnverified()` take `x-thakeen-brand` only as a selector among the session account's own active brands (an impersonation: the impersonated account's); "default" always resolves; archived, unknown, another account's, malformed (before any read) or an unreadable brand list is Next's 404; the stored choice is neither used nor written; an R1 session pays no extra round, a pre-R1 owner one (R-C7); `currentPerson()` ignores it | `tests/brand-url-session.test.ts` ("rule 886: the brand header is a selector…", "rule 886 with rule 2135…"), both `TEST_PERSONS` modes | — |
| 887-888 | Reserved for the `/b/{id}` pages and the redirect of the legacy paths (later tasks) | — | — |
| 889 | `api()` in the browser sets `x-thakeen-brand` from the `/b/{id}` segment of the page, keeps a header the caller set, sends none off a brand page, and accepts only same-origin `/api/` paths | `tests/brand-url-href.test.ts` ("rule 889: api() carries the page's brand") | — |
| 890 | `appHref`, `brandFromPath`, `isBrandPath` and `switchBrandPath` (`src/lib/app-href.ts`) build and read `/{lang}/app/b/{id}/…`; a brand section gets the prefix only with a valid brand id; the id shape is `BRAND_ID_RE`, shared with the stored `ActiveBrandId` schema | `tests/brand-url-href.test.ts` ("rule 890: brand paths and appHref") | — |
