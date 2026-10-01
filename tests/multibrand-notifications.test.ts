import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { newUser, settle } from "./helpers/session";
import { getUser, type User } from "@/lib/auth";
import { saveBrand, saveTask, type Brand, type Task } from "@/lib/brand";
import { addBrand, scopeFor } from "@/lib/brands";
import { db } from "@/lib/db";
import { brandFingerprint, followUps, listNotifs, seenKey } from "@/lib/notifications";
import { runWeekly, saveSchedule } from "@/lib/schedule";

/**
 * A multi-brand account hears about every brand (#15). The daily and weekly jobs run once per brand, but the dedupe
 * marker is per account, and its fingerprint (`due:{day}`, `pending:{n}`, `weekly:{day}`) had no brand in it: the first
 * brand processed claimed it and the same notice for every other brand was dropped. Rules 374-376 in docs/system/tests.md.
 */
const file = (name: string): Brand => ({ name, website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "beans", audience: "locals", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "Riyadh", updatedAt: "2026-09-29T00:00:00.000Z" });
const today = () => new Date().toISOString().slice(0, 10);
const dueTask = (id: string): Task => ({ id, type: "social", channel: "instagram", title: `Post ${id}`, body: "Body", status: "approved", createdAt: new Date().toISOString(), lang: "en", scheduledFor: today() });

/** One account with its default brand and one added brand, each with a brand file and an approved item due today. */
async function twoBrands(): Promise<{ u: User; a: User; b: User; scopeB: string }> {
  const u = await newUser("mb");
  const added = await addBrand({ ...u, actor: { kind: "owner", email: u.email, name: u.name, lang: u.lang, role: "owner" } }, "Second Roastery");
  if ("error" in added) throw new Error(added.error);
  const scopeB = scopeFor(u.email, added.id);
  await Promise.all([saveBrand(u.email, file("First Roastery")), saveBrand(scopeB, file("Second Roastery file"))]);
  await Promise.all([saveTask(u.email, dueTask("a1"), true), saveTask(scopeB, dueTask("b1"), true)]);
  const fresh = (await getUser(u.email))!;
  return { u: fresh, a: { ...fresh, brandId: "default", scope: u.email }, b: { ...fresh, brandId: added.id, scope: scopeB }, scopeB };
}

describe("each brand of an account gets its own follow-ups (rule 374)", () => {
  it("both brands' due items notify, each names its brand, and a second run repeats neither", async () => {
    const { u, a, b, scopeB } = await twoBrands();
    const first = (await followUps(a, a.scope!)).filter((n) => n.kind === "due");
    const second = (await followUps(b, scopeB)).filter((n) => n.kind === "due");
    expect(first, "the default brand").toHaveLength(1);
    expect(second, "the added brand, silenced before the fix").toHaveLength(1);
    expect(first[0].title).toContain("First Roastery");
    expect(second[0].title, "the name given to the brand, as the switcher shows it").toContain("Second Roastery");
    expect((await listNotifs(u.email)).filter((n) => n.kind === "due")).toHaveLength(2);

    expect((await followUps(a, a.scope!)).filter((n) => n.kind === "due"), "still once a day per brand").toHaveLength(0);
    expect((await followUps(b, scopeB)).filter((n) => n.kind === "due")).toHaveLength(0);
  });

  it("the default brand keeps its old fingerprint, so a notice already sent today is not repeated on the day this ships", async () => {
    const { u, a } = await twoBrands();
    // What the previous code claimed for today's run of the default brand.
    await db.setNx(seenKey(u.email, `due:${today()}`), 1, 2 * 86400);
    expect((await followUps(a, a.scope!)).filter((n) => n.kind === "due")).toHaveLength(0);
    expect(brandFingerprint(u.email, "due:2026-10-01")).toBe("due:2026-10-01");
    expect(brandFingerprint(`${u.email}#abc123`, "due:2026-10-01")).toBe("due:2026-10-01#abc123");
  });

  it("an account with one brand gets the title it always had, with no brand name", async () => {
    const u = await newUser("mb1");
    await saveBrand(u.email, file("Only Roastery"));
    await saveTask(u.email, dueTask("o1"), true);
    const [n] = (await followUps({ ...u, scope: u.email }, u.email)).filter((x) => x.kind === "due");
    expect(n.title).not.toContain("Only Roastery");
    expect(n.title).not.toContain(" — ");
  });
});

describe("each brand's Sunday plan notifies (rule 375)", () => {
  it("two brands' weekly plans give two weekly notices", async () => {
    const { u, a, b, scopeB } = await twoBrands();
    await saveSchedule(scopeB, { weeklyPlan: true });
    expect(await runWeekly(a)).toMatch(/^ok:/);
    expect(await runWeekly(b)).toMatch(/^ok:/);
    await settle();
    const weekly = (await listNotifs(u.email)).filter((n) => n.kind === "weekly");
    expect(weekly, "the second brand's notice was dropped before the fix").toHaveLength(2);
    expect(weekly.map((n) => n.title).join(" | ")).toContain("Second Roastery");
  });
});

describe("brand-level fingerprints carry the brand scope (rule 376)", () => {
  it("every due, pending and weekly fingerprint in the code goes through brandFingerprint", () => {
    const src = readFileSync("src/lib/notifications.ts", "utf8") + readFileSync("src/lib/schedule.ts", "utf8");
    // `weeklyClaim` (schedule.ts, rule 333) is the Sunday plan's credit hold key `weekly:{scope}:{week}` in
    // `User.paidOnce`, not a notification fingerprint; it already carries the brand scope.
    const claim = /export const weeklyClaim = \(scope: string[^\n]*`weekly:\$\{scope\}:/;
    expect(src).toMatch(claim);
    const scan = src.replace(claim, "");
    const fps = [...scan.matchAll(/`(due|pending|weekly):\$\{/g)].map((m) => scan.slice(Math.max(0, m.index! - 40), m.index!));
    expect(fps.length).toBeGreaterThanOrEqual(3);
    for (const at of fps) expect(at, at).toMatch(/brandFingerprint\((scope|email), $/);
  });
});
