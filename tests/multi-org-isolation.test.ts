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
import { push } from "@/lib/chat";
import { ownerOf } from "@/lib/membership";
import { deleteMembership, withAccountTeamLock, writeMembership, type TeamRole } from "@/lib/team";
import { accountKey, personKey, storedAccountId, type AccountId, type PersonId } from "@/lib/keys";

import * as tasksRoute from "@/app/api/tasks/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as filesRoute from "@/app/api/files/route";
import * as convRoute from "@/app/api/conversations/route";
import * as brandRoute from "@/app/api/brand/route";
import * as brandsRoute from "@/app/api/brands/route";
import * as chatRoute from "@/app/api/chat/route";
import * as feedRoute from "@/app/api/secretary/feed/route";

/**
 * Rule 2110, the isolation property (docs/specs/2026-10-18-multi-org.md section 8, item 5), the session half of release
 * M1: over a random graph of persons, accounts, brands and memberships, every Redis key a workspace request touches
 * belongs to an account the session's person owns or is a live member of AT THAT MOMENT, and no answer carries another
 * account's data. The account comes only from the session (`acct`, re-checked by `resolveSession` on every request);
 * workspace handles in the URL and the `x-thakeen-ws` guard come with release M2 (decision 7) and extend this test then.
 *
 * The graph: 5 accounts (owners mixed `p_` and legacy persons) with 2-3 brands each, 4 more persons who are members, and
 * random extra memberships (admin or member) of owners and members in other accounts. Between requests, memberships are
 * paused for seats and resumed, removed after a session for them was written, and records are forged: an `orgs:{pid}`
 * entry for an account the person never joined, a `mbr:{aid}:{pid}` row with role "owner", a row without its roster
 * entry. 200 requests run over the routes of tests/routes-isolation.test.ts (tasks, task, files, conversations, brand)
 * plus the brands list and switch, the chat history and the calendar feed status, with ids, scopes, emails, account and
 * person ids from OTHER accounts in the body, the query and forged headers.
 *
 * Every `db` call is recorded through a spy (as tests/helpers/rounds.ts does). A key names an account when one of its
 * `:`/`#`-separated parts is an account id of the graph. Each such key must name an account the person holds at that
 * moment, except the reads `resolveSession` makes to CHECK the session's account (`user:`, `mbr:`, the roster, the brand
 * list and the person's active brand there), after which the answer must be 401. The seed is printed on failure;
 * `ISOLATION_SEED` replays one.
 */

const SEED = Number(process.env.ISOLATION_SEED ?? 2110);
const REQUESTS = 200;

/** mulberry32: a small deterministic PRNG, so a failing run is replayed from its seed. */
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

type Acc = { k: number; u: User; aid: AccountId; ownerPid: PersonId; marker: string; brands: string[]; taskId: string; file: string; conv: string };
type Person = { pid: PersonId; email: string; owns: AccountId | null };
/** The ground truth: the memberships the test made, independent of the code under test. */
type Mship = { role: TeamRole; paused: boolean; home: boolean };

const accounts: Acc[] = [];
const persons: Person[] = [];
const memberships = new Map<string, Mship>(); // `${aid} ${pid}`
const mkey = (aid: AccountId, pid: PersonId) => `${aid} ${pid}`;

const holds = (p: Person, aid: AccountId): boolean => {
  if (p.owns === aid) return true;
  const m = memberships.get(mkey(aid, p.pid));
  return !!m && !m.paused;
};
const accById = (aid: string) => accounts.find((a) => a.aid === aid);

const brand = (name: string): Brand => ({ name, website: "https://x.example", industry: name, dialect: "saudi", languages: ["ar"], tone: "t", products: name, audience: "a", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "", updatedAt: new Date().toISOString() });
const task = (id: string, marker: string): Task => ({ id, type: "social", channel: "instagram", title: marker, body: marker, status: "pending", createdAt: new Date().toISOString(), lang: "ar" });

