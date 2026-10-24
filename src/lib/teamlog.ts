import { CAPS, db, pushCapped } from "./db";
import { accountKey, type AccountId } from "./keys";
import { TeamLogRow, type TeamLogRowValue } from "./stored";

/**
 * The team log of an account (multi-workspace membership, release M1, rule 2129; spec section 13): `teamlog:{aid}`, a
 * capped list (`CAPS.teamLog`, 500), newest first. Every membership event of src/lib/team.ts writes exactly one row,
 * under the same `lock:team:{aid}` as the change it records, and a refused action writes none.
 *
 * A row names people by person id and address only (`actor`, `target`), the role when it matters, and `via`: "web" for a
 * person acting in the app, "console" for the founder console (staff are never named: `actor` is the account's owner),
 * "system" for a plan change (`enforceSeats`). It never holds an invite token, an invite id or a password hash: the
 * writer below builds the row from named fields only, so a caller cannot pass one through.
 *
 * M1 writes the log; M3 reads it for the owner and admins of the account (`teamLogView`, GET /api/team/log, action
 * `team.log.view`), without the person ids. `readTeamLog` returns the stored rows, ids included, for tests.
 */

/**
 * The fields of a row the writer takes (`TeamLogRowValue` without `at`, spelled out: the stored shape is a loose object,
 * so `Omit` of it would accept any extra field, and an extra field is how a token or an invite id would get in).
 */
export type TeamLogInput = {
  kind: TeamLogRowValue["kind"];
  actor: { pid: string; email: string };
  target: { pid?: string; email: string };
  role?: "admin" | "member" | "viewer";
  via: TeamLogRowValue["via"];
};

/** Append one row. The caller holds `lock:team:{aid}` (`teamLocked`), the same lock as the change it records. */
export async function logTeam(aid: AccountId, row: TeamLogInput, opts: { teamLocked: true }): Promise<void> {
  void opts;
  const value: TeamLogRowValue = {
    at: new Date().toISOString(),
    kind: row.kind,
    actor: { pid: row.actor.pid, email: row.actor.email },
    target: row.target.pid === undefined ? { email: row.target.email } : { pid: row.target.pid, email: row.target.email },
    ...(row.role === undefined ? {} : { role: row.role }),
    via: row.via,
  };
  await pushCapped(accountKey.teamLog(aid), JSON.stringify(value), CAPS.teamLog);
}

/** The account's log, newest first. A row that fails `TeamLogRow` is skipped (logged without values). */
export async function readTeamLog(aid: AccountId): Promise<TeamLogRowValue[]> {
  const rows = await db.lrange(accountKey.teamLog(aid), 0, CAPS.teamLog - 1);
  return rows.flatMap((s) => {
    let raw: unknown;
    try {
      raw = JSON.parse(s);
    } catch {
      return [];
    }
    const r = TeamLogRow.safeParse(raw);
    return r.success ? [r.data] : [];
  });
}

/** One row of the Team log tab: who, what, to whom, how. People by address only: never a person id, a token or an invite id. */
export type TeamLogViewRow = {
  at: string;
  kind: TeamLogRowValue["kind"];
  actor: { email: string };
  target: { email: string };
  role?: "admin" | "member" | "viewer";
  via: TeamLogRowValue["via"];
};

/**
 * The Team log tab (multi-workspace M3, spec section 13; rule 2129 read half): the account's rows, newest first, rebuilt
 * from named fields so nothing but the address of each person, the kind, the role and `via` leaves (a loose stored row
 * could carry anything). `aid` is the caller's own account (`acct(u)`), never one from the request.
 */
export async function teamLogView(aid: AccountId): Promise<TeamLogViewRow[]> {
  return (await readTeamLog(aid)).map((r) => ({
    at: r.at,
    kind: r.kind,
    actor: { email: r.actor.email },
    target: { email: r.target.email },
    ...(r.role === undefined ? {} : { role: r.role }),
    via: r.via,
  }));
}
