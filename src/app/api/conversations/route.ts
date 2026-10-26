import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api-handler";
import { isAgentId } from "@/lib/agents";
import { createConversation, deleteConversation, listConversations, renameConversation, searchConversations, setConversationOwner } from "@/lib/conversations";
import { entitlements } from "@/lib/entitlements";
import { v2On } from "@/lib/v2-switch";
import { retryAfter } from "@/lib/rate";

const busy = () => NextResponse.json({ ok: false, error: "busy" }, { status: 503, headers: retryAfter(1) });

export const GET = handler({ auth: "user", query: z.object({ q: z.string().optional() }) }, async ({ scope, query: { q } }) => {
  if (q) return NextResponse.json({ ok: true, hits: await searchConversations(scope, q) });
  return NextResponse.json({ ok: true, conversations: await listConversations(scope) });
});

export const POST = handler({ auth: "user", role: "conversations", input: z.looseObject({ title: z.string().optional(), agent: z.unknown() }) }, async ({ scope, input: b }) =>
  NextResponse.json({ ok: true, conversation: await createConversation(scope, b.title ?? "…", isAgentId(b.agent) ? b.agent : "noor") }),
);

export const PATCH = handler({ auth: "user", role: "conversations", input: z.object({ id: z.string().min(1), title: z.string().min(1) }) }, async ({ scope, input: b }) => {
  // Under the conversation's lock (src/lib/conversations.ts): `busy` when it was not taken in time, nothing renamed.
  if ((await renameConversation(scope, b.id, b.title)) === "busy") return busy();
  return NextResponse.json({ ok: true });
});

export const DELETE = handler({ auth: "user", role: "conversations", query: z.object({ id: z.string().min(1) }) }, async ({ scope, query: { id } }) => {
  // Under the conversation's lock: `busy` when it was not taken in time, nothing deleted. Deleting what is not there is ok.
  if ((await deleteConversation(scope, id)) === "busy") return busy();
  return NextResponse.json({ ok: true });
});

/**
 * The person's press on a teammate card (v2 C12, rules 4746-4748): `{id, owner}` makes `owner` the agent who owns the
 * requests of the caller's own conversation `id`. The only way ownership moves; no model or tool reaches it. 404 while
 * team chat is off and for a conversation the caller's scope does not hold, `bad_agent` (400) for an agent the plan does not include.
 */
export const PUT = handler({ auth: "user", role: "conversations", input: z.object({ id: z.string().min(1), owner: z.unknown() }) }, async ({ u, scope, input: b }) => {
  if (!v2On("TEAM_CHAT")) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!isAgentId(b.owner) || !entitlements(u).agents.includes(b.owner)) return NextResponse.json({ ok: false, error: "bad_agent" }, { status: 400 });
  const r = await setConversationOwner(scope, b.id, b.owner);
  if (r === "busy") return busy();
  if (r === "not_found") return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, owner: b.owner });
});
