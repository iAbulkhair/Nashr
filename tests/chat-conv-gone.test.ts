import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { currentUser, sc } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { monthKey } from "@/lib/credits";
import { chatMsgKey } from "@/lib/usage";
import { wsKey } from "@/lib/keys";
import { createConversation, deleteConversation } from "@/lib/conversations";
import { json, newUser, signIn, signOut } from "./helpers/session";
import { POST } from "@/app/api/chat/route";

/**
 * Rule 2933: POST /api/chat with a `conv` that has no record under the caller's scope (deleted in another tab, or never
 * made) is 404 `conversation_gone` before any count, reservation or save, so no `chat:{scope}:{conv}` history is
 * written outside the `convs:` index the account wipe walks.
 */
afterEach(() => { signOut(); });

const send = (conv: string) => POST(json("http://localhost/api/chat", "POST", { text: "مرحبا", conv }));

describe("rule 2933: a turn never creates a conversation", () => {
  it("an id this scope never made, or a malformed one, is refused and nothing is written", async () => {
    const owner = await newUser("cg");
    await signIn(owner.email);
    const scope = sc((await currentUser())!);
    for (const conv of ["abc123def456", "../x", "a".repeat(80)]) {
      const r = await send(conv);
      expect(r.status, conv).toBe(404);
      expect(await r.json()).toEqual({ ok: false, error: "conversation_gone" });
    }
    expect(await db.get(wsKey.chat(scope, "abc123def456"))).toBeNull();
    expect(await db.get(wsKey.conv(scope, "abc123def456"))).toBeNull();
    expect(Number((await db.get(chatMsgKey(acct(owner), monthKey()))) ?? 0)).toBe(0);
  });

  it("a deleted conversation is refused the same way", async () => {
    const owner = await newUser("cgd");
    await signIn(owner.email);
    const scope = sc((await currentUser())!);
    const c = await createConversation(scope, "…");
    expect(await deleteConversation(scope, c.id)).toBe("ok");
    expect((await send(c.id)).status).toBe(404);
    expect(await db.get(wsKey.chat(scope, c.id))).toBeNull();
  });
});
