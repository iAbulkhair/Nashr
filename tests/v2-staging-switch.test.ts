import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Rules 4820-4829 (docs/system/tests/4820-v2-staging-switch.md): the staging-only switch (`V2_STAGING_FLAGS`, read through
 * `v2On` and `gatewayMode` in src/lib/v2-switch.ts) and the credit moves a run records (`runCredits`, shown in the work view).
 * The flags module is the real one here: every flag ships off, so whatever turns on below came from the staging list.
 */
import * as flags from "@/lib/v2-flags";
import { STAGING_NAMES, gatewayMode, stagingFlags, v2On, type V2Flag } from "@/lib/v2-switch";
import { acct, createUser, getUser, sc } from "@/lib/auth";
import { charge, chargeOnce, refund, refundOnce } from "@/lib/credits";
import { MAX_CREDITS, replay, runCredits, withRun, type Run } from "@/lib/runs";
import { creditStep, workRun, workStep } from "@/lib/work-view";
import { stepLabel } from "@/components/app/RunTimeline";
import { appDict } from "@/lib/app-i18n";
import { db } from "@/lib/db";
import { wsKey } from "@/lib/keys";

const FLAGS: V2Flag[] = ["RUN_LOG", "MEMORY_V2", "COMPACTION", "PLANS", "QUEUE", "SELF_CHECK", "TEAM_CHAT", "RESEARCH"];
const src = (p: string) => readFileSync(p, "utf8");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : [];
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/v2-flags");
  vi.resetModules();
});

describe("rule 4820: V2_STAGING_FLAGS is read on the staging site only", () => {
  it("live ships every flag off in code", () => {
    for (const f of FLAGS) expect(flags[f]).toBe(false);
    expect(flags.GATEWAY_MODE).toBe("off");
  });

  it("without APP_ENV=staging the list is ignored, whatever it names (live: APP_ENV unset, VERCEL_ENV=production)", () => {
    vi.stubEnv("V2_STAGING_FLAGS", STAGING_NAMES.join(","));
    vi.stubEnv("VERCEL_ENV", "production");
    for (const env of [undefined, "", "production", "Staging", "staging "]) {
      vi.stubEnv("APP_ENV", env);
      expect(stagingFlags().size).toBe(0);
      for (const f of FLAGS) expect(v2On(f)).toBe(false);
      expect(gatewayMode()).toBe("off");
    }
  });

  it("on staging each name turns on its own flag and no other", () => {
    vi.stubEnv("APP_ENV", "staging");
    for (const f of FLAGS) {
      vi.stubEnv("V2_STAGING_FLAGS", f);
      for (const g of FLAGS) expect(v2On(g)).toBe(g === f);
      expect(gatewayMode()).toBe("off");
    }
  });

  it("on staging, unset or empty turns nothing on", () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("V2_STAGING_FLAGS", undefined);
    for (const f of FLAGS) expect(v2On(f)).toBe(false);
    vi.stubEnv("V2_STAGING_FLAGS", " , ,");
    for (const f of FLAGS) expect(v2On(f)).toBe(false);
  });
});

describe("rule 4821: the list's names, and GATEWAY_LOG", () => {
  it("names are trimmed and case-blind; an unknown name, GATEWAY_MODE or a value is ignored", () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("V2_STAGING_FLAGS", " run_log ,Research, GATEWAY_MODE, gateway_mode=enforce, PUBLISH, SELF_CHECK=1");
    expect([...stagingFlags()].sort()).toEqual(["RESEARCH", "RUN_LOG"]);
    expect(v2On("RUN_LOG")).toBe(true);
    expect(v2On("RESEARCH")).toBe(true);
    expect(v2On("SELF_CHECK")).toBe(false);
    expect(gatewayMode()).toBe("off");
  });

  it("GATEWAY_LOG puts the gateway in log mode, never enforce", () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("V2_STAGING_FLAGS", "GATEWAY_LOG");
    expect(gatewayMode()).toBe("log");
    for (const f of FLAGS) expect(v2On(f)).toBe(false);
  });
});

describe("rule 4822: read at call time, and the code value wins", () => {
  it("a change to the list is seen by the next call, with no reload", () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("V2_STAGING_FLAGS", "PLANS");
    expect(v2On("PLANS")).toBe(true);
    vi.stubEnv("V2_STAGING_FLAGS", "");
    expect(v2On("PLANS")).toBe(false);
    vi.stubEnv("V2_STAGING_FLAGS", "PLANS");
    vi.stubEnv("APP_ENV", "production");
    expect(v2On("PLANS")).toBe(false);
  });

  it("a flag released in code is on everywhere, and the list cannot change it", async () => {
    vi.doMock("@/lib/v2-flags", () => ({
      GATEWAY_MODE: "enforce",
      RUN_LOG: true,
      MEMORY_V2: false,
      COMPACTION: false,
      PLANS: false,
      QUEUE: false,
      SELF_CHECK: false,
      TEAM_CHAT: false,
      RESEARCH: false,
    }));
    const sw = await import("@/lib/v2-switch");
    vi.stubEnv("APP_ENV", "production");
    expect(sw.v2On("RUN_LOG")).toBe(true);
    expect(sw.gatewayMode()).toBe("enforce");
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("V2_STAGING_FLAGS", "GATEWAY_LOG");
    expect(sw.gatewayMode()).toBe("enforce");
  });
});

