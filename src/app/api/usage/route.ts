import { NextResponse } from "next/server";
import { z } from "zod";
import { handler, param } from "@/lib/api-handler";
import { monthKey } from "@/lib/credits";
import { WINDOW } from "@/lib/rate";
import { isMonth, ownerUsage } from "@/lib/usage-report";

/**
 * GET ?month=YYYY-MM — the account's AI usage for one month (rule 2907): requests in total and per person, brand, agent,
 * model and UTC day, each with its share of the month. Owner and admins (`usage.view`). The account is the session's own
 * (`acct(u)` inside `ownerUsage`): the month is the only thing read from the request, checked against `YYYY-MM`. No dollar
 * figure: what a call costs Thakeen stays in the founder console.
 */
export const GET = handler(
  { auth: "user", unauthorized: "auth", role: "usage.view", rate: { bucket: "usageview", max: 300, window: WINDOW.hour }, query: z.object({ month: param(isMonth, "bad_input") }) },
  async ({ u, query: { month } }) => NextResponse.json({ ok: true, ...(await ownerUsage(u, month ?? monthKey())) }),
);
