import { db } from "./db";

/**
 * Which site a workspace is built from is the owner's choice, made on the start page and checked here in code.
 *
 * A link (`/app/signup?url=`, `/app/chat?onboard=`) only pre-fills the start page: it never starts a crawl or a model
 * call. The owner presses the button, `POST /api/onboard/confirm` records the URL under their own scope, and
 * `POST /api/onboard` refuses any other URL and clears the record once the brand is saved: one confirmation, one build.
 */
const key = (scope: string) => `onboardok:${scope}`;
/** A day, the window of the three-runs allowance, so "refresh to try again" after a failed or paused run still works. */
const TTL = 86400;

/** The one form of a site URL that the start page, the chat page and both onboarding routes compare. */
export const onboardUrl = (raw: unknown) => (typeof raw === "string" ? raw.trim().slice(0, 300) : "");
export const confirmOnboard = (scope: string, url: string) => db.set(key(scope), url, TTL);
export const confirmedOnboard = async (scope: string) => (await db.get<string>(key(scope))) ?? "";
export const clearOnboard = (scope: string) => db.del(key(scope));
