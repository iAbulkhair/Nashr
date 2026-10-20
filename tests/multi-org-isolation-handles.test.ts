import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { json, newMember, newUser, params, settle, signIn, withHeaders } from "./helpers/session";
import { vjson } from "./helpers/version";
import { acct, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { saveBrand, saveTask, type Brand, type Task } from "@/lib/brand";
import { saveBrands, scopeFor, type BrandMeta } from "@/lib/brands";
import { writeFile } from "@/lib/files";
import { createConversation } from "@/lib/conversations";
import { ownerOf } from "@/lib/membership";
import { deleteMembership, withAccountTeamLock, writeMembership, type TeamRole } from "@/lib/team";
import { accountKey, personKey, storedAccountId, type AccountId, type PersonId } from "@/lib/keys";
import { wsHandle } from "@/lib/ws-handle";
import { WS_HEADER, isNotFoundError, workspaceMissing } from "@/lib/ws-path";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

import * as tasksRoute from "@/app/api/tasks/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as filesRoute from "@/app/api/files/route";
import * as convRoute from "@/app/api/conversations/route";
import * as brandRoute from "@/app/api/brand/route";
import * as brandsRoute from "@/app/api/brands/route";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/**
 * Rule 2110, the handle half (docs/specs/2026-10-18-multi-org.md section 8, item 5; release M2, decision 7), with
 * `MULTI_ORG` on. The account of a request is the one its `x-thakeen-ws` handle names, and only when the session's person
 * holds that account at that moment; tests/multi-org-isolation.test.ts is the session half.
 *
 * The graph: 4 accounts (new owners are `p_` persons with `a_` accounts, as sign-up makes them with the flag on), 3 more
 * persons who are members, and random extra memberships. Between requests a membership is removed (its handle goes
 * stale) or a forged `orgs:{pid}` entry names an account the person never joined. Each request carries a handle that is
 * held, foreign, forged into `orgs:`, stale, made up, malformed or absent, plus account and person ids of other accounts
 * in the body, the query and other headers, and runs while the session's own `acct` is a held account that may differ
 * from the handle's.
 *
 * Every `db` call is recorded. A key names an account when one of its `:`/`#` parts is an account id of the graph.
 * - A held handle: the answer is not 401, 404 or 409 (a valid write is 200), and every key naming an account other than
 *   the handle's is one of the reads that CHECK a candidate (`user:`, `mbr:`, the roster, the brand list, the active brand).
 * - Any other handle: 404 (the same answer for every case), nothing naming an account is written, and only check reads.
 * - No handle: a read answers in the session's account; a state-changing request is 409 `workspace_missing`.
 * - No answer carries another account's marker.
 */

const SEED = Number(process.env.ISOLATION_SEED ?? 2113);
const REQUESTS = 150;

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
const chance = (p: number) => rng() < p;

type Acc = { k: number; u: User; aid: AccountId; marker: string; brands: string[]; taskId: string; file: string; conv: string };
type Person = { pid: PersonId; email: string; owns: AccountId | null };

const accounts: Acc[] = [];
const persons: Person[] = [];
/** The ground truth: `${aid} ${pid}` → whether it is the person's home membership (never removed here). */
const memberships = new Map<string, { home: boolean }>();
const mkey = (aid: AccountId, pid: PersonId) => `${aid} ${pid}`;
const holds = (p: Person, aid: AccountId) => p.owns === aid || memberships.has(mkey(aid, p.pid));
const accById = (aid: string) => accounts.find((a) => a.aid === aid)!;

const brand = (name: string): Brand => ({ name, website: "https://x.example", industry: name, dialect: "saudi", languages: ["ar"], tone: "t", products: name, audience: "a", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "", updatedAt: new Date().toISOString() });
const task = (id: string, marker: string): Task => ({ id, type: "social", channel: "instagram", title: marker, body: marker, status: "pending", createdAt: new Date().toISOString(), lang: "ar" });

async function seedAccount(k: number, u: User): Promise<Acc> {
  const aid = storedAccountId(acct(u));
  const marker = `HACCT-${k}-X`;
  const rows: BrandMeta[] = ["default", `b${k}${randomBytes(2).toString("hex")}`].map((id) => ({ id, name: `${marker} ${id}`, createdAt: u.createdAt, status: "active" }));
  const taskId = randomBytes(8).toString("hex");
  const file = `hacct${k}.md`;
  await Promise.all([
    saveBrands(aid, rows),
    ...rows.map((b) => saveBrand(scopeFor(aid, b.id), brand(`${marker} ${b.id}`))),
    saveTask(aid, task(taskId, marker), true),
    writeFile(aid, file, `${marker} file`),
  ]);
  const conv = (await createConversation(aid, `${marker} thread`)).id;
  return { k, u, aid, marker, brands: rows.map((r) => r.id), taskId, file, conv };
}

const READS = new Set(["get", "mget", "lrange", "hgetall", "smembers", "sismember", "scardMany", "zcard", "zscore", "zrangeWithScores", "zrangeByScore", "ttl"]);
type Touch = { op: string; key: string };
let recording = false;
const touched: Touch[] = [];
const spies: { mockRestore(): void }[] = [];

function recordDb() {
  const target = db as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of Object.keys(target)) {
    if (typeof target[name] !== "function") continue;
    const real = target[name].bind(db);
    spies.push(
      vi.spyOn(target, name).mockImplementation(((...args: unknown[]) => {
        if (recording) {
          const keys = Array.isArray(args[0]) ? (args[0] as string[]) : typeof args[0] === "string" ? [args[0]] : [];
          if (name === "rename" && typeof args[1] === "string") keys.push(args[1]);
          for (const key of keys) touched.push({ op: name, key });
        }
        return real(...args);
      }) as never),
    );
  }
}

