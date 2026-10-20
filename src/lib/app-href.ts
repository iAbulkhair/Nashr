import { MULTI_ORG } from "./multi-org";
import { accountOfScope } from "./account-id";
import { handleOf, wsHandle } from "./ws-handle";
import { appHref } from "./ws-path";

/**
 * App links made on the server (multi-workspace M2, docs/specs/2026-10-18-multi-org.md section 7 "Links"; rule 2113,
 * link half). Client components use `useAppHref(lang)` (src/components/app/WorkspaceContext.tsx), pages `pageHref`
 * (src/lib/page-href.ts, the only one that reads the request); pure helpers take a builder. This file reads no request. With `MULTI_ORG` off both give today's `/{lang}/app{path}`; tests/multi-org-links-scan.test.ts keeps raw app
 * links out of the code.
 */

/** A link into account `u`'s workspace: notifications, mails, a route's answer. `u` is the caller's own loaded account. */
export function appHrefFor(u: { id?: string; email: string }, lang: string, path: string = ""): string {
  return appHref(lang, path, MULTI_ORG ? handleOf(u) : null);
}

/**
 * The same from a scope or an account id read from our own records (a cron, a reminder, a job): the account a scope
 * belongs to (`accountOfScope`). Never pass an id taken from the request.
 */
export function appHrefIn(scopeOrAid: string, lang: string, path: string = ""): string {
  return appHref(lang, path, MULTI_ORG ? wsHandle(accountOfScope(scopeOrAid)) : null);
}
