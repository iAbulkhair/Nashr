import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { db, seedForE2e } from "@/lib/db";
import { routinesHeld } from "@/lib/routines";
import { cronStatuses } from "@/lib/cron-heartbeat";
import { getLogin, verifyPassword } from "@/lib/auth";
import { MULTI_ORG } from "@/lib/multi-org";
import { OPAQUE_IDS } from "@/lib/account-id";
import { E2E_CRON_REPORT, HELD_ROUTINE, e2eSeed } from "../e2e/web-server";

/**
 * Rules 2590-2592: the end-to-end server starts its memory store with the two records no request can make (a run held
 * after a kill, a cron's last report), so a browser test can open both screens (`e2e/held-routine.spec.ts`). The seed is
 * read only on the test server and only into the memory store, which never runs in production (rule 430).
 */
afterEach(() => vi.unstubAllEnvs());
const seeded = (env: Record<string, string>) => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const kv = new Map<string, unknown>();
  seedForE2e(kv);
  return kv;
};

describe("rule 2590: the seed is read only on the end-to-end server", () => {
  const json = JSON.stringify({ "x:1": { a: 1 } });

  it("APP_ENV=test seeds the map; no APP_ENV, staging or production seeds nothing", () => {
    expect(seeded({ APP_ENV: "test", E2E_SEED_KV: json }).get("x:1")).toEqual({ a: 1 });
    expect(seeded({ APP_ENV: "", E2E_SEED_KV: json }).size).toBe(0);
    expect(seeded({ APP_ENV: "staging", E2E_SEED_KV: json }).size).toBe(0);
    expect(seeded({ APP_ENV: "production", E2E_SEED_KV: json }).size).toBe(0);
  });

  it("a value that is not a JSON object is ignored without throwing", () => {
    for (const bad of ["not json", "[1,2]", "null", "3"]) expect(seeded({ APP_ENV: "test", E2E_SEED_KV: bad }).size, bad).toBe(0);
  });

  it("only the memory store reads it, once, when it is first made; Upstash never does", () => {
    const src = readFileSync("src/lib/db.ts", "utf8");
    expect(src.match(/seedForE2e\(/g)).toHaveLength(2); // the definition and the one call
    expect(src).toMatch(/mem\.__nashrMem = \{ kv: new Map\(\), lists: new Map\(\), sets: new Map\(\), hashes: new Map\(\) \};\n\s+seedForE2e\(mem\.__nashrMem\.kv\);/);
    expect(src).toContain("if (!raw || !isTestServer()) return;");
  });
});

describe("rule 2591: the seed holds this month's Razan routine for the owner and stores a daily report", () => {
  it("the app's own readers see both", async () => {
    const owner = "e2e-seed-owner@test.example";
    const seed = JSON.parse(e2eSeed({ email: owner, password: "seedpass123", name: "Seed Owner" })) as Record<string, unknown>;
    await Promise.all(Object.entries(seed).map(([k, v]) => db.set(k, v)));
    expect(await routinesHeld(owner)).toEqual({ [HELD_ROUTINE]: true });
    const daily = (await cronStatuses()).find((c) => c.job === "daily");
    expect(daily?.status).toBe("ok");
    expect(daily?.report).toMatchObject(E2E_CRON_REPORT);
  });
});

describe("rule 2592: the end-to-end server is started with the seed for the seeded owner", () => {
  it("playwright.config.ts passes e2eSeed(OWNER) as E2E_SEED_KV", () => {
    const cfg = readFileSync("playwright.config.ts", "utf8");
    expect(cfg).toContain('import { OWNER } from "./e2e/fixtures/accounts";');
    expect(cfg).toContain("E2E_SEED_KV: e2eSeed(OWNER)");
  });
});

describe("rule 3827: with the switches on, the seeded owner is an account made before R2 enable and signs in", () => {
  it("its id is its address, so the held routine is its own, and its password opens it", async () => {
    expect(MULTI_ORG && OPAQUE_IDS).toBe(true);
    const owner = { email: "e2e-seed-legacy@test.example", password: "seedpass123", name: "Seed Legacy" };
    const seed = JSON.parse(e2eSeed(owner)) as Record<string, unknown>;
    expect((seed[`user:${owner.email}`] as { id?: string }).id, "a legacy record: no id field").toBeUndefined();
    await Promise.all(Object.entries(seed).map(([k, v]) => db.set(k, v)));
    const login = await getLogin(owner.email);
    expect(login?.kind).toBe("owner");
    expect(login?.acct).toBe(owner.email);
    expect(await verifyPassword(login!.person, owner.password)).toBe(true);
    expect(await verifyPassword(login!.person, "wrong-pass")).toBe(false);
    expect(await routinesHeld(owner.email)).toEqual({ [HELD_ROUTINE]: true });
  });
});
