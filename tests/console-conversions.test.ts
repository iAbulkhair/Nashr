import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { json, newMember as helperNewMember, newUser as helperNewUser, signOut } from "./helpers/session";
import { enrolledStaff } from "./helpers/staff";
import { db } from "@/lib/db";
import { accountKey, globalKey } from "@/lib/keys";
import { staffMay, STAFF_MAY } from "@/lib/roles";
import { AUDIT_SECTIONS } from "@/lib/admin-audit";
import { CONVERSIONS, countsOnly, countsText, isConversion } from "@/lib/conversions/console";
import { convertAccountIds as fromScript } from "../scripts/account-ids";
import { run as s1FromScript } from "../scripts/multi-org-index";
import { convertAccountIds } from "@/lib/conversions/account-ids";
import { run as s1 } from "@/lib/conversions/multi-org-index";
import { ConversionRow, CONVERSIONS_COPY } from "@/components/admin/ConversionsCard";
import * as route from "@/app/api/admin/conversions/[name]/route";

/**
 * Rules 4100-4106 (docs/system/tests/4100-console-conversions.md, flows.md section 125): the founder runs the one-time data
 * conversions from the console instead of a terminal. POST /api/admin/conversions/{name}: a console actor (401), the console
 * owner (403), a known name (404), a rate limit, a dry run by default that writes nothing but its clean mark, an apply that
 * needs the second factor, a reason and a clean dry run, one lock for every conversion, one audit row in section `data`,
 * and an answer of counts only.
 */

// Records as a build from before R1 left them (address-keyed persons), as tests/account-id-r1.test.ts builds them. With
// `OPAQUE_IDS` on the owner keeps its address as its account id (`addressId`), as every account production holds (rule 3810).
const newUser = (prefix?: string) => helperNewUser(prefix, { legacy: true, addressId: true });
const newMember = (owner: Parameters<typeof helperNewMember>[0]) => helperNewMember(owner, undefined, undefined, { legacy: true });

const KEY = "console-conversions-admin-key-0123456789";
const REASON = "R1 fill before the switch-on";
let ipN = 0;
const asKey = () => ({ "x-admin-key": KEY, "x-forwarded-for": `198.51.100.${(++ipN % 250) + 1}` });
const post = (name: string, body: unknown, headers: Record<string, string> = asKey()) =>
  route.POST(json(`/api/admin/conversions/${name}`, "POST", body, headers), { params: Promise.resolve({ name }) });
const answer = async (r: Response) => ({ status: r.status, body: await r.json() });

type Row = { section?: string; action?: string; target?: string; actor?: string; what?: string; after?: unknown; reason?: string };
const rows = async (): Promise<Row[]> => (await db.lrange("admin:log", 0, 200)).map((r) => (typeof r === "string" ? JSON.parse(r) : r) as Row);
const stripId = async (key: string) => {
  const { id: _id, ...rest } = (await db.get<Record<string, unknown>>(key))!;
  void _id;
  await db.set(key, rest);
};
/** An owner and its member with no ids and no login indexes. */
async function legacy(): Promise<{ owner: string; member: string }> {
  const u = await newUser("cc");
  const m = await newMember(u);
  await Promise.all([stripId(accountKey.user(u.email)), stripId(accountKey.member(m.email)), db.del(accountKey.login(u.email)), db.del(accountKey.login(m.email))]);
  return { owner: u.email, member: m.email };
}

beforeEach(async () => {
  vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
  await Promise.all([db.del("admin:log"), db.del(globalKey.rate("adminconv:key")), db.del(globalKey.conversionLock()), db.del(globalKey.conversionClean("account-ids")), db.del(globalKey.conversionClean("multi-org-index"))]);
});
afterEach(() => {
  vi.restoreAllMocks();
  signOut();
});

describe("rule 4100: the work lives in src/lib/conversions, and the scripts still run it", () => {
  it("the scripts re-export the same functions, so the terminal path is unchanged", () => {
    expect(fromScript).toBe(convertAccountIds);
    expect(s1FromScript).toBe(s1);
  });
  it("the names are a fixed list; anything else is not a conversion", () => {
    expect(Object.keys(CONVERSIONS).sort()).toEqual(["account-ids", "multi-org-index"]);
    for (const v of ["account-ids", "multi-org-index"]) expect(isConversion(v)).toBe(true);
    for (const v of ["", "users:all", "__proto__", "constructor", "account-ids/../x", null, 1]) expect(isConversion(v), String(v)).toBe(false);
    expect(CONVERSIONS["account-ids"].applies).toBe(true);
    expect(CONVERSIONS["multi-org-index"].applies).toBe(false);
  });
});

