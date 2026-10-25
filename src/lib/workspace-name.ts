import type { User } from "./auth";

/**
 * The workspace's display name (rules 3115-3118). Set when a workspace is created (`createWorkspace`, `workspaceName`)
 * and, from 2026-10-23, renamed by the owner in Settings, Account (PUT /api/account/workspace). It lives on the account
 * record (`user:{acct}`), the field every build since M2 already reads; the handle in the link (`w/{handle}`) is derived
 * from the account id and never changes with the name.
 *
 * Import-light on purpose (a type import only): the settings card checks the same limit in the browser.
 */

/** Characters a workspace name may hold, after cleaning. The input's `maxLength` uses the same number. */
export const WORKSPACE_NAME_MAX = 80;

/**
 * Control characters, and the bidi embedding, override and isolate marks (U+202A-U+202E, U+2066-U+2069): a name is shown
 * to other people (the switcher, an invite) inside sentences in both directions, so a pasted override must not reorder
 * the text around it. The left-to-right and right-to-left marks stay: they only steer neutral characters.
 */
const UNSAFE = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g;

export type WorkspaceNameCheck = { ok: true; name: string } | { ok: false; error: "required" | "too_long" };

/**
 * A name as it is stored: unsafe characters removed, runs of white space made one space, trimmed. Empty after that is
 * `required`; longer than `WORKSPACE_NAME_MAX` is `too_long` (refused, never cut, so what is saved is what was typed).
 */
export function cleanWorkspaceName(v: unknown): WorkspaceNameCheck {
  if (typeof v !== "string") return { ok: false, error: "required" };
  const name = v.replace(UNSAFE, "").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "required" };
  if (name.length > WORKSPACE_NAME_MAX) return { ok: false, error: "too_long" };
  return { ok: true, name };
}

/**
 * The name a workspace is shown by (the switcher, the workspaces page, the invitations inbox, the join page, the founder's
 * people view): the name the owner gave it, else its default brand's name, else the owner's name. A name the owner set
 * comes first (rule 3116): before the rename existed the brand's name came first, and a renamed workspace would have kept
 * showing its brand's name.
 */
export function workspaceLabel(u: Pick<User, "workspaceName" | "name"> | null | undefined, brand: { name?: string } | null | undefined): string {
  return u?.workspaceName?.trim() || brand?.name?.trim() || u?.name || "";
}