const namedAccounts = (key: string): AccountId[] => {
  const parts = key.split(":").flatMap((x) => x.split("#"));
  return accounts.filter((a) => parts.includes(a.aid)).map((a) => a.aid);
};
/** A read that checks whether `pid` holds `aid` (the selector's candidates), never the account's data. */
const checkRead = (t: Touch, aid: AccountId, pid: PersonId) =>
  READS.has(t.op) && [accountKey.user(aid), accountKey.membership(aid, pid), accountKey.members(aid), accountKey.brands(aid), personKey.activeBrand(pid, aid)].includes(t.key);

beforeAll(async () => {
  for (let k = 0; k < 4; k++) {
    const u = await newUser(`hiso${k}-`, { shadow: false });
    accounts.push(await seedAccount(k, u));
    persons.push({ pid: ownerOf(u), email: u.email, owns: storedAccountId(acct(u)) });
  }
  for (let j = 0; j < 3; j++) {
    const home = pick(accounts);
    const role: TeamRole = chance(0.5) ? "admin" : "member";
    const m = await newMember(home.u, role, `hisom${j}-`, { shadow: false });
    persons.push({ pid: m.pid, email: m.email, owns: null });
    memberships.set(mkey(home.aid, m.pid), { home: true });
  }
  for (const p of persons) {
    for (const a of accounts.filter((x) => !holds(p, x.aid)).filter(() => chance(0.5)).slice(0, 2)) {
      await withAccountTeamLock(a.aid, () =>
        writeMembership(a.aid, p.pid, { aid: a.aid, pid: p.pid, role: chance(0.5) ? "admin" : "member", acceptedAt: new Date().toISOString(), invitedBy: a.u.email }, { home: false, teamLocked: true }),
      );
      memberships.set(mkey(a.aid, p.pid), { home: false });
    }
  }
  recordDb();
}, 60_000);

afterAll(() => {
  for (const s of spies) s.mockRestore();
});

/** Removed memberships per person: their handles are stale. Forged `orgs:` entries per person. */
const stale = new Map<PersonId, AccountId[]>();
const forged = new Map<PersonId, AccountId[]>();

