import { NextResponse } from "next/server";
import { z } from "zod";
import { fail, handler } from "@/lib/api-handler";
import { sc } from "@/lib/auth";
import { forgetFact, listFacts } from "@/lib/memory";
import { WINDOW } from "@/lib/rate";
import { MEMORY_V2 } from "@/lib/v2-flags";

/**
 * The brand's saved memory (src/lib/memory.ts, Thakeen v2 phase 1, rule 4558), in the caller's own scope (`sc(u)`).
 * GET: every saved fact, newest first, for any member (the agents read the same facts); `by` is left out, as on the
 * card. DELETE `?id=`: forget one, admin and owner (`brand.write`, the role that saves one); 404 for an id this workspace
 * does not hold. Both 404 while `MEMORY_V2` is off, as if the route did not exist.
 */
export const GET = handler(
  { auth: "user", rate: { bucket: "mem:r", max: 300, window: WINDOW.hour, per: "scope" } },
  async ({ u }) => {
    if (!MEMORY_V2) return fail("not_found", 404);
    const facts = await listFacts(sc(u));
    return NextResponse.json({
      ok: true,
      facts: facts.map(({ id, text, scope, agent, conv, source, at }) => ({
        id,
        text,
        scope,
        agent,
        conv,
        source,
        at,
      })),
    });
  },
);

export const DELETE = handler(
  {
    auth: "user",
    role: "brand.write",
    rate: { bucket: "mem:w", max: 60, window: WINDOW.hour, per: "scope" },
    query: z.object({ id: z.string().min(1) }),
  },
  async ({ u, query: { id } }) => {
    if (!MEMORY_V2) return fail("not_found", 404);
    if (!(await forgetFact(sc(u), id))) return fail("not_found", 404);
    return NextResponse.json({ ok: true });
  },
);
