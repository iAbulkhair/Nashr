import { normalizeEmail, saveUser, validEmail, type Actor, type User } from "./auth";
import { acct } from "./account-id";
import { withUserLock } from "./credits";
import { aidOf, ownerOf } from "./membership";
import { notifyItem } from "./notifications";
import { mailReady, sendEmail } from "./notify";
import { appOrigin } from "./origin";
import { isSuspended } from "./suspension";
import { cancelInvite, createInvite, discardInvite, listInvites, listMembers, removeMember, withAccountTeamLock, type TeamFail } from "./team";
import { inviteMail } from "./team-invite-mail";
import { logTeam } from "./teamlog";
import { log } from "./log";

/**
 * The founder console's workspace edit (rules 3550-3569, docs/system/flows.md section 108), after supastarter's admin
 * organization edit: Thakeen support renames a customer workspace, invites a member, removes a member or cancels a
 * pending invite, on the customer's behalf. The route (POST /api/admin/users/{email}/workspace/edit) gates it: the
 * console owner only, a second factor, a reason, rate limits. This file only carries the change out.
 *
 * Same rules as the customer: every change runs through the SAME src/lib/team.ts functions the customer's team routes
 * call (`createInvite`, `removeMember`, `cancelInvite`), under the target account found by `accountForChosen` (the
 * account the console view showed, from the stored login, never a key built from the request). Seat limits, the
 * address checks, the team lock and the team log row are theirs. The acting person is the account OWNER
 * (`consoleActor`): support acts for the owner, never as a staff identity, and the team log row says `via: "console"`
 * ("by Thakeen support" on the customer's Team log tab) without naming the staff member (rule 2129).
 *
 * What is never offered: removing or demoting the owner (the owner is no membership, and a remove that names the owner's
 * address is refused before anything is read), changing a member's role, and ownership transfer (the customer's own
 * flow, src/lib/transfer.ts).
 */

export const EDIT_ACTIONS = ["rename", "invite", "remove", "cancel_invite"] as const;
export type EditAction = (typeof EDIT_ACTIONS)[number];
export type EditInput = { action: EditAction; owner: string; name?: string; email?: string; role?: string; lang?: "ar" | "en" };

/** Longest workspace name, as at create (src/lib/workspaces.ts `createWorkspace`). */
export const WORKSPACE_NAME_MAX = 80;

/**
 * A workspace name from the console: control characters and bidi overrides out (the name is shown in other people's
 * switchers and notices, so it must not reorder the text around it), runs of spaces folded, 1 to 80 characters. Null when
 * nothing is left or it is too long.
 */
export function cleanWorkspaceName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\p{Cc}‎‏‪-‮⁦-⁩]/gu, " ").replace(/\s+/g, " ").trim();
  if (!s || [...s].length > WORKSPACE_NAME_MAX) return null;
  return s;
}

/** The body, read field by field: an action from the list, the owner the console view showed, and that action's fields. */
export function parseEdit(raw: unknown): EditInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.action !== "string" || !(EDIT_ACTIONS as readonly string[]).includes(b.action)) return null;
  if (typeof b.owner !== "string" || !b.owner) return null;
  return {
    action: b.action as EditAction,
    owner: normalizeEmail(b.owner),
    ...(typeof b.name === "string" ? { name: b.name } : {}),
    ...(typeof b.email === "string" ? { email: normalizeEmail(b.email) } : {}),
    ...(typeof b.role === "string" ? { role: b.role } : {}),
    ...(b.lang === "ar" || b.lang === "en" ? { lang: b.lang } : {}),
  };
}

/**
 * The account owner as the acting person (rule 3552): kind "owner" so the team rules allow exactly what the owner may,
 * the owner's own person id and address. `home` as the session resolver sets it: a legacy owner's person id is its
 * account id. Never a staff address: the team log, the invite record and the email name the owner.
 */
export function consoleActor(owner: User): Actor {
  const pid = ownerOf(owner);
  return { kind: "owner", pid, home: (pid as string) === acct(owner), email: owner.email, name: owner.name, lang: owner.lang, role: "owner" };
}

