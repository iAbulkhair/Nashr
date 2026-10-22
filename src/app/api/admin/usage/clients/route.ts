import { NextResponse } from "next/server";
import { z } from "zod";
import { handler, param } from "@/lib/api-handler";
import { monthKey } from "@/lib/credits";
import { clientRanking, isMonth } from "@/lib/usage-report";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET ?month=YYYY-MM — the founder console's clients ranked by what their AI cost us this month (rule 2905): model calls
 * plus renders, the plan and the margin, highest first, at most 100. Founder only (`isAdmin`). The month is the only input.
 */
export const GET = handler(
  { auth: "admin", query: z.object({ month: param(isMonth, "bad_input") }) },
  async ({ query: { month } }) => {
    const m = month ?? monthKey();
    return NextResponse.json({ ok: true, month: m, rows: await clientRanking(m) });
  },
);
