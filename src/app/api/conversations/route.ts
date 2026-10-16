import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api-handler";
import { isAgentId } from "@/lib/agents";
import { createConversation, deleteConversation, listConversations, renameConversation, searchConversations } from "@/lib/conversations";
import { retryAfter } from "@/lib/rate";

const busy = () => NextResponse.json({ ok: false, error: "busy" }, { status: 503, headers: retryAfter(1) });

export const GET = handler({ auth: "user", query: z.object({ q: z.string().optional() }) }, async ({ scope, query: { q } }) => {
  if (q) return NextResponse.json({ ok: true, hits: await searchConversations(scope, q) });
  return NextResponse.json({ ok: true, conversations: await listConversations(scope) });
});

export const POST = handler({ auth: "user", input: z.looseObject({ title: z.string().optional(), agent: z.unknown() }) }, async ({ scope, input: b }) =>
  NextResponse.json({ ok: true, conversation: await createConversation(scope, b.title ?? "…", isAgentId(b.agent) ? b.agent : "noor") }),
);

export const PATCH = handler({ auth: "user", input: z.object({ id: z.string().min(1), title: z.string().min(1) }) }, async ({ scope, input: b }) => {
  // Under the conversation's lock (src/lib/conversations.ts): `busy` when it was not taken in time, nothing renamed.
  if ((await renameConversation(scope, b.id, b.title)) === "busy") return busy();
  return NextResponse.json({ ok: true });
});

export const DELETE = handler({ auth: "user", query: z.object({ id: z.string().min(1) }) }, async ({ scope, query: { id } }) => {
  // Under the conversation's lock: `busy` when it was not taken in time, nothing deleted. Deleting what is not there is ok.
  if ((await deleteConversation(scope, id)) === "busy") return busy();
  return NextResponse.json({ ok: true });
});