async function seedAccount(k: number, u: User): Promise<Acc> {
  const aid = storedAccountId(acct(u));
  const marker = `ACCT-${k}-X`;
  const extra = Array.from({ length: 1 + Math.floor(rng() * 2) }, (_, i) => `b${k}${i}${randomBytes(2).toString("hex")}`);
  const rows: BrandMeta[] = ["default", ...extra].map((id) => ({ id, name: `${marker} ${id}`, createdAt: u.createdAt, status: "active" }));
  const taskId = randomBytes(8).toString("hex");
  const file = `acct${k}.md`;
  await Promise.all([
    saveBrands(aid, rows),
    ...rows.map((b) => saveBrand(scopeFor(aid, b.id), brand(`${marker} ${b.id}`))),
    saveTask(aid, task(taskId, marker), true),
    writeFile(aid, file, `${marker} file`),
  ]);
  const conv = (await createConversation(aid, `${marker} thread`)).id;
  await push(aid, { role: "user", content: `${marker} message`, at: new Date().toISOString() }, conv);
  return { k, u, aid, ownerPid: ownerOf(u), marker, brands: rows.map((r) => r.id), taskId, file, conv };
}

async function join(aid: AccountId, pid: PersonId, role: TeamRole, paused = false) {
  await withAccountTeamLock(aid, () =>
    writeMembership(aid, pid, { aid, pid, role, acceptedAt: new Date().toISOString(), invitedBy: accById(aid)!.u.email, ...(paused ? { disabled: "seats" as const } : {}) }, { home: false, teamLocked: true }),
  );
  memberships.set(mkey(aid, pid), { role, paused, home: false });
}

// ---------------------------------------------------------------------------------------------------------------------
// The key recorder: every db call while a request runs.
// ---------------------------------------------------------------------------------------------------------------------

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

/**
 * The key families whose id parts name a PERSON or a login: `person:{pid}`, `orgs:{pid}`, `mbr:{aid}:{pid}`,
 * `activebrand:{pid}:{aid}`, the login index, rate buckets per login (`rate:sec:read:{login}`), and a legacy person's records (a legacy owner's
 * person id is its account id, so its credential record is `user:{pid}` and its legacy active brand
 * `activebrand:{login}`). In these the session person's own id or address is the person, not an account; the account
 * part that remains (the `aid` of `mbr:{aid}:{pid}`) is checked like any other. `user:` counts as the person's record
 * for reads only: a write there writes the account.
 */
const PERSON_FAMILIES = /^(rate:)?(person|lock:person|orgs|lastorg|mbr|activebrand|sec:feedof|sec:bookof|lock:feed|lock:book|login|lock:login|member|lock:member|sec:read|sec:feed|user):/;

/** The accounts a key names: its `:`/`#` parts that are account ids of the graph, less the session person's own parts. */
const namedAccounts = (t: Touch, p: Person): AccountId[] => {
  let parts = t.key.split(":").flatMap((x) => x.split("#"));
  if (PERSON_FAMILIES.test(t.key) && (!t.key.startsWith("user:") || READS.has(t.op))) {
    const self = parts.findIndex((x) => x === p.pid || x === p.email);
    if (self >= 0) parts = parts.filter((_, i) => i !== self);
  }
  return accounts.filter((a) => parts.includes(a.aid)).map((a) => a.aid);
};
/** The reads `resolveSession` makes to check the session's account `aid` for person `pid`; nothing else of it is read. */
const checkRead = (t: Touch, aid: AccountId, pid: PersonId) =>
  READS.has(t.op) && [accountKey.user(aid), accountKey.membership(aid, pid), accountKey.members(aid), accountKey.brands(aid), personKey.activeBrand(pid, aid)].includes(t.key);

// ---------------------------------------------------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  for (let k = 0; k < 5; k++) {
    const u = await newUser(`iso${k}-`, { shadow: false, legacy: chance(0.5) });
    accounts.push(await seedAccount(k, u));
    persons.push({ pid: ownerOf(u), email: u.email, owns: storedAccountId(acct(u)) });
  }
  for (let j = 0; j < 4; j++) {
    const home = pick(accounts);
    const role: TeamRole = chance(0.5) ? "admin" : "member";
    const m = await newMember(home.u, role, `isom${j}-`, { shadow: false, legacy: chance(0.5) });
    persons.push({ pid: m.pid, email: m.email, owns: null });
    memberships.set(mkey(home.aid, m.pid), { role, paused: false, home: true });
  }
  // Random extra memberships: every person joins 1-2 accounts they do not own and are not in yet.
  for (const p of persons) {
    const free = accounts.filter((a) => a.aid !== p.owns && !memberships.has(mkey(a.aid, p.pid)));
    for (const a of free.filter(() => chance(0.45)).slice(0, 2)) await join(a.aid, p.pid, chance(0.5) ? "admin" : "member", chance(0.2));
  }
  recordDb();
}, 60_000);

