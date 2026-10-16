import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { adminSignIn, json, newMember, newUser, params, signIn, signOut } from "./helpers/session";
import { API_ERRORS, handler, param } from "@/lib/api-handler";
import { sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { readFile, writeFile } from "@/lib/files";
import { WINDOW } from "@/lib/rate";
import * as filesRoute from "@/app/api/files/route";
import * as brandRoute from "@/app/api/brand/route";
import * as activityRoute from "@/app/api/activity/route";
import * as activityExportRoute from "@/app/api/activity/export/route";
import * as conversationsRoute from "@/app/api/conversations/route";
import * as proposalRoute from "@/app/api/brand/proposals/[id]/route";
import * as voteRoute from "@/app/api/wishlist/vote/route";
import * as suggestRoute from "@/app/api/wishlist/suggest/route";
import * as tasksRoute from "@/app/api/tasks/route";

/**
 * Rules 1900-1905: the API route wrapper (src/lib/api-handler.ts) and the routes converted to it. The wrapper runs the
 * steps every route used to write by hand in one order (auth, role, rate, size, query, body) and hands the handler the
 * scope from the session only. The last block pins that the converted routes answer byte for byte what they did.
 */

let bucket = 0;
const fresh = () => `apitest${++bucket}x${Date.now()}`;
const body = async (r: Response) => JSON.parse(await r.text()) as unknown;
const counter = (key: string) => db.get<number>(`rate:${key}`);

/** A schema that records whether it ran: a refusal before step 5 must leave it untouched. */
function spySchema() {
  const seen: unknown[] = [];
  return { seen, schema: z.custom<{ x?: string }>((v) => { seen.push(v); return true; }) };
}

beforeEach(() => signOut());
afterEach(() => vi.unstubAllEnvs());

describe("rule 1900: authentication comes first, before the role, the rate limit and any parsing", () => {
  it("a signed-out caller of a user handler gets 401 and nothing of the request is read or counted", async () => {
    const spy = spySchema();
    const b = fresh();
    const fn = vi.fn(() => Response.json({ ok: true }));
    const h = handler({ auth: "user", role: "brand.write", rate: { bucket: b, max: 5, window: WINDOW.hour, per: "ip" }, input: spy.schema, query: spy.schema }, fn);
    const req = json("/api/probe?x=1", "POST", { x: "y" });
    const read = vi.spyOn(req, "json");
    const r = await h(req);
    expect(r.status).toBe(401);
    expect(await body(r)).toEqual({ ok: false });
    expect(read).not.toHaveBeenCalled();
    expect(spy.seen).toEqual([]);
    expect(await counter(`${b}:unknown`)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("`unauthorized` names the 401 code; omitted, the body is the bare { ok: false } the routes sent", async () => {
    const h = handler({ auth: "user", unauthorized: "auth" }, () => Response.json({ ok: true }));
    expect(await body(await h(json("/api/probe", "GET")))).toEqual({ ok: false, error: "auth" });
  });

  it("admin: isAdmin(req) or 401; the handler gets no user and no scope", async () => {
    vi.stubEnv("WAITLIST_ADMIN_KEY", "k".repeat(40));
    const seen: Record<string, unknown>[] = [];
    const h = handler({ auth: "admin" }, (ctx) => { seen.push(ctx as unknown as Record<string, unknown>); return Response.json({ ok: true }); });
    expect((await h(json("/api/probe", "GET"))).status).toBe(401);
    await adminSignIn();
    expect((await h(json("/api/probe", "GET"))).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect("u" in seen[0] || "scope" in seen[0]).toBe(false);
  });

  it("cron: the CRON_SECRET bearer compared with sameSecret, or 401; an unset secret refuses everyone", async () => {
    const h = handler({ auth: "cron" }, () => Response.json({ ok: true }));
    const call = (auth?: string) => h(new Request("https://nashr.test/api/cron/probe", { headers: auth ? { authorization: auth } : {} }));
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(401);
    expect((await call()).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "s".repeat(40));
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${"s".repeat(40)}`)).status).toBe(200);
  });

  it("public: no session needed, and its rate limit counts per client IP", async () => {
    const b = fresh();
    const h = handler({ auth: "public", rate: { bucket: b, max: 1, window: 60 } }, () => Response.json({ ok: true }));
    const from = (ip: string) => h(new Request("https://nashr.test/api/probe", { headers: { "x-forwarded-for": ip } }));
    expect((await from("203.0.113.1")).status).toBe(200);
    expect((await from("203.0.113.1")).status).toBe(429);
    expect((await from("203.0.113.2")).status).toBe(200);
  });

  it("a role is only for a signed-in user: declaring one on another auth fails at definition", () => {
    // @ts-expect-error role needs auth "user"
    expect(() => handler({ auth: "public", role: "read" }, () => new Response())).toThrow(/role needs auth "user"/);
  });
});

describe("rule 1901: the role check is forbid(), before the rate limit and the body", () => {
  it("a member refused brand.write gets the 403 { error: 'forbidden' } forbid() always sent; nothing counted or parsed", async () => {
    const owner = await newUser("hrole");
    const m = await newMember(owner, "member");
    await signIn(m.email);
    const spy = spySchema();
    const b = fresh();
    const h = handler({ auth: "user", role: "brand.write", rate: { bucket: b, max: 5, window: WINDOW.hour }, input: spy.schema }, () => Response.json({ ok: true }));
    const r = await h(json("/api/probe", "PUT", { x: "y" }));
    expect(r.status).toBe(403);
    expect(await body(r)).toEqual({ error: "forbidden" });
    expect(spy.seen).toEqual([]);
    expect(await counter(`${b}:${m.email}`)).toBeNull();
  });

  it("the owner passes the same check", async () => {
    const owner = await newUser("hrole2");
    await signIn(owner.email);
    const h = handler({ auth: "user", role: "brand.write" }, () => Response.json({ ok: true }));
    expect((await h(json("/api/probe", "PUT", {}))).status).toBe(200);
  });
});

describe("rule 1902: the rate limit answers 429 slow_down with Retry-After, before the body is read", () => {
  it("counts per account by default, per scope or per IP when asked, and refuses past max", async () => {
    const owner = await newUser("hrate");
    await signIn(owner.email);
    const spy = spySchema();
    for (const per of ["account", "scope", "ip"] as const) {
      const b = fresh();
      const h = handler({ auth: "user", rate: { bucket: b, max: 2, window: WINDOW.day, per }, input: spy.schema }, () => Response.json({ ok: true }));
      const req = () => json("/api/probe", "POST", { x: "y" }, { "x-forwarded-for": "198.51.100.7" });
      expect((await h(req())).status).toBe(200);
      expect((await h(req())).status).toBe(200);
      const seenBefore = spy.seen.length;
      const r = await h(req());
      expect(r.status).toBe(429);
      expect(r.headers.get("Retry-After")).toBe(String(WINDOW.day));
      expect(await body(r)).toEqual({ ok: false, error: "slow_down" });
      expect(spy.seen.length, "the refused body is never parsed").toBe(seenBefore);
      const who = per === "account" ? owner.email : per === "scope" ? sc(owner) : "198.51.100.7";
      expect(Number(await counter(`${b}:${who}`))).toBe(3);
    }
  });

  it("maxBytes answers 413 too_large from Content-Length, after the rate limit and before the body", async () => {
    const owner = await newUser("hsize");
    await signIn(owner.email);
    const spy = spySchema();
    const h = handler({ auth: "user", maxBytes: 10, input: spy.schema }, () => Response.json({ ok: true }));
    const r = await h(json("/api/probe", "PUT", { x: "a".repeat(50) }, { "content-length": "60" }));
    expect(r.status).toBe(413);
    expect(await body(r)).toEqual({ ok: false, error: "too_large" });
    expect(spy.seen).toEqual([]);
  });
});

describe("rule 1903: zod refusals answer 400 with the field's own code, else `invalid`, else the bare body", () => {
  const schema = z.object({ a: z.string({ error: "missing" }), b: z.number(), c: z.custom<string>((v) => v === "ok", { error: "bad_kind" }) });
  const call = async (opts: { invalid?: "bad_input" }, payload: unknown) => {
    const owner = await newUser("hzod");
    await signIn(owner.email);
    const h = handler({ auth: "user", input: schema, ...opts }, ({ input }) => Response.json({ ok: true, input }));
    return h(new Request("https://nashr.test/api/probe", { method: "POST", body: typeof payload === "string" ? payload : JSON.stringify(payload) }));
  };

  it("the first failing field in key order decides, when its message is a known code", async () => {
    expect(await body(await call({}, { b: "x", c: "no" }))).toEqual({ ok: false, error: "missing" });
    expect(await body(await call({}, { a: "x", b: 1, c: "no" }))).toEqual({ ok: false, error: "bad_kind" });
  });

  it("a field without a code falls back to `invalid`, and without `invalid` to { ok: false }", async () => {
    const r = await call({ invalid: "bad_input" }, { a: "x", b: "not a number", c: "ok" });
    expect(r.status).toBe(400);
    expect(await body(r)).toEqual({ ok: false, error: "bad_input" });
    expect(await body(await call({}, { a: "x", b: "not a number", c: "ok" }))).toEqual({ ok: false });
  });

  it("a body that is not JSON is checked as {}, as req.json().catch(() => ({})) did", async () => {
    expect(await body(await call({}, "{not json"))).toEqual({ ok: false, error: "missing" });
  });

  it("a valid body reaches the handler parsed", async () => {
    const r = await call({}, { a: "x", b: 2, c: "ok", extra: true });
    expect(await body(r)).toEqual({ ok: true, input: { a: "x", b: 2, c: "ok" } });
  });

  it("query: the first value of each name, an empty value is none, codes as for the body", async () => {
    const owner = await newUser("hq");
    await signIn(owner.email);
    const h = handler({ auth: "user", query: z.object({ agent: param((v): v is "noor" => v === "noor", "bad_agent") }) }, ({ query }) => Response.json({ ok: true, query }));
    expect(await body(await h(json("/api/probe?agent=noor&agent=x", "GET")))).toEqual({ ok: true, query: { agent: "noor" } });
    expect(await body(await h(json("/api/probe?agent=", "GET")))).toEqual({ ok: true, query: {} });
    expect(await body(await h(json("/api/probe?agent=x", "GET")))).toEqual({ ok: false, error: "bad_agent" });
  });

  it("every code is a lowercase identifier the client maps can key on, listed once", () => {
    for (const c of API_ERRORS) expect(c).toMatch(/^[a-z_]+$/);
    expect(new Set(API_ERRORS).size).toBe(API_ERRORS.length);
  });
});

describe("rule 1904: the tenant scope comes only from sc(u), never from the request", () => {
  const anyBody = z.looseObject({});

  it("a scope, email or id in the body, the query, a header or the path does not move the handler's scope", async () => {
    const owner = await newUser("hscope");
    const victim = await newUser("hvictim");
    await signIn(owner.email);
    const seen: { scope: string; email: string }[] = [];
    const h = handler<"user", typeof anyBody, undefined, { scope: string }>({ auth: "user", input: anyBody }, ({ u, scope }) => {
      seen.push({ scope, email: u.email });
      return Response.json({ ok: true });
    });
    const q = `?scope=${encodeURIComponent(sc(victim))}&email=${encodeURIComponent(victim.email)}`;
    await h(json(`/api/probe${q}`, "POST", { scope: sc(victim), email: victim.email, u: { email: victim.email } }, { "x-scope": sc(victim) }), params({ scope: sc(victim) }));
    expect(seen).toEqual([{ scope: sc(owner), email: owner.email }]);
  });

  it("PUT /api/files with another account's scope in the body writes the caller's own workspace only", async () => {
    const owner = await newUser("hfiles");
    const victim = await newUser("hfilesv");
    await writeFile(sc(victim), "notes.md", "victim's own", "user");
    await signIn(owner.email);
    const r = await filesRoute.PUT(json("/api/files", "PUT", { name: "notes.md", content: "planted", scope: sc(victim), email: victim.email }));
    expect(r.status).toBe(200);
    expect((await readFile(sc(victim), "notes.md"))?.content).toBe("victim's own");
    expect((await readFile(sc(owner), "notes.md"))?.content).toBe("planted");
  });
});

describe("rule 1905: the converted routes answer byte for byte what they answered by hand", () => {
  const text = async (r: Response | Promise<Response>) => { const x = await r; return `${x.status} ${await x.text()}`; };

  it("signed out: each route's own 401 body", async () => {
    expect(await text(filesRoute.GET(json("/api/files", "GET")))).toBe('401 {"ok":false}');
    expect(await text(brandRoute.PUT(json("/api/brand", "PUT", {})))).toBe('401 {"ok":false}');
    expect(await text(tasksRoute.GET(json("/api/tasks", "GET")))).toBe('401 {"ok":false}');
    expect(await text(conversationsRoute.POST(json("/api/conversations", "POST", {})))).toBe('401 {"ok":false}');
    expect(await text(proposalRoute.POST(json("/api/brand/proposals/x", "POST", {}), params({ id: "x" })))).toBe('401 {"ok":false}');
    expect(await text(activityRoute.GET(json("/api/activity", "GET")))).toBe('401 {"ok":false,"error":"auth"}');
    expect(await text(activityExportRoute.GET(json("/api/activity/export", "GET")))).toBe('401 {"ok":false,"error":"auth"}');
    expect(await text(voteRoute.POST(json("/api/wishlist/vote", "POST", {})))).toBe('401 {"ok":false,"error":"auth"}');
    expect(await text(suggestRoute.POST(json("/api/wishlist/suggest", "POST", {})))).toBe('401 {"ok":false,"error":"auth"}');
  });

  it("refusals of a signed-in owner keep their codes and statuses", async () => {
    const owner = await newUser("hbytes");
    await signIn(owner.email);
    expect(await text(filesRoute.PUT(json("/api/files", "PUT", { name: "x.md" })))).toBe('400 {"ok":false,"error":"missing"}');
    expect(await text(filesRoute.PUT(json("/api/files", "PUT", { name: "x.md", content: "y" }, { "content-length": "300000" })))).toBe('413 {"ok":false,"error":"too_large"}');
    expect(await text(filesRoute.DELETE(json("/api/files", "DELETE")))).toBe('400 {"ok":false}');
    expect(await text(brandRoute.PUT(json("/api/brand", "PUT", { name: "n", industry: "i", products: "p" })))).toBe('400 {"ok":false,"error":"missing"}');
    expect(await text(brandRoute.PUT(json("/api/brand", "PUT", [])))).toBe('400 {"ok":false,"error":"missing"}');
    expect(await text(proposalRoute.POST(json("/api/brand/proposals/x", "POST", { action: "nope" }), params({ id: "x" })))).toBe('400 {"ok":false,"error":"bad_action"}');
    expect(await text(conversationsRoute.PATCH(json("/api/conversations", "PATCH", { id: "c1" })))).toBe('400 {"ok":false}');
    expect(await text(conversationsRoute.DELETE(json("/api/conversations", "DELETE")))).toBe('400 {"ok":false}');
    // The activity filters are checked agent, kind, cursor: the first bad one names the code.
    expect(await text(activityRoute.GET(json("/api/activity?agent=nobody&kind=nothing", "GET")))).toBe('400 {"ok":false,"error":"bad_agent"}');
    expect(await text(activityRoute.GET(json("/api/activity?agent=noor&kind=nothing&before=x", "GET")))).toBe('400 {"ok":false,"error":"bad_kind"}');
    expect(await text(activityRoute.GET(json("/api/activity?agent=noor&before=not-a-cursor", "GET")))).toBe('400 {"ok":false,"error":"bad_cursor"}');
    expect(await text(voteRoute.POST(json("/api/wishlist/vote", "POST", { id: "w-nope" })))).toBe('400 {"ok":false,"error":"unknown_item"}');
    expect(await text(suggestRoute.POST(json("/api/wishlist/suggest", "POST", { text: "hi" })))).toBe('400 {"ok":false,"error":"too_short"}');
    expect(await text(suggestRoute.POST(json("/api/wishlist/suggest", "POST", { text: "x".repeat(500) })))).toBe('400 {"ok":false,"error":"too_long"}');
  });

  it("the rate limits keep their buckets and their Retry-After", async () => {
    const owner = await newUser("hbuckets");
    await signIn(owner.email);
    await db.set(`rate:files:${sc(owner)}`, 60, 3600);
    const files = await filesRoute.PUT(json("/api/files", "PUT", { name: "x.md", content: "y" }));
    expect([files.status, files.headers.get("Retry-After"), await files.text()]).toEqual([429, "3600", '{"ok":false,"error":"slow_down"}']);
    await db.set(`rate:wishvote:${owner.email}`, 60, 3600);
    const vote = await voteRoute.POST(json("/api/wishlist/vote", "POST", { id: "w-nope" }));
    expect([vote.status, vote.headers.get("Retry-After")]).toEqual([429, "3600"]);
    await db.set(`rate:activityexport:${owner.email}`, 1000, 3600);
    expect((await activityExportRoute.GET(json("/api/activity/export", "GET"))).status).toBe(429);
  });
});