export type EditDone = {
  ok: true;
  action: EditAction;
  /** The person or the name the change concerned, for the audit row and the answer. Never a token or an invite id. */
  subject: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Puts the change back when the audit row cannot be written (rename and invite only; see the route). */
  undo?: () => Promise<void>;
};
export type EditFail = { ok: false; status: number; error: string } | { ok: false; team: TeamFail };

const fail = (status: number, error: string): EditFail => ({ ok: false, status, error });

/** Carry one console edit out on `owner`'s account. `owner` is the account `accountForChosen` resolved, never the body's. */
export async function applyEdit(owner: User, input: EditInput): Promise<EditDone | EditFail> {
  const actor = consoleActor(owner);
  switch (input.action) {
    case "rename":
      return rename(owner, input.name);
    case "invite":
      return invite(owner, actor, input);
    case "remove":
      return remove(owner, actor, input.email);
    case "cancel_invite":
      return cancelByEmail(owner, actor, input.email);
  }
}

/**
 * Rename (rule 3554): `User.workspaceName`, the field `createWorkspace` sets, under `lock:team:{aid}` then
 * `lock:user:{aid}` (rule 2139 order), with one `workspace_renamed` team log row. The switcher and the invitations
 * inbox still show the main brand's name first when it has one (src/lib/workspaces.ts), as for a name given at create.
 */
async function rename(owner: User, rawName: unknown): Promise<EditDone | EditFail> {
  const name = cleanWorkspaceName(rawName);
  if (!name) return fail(400, "bad_name");
  const aid = aidOf(owner);
  const pid = ownerOf(owner) as string;
  const row = { kind: "workspace_renamed" as const, actor: { pid, email: owner.email }, target: { pid, email: owner.email }, via: "console" as const };
  const was = await withAccountTeamLock(aid, () =>
    withUserLock(acct(owner), async (u) => {
      const prev = u.workspaceName?.trim() || null;
      if (prev === name) return { same: true as const };
      u.workspaceName = name;
      await saveUser(u);
      await logTeam(aid, row, { teamLocked: true });
      return { same: false as const, prev };
    }),
  );
  if (was.same) return fail(409, "unchanged");
  const undo = async () => {
    await withAccountTeamLock(aid, () =>
      withUserLock(acct(owner), async (u) => {
        if ((u.workspaceName?.trim() || null) !== name) return;
        u.workspaceName = was.prev ?? undefined;
        await saveUser(u);
        await logTeam(aid, row, { teamLocked: true });
      }),
    );
  };
  return { ok: true, action: "rename", subject: name, before: { workspaceName: was.prev }, after: { workspaceName: name }, undo };
}

/**
 * Invite (rule 3553): `createInvite` with the owner as the inviter, so the seat limit, the address checks and the
 * "invited" row are the customer's own. Only when mail can reach a customer: the link goes to the invited address and
 * nowhere else, so staff never hold a join link (409 `mail_unavailable` otherwise). A suspended account gets no invite
 * (nobody could accept it). A send that fails withdraws the invite (`discardInvite`) and answers 502 `send_failed`.
 */
async function invite(owner: User, a: Actor, input: EditInput): Promise<EditDone | EditFail> {
  const email = input.email ?? "";
  if (!validEmail(email)) return fail(400, "invalid_email");
  if (!mailReady()) return fail(409, "mail_unavailable");
  if (isSuspended(owner)) return fail(409, "suspended");
  const lang = input.lang ?? owner.lang;
  const res = await createInvite(owner, a, email, input.role ?? "", lang, { via: "console" });
  if (!res.ok) return { ok: false, team: res };
  const inv = res.invite;
  const link = `${appOrigin()}/${inv.lang}/app/join#t=${res.token}`;
  const mail = inviteMail(inv, owner.email, link);
  if (!(await sendEmail({ to: inv.email, subject: mail.subject, text: mail.text, template: "teamInvite", context: mail.context, locale: inv.lang }))) {
    await discardInvite(acct(owner), res.id);
    return fail(502, "send_failed");
  }
  return {
    ok: true, action: "invite", subject: inv.email, before: null, after: { email: inv.email, role: inv.role, expiresAt: inv.expiresAt },
    undo: () => discardInvite(acct(owner), res.id),
  };
}