async function mutate(p: Person): Promise<string> {
  const r = rng();
  if (r < 0.12) {
    const extra = [...memberships.entries()].filter(([k, m]) => !m.home && k.endsWith(` ${p.pid}`));
    if (extra.length) {
      const aid = pick(extra)[0].split(" ")[0] as AccountId;
      await withAccountTeamLock(aid, () => deleteMembership(aid, p.pid, { home: false, teamLocked: true }));
      memberships.delete(mkey(aid, p.pid));
      stale.set(p.pid, [...(stale.get(p.pid) ?? []), aid]);
      return `removed ${aid}`;
    }
  }
  if (r < 0.24) {
    const other = accounts.find((a) => !holds(p, a.aid));
    if (other) {
      await db.sadd(personKey.orgs(p.pid), other.aid);
      forged.set(p.pid, [...(forged.get(p.pid) ?? []), other.aid]);
      return `forged orgs:${other.aid}`;
    }
  }
  return "none";
}

type Kind = "held" | "foreign" | "forged" | "stale" | "madeup" | "malformed" | "none";
function handleFor(p: Person): { kind: Kind; handle: string | null; target: AccountId | null } {
  const held = accounts.filter((a) => holds(p, a.aid));
  const notHeld = accounts.filter((a) => !holds(p, a.aid));
  const r = rng();
  const st = (stale.get(p.pid) ?? []).filter((aid) => !holds(p, aid));
  const fo = (forged.get(p.pid) ?? []).filter((aid) => !holds(p, aid));
  if (r < 0.45) { const a = pick(held); return { kind: "held", handle: wsHandle(a.aid), target: a.aid }; }
  if (r < 0.58 && notHeld.length) return { kind: "foreign", handle: wsHandle(pick(notHeld).aid), target: null };
  if (r < 0.66 && fo.length) return { kind: "forged", handle: wsHandle(pick(fo)), target: null };
  if (r < 0.74 && st.length) return { kind: "stale", handle: wsHandle(pick(st)), target: null };
  if (r < 0.82) return { kind: "madeup", handle: `w_${Array.from({ length: 16 }, () => pick([..."abcdefghijklmnopqrstuvwxyz234567"])).join("")}`, target: null };
  if (r < 0.88) return { kind: "malformed", handle: pick(["garbage", accounts[0].aid, "w_AAAA", ""]), target: null };
  return { kind: "none", handle: null, target: null };
}

/** `method`/`path`: what the proxy sees. `write`: a valid write (200 when it may run). `foreign`: names another account's record (404 in a held account). */
type Call = { name: string; method: string; path: string; write?: true; foreign?: true; run: (h: Record<string, string>) => Promise<Response> };
function requestFor(target: AccountId): Call {
  const o = pick(accounts.filter((a) => a.aid !== target));
  const own = accById(target);
  const body = { scope: scopeFor(o.aid, pick(o.brands)), acct: o.aid, aid: o.aid, pid: ownerOf(o.u), accountId: o.aid };
  const qs = `acct=${encodeURIComponent(o.aid)}&scope=${encodeURIComponent(body.scope)}`;
  const calls: Call[] = [
    { name: "tasks GET", method: "GET", path: "/api/tasks", run: (h) => tasksRoute.GET(json(`/api/tasks?${qs}`, "GET", undefined, h)) },
    { name: "task PATCH foreign id", method: "PATCH", path: `/api/tasks/${o.taskId}`, foreign: true, run: async (h) => taskRoute.PATCH(await vjson(`/api/tasks/${o.taskId}`, "PATCH", { status: "approved", editedBody: "hijacked", ...body }, h), params({ id: o.taskId })) },
    { name: "files GET foreign name", method: "GET", path: "/api/files", run: (h) => filesRoute.GET(json(`/api/files?name=${o.file}&${qs}`, "GET", undefined, h)) },
    { name: "files GET own name", method: "GET", path: "/api/files", run: (h) => filesRoute.GET(json(`/api/files?name=${own.file}`, "GET", undefined, h)) },
    { name: "conversations GET", method: "GET", path: "/api/conversations", run: (h) => convRoute.GET(json(`/api/conversations?${qs}`, "GET", undefined, h)) },
    { name: "conversations POST", method: "POST", path: "/api/conversations", write: true, run: (h) => convRoute.POST(json("/api/conversations", "POST", { title: "new", agent: "noor", ...body }, h)) },
    { name: "brand GET", method: "GET", path: "/api/brand", run: (h) => brandRoute.GET(json(`/api/brand?${qs}`, "GET", undefined, h)) },
    { name: "brands GET", method: "GET", path: "/api/brands", run: () => brandsRoute.GET() },
  ];
  return pick(calls);
}

