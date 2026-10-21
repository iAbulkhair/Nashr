import { describe, expect, it } from "vitest";
import { newUser } from "./helpers/session";
import { saveConnection, type Connection } from "@/lib/connectors/store";
import { followUps, type Notif } from "@/lib/notifications";

/**
 * Rule 2200 (docs/system/tests/2160-integrations-panel-drift.md): a connection a platform refused (`needsReconnect`)
 * puts one bell entry on the owner's daily follow-ups, pointing at Settings > Connections, once per refusal and again a
 * week later while it stays broken.
 */

const conn = (provider: string, extra: Partial<Connection> = {}): Connection => ({ provider, data: { access_token: "test-token" }, meta: { account: "Shop A" }, connectedAt: "2026-10-01T00:00:00Z", ...extra });
const reconnects = (ns: Notif[]) => ns.filter((n) => n.href.endsWith("/settings/connections"));

describe("the daily follow-ups tell the owner to reconnect a refused platform (rule 2200)", () => {
  it("one entry naming every refused platform, linked to Connections, and silence on the next run", async () => {
    const u = await newUser("reconnect");
    const user = { ...u, lang: "en" as const };
    await Promise.all([
      saveConnection(u.email, conn("salla", { needsReconnect: "2026-10-18T02:00:00Z" })),
      saveConnection(u.email, conn("x", { needsReconnect: "2026-10-17T14:00:00Z", meta: { via: "composio" } })),
      saveConnection(u.email, conn("shopify")),
    ]);
    const first = reconnects(await followUps(user, u.email));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "info", href: "/en/app/b/default/settings/connections" });
    expect(first[0].title).toBe("Reconnect Salla (سلة), X");
    expect(first[0].title).not.toContain("Shopify");
    expect(JSON.stringify(first[0])).not.toContain("test-token");
    expect(reconnects(await followUps(user, u.email)), "same refusal, same week").toHaveLength(0);
  });

  it("a new refusal of the same platform is a new entry; a healthy workspace gets none", async () => {
    const u = await newUser("reconnect-again");
    const user = { ...u, lang: "ar" as const };
    await saveConnection(u.email, conn("salla", { needsReconnect: "2026-10-10T02:00:00Z" }));
    const first = reconnects(await followUps(user, u.email));
    expect(first).toHaveLength(1);
    expect(first[0].title).toBe("أعد ربط Salla (سلة)");
    await saveConnection(u.email, conn("salla", { needsReconnect: "2026-10-18T02:00:00Z" }));
    expect(reconnects(await followUps(user, u.email))).toHaveLength(1);

    const ok = await newUser("reconnect-none");
    await saveConnection(ok.email, conn("shopify"));
    expect(reconnects(await followUps({ ...ok, lang: "en" }, ok.email))).toHaveLength(0);
  });
});
