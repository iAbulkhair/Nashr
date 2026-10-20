import { randomBytes } from "crypto";
import { base32lower } from "./account-id";

/**
 * Multi-workspace membership (docs/specs/2026-10-18-multi-org.md, release M1 "expand", rules 2110-2139).
 *
 * Imports only `crypto` and src/lib/account-id.ts (itself import-free apart from `crypto` and `zod`), so every module
 * can read the switch without a cycle.
 */

/**
 * The release switch, a code constant and not an environment variable (as `OPAQUE_IDS`, src/lib/account-id.ts): a
 * variable change needs a rebuild anyway. Off through M1: an invite to an address that already has a login still answers
 * `unavailable`, there is no create-workspace route and no switcher, and a person who loses their last workspace is
 * deleted as today. Production behaviour is identical (rule 2132). docs/system/variables.md does not change.
 */
export const MULTI_ORG = false;

/** The shape of a new person id (rule 2137): `p_` and 24 base32 characters. No `@`, `:` or `#`. */
export const PERSON_ID = /^p_[a-z2-7]{24}$/;

/**
 * A new person id from `crypto` (120 bits), never `Math.random`; the alphabet of `newAccountId`. In M1 only tests create
 * one (a `p_` person has no legacy record); signups and invitations keep their address-based ids until M2.
 */
export const newPersonId = (): string => "p_" + base32lower(randomBytes(15));