describe("rule 2110 (handle half): a request reaches only the held account its handle names", () => {
  it(`${REQUESTS} random requests with held, foreign, forged, stale, made-up, malformed and missing handles (seed ${SEED})`, async () => {
    const problems: string[] = [];
    const kinds = new Map<Kind, number>();
    for (let i = 0; i < REQUESTS && problems.length < 5; i++) {
      const p = pick(persons);
      const did = await mutate(p);
      const session = pick(accounts.filter((a) => holds(p, a.aid))).aid;
      await signIn(p.email, { acct: session });
      const h = handleFor(p);
      kinds.set(h.kind, (kinds.get(h.kind) ?? 0) + 1);
      // The account the request must answer for: the handle's when held, the session's with no handle.
      const target = h.kind === "held" ? h.target! : h.kind === "none" ? session : null;
      const call = requestFor(target ?? session);
      const headers: Record<string, string> = { "x-thakeen-acct": accounts[0].aid, "x-account": accounts[1].aid, ...(h.handle !== null ? { [WS_HEADER]: h.handle } : {}) };
      touched.length = 0;
      recording = true;
      let status = 0;
      let text = "";
      try {
        const res = await withHeaders(headers, () => call.run(headers)).catch((e: unknown) => {
          if (isNotFoundError(e)) return new Response("not found", { status: 404 });
          throw e;
        });
        status = res.status;
        text = await res.text();
        await settle();
      } finally {
        recording = false;
      }
      const at = `seed ${SEED}, request ${i} (${call.name}) by ${p.pid}, session ${session}, handle ${h.kind} ${h.handle}, mutation ${did}`;
      // A state-changing request without a valid handle never reaches a route in production: the proxy answers 409
      // (the route wrapper repeats it; a route outside the wrapper still refuses with the 404 of `resolveSession`).
      const missing = workspaceMissing(call.method, call.path, true, h.handle);
      if (missing) {
        const viaProxy = proxy(new NextRequest(`https://thakeen.example${call.path}`, { method: call.method, headers: { cookie: "thakeen_session=tok", "sec-fetch-site": "same-origin", ...(h.handle !== null ? { [WS_HEADER]: h.handle } : {}) } }));
        if (viaProxy.status !== 409) problems.push(`${at}: the proxy answered ${viaProxy.status}, not 409`);
        if (![404, 409].includes(status)) problems.push(`${at}: status ${status}, not refused`);
      } else if (target) {
        if ([401, 409].includes(status) || (status === 404 && !call.foreign)) problems.push(`${at}: status ${status}`);
        if (call.write && status !== 200) problems.push(`${at}: the write answered ${status}`);
      } else if (status !== 404) problems.push(`${at}: status ${status}, not 404`);
      if (status >= 500) problems.push(`${at}: status ${status} ${text.slice(0, 200)}`);
      for (const t of touched) {
        for (const aid of namedAccounts(t.key)) {
          if (target && aid === target) continue;
          if (checkRead(t, aid, p.pid)) continue;
          problems.push(`${at}: ${t.op} ${t.key}`);
        }
      }
      for (const a of accounts) if (a.aid !== target && text.includes(a.marker)) problems.push(`${at}: the answer holds ${a.marker}`);
    }
    expect(problems, `isolation property failed; replay with ISOLATION_SEED=${SEED}`).toEqual([]);
    for (const k of ["held", "foreign", "madeup", "malformed", "none"] as const) expect(kinds.get(k) ?? 0, `seed ${SEED} sent no "${k}" handle`).toBeGreaterThan(5);
    expect((kinds.get("stale") ?? 0) + (kinds.get("forged") ?? 0), `seed ${SEED} sent no stale or forged handle`).toBeGreaterThan(0);
  }, 90_000);
});
