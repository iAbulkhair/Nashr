import { getAccount, getLogin, normalizeEmail, type User } from "./auth";
import { getBrand } from "./brand";
import { lastSignIn } from "./devices";
import { getMembership } from "./membership";
import { pmap } from "./parallel";
import { isPersonSuspended, isSuspended } from "./suspension";
import { heldAnywhere } from "./team";
import { wsHandle } from "./ws-handle";
import { workspaceLabel } from "./workspace-name";

export type PeopleWorkspace = { handle: string; name: string; role: string; plan: User["plan"] | null; suspended: boolean; paused: boolean };
export type PeopleView = {
  person: { email: string; name: string; verified: boolean; suspended: boolean; lastSignIn: number | null };
  workspaces: PeopleWorkspace[];
};

/**
 * The founder console's people view (multi-workspace M3, rules 2130 and 2755; plan ruling 10): one sign-in address, the
 * person it signs in as, and every account that person owns or has a membership row in, paused ones included
 * (`heldAnywhere`). The address only picks the person through `getLogin`; every key after that comes from the stored
 * person and its own lists. One `pmap` round reads each account, the person's membership in it and its default brand.
 * Each workspace is named by its opaque handle (`wsHandle`) and its display name, never by an account id; the answer has
 * no password hash, two-step secret, token, session or device detail. Read only: nothing here writes.
 */
export async function peopleView(email: string): Promise<PeopleView | null> {
  const login = await getLogin(normalizeEmail(email));
  if (!login) return null;
  const { pid, person } = login;
  const [held, last] = await Promise.all([heldAnywhere(pid), lastSignIn(normalizeEmail(person.email))]);
  const workspaces = await pmap(held, async ({ aid, owner }) => {
    const [u, m, brand] = await Promise.all([getAccount(aid), owner ? Promise.resolve(null) : getMembership(aid, pid), getBrand(aid)]);
    const name = workspaceLabel(u, brand);
    return {
      handle: wsHandle(aid), name, role: owner ? "owner" : (m?.role ?? "member"),
      plan: u?.plan ?? null, suspended: !!u && isSuspended(u), paused: !owner && !!m?.disabled,
    };
  });
  return {
    person: { email: person.email, name: person.name, verified: !!person.emailVerifiedAt, suspended: isPersonSuspended(person), lastSignIn: last },
    workspaces,
  };
}
