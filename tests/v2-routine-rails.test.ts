import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, newUser, signIn } from "./helpers/session";
import { claudeOn } from "./helpers/model";
import { acct, getUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { saveTask, type Brand, type Task } from "@/lib/brand";
import { saveSchedule } from "@/lib/schedule";
import { listNotifs } from "@/lib/notifications";
import { wipeAccount } from "@/lib/account";
import {
  ROUTINES,
  ROUTINES_MAX_ACTIVE,
  ROUTINE_FAILS_PAUSE,
  ROUTINE_IDS,
  ROUTINE_MIN_GAP_MS,
  dueRoutines,
  type RoutineId,
} from "@/lib/routines";
import * as scheduleRoute from "@/app/api/schedule/route";

/**
 * Rules 4720-4729 (docs/system/tests/4720-v2-team.md): Thakeen v2 phase 3, the routine rails (C8). A routine runs at most
 * once a day, a brand runs at most ROUTINES_MAX_ACTIVE of them, and after ROUTINE_FAILS_PAUSE failed runs in a row it
 * pauses, tells the owner once and charges nothing until the owner switches it on again.
 */
const brand: Brand = {
  name: "مقهى الفنجان",
  website: "",
  industry: "مقاهي",
  dialect: "saudi",
  languages: ["ar"],
  tone: "ودود",
  products: "قهوة مختصة",
  audience: "الرياض",
  offers: "",
  competitors: "",
  banned: "",
  preferred: "",
  channels: ["instagram"],
  city: "الرياض",
  updatedAt: "2026-09-29T00:00:00.000Z",
};
const item = (id: string): Task => ({
  id,
  type: "social",
  channel: "instagram",
  title: `title ${id}`,
  body: "نص العنصر",
  status: "pending",
  createdAt: new Date().toISOString(),
  lang: "ar",
  source: "manual",
});
const RID: RoutineId = "dana_weekly_report";
const railKey = (u: User) => `routinerail:${acct(u)}:${RID}`;

/** An owner whose only routine on is Dana's, with fresh activity so her gate passes. */
async function owner(prefix: string): Promise<User> {
  const u = await newUser(prefix);
  const routines = Object.fromEntries(ROUTINE_IDS.map((id) => [id, id === RID])) as Record<RoutineId, boolean>;
  await Promise.all([db.set(`brand:${acct(u)}`, brand), saveSchedule(acct(u), { routines })]);
  await saveTask(acct(u), item("n1"), true);
  return { ...(await getUser(acct(u)))!, scope: acct(u) };
}

/** The SDK, replaced: every generation throws, or answers one item; `made` counts clients. */
function sdk(opts: { genFails: { on: boolean } }) {
  vi.resetModules();
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  claudeOn();
  const seen = { made: 0 };
  const reply = (text: string) => ({
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 100 },
    content: [{ type: "text", text }],
  });
  const verdict = {
    completeness: 90,
    brand: 90,
    honesty: 90,
    language: 90,
    format: 90,
    autofail: null,
    notes: "ready",
  };
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      static BadRequestError = class extends Error {};
      constructor() {
        seen.made++;
      }
      beta = {
        messages: {
          stream: () => ({
            finalMessage: async () => {
              if (opts.genFails.on) throw new Error("model down");
              return reply(JSON.stringify([{ channel: "doc", title: "t", body: "نص تجريبي للعنصر يكفي للمراجعة" }]));
            },
          }),
        },
      };
      messages = {
        create: async () => reply(JSON.stringify([verdict])),
        stream: () => ({ finalMessage: async () => reply(JSON.stringify([verdict])) }),
      };
    },
  }));
  return seen;
}
const load = () => import("@/lib/routines");

afterEach(() => {
  vi.doUnmock("@anthropic-ai/sdk");
  vi.doUnmock("@/lib/model");
  vi.unstubAllEnvs();
});

describe("rules 4720-4721: at most once a day, at most ROUTINES_MAX_ACTIVE a brand", () => {
  it("the gap is under a day but never less than 20 hours, and the runner checks it after the period", () => {
    expect(ROUTINE_MIN_GAP_MS).toBe(20 * 3600e3);
    const src = readFileSync("src/lib/routines.ts", "utf8");
    const period = src.indexOf('if (ranThisPeriod(r.cadence, last)) return "already_this_period";');
    const gap = src.indexOf('if (last && Date.now() - Date.parse(last) < ROUTINE_MIN_GAP_MS) return "too_soon";');
    expect(period).toBeGreaterThan(0);
    expect(gap).toBeGreaterThan(period);
    // No cadence shorter than a week exists to need more.
    for (const r of ROUTINES) expect(["weekly", "monthly"]).toContain(r.cadence);
  });
  it("the list fits the cap, and the cron takes no more than the cap of it", () => {
    expect(ROUTINES.length).toBeLessThanOrEqual(ROUTINES_MAX_ACTIVE);
    expect(readFileSync("src/lib/routines.ts", "utf8")).toContain(
      "ROUTINES.filter((r) => routineOn(sched, r.id)).slice(0, ROUTINES_MAX_ACTIVE)",
    );
  });
});

