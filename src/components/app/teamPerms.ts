import type { User } from "@/lib/auth";
import { MULTI_ORG } from "@/lib/multi-org";
import { can } from "@/lib/roles";

/**
 * What the Members page offers the person looking at it, computed on the server from `currentUser()` with the same
 * `can()` table the /api/team routes enforce. Display only: hiding a control never replaces the server check.
 */
export type TeamPerms = {
  inviteMember: boolean;
  inviteAdmin: boolean;
  changeRole: boolean;
  removeMember: boolean;
  removeAdmin: boolean;
  viewInvites: boolean;
  cancelInvite: boolean;
  leave: boolean;
  /** The Team log tab (multi-workspace M3): owner and admin, while `MULTI_ORG` is on. */
  viewLog: boolean;
  /** Transfer ownership (multi-workspace M3): the owner's own session, while `MULTI_ORG` is on. */
  transfer: boolean;
  /** Rules 3756, 3760: change a person's brand scope and approve toggle (owner and unscoped admins). */
  access: boolean;
  /** Rule 3770: set a person's monthly credit cap (the owner). */
  cap: boolean;
  /** Rule 3762: turn the approval policy on or off (the owner). */
  policy: boolean;
  /** A founder viewing this account: every team change is refused, so the page says why. */
  impersonating: boolean;
};

export function teamPerms(u: User | null | undefined): TeamPerms {
  return {
    inviteMember: can(u, "team.invite.member"),
    inviteAdmin: can(u, "team.invite.admin"),
    changeRole: can(u, "team.role"),
    removeMember: can(u, "team.remove.member"),
    removeAdmin: can(u, "team.remove.admin"),
    viewInvites: can(u, "team.invites.view"),
    cancelInvite: can(u, "team.invite.cancel"),
    leave: can(u, "team.leave"),
    viewLog: MULTI_ORG && can(u, "team.log.view"),
    transfer: MULTI_ORG && can(u, "team.transfer"),
    access: can(u, "team.access"),
    cap: can(u, "team.cap"),
    policy: can(u, "team.policy"),
    impersonating: u?.actor?.kind === "founder",
  };
}