describe("rule 4101: only a console owner runs a conversion", () => {
  it("STAFF_MAY: data.convert is owner only and fails closed", () => {
    expect(STAFF_MAY["data.convert"]).toEqual(["owner"]);
    expect(staffMay("owner", "data.convert")).toBe(true);
    for (const r of ["support", null, undefined, "", "Owner", 1]) expect(staffMay(r, "data.convert"), String(r)).toBe(false);
  });
  it("no console actor: 401 for a dry run and an apply, and nothing is read, locked or logged", async () => {
    const smembers = vi.spyOn(db, "smembers");
    for (const body of [{}, { apply: false }, { apply: true, reason: REASON }]) expect((await post("account-ids", body, {})).status).toBe(401);
    expect((await post("account-ids", {}, { "x-admin-key": "wrong-key-0000000000000000000000" })).status).toBe(401);
    expect(smembers).not.toHaveBeenCalledWith(globalKey.usersAll());
    expect(await db.get(globalKey.conversionLock())).toBeNull();
    expect(await rows()).toEqual([]);
  });
  it("a support staff session: 403 forbidden, before the name or the body is looked at", async () => {
    const { openStaffSession } = await import("@/lib/staff-session");
    const { staff } = await enrolledStaff({ role: "support" });
    await openStaffSession(staff.email);
    const smembers = vi.spyOn(db, "smembers");
    expect(await answer(await post("account-ids", {}, {}))).toEqual({ status: 403, body: { ok: false, error: "forbidden" } });
    expect(await answer(await post("nope", { apply: "x" }, {}))).toEqual({ status: 403, body: { ok: false, error: "forbidden" } });
    expect(smembers).not.toHaveBeenCalledWith(globalKey.usersAll());
    expect(await rows()).toEqual([]);
  });
  it("an unknown name is 404 and a non-boolean apply is 400, with nothing run", async () => {
    expect(await answer(await post("users-all", {}))).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    expect(await answer(await post("account-ids", { apply: "yes" }))).toEqual({ status: 400, body: { ok: false, error: "bad_request" } });
    expect(await rows()).toEqual([]);
  });
});

describe("rule 4102: a rate limit per console actor", () => {
  it("the 21st run in an hour is 429 slow_down, and does not run", async () => {
    await db.set(globalKey.rate("adminconv:key"), 20, 3600);
    const r = await post("account-ids", {});
    expect(r.status).toBe(429);
    expect((await r.json()).error).toBe("slow_down");
    expect(await rows()).toEqual([]);
  });
});

describe("rule 4103: one lock for every conversion, so two clicks never run at once", () => {
  it("while any conversion holds the lock, both answer 409 busy and nothing is written", async () => {
    const a = await legacy();
    const token = await db.lockOwned(globalKey.conversionLock(), 300);
    expect(token).not.toBeNull();
    expect(await answer(await post("account-ids", {}))).toEqual({ status: 409, body: { ok: false, error: "busy" } });
    expect(await answer(await post("multi-org-index", {}))).toEqual({ status: 409, body: { ok: false, error: "busy" } });
    expect(await db.get(globalKey.conversionClean("account-ids"))).toBeNull();
    expect(await rows()).toEqual([]);
    await db.unlockOwned(globalKey.conversionLock(), token!);
    expect((await post("account-ids", {})).status).toBe(200);
    expect(await db.get(accountKey.user(a.owner))).not.toHaveProperty("id");
  });
  it("a run frees the lock when it ends, and when it throws", async () => {
    expect((await post("account-ids", {})).status).toBe(200);
    expect(await db.get(globalKey.conversionLock())).toBeNull();
    vi.spyOn(db, "smembers").mockRejectedValueOnce(new Error("store down"));
    expect(await answer(await post("account-ids", {}))).toEqual({ status: 500, body: { ok: false, error: "failed" } });
    expect(await db.get(globalKey.conversionLock())).toBeNull();
  });
});

