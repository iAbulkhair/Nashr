import { describe, expect, it } from "vitest";
import { json, newUser, signIn } from "./helpers/session";
import { adCodeIndex, getTask, saveTask, type Task } from "@/lib/brand";
import { codesIn, newAdCode } from "@/lib/ad-codes";
import { analyze, readRows } from "@/lib/perf-import";
import { getPerf } from "@/lib/perf-store";
import { readFile } from "@/lib/files";
import * as route from "@/app/api/performance/route";

const task = (id: string, type: Task["type"] = "ads"): Task => ({ id, type, channel: "snapchat", title: id, body: "نص الإعلان", status: "approved", createdAt: new Date().toISOString(), lang: "ar" });

describe("ad codes (rule 90)", () => {
  it("are NSR- plus five characters that cannot be misread", () => {
    for (let i = 0; i < 200; i++) expect(newAdCode()).toMatch(/^NSR-[2-9A-HJKMNP-Z]{5}$/);
  });
  it("are found however the owner typed them, and never from look-alike characters", () => {
    expect(codesIn("Ramadan | NSR-7K2QM | v2")).toEqual(["NSR-7K2QM"]);
    expect(codesIn("nsr_7k2qm and NSR 7K2QM")).toEqual(["NSR-7K2QM"]);
    expect(codesIn("NSR-0OIL1 NSR-7K2Q NSR7K2QMX")).toEqual([]);
  });
  it("are given to every new ad and social item, indexed once, kept on later saves, and not given to other types", async () => {
    const u = await newUser("codes");
    const ad = task("ad1"), post = task("post1", "social"), plan = task("plan1", "weekly_plan");
    await Promise.all([saveTask(u.email, ad, true), saveTask(u.email, post, true), saveTask(u.email, plan, true)]);
    const [a, p, w] = await Promise.all([getTask(u.email, "ad1"), getTask(u.email, "post1"), getTask(u.email, "plan1")]);
    expect(a!.adCode).toMatch(/^NSR-/);
    expect(p!.adCode).toMatch(/^NSR-/);
    expect(w!.adCode).toBeUndefined();
    await saveTask(u.email, { ...a!, status: "pending" });
    expect((await getTask(u.email, "ad1"))!.adCode).toBe(a!.adCode);
    expect(await adCodeIndex(u.email)).toEqual({ [a!.adCode!]: "ad1", [p!.adCode!]: "post1" });
  });
});

/** Nine ads: three carry Thakeen codes and did clearly better on CTR; one carries a code this workspace never issued. */
const csv = (codes: string[]) => [
  "Ad name,Impressions,Link clicks,Amount spent,Purchases",
  `"Friday offer ${codes[0]}",9000,360,300,9`,
  `"New roast ${codes[1]}",8000,300,280,7`,
  `"Gift box ${codes[2]}",7000,260,260,6`,
  `"Someone else's NSR-22222",8000,80,250,1`,
  "Brand story,9000,90,300,1",
  "Roastery tour,8500,85,290,1",
  "Weekly roast,7800,70,270,0",
  "V60 guide,7000,56,260,1",
  "Tiny test NSR-33333,100,9,5,0",
].join("\n");

describe("measuring Thakeen's ads (rule 91)", () => {
  it("compares only this workspace's coded ads with the others, on the same metric, with both samples", () => {
    const codes = { "NSR-7K2QM": "t1", "NSR-8P3RT": "t2", "NSR-9W4XY": "t3" };
    const { rows, platform, range } = readRows(csv(Object.keys(codes)));
    const snap = analyze(rows, "x.csv", platform, range, "ctr", undefined, codes);
    expect(snap.nashr!.ads.map((a) => a.taskId)).toEqual(["t1", "t2", "t3"]);
    expect(snap.nashr!.ranked).toBe(3);
    expect(snap.nashr!.othersRanked).toBe(5); // the unknown code is an ordinary ad; the 100-impression one is too small
    expect(snap.nashr!.text!.en).toMatch(/^Thakeen.s ads \(3\): CTR 3\.83% vs 0\.95% for your other ads \(5\), \d+% better\.$/);
    expect(["low", "medium"]).toContain(snap.nashr!.confidence);
    // The codes' own digits are not wording: without this the "number or price" pattern tracks the codes.
    expect(snap.findings.some((f) => f.kind === "pattern" && /number or price/.test(f.text.en))).toBe(false);
  });
  it("says nothing comparative when either side is too small, and nothing at all without codes", () => {
    const { rows, platform, range } = readRows(csv(["NSR-AAAAA", "x", "y"]));
    const one = analyze(rows, "x.csv", platform, range, "ctr", undefined, { "NSR-AAAAA": "t1" });
    expect(one.nashr!.ads).toHaveLength(1);
    expect(one.nashr!.text).toBeNull();
    expect(analyze(rows, "x.csv", platform, range, "ctr").nashr).toBeNull();
  });
  it("phrases a cost as lower or higher, never as a multiple", () => {
    const codes = { "NSR-AAAAA": "t1", "NSR-BBBBB": "t2", "NSR-CCCCC": "t3" };
    const { rows, platform, range } = readRows(csv(Object.keys(codes)));
    const text = analyze(rows, "x.csv", platform, range, "cpa", undefined, codes).nashr!.text!.en;
    expect(text).toMatch(/cost per result .* \d+% lower\.$/);
    expect(Number(text.match(/(\d+)% lower/)![1])).toBeLessThan(100);
  });
  it("an upload matches the caller's own codes into the snapshot and into Noor's memory", async () => {
    const u = await newUser("nashrads");
    const items = [task("a1"), task("a2"), task("a3")];
    for (const t of items) await saveTask(u.email, t, true);
    const mine = (await Promise.all(items.map((t) => getTask(u.email, t.id)))).map((t) => t!.adCode!);
    const other = await newUser("nashrads");
    await saveTask(other.email, task("o1"), true);
    const theirs = (await getTask(other.email, "o1"))!.adCode!;
    await signIn(u.email);
    const res = await route.POST(json("/api/performance", "POST", { csv: csv([mine[0], mine[1], theirs]), file: "x.csv", metric: "ctr" }));
    expect(res.status).toBe(200);
    const snap = (await getPerf(u.email))!;
    expect(snap.nashr!.ads.map((a) => a.taskId)).toEqual(["a1", "a2"]);
    expect(snap.nashr!.ads.some((a) => a.code === theirs)).toBe(false);
    expect((await readFile(u.email, "performance-learnings.md"))!.content).toContain("## Thakeen's own ads");
  });
});
