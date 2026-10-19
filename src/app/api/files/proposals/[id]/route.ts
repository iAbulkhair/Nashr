import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api-handler";
import { sc } from "@/lib/auth";
import { byOf } from "@/lib/actor";
import { recordActivity } from "@/lib/activity";
import { decideFileProposal } from "@/lib/file-proposals";
import { WINDOW } from "@/lib/rate";

const decision = z.object({ decision: z.enum(["apply", "dismiss"]) });

/**
 * The owner's answer to a core-file rewrite an agent asked for in chat (src/lib/file-proposals.ts, rule 2306): POST
 * `{ decision: "apply" | "dismiss" }`. This click is the only approval there is: `write_file` stored the text and wrote
 * nothing. Admin and owner (`files.core.write`), the same role as saving a core file on the Files page; 60 answers per
 * workspace and hour, since a person clicks a card and nothing needs more.
 *
 * The proposal is read only from the caller's own scope (`sc(u)`): an id from another account or another brand is 404,
 * and no body field names a scope. Answers: `{ ok: true, file: { name, chars } }` for apply, `{ ok: true }` for dismiss;
 * 410 `gone` once decided; 404 for an id that is not in this workspace; 409 `stale` when the file was saved again since
 * the proposal (closed, nothing written) and `claim_busy` while another answer for it runs.
 */
export const POST = handler<"user", typeof decision, undefined, { id: string }>(
  { auth: "user", role: "files.core.write", rate: { bucket: "fileprop", max: 60, window: WINDOW.hour, per: "scope" }, input: decision, invalid: "bad_action" },
  async ({ u, input: b, params: { id } }) => {
    const s = sc(u);
    const r = await decideFileProposal(s, id, b.decision);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.error === "gone" ? 410 : r.error === "not_found" ? 404 : 409 });
    if (!r.file) return NextResponse.json({ ok: true });
    await recordActivity(s, [{ at: r.file.updatedAt, kind: "file_written", agent: r.agent, by: byOf(u), via: "app", note: r.file.name }]);
    return NextResponse.json({ ok: true, file: { name: r.file.name, chars: r.file.content.length } });
  },
);