describe("rule 4104: dry run by default; an apply needs the second factor, a reason and a clean dry run", () => {
  it("a dry run writes nothing but its clean mark: no id, no index", async () => {
    const a = await legacy();
    const set = vi.spyOn(db, "set");
    const { status, body } = await answer(await post("account-ids", {}));
    expect(status).toBe(200);
    expect(body.report.apply).toBe(false);
    expect(body.report.idsSet).toBeGreaterThanOrEqual(2);
    expect(body.report.indexesSet).toBeGreaterThanOrEqual(2);
    expect(body.clean).toBe(true);
    expect(set.mock.calls.map((c) => c[0])).toEqual([globalKey.conversionClean("account-ids")]);
    expect(await db.get(accountKey.user(a.owner))).not.toHaveProperty("id");
    expect(await db.get(accountKey.member(a.member))).not.toHaveProperty("id");
    expect(await db.get(accountKey.login(a.owner))).toBeNull();
    expect(await db.get(accountKey.login(a.member))).toBeNull();
    expect(await db.get(globalKey.conversionClean("account-ids"))).toMatchObject({ by: "key" });
  });
  it("an apply with no clean dry run is 409 dry_run_first and writes nothing", async () => {
    const a = await legacy();
    expect(await answer(await post("account-ids", { apply: true, reason: REASON }))).toEqual({ status: 409, body: { ok: false, error: "dry_run_first" } });
    expect(await db.get(accountKey.user(a.owner))).not.toHaveProperty("id");
    expect(await rows()).toEqual([]);
  });
  it("an apply with no reason is refused before it runs", async () => {
    expect((await post("account-ids", {})).status).toBe(200);
    const r = await post("account-ids", { apply: true });
    expect(r.status).toBe(400);
    expect(String((await r.json()).error)).toMatch(/^reason_/);
    expect(await db.get(globalKey.conversionClean("account-ids"))).not.toBeNull();
  });
  it("dry run, then apply: ids and indexes written; the apply uses up the clean mark", async () => {
    const a = await legacy();
    expect((await post("account-ids", {})).status).toBe(200);
    const { status, body } = await answer(await post("account-ids", { apply: true, reason: REASON }));
    expect(status).toBe(200);
    expect(body.report.apply).toBe(true);
    expect(body.report.idsSet).toBeGreaterThanOrEqual(2);
    expect(await db.get(accountKey.user(a.owner))).toMatchObject({ id: a.owner });
    expect(await db.get(accountKey.member(a.member))).toMatchObject({ id: a.member });
    expect(await db.get(accountKey.login(a.owner))).toEqual({ kind: "person", pid: a.owner });
    expect(await db.get(globalKey.conversionClean("account-ids"))).toBeNull();
    expect(await answer(await post("account-ids", { apply: true, reason: REASON }))).toEqual({ status: 409, body: { ok: false, error: "dry_run_first" } });
  });
  it("idempotent: a second dry run and apply find nothing to set and write no record", async () => {
    await legacy();
    expect((await post("account-ids", {})).status).toBe(200);
    expect((await post("account-ids", { apply: true, reason: REASON })).status).toBe(200);
    const dry = await answer(await post("account-ids", {}));
    expect([dry.body.report.idsSet, dry.body.report.indexesSet]).toEqual([0, 0]);
    const set = vi.spyOn(db, "set");
    const again = await answer(await post("account-ids", { apply: true, reason: REASON }));
    expect(again.status).toBe(200);
    expect([again.body.report.idsSet, again.body.report.indexesSet]).toEqual([0, 0]);
    expect(set.mock.calls.filter((c) => !String(c[0]).startsWith("conversion:") && !String(c[0]).startsWith("rate:") && !String(c[0]).startsWith("admin:"))).toEqual([]);
  });
  it("S1 runs dry only: an apply is 400 dry_run_only, a dry run answers its counts", async () => {
    expect(await answer(await post("multi-org-index", { apply: true, reason: REASON }))).toEqual({ status: 400, body: { ok: false, error: "dry_run_only" } });
    const { status, body } = await answer(await post("multi-org-index", {}));
    expect(status).toBe(200);
    expect(body.report).toMatchObject({ apply: false });
    expect(typeof body.report.accounts).toBe("number");
    expect(typeof body.report.loginsSet).toBe("number");
  });
});

describe("rule 4105: counts only, in the answer and in the audit row", () => {
  it("countsOnly keeps numbers and apply, and drops any text", () => {
    expect(countsOnly({ apply: true, accounts: 3, note: "a@test.example", list: ["x"], bad: NaN })).toEqual({ apply: true, accounts: 3 });
    expect(countsText("account_ids_dry_run", { apply: false, accounts: 3, conflicts: 0 })).toBe("account_ids_dry_run accounts 3 conflicts 0");
  });
  it("no address, id or key in the answer or the row; the row is section data with the counts in what", async () => {
    const a = await legacy();
    const dry = await post("account-ids", {});
    const applied = await post("account-ids", { apply: true, reason: REASON });
    const s1dry = await post("multi-org-index", {});
    const texts = [JSON.stringify(await dry.json()), JSON.stringify(await applied.json()), JSON.stringify(await s1dry.json())];
    const log = await rows();
    for (const t of [...texts, ...log.map((r) => JSON.stringify({ what: r.what, after: r.after }))]) {
      expect(t).not.toContain("@");
      expect(t).not.toContain(a.owner);
      expect(t).not.toContain("user:");
      expect(t).not.toContain("login:");
    }
    expect(AUDIT_SECTIONS).toContain("data");
    expect(log.map((r) => [r.section, r.action, r.target])).toEqual([
      ["data", "multi_org_index_dry_run", "multi-org-index"],
      ["data", "account_ids_apply", "account-ids"],
      ["data", "account_ids_dry_run", "account-ids"],
    ]);
    expect(log[1].what).toMatch(/^account_ids_apply accounts \d+ missing \d+ members \d+ idsSet \d+ indexesSet \d+ conflicts 0 orphans 0$/);
    expect(log[1].reason).toBe(REASON);
    expect(log[2].reason).toBeUndefined();
  });
});