describe("rule 4823: every reader goes through the switch", () => {
  it("only v2-switch reads the flag values; gateway takes the type only", () => {
    const readers = walk("src").filter((p) => /from "(\.\/|@\/lib\/)v2-flags"/.test(src(p)));
    expect(readers.sort()).toEqual(["src/lib/gateway.ts", "src/lib/v2-switch.ts"]);
    expect(src("src/lib/gateway.ts")).toMatch(/import \{ type GatewayMode \} from "\.\/v2-flags";/);
  });

  it("the variable is read in one place, after the staging check, never from a request", () => {
    const readers = walk("src").filter((p) => src(p).includes("process.env.V2_STAGING_FLAGS"));
    expect(readers).toEqual(["src/lib/v2-switch.ts"]);
    expect(src("src/lib/v2-switch.ts")).toMatch(
      /if \(!isStaging\(\)\) return new Set\(\);\n\s+const raw = process\.env\.V2_STAGING_FLAGS/,
    );
  });

  it("the judge's web-claim rule follows RESEARCH through the switch, read when the server starts", () => {
    expect(src("src/lib/judge.ts")).toMatch(
      /invented_fact: v2On\("RESEARCH"\) \? INVENTED_FACT \+ WEB_CLAIM : INVENTED_FACT,/,
    );
  });

  it("the variable is documented", () => {
    expect(src("docs/system/variables.md")).toContain("`V2_STAGING_FLAGS`");
  });
});

let n = 0;
async function fresh() {
  const id = acct(
    await createUser({
      email: `sw-credits${++n}@test.example`,
      name: "T",
      phone: "",
      password: "abc12345",
      lang: "ar",
    }),
  );
  return { id, scope: sc((await getUser(id))!) };
}
/** Runs `fn` as one batch run (the log switched on by argument) and reads back the record it wrote. */
async function inRun(scope: ReturnType<typeof sc>, fn: () => Promise<unknown>): Promise<Run> {
  await withRun({ scope, kind: "batch", label: "post" }, async () => void (await fn()), true);
  const [rid] = await db.lrange(wsKey.runs(scope), 0, 0);
  return (await db.get<Run>(wsKey.run(scope, rid)))!;
}

describe("rules 4825-4827: a run records the credits it moved", () => {
  it("a charge and its refund inside a run are recorded in order, beside the events", async () => {
    const { id, scope } = await fresh();
    const run = await inRun(scope, async () => {
      await charge(id, 10);
      await refund(id, 4);
    });
    expect(run.credits?.map((c) => c.credits)).toEqual([10, -4]);
    expect(run.events).toEqual([]);
    expect(replay(run).credits).toBe(6);
  });

  it("a refused charge records nothing, and outside a run nothing is recorded or thrown", async () => {
    const { id, scope } = await fresh();
    const run = await inRun(scope, async () => {
      expect((await charge(id, 999)).ok).toBe(false);
    });
    expect(run.credits).toBeUndefined();
    expect((await charge(id, 1)).ok).toBe(true);
    expect(() => runCredits(5)).not.toThrow();
  });

  it("chargeOnce records once; a reused claim records nothing and refundOnce gives it back", async () => {
    const { id, scope } = await fresh();
    const meta = { scope: String(scope), agent: "noor" as const };
    const run = await inRun(scope, async () => {
      await chargeOnce(id, 3, meta, "claim-1");
      await chargeOnce(id, 3, meta, "claim-1");
      await refundOnce(id, "claim-1");
    });
    expect(run.credits?.map((c) => c.credits)).toEqual([3, -3]);
  });

  it("past MAX_CREDITS moves the rest are counted in dropped; 0 and NaN are not moves", async () => {
    const { scope } = await fresh();
    const run = await inRun(scope, async () => {
      for (let i = 0; i < MAX_CREDITS + 3; i++) runCredits(1);
      runCredits(0);
      runCredits(Number.NaN);
    });
    expect(run.credits).toHaveLength(MAX_CREDITS);
    expect(run.dropped).toBe(3);
  });
});

describe("rules 4828-4829: the work view shows the moves, and old readers stay safe", () => {
  const base: Run = {
    v: 1,
    id: "r1",
    kind: "batch",
    startedAt: new Date().toISOString(),
    ms: 900,
    ok: true,
    events: [{ t: "check", at: 50, score: 80, rewritten: false }],
    dropped: 0,
  };

  it("charge steps sit among the steps in time order, and the run shows the net", () => {
    const w = workRun({
      ...base,
      credits: [
        { at: 10, credits: 10 },
        { at: 90, credits: -4 },
      ],
    });
    expect(w.steps.map((s) => s.kind)).toEqual(["charge", "check", "charge"]);
    expect(w.credits).toBe(6);
    expect(stepLabel(appDict.ar, creditStep({ at: 10, credits: 10 }))).toBe("10 رصيد");
    expect(stepLabel(appDict.ar, creditStep({ at: 90, credits: -4 }))).toBe("أُعيد 4 رصيد");
    expect(stepLabel(appDict.en, creditStep({ at: 90, credits: -4 }))).toBe("4 credits given back");
  });

  it("a run written before rule 4825 reads as no credits", () => {
    expect(workRun(base).credits).toBe(0);
    expect(replay(base).credits).toBe(0);
  });

  it("an event kind this code does not know is skipped, never a crash", () => {
    expect(workStep({ t: "later", at: 1 } as never)).toBeNull();
    expect(workRun({ ...base, events: [...base.events, { t: "later", at: 60 } as never] }).steps).toHaveLength(1);
  });
});
