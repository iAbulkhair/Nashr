# Coverage: the brand id in app URLs (rules 885-899)

Status on 2026-10-20 on branch `claude/brand-parts-bc-29277a`: built from `docs/superpowers/plans/2026-10-20-brand-url.md` (spec: `docs/superpowers/specs/2026-10-09-admin-shell-and-brand-workspaces-design.md` Part C). Task 1 adds the pure helpers only (rules 889-890); later tasks add rows here as they land. Nothing is wired yet: no page, route or link uses the helpers.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 885-888 | Reserved for the brand guard (proxy), the `/b/{id}` pages and the redirect of the legacy paths (later tasks) | — | — |
| 889 | `api()` in the browser sets `x-thakeen-brand` from the `/b/{id}` segment of the page, keeps a header the caller set, sends none off a brand page, and accepts only same-origin `/api/` paths | `tests/brand-url-href.test.ts` ("rule 889: api() carries the page's brand") | — |
| 890 | `appHref`, `brandFromPath`, `isBrandPath` and `switchBrandPath` (`src/lib/app-href.ts`) build and read `/{lang}/app/b/{id}/…`; a brand section gets the prefix only with a valid brand id; the id shape is `BRAND_ID_RE`, shared with the stored `ActiveBrandId` schema | `tests/brand-url-href.test.ts` ("rule 890: brand paths and appHref") | — |