describe("rule 4104 (not clean): a dry run that leaves anything alone keeps the apply shut", () => {
  it("an orphan makes the dry run not clean, removes the mark, and the apply is refused", async () => {
    const a = await legacy();
    const ghost = `ghost-${Math.random().toString(36).slice(2, 8)}@test.example`;
    await db.sadd(accountKey.members(a.owner), ghost);
    try {
      await db.set(globalKey.conversionClean("account-ids"), { at: new Date().toISOString(), by: "key" }, 900);
      const { body } = await answer(await post("account-ids", {}));
      expect(body.clean).toBe(false);
      expect(body.report.orphans).toBeGreaterThanOrEqual(1);
      expect(await db.get(globalKey.conversionClean("account-ids"))).toBeNull();
      expect(await answer(await post("account-ids", { apply: true, reason: REASON }))).toEqual({ status: 409, body: { ok: false, error: "dry_run_first" } });
      expect(await db.get(accountKey.user(a.owner))).not.toHaveProperty("id");
    } finally {
      await db.srem(accountKey.members(a.owner), ghost);
    }
  });
});

describe("rule 4106: the console card", () => {
  const html = (initial?: Parameters<typeof ConversionRow>[0]["initial"], lang: "en" | "ar" = "en") =>
    renderToStaticMarkup(createElement(ConversionRow, { lang, name: "account-ids", applies: true, initial }));
  const applyButton = (h: string) => h.match(/<button[^>]*btn-primary[^>]*>/)?.[0] ?? "";
  const report = (o: Record<string, number>) => ({ apply: false, accounts: 2, missing: 0, members: 1, idsSet: 2, indexesSet: 2, conflicts: 0, orphans: 0, ...o });

  it("Apply is shut until a dry run in this view came back clean, and shut again after an apply", () => {
    expect(applyButton(html())).toContain("disabled");
    expect(applyButton(html({ report: report({ orphans: 1 }), clean: false, ms: 10, applied: false }))).toContain("disabled");
    expect(applyButton(html({ report: report({}), clean: true, ms: 10, applied: false }))).not.toContain("disabled");
    expect(applyButton(html({ report: report({}), clean: true, ms: 10, applied: true }))).toContain("disabled");
  });
  it("shows the counts, says a second run writes nothing, and S1 offers no Apply", () => {
    const h = html({ report: report({}), clean: true, ms: 1234, applied: false });
    expect(h).toContain("Ids to set");
    expect(h).toContain("Took 1.2 s.");
    expect(h).toContain(CONVERSIONS_COPY.en.again);
    expect(html(undefined, "ar")).toContain(CONVERSIONS_COPY.ar.again);
    const s1Row = renderToStaticMarkup(createElement(ConversionRow, { lang: "en", name: "multi-org-index", applies: false }));
    expect(applyButton(s1Row)).toBe("");
    expect(s1Row).toContain(CONVERSIONS_COPY.en.dryOnly);
  });
  it("both languages carry the same keys, every count and every error the route answers", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(CONVERSIONS_COPY.ar)).toEqual(keys(CONVERSIONS_COPY.en));
    expect(keys(CONVERSIONS_COPY.ar.counts)).toEqual(keys(CONVERSIONS_COPY.en.counts));
    expect(keys(CONVERSIONS_COPY.ar.errors)).toEqual(keys(CONVERSIONS_COPY.en.errors));
    for (const e of ["forbidden", "busy", "dry_run_first", "dry_run_only", "slow_down", "failed"]) expect(CONVERSIONS_COPY.en.errors[e], e).toBeTruthy();
  });
  it("the card is on the Integrations page", () => {
    expect(readFileSync("src/components/admin/IntegrationsPanel.tsx", "utf8")).toContain("<ConversionsCard lang={lang} />");
  });
});