describe("rules 4722-4724: three failures in a row pause the routine until the owner resumes it", () => {
  it("pauses on the third failure, tells the owner once, then runs nothing until switched on again", async () => {
    const fails = { on: true };
    const seen = sdk({ genFails: fails });
    const { runRoutine } = await load();
    const u = await owner("rail-pause");
    for (let i = 1; i < ROUTINE_FAILS_PAUSE; i++) {
      await expect(runRoutine(u, RID)).rejects.toThrow("model down");
      expect(await db.get(railKey(u))).toEqual({ fails: i, last: "error" });
    }
    expect(await dueRoutines([u])).toEqual([{ user: u, id: RID }]);
    await expect(runRoutine(u, RID)).rejects.toThrow("model down");
    const rail = await db.get<{ fails: number; pausedAt?: string }>(railKey(u));
    expect(rail).toMatchObject({ fails: ROUTINE_FAILS_PAUSE, last: "error" });
    expect(rail?.pausedAt).toBeTruthy();
    const notices = (await listNotifs(acct(u))).filter((n) => n.kind === "info" && n.agent === "dana");
    expect(notices).toHaveLength(1);
    expect(notices[0].href).toContain("/tasks");
    expect(notices[0].body).toContain(String(ROUTINE_FAILS_PAUSE));

    // Paused: the cron skips it and a run answers "paused" with no model call and no charge.
    expect(await dueRoutines([u])).toEqual([]);
    const made = seen.made;
    const credits = (await getUser(acct(u)))!.credits;
    expect(await runRoutine(u, RID)).toBe("paused");
    expect(seen.made).toBe(made);
    expect((await getUser(acct(u)))!.credits).toBe(credits);
    expect((await listNotifs(acct(u))).filter((n) => n.kind === "info" && n.agent === "dana")).toHaveLength(1);

    // The owner's switch on resumes it: the rail goes, and the next run is a normal run.
    await signIn(u.email);
    const res = await scheduleRoute.PUT(json("/api/schedule", "PUT", { routines: { [RID]: true } }));
    expect(res.status).toBe(200);
    expect(await db.get(railKey(u))).toBeNull();
    fails.on = false;
    expect(await runRoutine(u, RID)).toBe("ok:1");
  });

  it("a run that made items clears the count; one that ran nothing leaves it", async () => {
    const fails = { on: true };
    sdk({ genFails: fails });
    const { runRoutine } = await load();
    const u = await owner("rail-reset");
    await expect(runRoutine(u, RID)).rejects.toThrow("model down");
    await expect(runRoutine(u, RID)).rejects.toThrow("model down");
    // Switched off by the owner: "off" ran nothing, the count stays.
    await saveSchedule(acct(u), { routines: { [RID]: false } });
    expect(await runRoutine(u, RID)).toBe("off");
    expect(await db.get(railKey(u))).toEqual({ fails: 2, last: "error" });
    await saveSchedule(acct(u), { routines: { [RID]: true } });
    fails.on = false;
    expect(await runRoutine(u, RID)).toBe("ok:1");
    expect(await db.get(railKey(u))).toBeNull();
  });

  it("switching a routine off does not resume it, and only the caller's own brand is touched", async () => {
    const u = await owner("rail-off");
    const other = await owner("rail-other");
    const paused = { fails: 3, last: "error", pausedAt: new Date().toISOString() };
    await Promise.all([db.set(railKey(u), paused), db.set(railKey(other), paused)]);
    await signIn(u.email);
    await scheduleRoute.PUT(json("/api/schedule", "PUT", { routines: { [RID]: false } }));
    expect(await db.get(railKey(u))).toEqual(paused);
    await scheduleRoute.PUT(json("/api/schedule", "PUT", { routines: { [RID]: true }, scope: acct(other) }));
    expect(await db.get(railKey(u))).toBeNull();
    expect(await db.get(railKey(other))).toEqual(paused);
  });

  it("the page shows the pause and the wipe deletes the rail", async () => {
    const panel = readFileSync("src/components/app/TasksPanel.tsx", "utf8");
    expect(panel).toContain("{r.paused && (");
    expect(panel).toContain("{!readOnly && <button");
    expect(readFileSync("src/app/[lang]/app/b/[brand]/tasks/page.tsx", "utf8")).toContain("routinesPaused(sc(u))");
    const u = await owner("rail-wipe");
    await db.set(railKey(u), { fails: 1, last: "error" });
    await wipeAccount(acct(u));
    expect(await db.get(railKey(u))).toBeNull();
  });
});