/**
 * Remove (rule 3555): never the owner (400 `owner_protected`, before anything is read), else `removeMember` as the owner,
 * which finds the member on the stored roster by address.
 */
async function remove(owner: User, a: Actor, rawEmail: string | undefined): Promise<EditDone | EditFail> {
  const email = rawEmail ?? "";
  if (!email) return fail(400, "invalid_email");
  if (email === normalizeEmail(owner.email)) return fail(400, "owner_protected");
  const was = (await listMembers(acct(owner))).find((m) => m.email === email);
  if (!was) return fail(404, "not_found");
  const res = await removeMember(owner, a, email, { via: "console" });
  if (!res.ok) return { ok: false, team: res };
  return { ok: true, action: "remove", subject: email, before: { email, role: was.role, paused: !!was.disabled }, after: null };
}

/**
 * Cancel a pending invite (rule 3555), named by the invited address: the invite id comes from the account's own stored
 * index (`listInvites`), never from the request, then `cancelInvite` as the owner.
 */
async function cancelByEmail(owner: User, a: Actor, rawEmail: string | undefined): Promise<EditDone | EditFail> {
  const email = rawEmail ?? "";
  if (!email) return fail(400, "invalid_email");
  const inv = (await listInvites(acct(owner))).find((i) => i.email === email);
  if (!inv) return fail(404, "not_found");
  const res = await cancelInvite(owner, a, inv.id, { via: "console" });
  if (!res.ok) return { ok: false, team: res };
  return { ok: true, action: "cancel_invite", subject: email, before: { email, role: inv.role, expiresAt: inv.expiresAt }, after: null };
}

/**
 * The owner's in-app notice (rule 3557). Never fails the request: the change is made and logged. The bell is shared by
 * every login of the account, so, like the customer's own invite notice, it names neither an address nor a role; the
 * Members page shows them to whoever may see them. A rename names the new name, which every member sees anyway.
 */
export async function tellOwnerOfEdit(owner: User, done: EditDone): Promise<void> {
  const ar = owner.lang === "ar";
  const contact = ar ? "إن لم تطلب هذا فراسل الدعم." : "If you did not ask for this, contact support.";
  const text: Record<EditAction, { title: string; body: string }> = {
    rename: {
      title: ar ? "غيّر فريق ذكين اسم مساحة العمل" : "Thakeen support renamed your workspace",
      body: ar ? `صار اسمها «${done.subject}». ${contact}` : `It is now called "${done.subject}". ${contact}`,
    },
    invite: {
      title: ar ? "أرسل فريق ذكين دعوة باسمك" : "Thakeen support sent an invitation for you",
      body: ar ? `أُرسلت دعوة بالبريد تنتهي خلال 7 أيام، وتفاصيلها في صفحة «الأعضاء». ${contact}` : `An invitation was emailed on your behalf. It expires in 7 days; the details are on the Members page. ${contact}`,
    },
    remove: {
      title: ar ? "أزال فريق ذكين عضواً من مساحة العمل" : "Thakeen support removed a member",
      body: ar ? `التفاصيل في صفحة «الأعضاء». ${contact}` : `The details are on the Members page. ${contact}`,
    },
    cancel_invite: {
      title: ar ? "ألغى فريق ذكين دعوة معلّقة" : "Thakeen support cancelled a pending invitation",
      body: ar ? `التفاصيل في صفحة «الأعضاء». ${contact}` : `The details are on the Members page. ${contact}`,
    },
  };
  try {
    await notifyItem(acct(owner), owner.lang, { kind: "info", ...text[done.action], href: "team" });
  } catch (e) {
    log.error("console workspace edit: owner notice failed", { action: done.action, error: e });
  }
}