afterAll(() => {
  for (const s of spies) s.mockRestore();
});

// ---------------------------------------------------------------------------------------------------------------------
// Mutations between requests
// ---------------------------------------------------------------------------------------------------------------------

/** Change the graph at random; returns what it did, for the failure message. */
async function mutate(p: Person, active: AccountId): Promise<string> {
  const r = rng();
  const extra = [...memberships.entries()].filter(([k, m]) => !m.home && k.endsWith(` ${p.pid}`));
  if (r < 0.12 && extra.length) {
    // Pause for seats, or resume.
    const [k, m] = pick(extra);
    const aid = k.split(" ")[0] as AccountId;
    await withAccountTeamLock(aid, () => writeMembership(aid, p.pid, { aid, pid: p.pid, role: m.role, acceptedAt: new Date().toISOString(), invitedBy: accById(aid)!.u.email, ...(m.paused ? {} : { disabled: "seats" as const }) }, { home: false, teamLocked: true }));
    m.paused = !m.paused;
    return `${m.paused ? "paused" : "resumed"} ${aid}`;
  }
  if (r < 0.2) {
    // Remove the membership of the session's own account, after the session was written.
    const m = memberships.get(mkey(active, p.pid));
    if (m && !m.home) {
      await withAccountTeamLock(active, () => deleteMembership(active, p.pid, { home: false, teamLocked: true }));
      memberships.delete(mkey(active, p.pid));
      return `removed ${active}`;
    }
  }
  if (r < 0.28) {
    // A stale or forged orgs: entry for an account the person does not hold.
    const other = accounts.find((a) => !holds(p, a.aid));
    if (other) {
      await db.sadd(personKey.orgs(p.pid), other.aid);
      return `forged orgs:${other.aid}`;
    }
  }
  if (r < 0.36) {
    // A forged membership row: role "owner", or a real role with no roster entry. Neither holds.
    const other = accounts.find((a) => !holds(p, a.aid) && !memberships.has(mkey(a.aid, p.pid)));
    if (other) {
      const role = chance(0.5) ? "owner" : "admin";
      await db.set(accountKey.membership(other.aid, p.pid), { aid: other.aid, pid: p.pid, role, acceptedAt: new Date().toISOString(), invitedBy: "" });
      return `forged mbr:${other.aid} role ${role}`;
    }
  }
  return "none";
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests: ids, scopes and account and person ids from other accounts
// ---------------------------------------------------------------------------------------------------------------------

type Call = { name: string; run: () => Promise<Response> };
function requestFor(p: Person, active: AccountId): Call {
  const others = accounts.filter((a) => a.aid !== active);
  const o = pick(others);
  const forged = { scope: scopeFor(o.aid, pick(o.brands)), email: o.u.email, acct: o.aid, aid: o.aid, pid: o.ownerPid, accountId: o.aid, ownerPid: o.ownerPid };
  const headers = { "x-thakeen-ws": o.aid, "x-thakeen-acct": o.aid, "x-account": o.aid };
  const own = accById(active)!;
  const qs = `acct=${encodeURIComponent(o.aid)}&pid=${encodeURIComponent(o.ownerPid)}&scope=${encodeURIComponent(forged.scope)}`;
  const calls: Call[] = [
    { name: "tasks GET", run: () => tasksRoute.GET(json(`/api/tasks?${qs}`, "GET", undefined, headers)) },
    { name: "tasks GET count", run: () => tasksRoute.GET(json(`/api/tasks?count=pending&${qs}`, "GET", undefined, headers)) },
    { name: "task PATCH foreign id", run: async () => taskRoute.PATCH(await vjson(`/api/tasks/${o.taskId}`, "PATCH", { status: "approved", editedBody: "hijacked", ...forged }, headers), params({ id: o.taskId })) },
    { name: "files GET foreign name", run: () => filesRoute.GET(json(`/api/files?name=${o.file}&${qs}`, "GET", undefined, headers)) },
    { name: "files GET list", run: () => filesRoute.GET(json(`/api/files?${qs}`, "GET", undefined, headers)) },
    { name: "files PUT forged scope", run: () => filesRoute.PUT(json("/api/files", "PUT", { name: o.file, content: "written by the caller", ...forged }, headers)) },
    { name: "files DELETE foreign name", run: () => filesRoute.DELETE(json(`/api/files?name=${o.file}&${qs}`, "DELETE", undefined, headers)) },
    { name: "conversations GET", run: () => convRoute.GET(json(`/api/conversations?${qs}`, "GET", undefined, headers)) },
    { name: "conversations search", run: () => convRoute.GET(json(`/api/conversations?q=ACCT&${qs}`, "GET", undefined, headers)) },
    { name: "conversations POST", run: () => convRoute.POST(json("/api/conversations", "POST", { title: "new", ...forged }, headers)) },
    { name: "conversations PATCH foreign id", run: () => convRoute.PATCH(json("/api/conversations", "PATCH", { id: o.conv, title: "renamed", ...forged }, headers)) },
    { name: "conversations DELETE foreign id", run: () => convRoute.DELETE(json(`/api/conversations?id=${o.conv}&${qs}`, "DELETE", undefined, headers)) },
    { name: "brand GET", run: () => brandRoute.GET(json(`/api/brand?${qs}`, "GET", undefined, headers)) },
    { name: "brand PUT forged scope", run: () => brandRoute.PUT(json("/api/brand", "PUT", { ...brand(`${own.marker} edited`), ...forged }, headers)) },
    { name: "brands GET", run: () => withHeaders(headers, () => brandsRoute.GET()) },
    { name: "brands switch foreign id", run: () => brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: pick(o.brands.filter((b) => b !== "default").concat(["default"])), ...forged }, headers)) },
    { name: "brands switch own id", run: () => brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: pick(own.brands), ...forged }, headers)) },
    { name: "chat history foreign conv", run: () => chatRoute.GET(json(`/api/chat?conv=${o.conv}&${qs}`, "GET", undefined, headers)) },
    { name: "secretary feed status", run: () => withHeaders(headers, () => feedRoute.GET()) },
  ];
  return pick(calls);
}

