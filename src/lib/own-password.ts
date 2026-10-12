import bcrypt from "bcryptjs";
import type { User } from "./auth";
import { getMember } from "./team";

/**
 * The acting LOGIN's own password hash: the member record for a member, the owner record for the owner. Null for any
 * other actor (a founder impersonating, a token) and for a member no longer in this account. The account record's
 * hash is never the answer for a member: knowing the owner's password must not let a member act as the owner.
 * Moved here from /api/account so /api/account/sessions checks the password the same way (rule 1150).
 */
async function ownHash(u: User): Promise<string | null> {
  const a = u.actor;
  if (a?.kind === "owner" && a.email === u.email) return u.passHash;
  if (a?.kind !== "member") return null;
  const m = await getMember(a.email);
  return m && m.memberOf === u.email && !m.disabled ? m.passHash : null;
}

/** Does `password` match the acting login's own password? False for any actor that has none of its own. */
export const ownPasswordMatches = async (u: User, password: unknown) => {
  const hash = await ownHash(u);
  return !!hash && typeof password === "string" && (await bcrypt.compare(password, hash));
};
