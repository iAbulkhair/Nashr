import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { newUser } from "./helpers/session";
import { PROVIDER_REPLY_BYTES, STORE_REPLY_BYTES } from "@/lib/read-capped";
import { importSalla } from "@/lib/connectors/salla";
import { refreshTokens } from "@/lib/connectors/oauth";
import { getProvider } from "@/lib/connectors/registry";
import { postToX } from "@/lib/connectors/x";
import { readFile } from "@/lib/files";
import type { Connection } from "@/lib/connectors/store";

/**
 * Rule 2250 (docs/system/tests/2250-connector-leftovers.md): a reply from a provider at a fixed host (Shopify, Salla,
 * Zid, Meta, Meta Ads, X, an OAuth token URL, Telegram, Brevo, Klaviyo) is read through `responseJson` or
 * `responseText` with PROVIDER_REPLY_BYTES, as rule 2245 does for hosts the owner types in. A refusal too large to read
 * still reports its status, so a revoked token is still told from a passing failure.
 */

const MB = 1024 * 1024;
function endless(status = 200) {
  const seen = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      seen.pulls++;
      ctl.enqueue(new Uint8Array(MB).fill(0x20));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { res: new Response(body, { status, headers: { "content-type": "application/json" } }), seen };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("replies from fixed-host providers are read up to a cap (rule 2250)", () => {
  it("the cap is the store cap, 8 MB", () => {
    expect(PROVIDER_REPLY_BYTES).toBe(STORE_REPLY_BYTES);
    expect(PROVIDER_REPLY_BYTES).toBe(8 * MB);
  });

  it("a Salla catalog page that never ends fails the import, stops at the cap and leaves products.md alone", async () => {
    const ws = await newUser("provcap").then((u) => u.email);
    const e = endless();
    vi.stubGlobal("fetch", vi.fn(async () => e.res));
    const salla: Connection = { provider: "salla", data: { access_token: "t" }, connectedAt: new Date().toISOString() };
    await expect(importSalla(ws, salla)).rejects.toThrow("too_large");
    expect(e.seen.pulls).toBeLessThanOrEqual(PROVIDER_REPLY_BYTES / MB + 2);
    expect(e.seen.cancelled).toBe(true);
    expect(await readFile(ws, "products.md")).toBeNull();
  });

  it("an OAuth token refusal too large to read keeps its status; a success too large to read throws", async () => {
    vi.stubEnv("SALLA_CLIENT_ID", "id");
    vi.stubEnv("SALLA_CLIENT_SECRET", "secret");
    const p = getProvider("salla")!;
    vi.stubGlobal("fetch", vi.fn(async () => endless(400).res));
    await expect(refreshTokens(p, "r")).rejects.toThrow(/^salla token 400$/);
    vi.stubGlobal("fetch", vi.fn(async () => endless(200).res));
    await expect(refreshTokens(p, "r")).rejects.toThrow("too_large");
  });

  it("an X refusal too large to read keeps its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => endless(401).res));
    const x: Connection = { provider: "x", data: { access_token: "t" }, connectedAt: new Date().toISOString() };
    await expect(postToX(x, "hello")).rejects.toThrow(/^x 401: $/);
  });

  it("no fixed-host connector reads a reply with res.json(), res.text(), arrayBuffer() or blob()", () => {
    const code = (path: string) => readFileSync(path, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    const files = ["shopify", "salla", "zid", "meta", "ads", "x", "oauth", "keyed"].map((f) => `src/lib/connectors/${f}.ts`);
    for (const f of files) {
      const src = code(f);
      expect(src, f).not.toMatch(/\.(?:json|text|arrayBuffer|blob)\(\)/);
      expect(src, f).toMatch(/PROVIDER_REPLY_BYTES|STORE_REPLY_BYTES/);
    }
  });
});