describe("rule 2110: the isolation property over random graphs, sessions and forged requests", () => {
  it(`${REQUESTS} random requests touch only accounts the session's person holds at that moment (seed ${SEED})`, async () => {
    const problems: string[] = [];
    let resolved = 0;
    let refused = 0;
    const kinds = new Map<string, number>();
    for (let i = 0; i < REQUESTS && problems.length < 5; i++) {
      const p = pick(persons);
      // Mostly an account the person holds; sometimes one they do not (a session that outlived its membership).
      const heldNow = accounts.filter((a) => holds(p, a.aid));
      const active = (heldNow.length && chance(0.75) ? pick(heldNow) : pick(accounts)).aid;
      await signIn(p.email, { acct: active });
      const did = await mutate(p, active);
      const kind = did.split(" ")[0];
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      const call = requestFor(p, active);
      const held = holds(p, active);
      touched.length = 0;
      recording = true;
      let status = 0;
      let text = "";
      try {
        const res = await call.run();
        status = res.status;
        text = await res.text();
        await settle();
      } finally {
        recording = false;
      }
      const at = `seed ${SEED}, request ${i} (${call.name}) by ${p.pid} in ${active}, held ${held}, mutation ${did}`;
      if (held ? status === 401 : status !== 401) problems.push(`${at}: status ${status}`);
      if (status >= 500) problems.push(`${at}: status ${status} ${text.slice(0, 200)}`);
      held ? resolved++ : refused++;
      for (const t of touched) {
        for (const aid of namedAccounts(t, p)) {
          if (held && aid === active) continue;
          if (aid === active && checkRead(t, active, p.pid)) continue;
          problems.push(`${at}: ${t.op} ${t.key}`);
        }
      }
      // No answer carries another account's data.
      for (const a of accounts) if (a.aid !== active && text.includes(a.marker)) problems.push(`${at}: the answer holds ${a.marker}`);
    }
    expect(problems, `isolation property failed; replay with ISOLATION_SEED=${SEED}`).toEqual([]);
    // The run exercised both sides.
    expect(resolved).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(10);
    for (const kind of ["paused", "removed", "forged"]) expect(kinds.get(kind) ?? 0, `seed ${SEED} made no "${kind}" mutation`).toBeGreaterThan(0);
  }, 60_000);
});
