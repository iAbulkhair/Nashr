/**
 * Invite-only sign-up (rules 3520-3529, docs/system/tests/3520-invite-only-signup.md).
 *
 * `SIGNUP_MODE` is an environment variable, not a code constant (as `MULTI_ORG` is): closing and reopening sign-up is an
 * operating decision the founder makes on the host (a launch wave, an abuse wave), and it must not wait for a code change
 * and a release pull request. It is read on the server at call time, never through `NEXT_PUBLIC_`, so it never reaches a
 * bundle; a host that reads its environment only at start needs a restart after a change.
 *
 * Default OPEN: unset, empty or any value other than `invite` keeps today's behaviour, so a typo never locks out the
 * public by surprise and a deploy without the variable changes nothing (rule 3520).
 *
 * With `invite`, every path that creates a NEW login checks here first (rule 3521-3523):
 *   - POST /api/auth/signup: only with the invite link's token naming a standing invite to that address
 *     (`inviteTokenFor`); otherwise 403 `invite_only`, the same answer whether or not the address has a login (rule 3524).
 *   - Google sign-up (`resolveGoogle`, mode "signup"): only when Google's verified address has a standing invite
 *     (`verifiedAddressInvited`); otherwise `google_invite_only`. Existing people still sign in with Google.
 *   - Accepting a team invite (POST /api/team/accept) is the invite itself and stays open (rule 3525).
 * Passkeys only sign an existing person in (registration needs a session), so there is no passkey-first sign-up to close.
 */
export type SignupMode = "open" | "invite";

export function signupMode(): SignupMode {
  return (process.env.SIGNUP_MODE ?? "").trim().toLowerCase() === "invite" ? "invite" : "open";
}

/** Password sign-up: may this address get a new login? `token` is the invite link's token from the body, if any. */
export async function passwordSignupAllowed(email: string, token: unknown): Promise<boolean> {
  if (signupMode() === "open") return true;
  // Dynamic: this module stays import-free, so any module (the team module included) can read the switch without a cycle.
  const { inviteTokenFor } = await import("./team");
  return inviteTokenFor(token, email);
}

/** Google sign-up: may this Google-verified address get a new login? */
export async function googleSignupAllowed(verifiedEmail: string): Promise<boolean> {
  if (signupMode() === "open") return true;
  const { verifiedAddressInvited } = await import("./team");
  return verifiedAddressInvited(verifiedEmail);
}
