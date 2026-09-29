import type { User } from "@/lib/auth";
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
    impersonating: u?.actor?.kind === "founder",
  };
}
