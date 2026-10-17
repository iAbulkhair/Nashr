import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { newUser } from "./helpers/session";
import { sc } from "@/lib/auth";
import { activeBrandId, listBrands, saveBrands } from "@/lib/brands";
import { getConnection, listConnections, saveConnection } from "@/lib/connectors/store";
import { createConversation, getConversation, listConversations, touchConversation } from "@/lib/conversations";
import { db } from "@/lib/db";
import { accountKey, wsKey } from "@/lib/keys";
import { log } from "@/lib/log";
import { parseStored } from "@/lib/stored";

/**
 * Rules 2035-2039: stored shapes checked when they are read (src/lib/stored.ts). A record that does not fit is logged
 * without values and read as a safe default; every shape the app has written still reads as before.
 */

afterEach(() => vi.restoreAllMocks());
const warns = () => vi.spyOn(log, "warn");

describe("rule 2035: parseStored never throws and logs only the shape, paths and codes", () => {
  const S = z.looseObject({ id: z.string(), n: z.number() });

  it("absent is the fallback with no log; a fitting value comes back as is, unknown fields kept", () => {
    const w = warns();
    expect(parseStored("t", S, null, "fb")).toBe("fb");
    expect(parseStored("t", S, undefined, "fb")).toBe("fb");
    expect(parseStored("t", S, { id: "a", n: 1, extra: true }, null)).toEqual({ id: "a", n: 1, extra: true });
    expect(w).not.toHaveBeenCalled();
  });

  it("a value that does not fit is the fallback, logged once without the value", () => {
    const w = warns();
    const secret = "sk-live-should-never-be-logged-1234567890";
    expect(parseStored("t", S, { id: secret, n: "x" }, null)).toBeNull();
    expect(parseStored("t", S, "not an object", "fb")).toBe("fb");
    expect(w).toHaveBeenCalledTimes(2);
    expect(w.mock.calls[0][0]).toBe("stored shape invalid");
    expect(w.mock.calls[0][1]).toEqual({ shape: "t", issues: [{ path: "n", code: "invalid_type" }] });
    expect(JSON.stringify(w.mock.calls)).not.toContain(secret);
  });
});

describe("rule 2036: brands:{email} is checked row by row", () => {
  it("a value that is not a list reads as the default brand only", async () => {
    const u = await newUser("shape");
    await db.set(accountKey.brands(u.email), { not: "a list" });
    const w = warns();
    expect((await listBrands(u.email)).map((b) => b.id)).toEqual(["default"]);
    expect(w).toHaveBeenCalledTimes(1);
  });

  it("a row without an id is left out, the others stay; an old row without status reads as active", async () => {
    const u = await newUser("shape");
    await db.set(accountKey.brands(u.email), [
      { id: "default", name: "", createdAt: "2026-01-01T00:00:00.000Z", status: "active" },
      { name: "no id" },
      { id: "b2", name: "Second", createdAt: "2026-02-01T00:00:00.000Z" },
    ]);
    const rows = await listBrands(u.email);
    expect(rows.map((b) => [b.id, b.status])).toEqual([["default", "active"], ["b2", "active"]]);
  });

  it("a field a newer release added survives a read-modify-write", async () => {
    const u = await newUser("shape");
    await db.set(accountKey.brands(u.email), [{ id: "default", name: "", createdAt: "x", status: "active", color: "teal" }]);
    await saveBrands(u.email, await listBrands(u.email));
    expect(await db.get(accountKey.brands(u.email))).toEqual([{ id: "default", name: "", createdAt: "x", status: "active", color: "teal" }]);
  });
});

describe("rule 2037: activebrand:{login}", () => {
  it("a stored id comes back; absent or malformed is the default brand; a number is text again", async () => {
    const u = await newUser("shape");
    expect(await activeBrandId(u.email)).toBe("default");
    await db.set(accountKey.activeBrand(u.email), "ab12cd34");
    expect(await activeBrandId(u.email)).toBe("ab12cd34");
    await db.set(accountKey.activeBrand(u.email), 12345678);
    expect(await activeBrandId(u.email)).toBe("12345678");
    await db.set(accountKey.activeBrand(u.email), { id: "x" });
    expect(await activeBrandId(u.email)).toBe("default");
  });
});

describe("rule 2038: conn:{scope}:{provider}", () => {
  it("a record without enc reads as not connected instead of throwing; good records still list", async () => {
    const u = await newUser("shape");
    const s = sc(u);
    await saveConnection(s, { provider: "shopify", data: { token: "t" }, meta: { shop: "x" }, connectedAt: "2026-10-01T00:00:00.000Z" });
    await db.set(wsKey.conn(s, "meta"), { provider: "meta", connectedAt: "2026-10-01T00:00:00.000Z" });
    await db.sadd(wsKey.conns(s), "meta");
    const w = warns();
    await expect(getConnection(s, "meta")).resolves.toBeNull();
    expect((await listConnections(s)).map((c) => c.provider)).toEqual(["shopify"]);
    expect(w).toHaveBeenCalled();
    expect((await getConnection(s, "shopify"))?.data).toEqual({ token: "t" });
  });

  it("a record sealed before key versions (no kid) and with a bad display field still opens", async () => {
    const u = await newUser("shape");
    const s = sc(u);
    await saveConnection(s, { provider: "ga4", data: { token: "t" }, connectedAt: "2026-10-01T00:00:00.000Z" });
    const raw = (await db.get<Record<string, unknown>>(wsKey.conn(s, "ga4")))!;
    delete raw.kid;
    await db.set(wsKey.conn(s, "ga4"), { ...raw, meta: "not a map" });
    const c = await getConnection(s, "ga4");
    expect(c?.data).toEqual({ token: "t" });
    expect(c?.meta).toBeUndefined();
  });
});

describe("rule 2039: conv:{scope}:{id}", () => {
  it("an old record without count reads as 0 and counts on from there; a record without an id is absent", async () => {
    const u = await newUser("shape");
    const s = sc(u);
    const c = await createConversation(s, "hi");
    await db.set(wsKey.conv(s, c.id), { id: c.id, title: "old", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    expect((await getConversation(s, c.id))?.count).toBe(0);
    await touchConversation(s, c.id);
    expect((await getConversation(s, c.id))?.count).toBe(1);

    const bad = await createConversation(s, "bad");
    await db.set(wsKey.conv(s, bad.id), { title: "no id" });
    await expect(getConversation(s, bad.id)).resolves.toBeNull();
    expect((await listConversations(s)).map((x) => x.id)).toEqual([c.id]);
  });
});
