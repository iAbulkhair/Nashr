import type { User } from "./auth";
import { PRIVACY_VERSION, TERMS_VERSION } from "./legal";

/**
 * What an owner agreed to at signup (rules 1325-1326): the terms and privacy versions on the page (each document's own
 * "last updated" day in src/lib/legal.ts), when, in which language, and how. `via: "signup_notice"` is the line under
 * the signup form ("By continuing you agree to the Terms and Privacy Policy"); the form has no separate checkbox, and
 * whether it needs one waits for the lawyer.
 *
 * Expand only (rule 679): `User.consent` is optional. Accounts created before 2026-10-12 have no record, and every reader
 * goes through `consentOf`, which answers `{ recorded: false }` for them instead of inventing a date. Older code that
 * reads a user with the field ignores it, and `saveUser` writes it back untouched (it spreads the whole record).
 */
export type Consent = { terms: string; privacy: string; at: string; lang: "ar" | "en"; via: "signup_notice" };

/** The record a new account gets, built from the versions in code: nothing in it comes from the request. */
export function signupConsent(lang: "ar" | "en", now = new Date()): Consent {
  return { terms: TERMS_VERSION, privacy: PRIVACY_VERSION, at: now.toISOString(), lang, via: "signup_notice" };
}

export type ConsentView = ({ recorded: true } & Consent) | { recorded: false; note: string };

const isConsent = (c: unknown): c is Consent => {
  const r = c as Partial<Consent> | null | undefined;
  return !!r && typeof r.terms === "string" && typeof r.privacy === "string" && typeof r.at === "string";
};

/**
 * The one reader of `User.consent`, old shape and new. An account without a well-formed record (created before the
 * record existed) reads as not recorded, with a fixed note; the account's own creation date is never passed off as a
 * consent date.
 */
export function consentOf(u: Pick<User, "consent">): ConsentView {
  const c = u.consent;
  if (!isConsent(c)) return { recorded: false, note: "No consent record: the account was created before consent was recorded at signup (2026-10-12)." };
  return { recorded: true, terms: c.terms, privacy: c.privacy, at: c.at, lang: c.lang === "en" ? "en" : "ar", via: "signup_notice" };
}
