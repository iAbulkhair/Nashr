import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { adminSignIn, json, newUser, signIn, signOut } from "./helpers/session";
import { adminConsoleSrc } from "./helpers/admin-console";
import { createUser, currentUser, IMPERSONATION_LEGACY_MS } from "@/lib/auth";
import { CAPS, db } from "@/lib/db";
import { AUDIT_CAP, adminAudit, auditRow, auditView, pageAudit, parseAuditFilter, redact, type AuditRow } from "@/lib/admin-audit";
import { ADMIN_INPUT_ERRORS, IMPERSONATE_DEFAULT, inputError, parseImpersonateMinutes, parseReason, REASON_MAX } from "@/lib/admin-input";
import { DEFAULT_USER_QUERY, hasFilter, matchUser, pageOf, parseUserQuery, sortUsers, tileCounts, userFacets, userQueryParams, type UserFacts } from "@/lib/admin-users";
import { AUDIT_SECTIONS as SHAPE_SECTIONS, auditDiff } from "@/lib/admin-audit-shape";
import { AUDIT_SECTIONS } from "@/lib/admin-audit";
import { FORM_COPY, formGate, formReady, initialValues, submitForm, type ActionSpec } from "@/components/admin/AdminForm";
import { TABLE_COPY } from "@/components/admin/DataTable";
import { USERS_COPY } from "@/components/admin/users-copy";
import { LOG_COPY } from "@/components/admin/Log";
import { IMPERSONATION_COPY, minutesLeft } from "@/components/app/ImpersonationBanner";
import * as planRoute from "@/app/api/admin/plan/route";
import * as logRoute from "@/app/api/admin/log/route";

/**
 * UI/UX phase 4, the founder console (rules 1172-1185, docs/system/tests/1170-uiux-phase4.md), merged with the Control
 * Center spec's phase 1 (spec rules 1069-1074). Rules 1170-1171 are in tests/uiux-phase4-signout.test.ts. The form
 * rules build on #321's rules 1100-1102 (cited, not renumbered).
 */
const KEY = "test-admin-key-phase4-0123456789";
const read = (f: string) => readFileSync(f, "utf8");
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.(ts|tsx)$/.test(n)) out.push(p.split("\\").join("/"));
  }
  return out;
}
const rows = async (n = 50): Promise<AuditRow[]> => (await db.lrange("admin:log", 0, n - 1)).map((r) => JSON.parse(r));
const getLog = (qs = "") => logRoute.GET(new Request(`http://localhost/api/admin/log${qs}`));

beforeEach(async () => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); signOut(); await db.del("admin:log"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); signOut(); });

