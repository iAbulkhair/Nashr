/**
 * The session gate's approvals (rule 3407, docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md section 4.1).
 *
 * better-auth mints a session in two steps inside one request: `databaseHooks.session.create.before` (the gate, which
 * replaces the token with Thakeen's 64-hex one and approves it here) and then the adapter's `create`, which writes the
 * record only for a token approved here and takes the approval in the same step. An approval lives in this process only,
 * for at most `APPROVAL_MS`, and is good for one write: a session better-auth would mint through any other path (an
 * endpoint the gate does not know, a plugin added by an upgrade) has no approval, and the adapter refuses it.
 *
 * Import-free on purpose (no store, no request), so the tests can drive it alone.
 */
export const APPROVAL_MS = 30_000;

/** What the adapter needs to write the session: the login address the gate resolved, as `createSession` takes it. */
export type Approval = { email: string; at: number };

const g = globalThis as unknown as { __thakeenBaApprovals?: Map<string, Approval> };
const approvals = (g.__thakeenBaApprovals ??= new Map<string, Approval>());

/** Drop approvals older than `APPROVAL_MS` (a request that failed between the gate and the write). */
function sweep(now: number) {
  for (const [k, v] of approvals) if (now - v.at > APPROVAL_MS) approvals.delete(k);
}

/** The gate approves `token` for `email` (called only by src/lib/better-auth/gate.ts). */
export function approveSession(token: string, email: string): void {
  const now = Date.now();
  sweep(now);
  approvals.set(token, { email, at: now });
}

/** The adapter takes the approval for `token`: the email when it was approved in the last `APPROVAL_MS`, else null. Once only. */
export function takeApproval(token: string): string | null {
  const a = approvals.get(token);
  approvals.delete(token);
  if (!a || Date.now() - a.at > APPROVAL_MS) return null;
  return a.email;
}

/** How many approvals are waiting (tests only). */
export const pendingApprovals = (): number => approvals.size;
