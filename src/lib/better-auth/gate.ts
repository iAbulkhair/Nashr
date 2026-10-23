import { randomBytes } from "crypto";
import { APIError } from "better-auth/api";
import { admitLogin, trackLogin, type Refusal } from "@/lib/login-finish";
import { loginOfPerson } from "./adapter";
import { approveSession } from "./approvals";

/**
 * The session gate (rule 3411, docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md section 4.1): better-auth's
 * `databaseHooks.session.create.before`, run for every session better-auth would mint. better-auth has checked the proof
 * (the password, or the magic link); everything after that is Thakeen's, through the one function the legacy sign-in
 * runs (`admitLogin` in src/lib/login-finish.ts): an expired suspension ends, a refusal goes back with the legacy code,
 * two-step sign-in opens the same challenge and NO session exists (rule 1934). Only then does the gate put Thakeen's
 * 64-hex token in place of better-auth's and approve it for the adapter's single write (src/lib/better-auth/approvals.ts).
 */

/** The better-auth endpoints that may end in a session. Any other path (sign-up, an OAuth callback, a plugin an upgrade adds) is refused. */
export const GATE_PATHS: ReadonlySet<string> = new Set(["/sign-in/email", "/magic-link/verify"]);

/** A Thakeen answer thrown through better-auth: the route wrapper sends `body` as it is, with the legacy status. */
export class GateRefusal extends APIError {
  constructor(status: 401 | 403, body: Refusal["body"] | { ok: false; error: "mfa_required"; mfa: true }) {
    super(status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", { ...body, code: body.error, message: body.error });
  }
}

type SessionDraft = { userId: string } & Record<string, unknown>;
type EndpointLike = { path?: string } | null;

export async function sessionGate(session: SessionDraft, ctx: EndpointLike): Promise<{ data: { token: string } }> {
  if (!ctx?.path || !GATE_PATHS.has(ctx.path)) throw new GateRefusal(403, { ok: false, error: "invalid" });
  const l = await loginOfPerson(String(session.userId));
  if (!l) throw new GateRefusal(401, { ok: false, error: "invalid" });
  // A magic link proves the address the way a password proves the person: the first factor. The challenge keeps today's
  // `via` values, so its stored shape does not change (rule 3411).
  const a = await admitLogin(l, { via: "password" });
  if (a.kind === "refused") throw new GateRefusal(a.refusal.status, a.refusal.body);
  if (a.kind === "mfa") throw new GateRefusal(401, { ok: false, error: "mfa_required", mfa: true });
  const token = randomBytes(32).toString("hex");
  approveSession(token, a.email);
  return { data: { token } };
}

/** `databaseHooks.session.create.after`: count the login, as `finishLogin` does. */
export async function sessionCreated(session: SessionDraft): Promise<void> {
  const l = await loginOfPerson(String(session.userId));
  if (l) await trackLogin(l);
}