describe("rule 1172 (spec 1069): adminAudit is the only writer of admin:log, and every row says who, when, what, on what and why", () => {
  it("no file but admin-audit.ts writes the list, and only the log route reads it", () => {
    const uses = filesUnder("src").filter((f) => read(f).includes('"admin:log"'));
    expect(uses.sort()).toEqual(["src/app/api/admin/log/route.ts", "src/lib/admin-audit.ts"]);
    expect(read("src/app/api/admin/log/route.ts")).not.toMatch(/lpush|pushCapped|db\.set/);
    // Every admin route that changes something writes through the helper.
    for (const f of ["golden", "partners", "payments/[email]", "plan", "topups", "users/[email]", "wishlist", "impersonate"]) {
      expect(read(`src/app/api/admin/${f}/route.ts`), f).toMatch(/adminAudit\(/);
    }
    for (const f of ["src/lib/billing.ts", "src/lib/notify.ts"]) expect(read(f), f).toMatch(/adminAudit\(/);
  });

  it("a row carries id, at, actor, section, action, target, before, after and reason, and keeps the legacy what and email", async () => {
    const r = await adminAudit({ actor: "founder@test.example", section: "users", what: "suspend", target: "c@test.example", before: { suspended: false }, after: { suspended: true }, reason: "  spam\nreports  " });
    expect(r).toMatchObject({ actor: "founder@test.example", section: "users", action: "suspend", target: "c@test.example", email: "c@test.example", what: "suspend", before: { suspended: false }, after: { suspended: true }, reason: "spam reports" });
    expect(r.id).toMatch(/^[0-9a-f]{12}$/);
    expect(Number.isNaN(Date.parse(r.at))).toBe(false);
    expect((await rows())[0]).toEqual(r);
  });

  it("the action defaults to the first word of what, and a reason is one line of at most 200 characters", () => {
    expect(auditRow({ actor: "key", section: "billing", what: "topup_void: x" }).action).toBe("topup_void");
    expect(auditRow({ actor: "key", section: "billing", what: "x", reason: "a".repeat(500) }).reason).toHaveLength(REASON_MAX);
    expect(auditRow({ actor: "key", section: "billing", what: "x", reason: "   " }).reason).toBeUndefined();
  });

  it("a real change through the users route writes one row with the founder's reason (an expand: reason stays optional on the server)", async () => {
    const c = await createUser({ email: `a4-${Date.now().toString(36)}@test.example`, name: "C", phone: "", password: "abc12345", lang: "en" });
    const users = await import("@/app/api/admin/users/[email]/route");
    await adminSignIn();
    const p = { params: Promise.resolve({ email: encodeURIComponent(c.email) }) };
    expect((await users.POST(json("/api/admin/users/x", "POST", { action: "suspend", reason: "chargeback" }), p)).status).toBe(200);
    expect((await users.POST(json("/api/admin/users/x", "POST", { action: "setLang", lang: "ar" }), p)).status).toBe(200);
    const [lang, sus] = await rows(2);
    expect(sus).toMatchObject({ actor: "key", section: "users", action: "suspend", target: c.email, reason: "chargeback", before: { suspended: false }, after: { suspended: true } });
    expect(lang).toMatchObject({ action: "setLang", before: { lang: "en" }, after: { lang: "ar" } });
    expect(lang.reason).toBeUndefined();
  });
});

describe("rule 1173 (spec 1071): no secret reaches an audit row", () => {
  it("a planted environment secret is masked wherever it appears, and secret-named keys are dropped at any depth", async () => {
    const planted = "planted-Secret-Value-7f3a9c1e5b";
    vi.stubEnv("PHASE4_TEST_API_KEY", planted);
    vi.stubEnv("PHASE4_TEST_SECRET", "second-planted-0042");
    const r = await adminAudit({
      actor: "key", section: "system", what: `mail failed: ${planted}`, target: "mail", reason: `pasted ${planted}`,
      before: { tempPassword: "Temp-123456", nested: { token: "tok-abc", list: [{ cookie: "c=1", ok: 1 }] } },
      after: { passHash: "x", ref: "PAY-REF-1", hmac: "h", apiKey: "k", session: "s", note: "second-planted-0042" },
      extra: { kp: "binding", card: "4111", keep: "visible" },
    });
    const raw = (await db.lrange("admin:log", 0, 0))[0];
    for (const s of [planted, "second-planted-0042", "Temp-123456", "tok-abc", "c=1", "PAY-REF-1", "binding", "4111"]) expect(raw, s).not.toContain(s);
    for (const k of ["tempPassword", "token", "cookie", "passHash", "ref", "hmac", "apiKey", "session", "kp", "card"]) expect(raw, k).not.toContain(`"${k}"`);
    expect(r.what).toBe("mail failed: [redacted]");
    expect(r.keep).toBe("visible");
    expect((r.before as { nested: { list: { ok: number }[] } }).nested.list[0].ok).toBe(1);
  });

  it("a password reset logs the action, never the temporary password the route answers", async () => {
    const c = await createUser({ email: `a4r-${Date.now().toString(36)}@test.example`, name: "C", phone: "", password: "abc12345", lang: "en" });
    const users = await import("@/app/api/admin/users/[email]/route");
    await adminSignIn();
    const res = await users.POST(json("/api/admin/users/x", "POST", { action: "resetPassword", reason: "locked out" }), { params: Promise.resolve({ email: encodeURIComponent(c.email) }) });
    const { tempPassword } = (await res.json()) as { tempPassword: string };
    expect(tempPassword).toBeTruthy();
    const raw = (await db.lrange("admin:log", 0, 0))[0];
    expect(raw).toContain('"resetPassword"');
    expect(raw).not.toContain(tempPassword);
  });

  it("redact caps depth and array length: a row is a summary, never a dump", () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain("[redacted]");
    expect((redact(Array.from({ length: 80 }, (_, i) => i)) as unknown[]).length).toBe(50);
  });
});

describe("rule 1174: the list keeps 5,000 rows", () => {
  it("the cap is 5,000 (was 2,000) and the helper writes with it", () => {
    expect(CAPS.adminLog).toBe(5000);
    expect(AUDIT_CAP).toBe(5000);
    expect(read("src/lib/admin-audit.ts")).toMatch(/pushCapped\("admin:log", json, AUDIT_CAP\)/);
  });
});

describe("rule 1175 (spec 1072, 1078): the log route answers one filtered page, founder only, rate limited", () => {
  it("refuses anyone who is not the founder", async () => {
    expect((await getLog()).status).toBe(401);
    const u = await newUser("a4l");
    await signIn(u.email);
    expect((await getLog()).status).toBe(401);
  });

  it("filters by section, actor, action and target, pages 50 at a time, and renders legacy rows", async () => {
    // A row written before 2026-10-11: no id, no section, no action, the account under `email`.
    await db.lpush("admin:log", JSON.stringify({ at: "2026-10-01T00:00:00.000Z", actor: "key", email: "old@test.example", what: "extendTrial 7d" }));
    for (let i = 0; i < 60; i++) await adminAudit({ actor: i % 2 ? "founder@test.example" : "key", section: i % 3 ? "users" : "billing", what: `suspend ${i}`, target: `t${i}@test.example` });
    await adminSignIn();
    const all = (await (await getLog()).json()) as { ok: boolean; log: (AuditRow & { legacy: boolean })[]; next: number | null; scanned: number };
    expect(all.log).toHaveLength(50);
    expect(all.next).toBe(50);
    expect(all.scanned).toBe(61);
    const rest = (await (await getLog(`?from=${all.next}`)).json()) as typeof all;
    expect(rest.log).toHaveLength(11);
    expect(rest.next).toBeNull();
    const old = rest.log.at(-1)!;
    expect(old).toMatchObject({ legacy: true, action: "extendTrial", target: "old@test.example", what: "extendTrial 7d" });
    const billing = (await (await getLog("?section=billing&actor=KEY")).json()) as typeof all;
    expect(billing.log.length).toBeGreaterThan(0);
    expect(billing.log.every((r) => r.section === "billing" && r.actor === "key")).toBe(true);
    const one = (await (await getLog("?target=t7@")).json()) as typeof all;
    expect(one.log.map((r) => r.target)).toEqual(["t7@test.example"]);
    // An unknown section is ignored, not matched literally.
    expect(parseAuditFilter(new URLSearchParams("section=__proto__&actor=" + "x".repeat(300)))).toEqual({ actor: "x".repeat(120) });
  });

  it("reads the list with one command, and allows 300 reads an hour per founder", async () => {
    const src = read("src/app/api/admin/log/route.ts");
    expect(src).toMatch(/allow\(`adminlog:\$\{who\}`, LOG_READS_PER_HOUR, WINDOW\.hour\)/);
    expect(src).toMatch(/const LOG_READS_PER_HOUR = 300;/);
    expect(src.match(/db\./g)).toHaveLength(1);
    await adminSignIn();
    await db.set("rate:adminlog:key", 300, 3600);
    expect((await getLog()).status).toBe(429);
  });

  it("pageAudit skips rows that are not JSON and keeps the newest-first order", () => {
    const raw = ["not json", JSON.stringify({ id: "a", at: "2", actor: "k", what: "b x" }), JSON.stringify({ at: "1", actor: "k", what: "a" })];
    const p = pageAudit(raw, {}, 0, 50);
    expect(p.rows.map((r) => r.action)).toEqual(["b", "a"]);
    expect(p.rows.map((r) => r.legacy)).toEqual([false, true]);
    expect(auditView({ at: "1", actor: "k", what: "x" }).target).toBeUndefined();
  });
});

describe("rule 1176 (spec 1070, 1073-1074; builds on #321 rules 1100-1102): every founder change asks through one form with a required reason", () => {
  const spec: ActionSpec<{ seats: number }> = { title: "Seats", fields: [{ name: "seats", label: "Seats", initial: "3" }], parse: (v) => (/^\d+$/.test(v.seats) ? { ok: true, value: { seats: Number(v.seats) } } : { ok: false, error: "bad_seats" }) };

  it("the reason is checked first, 3 to 200 characters, then the fields", () => {
    expect(submitForm(spec, { seats: "x", reason: "" })).toEqual({ ok: false, error: "reason_short" });
    expect(submitForm(spec, { seats: "x", reason: "a".repeat(201) })).toEqual({ ok: false, error: "reason_long" });
    expect(submitForm(spec, { seats: "x", reason: "ok!" })).toEqual({ ok: false, error: "bad_seats" });
    expect(submitForm(spec, { seats: "4", reason: " upgrade\nasked " })).toEqual({ ok: true, value: { seats: 4, reason: "upgrade asked" } });
    expect(parseReason("ab")).toEqual({ ok: false, error: "reason_short" });
  });

  it("type to confirm keeps the submit closed until the field holds the email", () => {
    const del: ActionSpec<object> = { title: "Delete", destructive: true, fields: [{ name: "confirm", label: "Type", mustMatch: "C@Test.example" }], parse: () => ({ ok: true, value: {} }) };
    expect(formReady(del.fields, { confirm: "c@test" })).toBe(false);
    expect(submitForm(del, { confirm: "nope", reason: "gone now" })).toEqual({ ok: false, error: "mismatch" });
    expect(formReady(del.fields, { confirm: "  c@test.example " })).toBe(true);
  });

  it("one form at a time: a second ask while one is open answers null and shows nothing; only the first answer counts", async () => {
    const g = formGate();
    const shown: number[] = [];
    const first = g.ask<{ a: number }>((n) => shown.push(n));
    expect(await g.ask((n) => shown.push(n))).toBeNull();
    g.answer({ a: 1 });
    g.answer({ a: 2 });
    expect(await first).toEqual({ a: 1 });
    expect(shown).toEqual([1]);
  });

  it("a following field starts from what it follows", () => {
    expect(initialValues([{ name: "pack", label: "", initial: "100" }, { name: "paid", label: "", follow: (v) => String(Number(v.pack) * 2) }])).toEqual({ pack: "100", paid: "200" });
  });

  it("every error code has words in Arabic and English, and an unknown code falls back to the generic one", () => {
    expect(Object.keys(ADMIN_INPUT_ERRORS.ar).sort()).toEqual(Object.keys(ADMIN_INPUT_ERRORS.en).sort());
    for (const [k, v] of Object.entries(ADMIN_INPUT_ERRORS.ar)) expect(v, k).toMatch(/[\u0600-\u06FF]/);
    expect(inputError("ar", "no_such_code")).toBe(ADMIN_INPUT_ERRORS.ar.failed);
  });

  it("the form is built on Phase 1's FormDialog, alertdialog when destructive, with no native required", () => {
    const src = read("src/components/admin/AdminForm.tsx");
    expect(src).toMatch(/<FormDialog/);
    expect(src).toMatch(/role=\{spec\.destructive \? "alertdialog" : "dialog"\}/);
    expect(src).toMatch(/submitReady=\{ready\}/);
    expect(src).not.toMatch(/\brequired\b/);
    expect(read("src/components/ui/Dialog.tsx")).toMatch(/if \(busy \|\| !submitReady\) return;/);
  });
});

describe("rule 1177: an impersonation lasts 15, 60 or 120 minutes and ends on time", () => {
  it("parses the length: none is the old 120, anything off the list is refused", () => {
    expect(parseImpersonateMinutes(undefined)).toBe(IMPERSONATE_DEFAULT);
    expect(IMPERSONATE_DEFAULT).toBe(120);
    expect(parseImpersonateMinutes("15")).toBe(15);
    expect(parseImpersonateMinutes(60)).toBe(60);
    for (const v of [0, 30, 121, "abc", -15, 15.5, {}]) expect(parseImpersonateMinutes(v), String(v)).toBeNull();
  });

  it("the route sets the cookies and the session to the chosen length and logs it", async () => {
    const c = await createUser({ email: `a4i-${Date.now().toString(36)}@test.example`, name: "C", phone: "", password: "abc12345", lang: "en" });
    const users = await import("@/app/api/admin/users/[email]/route");
    await adminSignIn();
    const p = { params: Promise.resolve({ email: encodeURIComponent(c.email) }) };
    expect((await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate", minutes: 45 }), p)).status).toBe(400);
    expect((await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate", minutes: 15, reason: "ticket 12" }), p)).status).toBe(200);
    expect((await rows(1))[0]).toMatchObject({ action: "impersonate.start", target: c.email, expiresInMin: 15, reason: "ticket 12" });
    const me = await currentUser();
    expect(me?.email).toBe(c.email);
    expect(me?.actor?.kind).toBe("founder");
    expect(me!.actor!.until! - me!.actor!.since!).toBe(15 * 60 * 1000);
  });

  it("a session past its exp resolves to nobody; a session written before the change shows at + 2 hours", async () => {
    const c = await newUser("a4x");
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await signIn(c.email, { imp: "key" });
    const legacy = await currentUser();
    expect(legacy?.actor?.until).toBe(legacy!.actor!.since! + IMPERSONATION_LEGACY_MS);
    const users = await import("@/app/api/admin/users/[email]/route");
    await adminSignIn();
    await users.POST(json("/api/admin/users/x", "POST", { action: "impersonate", minutes: 15 }), { params: Promise.resolve({ email: encodeURIComponent(c.email) }) });
    expect((await currentUser())?.email).toBe(c.email);
    vi.setSystemTime(t0 + 15 * 60 * 1000);
    expect(await currentUser(), "the chosen 15 minutes are over").toBeNull();
  });
});

describe("rule 1178: the Users table is filtered, sorted and paged on the server, with its state in the URL", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const u = (p: Partial<UserFacts> & { email: string }): UserFacts => ({ plan: "starter", credits: 100, trialEnds: "2026-10-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z", emailVerifiedAt: "2026-09-01", ...p });
  const list = [
    u({ email: "a@x.example", name: "Amal", createdAt: "2026-09-03T00:00:00Z" }),
    u({ email: "b@x.example", plan: "trial", trialEnds: "2026-10-12T06:00:00Z", credits: 5, createdAt: "2026-09-02T00:00:00Z" }),
    u({ email: "c@x.example", suspended: true, emailVerifiedAt: null, createdAt: "2026-09-01T00:00:00Z" }),
  ];

  it("reads and writes the URL with only what was chosen", () => {
    expect(parseUserQuery(new URLSearchParams(""))).toEqual(DEFAULT_USER_QUERY);
    const q = parseUserQuery(new URLSearchParams("q=Amal&plan=trial&filter=lowCredits&sort=email&dir=asc&page=2&per=50"));
    expect(q).toEqual({ q: "Amal", plan: "trial", filter: "lowCredits", sort: "email", dir: "asc", page: 2, per: 50 });
    expect(userQueryParams(q).toString()).toBe("q=Amal&plan=trial&filter=lowCredits&sort=email&dir=asc&page=2&per=50");
    expect(userQueryParams(DEFAULT_USER_QUERY).toString()).toBe("");
    expect(parseUserQuery(new URLSearchParams("plan=gold&filter=x&sort=__proto__&page=-3&per=7"))).toEqual(DEFAULT_USER_QUERY);
  });

  it("filters by text, plan and state, sorts with a stable tie-break and pages", () => {
    const q = (s: string) => parseUserQuery(new URLSearchParams(s));
    expect(list.filter((x) => matchUser(x, q("q=amal"), now)).map((x) => x.email)).toEqual(["a@x.example"]);
    expect(list.filter((x) => hasFilter(x, "trialEnding", now)).map((x) => x.email)).toEqual(["b@x.example"]);
    expect(list.filter((x) => hasFilter(x, "suspended", now)).map((x) => x.email)).toEqual(["c@x.example"]);
    expect(list.filter((x) => hasFilter(x, "unverified", now)).map((x) => x.email)).toEqual(["c@x.example"]);
    expect(list.filter((x) => hasFilter(x, "lowCredits", now)).map((x) => x.email)).toEqual(["b@x.example"]);
    expect(sortUsers(list, "createdAt", "desc").map((x) => x.email)).toEqual(["a@x.example", "b@x.example", "c@x.example"]);
    expect(sortUsers(list, "credits", "asc").map((x) => x.email)).toEqual(["b@x.example", "a@x.example", "c@x.example"]);
    expect(pageOf([1, 2, 3, 4, 5], 9, 2)).toEqual({ rows: [5], page: 3, pages: 3 });
    const f = userFacets(list, q("plan=trial"), now);
    expect(f.all).toBe(3);
    expect(f.plan.trial).toBe(1);
    expect(f.filter.suspended).toBe(1);
  });

  it("tiles count every account, not the page: paying and trial live accounts only, suspended apart", () => {
    const t = tileCounts([...list, u({ email: "d@x.example", plan: "trial", suspended: true, createdAt: "2026-10-11T08:00:00Z" })], now);
    expect(t).toEqual({ users: 4, paying: 1, trial: 1, today: 1, suspended: 2 });
  });

  it("GET /api/admin/plan?view=table is founder only, answers one page with its counts, and the old answer is unchanged", async () => {
    signOut();
    expect((await planRoute.GET(new Request("http://localhost/api/admin/plan?view=table"))).status).toBe(401);
    const tag = `p4t${Date.now().toString(36)}`;
    const made = await Promise.all([1, 2, 3].map(() => newUser(tag)));
    await adminSignIn();
    const res = await planRoute.GET(new Request(`http://localhost/api/admin/plan?view=table&q=${tag}&per=25&sort=email&dir=asc`));
    const j = (await res.json()) as { ok: boolean; view: string; users: { email: string; chatAllowance?: number }[]; matched: number; page: number; pages: number; per: number; facets: { all: number }; tiles: { users: number }; total: unknown };
    expect(j).toMatchObject({ ok: true, view: "table", matched: 3, page: 1, pages: 1, per: 25, facets: { all: 3 } });
    expect(j.users.map((x) => x.email)).toEqual(made.map((m) => m.email).sort());
    // The page rows carry the usage and chat columns the old list carried.
    expect(j.users.every((x) => typeof x.chatAllowance === "number")).toBe(true);
    expect(j.tiles.users).toBeGreaterThanOrEqual(3);
    const old = (await (await planRoute.GET(new Request("http://localhost/api/admin/plan"))).json()) as { view?: string; users: unknown[]; total: unknown };
    expect(old.view).toBeUndefined();
    expect(old.users.length).toBeGreaterThanOrEqual(3);
    // The usage of a page's rows is read for that page only, in one pmap, never per account in a loop.
    const route = read("src/app/api/admin/plan/route.ts");
    expect(route).toMatch(/pmap\(pg\.rows, rowOf\)/);
  });

  it("the table is a real table: caption, sortable headers as buttons with aria-sort and words, a pager with 44px controls", () => {
    const t = read("src/components/admin/DataTable.tsx");
    expect(t).toMatch(/<caption className="sr-only">\{caption\}<\/caption>/);
    expect(t).toMatch(/aria-sort=\{on \? \(dir === "asc" \? "ascending" : "descending"\) : undefined\}/);
    expect(t).toMatch(/<button type="button" onClick=\{\(\) => onSort\(c\.sort!\)\}[^>]*min-h-\[var\(--hit-min\)\]/);
    expect(t).toMatch(/<span className="sr-only">/);
    expect(t).toContain("overflow-x-auto");
    expect(t).not.toMatch(/\btext-(left|right)\b|\b(ml|mr|pl|pr)-\d/);
    expect(t.match(/<Button variant="secondary" size="md" aria-disabled=/g)?.length).toBe(2);
    expect(t).not.toMatch(/size="sm"/);
    const users = read("src/components/admin/Users.tsx");
    expect(users).toContain("useUserTable(query)");
    expect(users).toContain("router.replace(p ? `${pathname}?${p}` : pathname, { scroll: false });");
    expect(users).toContain("if (n !== seq.current) return;");
    expect(users).toContain("<PlanTiles lang={lang} counts={data?.tiles ?? null} total={data?.total ?? null} />");
  });
});

describe("rule 1179: the Log page shows who, the change key by key and the reason, with its filters in the URL", () => {
  it("diffs before and after key by key; a plain value is one change; nothing changed is empty", () => {
    expect(auditDiff({ plan: "trial", credits: 50, seats: 3 }, { plan: "pro", credits: 50, seats: 5 })).toEqual([
      { key: "plan", before: "trial", after: "pro" },
      { key: "seats", before: "3", after: "5" },
    ]);
    expect(auditDiff({ deal: null }, { deal: { credits: 3000 } })).toEqual([{ key: "deal", before: "null", after: '{"credits":3000}' }]);
    expect(auditDiff({ a: 1 }, { a: 1, b: true })).toEqual([{ key: "b", before: "", after: "true" }]);
    expect(auditDiff(false, true)).toEqual([{ key: "", before: "false", after: "true" }]);
    expect(auditDiff(undefined, undefined)).toEqual([]);
    expect(auditDiff({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it("the section names come from one client-safe list the writer re-exports", () => {
    expect(AUDIT_SECTIONS).toBe(SHAPE_SECTIONS);
    expect(read("src/lib/admin-audit-shape.ts")).not.toMatch(/^import /m);
    const log = read("src/components/admin/Log.tsx");
    expect(log).toContain('from "@/lib/admin-audit-shape"');
    expect(log).not.toMatch(/from "@\/lib\/admin-audit"/);
    for (const lang of ["en", "ar"] as const) expect(Object.keys(LOG_COPY[lang].sections).sort(), lang).toEqual([...AUDIT_SECTIONS].sort());
  });

  it("filters go to the address and the server; older pages add on; a legacy row is marked; values are text", () => {
    const log = read("src/components/admin/Log.tsx");
    expect(log).toContain("router.replace(p ? `${pathname}?${p}` : pathname, { scroll: false });");
    expect(log).toMatch(/adminFetch\(`\/api\/admin\/log/);
    expect(log).toContain("onClick={() => void fetchPage(next)}");
    expect(log).toContain("setRows((prev) => (from && prev ? [...prev, ...(j.log ?? [])] : j.log ?? []));");
    expect(log).toContain("{l.legacy && <Badge tone=\"neutral\">{L.legacy}</Badge>}");
    expect(log).toContain("auditDiff(l.before, l.after)");
    expect(log).toContain("L.scanned(scanned)");
    expect(log).not.toMatch(/dangerouslySetInnerHTML/);
    expect(log).toMatch(/<caption className="sr-only">/);
  });
});

describe("rule 1180: an account opens in a Sheet with tabs", () => {
  it("the sheet is the inline-end, large Sheet with five tabs and their panels", () => {
    const sheet = read("src/components/admin/UserSheet.tsx");
    expect(sheet).toContain('<Sheet lang={lang} label={`${UC.sheetLabel} ${sel.user.email}`} onClose={onClose} side="end" size="lg">');
    expect(sheet).toContain('const TAB_IDS = ["overview", "billing", "usage", "activity", "brand"] as const;');
    for (const id of ["overview", "billing", "usage", "activity", "brand"]) expect(sheet, id).toContain(`<TabPanel idBase={idBase} id="${id}" value={tab}`);
    // The brand file is fields now, text only, not a JSON dump.
    expect(sheet).toContain("<dl ");
    expect(sheet).not.toMatch(/JSON\.stringify\(sel\.brand/);
    expect(sheet).not.toMatch(/dangerouslySetInnerHTML/);
    expect(read("src/components/ui/Sheet.tsx")).toContain('size === "lg" ? "w-[min(48rem,calc(100%-1rem))]"');
    // A member login opens in its own sheet; the account's sheet remounts per account so its tab starts on Overview.
    const users = read("src/components/admin/Users.tsx");
    expect(users).toContain("<UserSheet\n          key={sel.user.email}");
    expect(users).toMatch(/<Sheet lang=\{lang\} label=\{`\$\{S\.memberLogin\} \$\{memberSel\.email\}`\}/);
  });
});

describe("rule 1177 (banner): the founder's view of an account shows a sticky banner with the time left and Stop", () => {
  it("counts whole minutes up, never below zero", () => {
    expect(minutesLeft(60_000 * 15, 0)).toBe(15);
    expect(minutesLeft(60_000 * 15, 1)).toBe(15);
    expect(minutesLeft(60_001, 0)).toBe(2);
    expect(minutesLeft(0, 5)).toBe(0);
  });

  it("is shown from the session's founder actor, never from the cookie alone, and Stop posts to the impersonate route", () => {
    const layout = read("src/app/[lang]/app/layout.tsx");
    expect(layout).toContain('{actor?.kind === "founder" && <ImpersonationBanner lang={lang} email={user.email} until={actor.until} />}');
    expect(layout).not.toContain('jar.get("nashr_impersonate")');
    const b = read("src/components/app/ImpersonationBanner.tsx");
    expect(b).toContain('action="/api/admin/impersonate"');
    expect(b).toContain('method="post"');
    expect(b).toMatch(/className="sticky top-0/);
    expect(b).toMatch(/<button type="submit" className="[^"]*min-h-\[var\(--hit-min\)\]/);
    expect(b).toContain('<bdi className="break-all font-mono" dir="ltr">{email}</bdi>');
    for (const lang of ["en", "ar"] as const) {
      expect(IMPERSONATION_COPY[lang].left(15), lang).toMatch(/15/);
      expect(IMPERSONATION_COPY[lang].left(15), lang).not.toMatch(/[\u0660-\u0669]/);
    }
  });
});

describe("rule 1181: the console's panels live in src/components/admin", () => {
  it("no admin panel is left in components/app, and nothing imports one from there", () => {
    const moved = ["PaymentsPanel", "PartnersPanel", "WishlistPanel", "LeadsPanel", "GoldenPanel", "EntitlementsTable"];
    for (const m of moved) {
      expect(() => statSync(`src/components/app/${m}.tsx`), m).toThrow();
      expect(statSync(`src/components/admin/${m}.tsx`).isFile(), m).toBe(true);
    }
    const importers = filesUnder("src").filter((f) => moved.some((m) => read(f).includes(`components/app/${m}"`)));
    expect(importers).toEqual([]);
  });
});

describe("rule 1182 (spec 1073): no native prompt, confirm or alert in the console, and every console word in both languages", () => {
  const NATIVE = (name: string) => new RegExp(`(?<![\\w$.\`])(?:window\\.)?${name}\\(`);
  it("no file under src/components/admin calls the browser's prompt, confirm or alert", () => {
    for (const f of filesUnder("src/components/admin")) {
      const src = read(f);
      for (const n of ["prompt", "confirm", "alert"]) expect(src, `${f}: ${n}`).not.toMatch(NATIVE(n));
    }
  });

  it("each console dictionary has the same keys in Arabic and English, none empty", () => {
    const shape = (o: unknown): string[] => (typeof o === "object" && o !== null && !Array.isArray(o) ? Object.entries(o).flatMap(([k, v]) => [k, ...shape(v).map((x) => `${k}.${x}`)]).sort() : []);
    const values = (o: unknown): unknown[] => (typeof o === "object" && o !== null ? Object.values(o).flatMap(values) : [o]);
    for (const [name, d] of Object.entries({ USERS_COPY, TABLE_COPY, FORM_COPY, LOG_COPY, IMPERSONATION_COPY, ADMIN_INPUT_ERRORS }) as [string, { en: object; ar: object }][]) {
      expect(shape(d.ar), name).toEqual(shape(d.en));
      for (const lang of ["en", "ar"] as const) for (const v of values(d[lang])) if (typeof v === "string") expect(v.trim(), `${name}.${lang}`).not.toBe("");
    }
    // The Arabic words are Arabic: every plain string in the ar half that has letters has Arabic letters.
    for (const [name, d] of Object.entries({ USERS_COPY, TABLE_COPY, FORM_COPY, LOG_COPY }) as [string, { ar: object }][]) {
      for (const v of values(d.ar)) if (typeof v === "string" && /[a-z]{3}/i.test(v)) expect(v, name).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it("the console shows no hard-coded English state words: the suspended badge and the table words come from the dictionaries", () => {
    const src = adminConsoleSrc();
    expect(src).not.toMatch(/>SUSPENDED</);
    expect(src).not.toContain('" · SUSPENDED"');
    for (const f of ["src/components/admin/Users.tsx", "src/components/admin/UserSheet.tsx"]) expect(read(f), f).not.toContain("— not completed —");
    expect(read("src/components/admin/Log.tsx")).not.toMatch(/<th[^>]*>(at|user|action|reason)<\/th>/);
  });
});

