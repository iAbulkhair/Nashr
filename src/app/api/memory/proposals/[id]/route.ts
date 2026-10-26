import { NextResponse } from "next/server";
import { z } from "zod";
import { byOf } from "@/lib/actor";
import { fail, handler } from "@/lib/api-handler";
import { sc } from "@/lib/auth";
import { decideMemoryProposal } from "@/lib/memory";
import { WINDOW } from "@/lib/rate";
import { v2On } from "@/lib/v2-switch";

const decision = z.object({ decision: z.enum(["save", "dismiss"]) });

/**
 * The owner's answer to a fact an agent proposed in chat (src/lib/memory.ts, Thakeen v2 phase 1, rule 4557): POST
 * `{ decision: "save" | "dismiss" }`. This click is the only approval there is: `remember` stored a proposal and wrote no
 * fact. Admin and owner (`brand.write`), since a saved fact is read back into every agent's prompt like the brand file;
 * 60 answers per workspace and hour. 404 while `MEMORY_V2` is off, as if the route did not exist.
 *
 * The proposal is read only from the caller's own scope (`sc(u)`): an id from another account or another brand is 404,
 * and no body field names a scope. Who saved it comes from the session (`byOf`). Answers: `{ ok: true }`; 410 `gone`
 * once decided; 404 for an id that is not in this workspace; 409 `full` at the brand's fact limit (the card stays open)
 * and `claim_busy` while another answer for it runs.
 */
export const POST = handler<"user", typeof decision, undefined, { id: string }>(
  {
    auth: "user",
    role: "brand.write",
    rate: { bucket: "memprop", max: 60, window: WINDOW.hour, per: "scope" },
    input: decision,
    invalid: "bad_action",
  },
  async ({ u, input: b, params: { id } }) => {
    if (!v2On("MEMORY_V2")) return fail("not_found", 404);
    const r = await decideMemoryProposal(sc(u), id, b.decision, byOf(u));
    if (!r.ok)
      return NextResponse.json(
        { ok: false, error: r.error },
        { status: r.error === "gone" ? 410 : r.error === "not_found" ? 404 : 409 },
      );
    return NextResponse.json({ ok: true });
  },
);
