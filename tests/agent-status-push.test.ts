import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { json, newMember, newUser, settle, signIn, signOut } from "./helpers/session";

const safeFetch = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit, opts?: { httpsOnly?: boolean }) => Promise<Response>>());
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import { acct, currentUser, sc, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, wsKey } from "@/lib/keys";
import { agentById } from "@/lib/agents";
import { appDict } from "@/lib/app-i18n";
import { recordActivity, type Activity } from "@/lib/activity";
import { wipeAccount } from "@/lib/account";
import { AGENT_STATES, agentStatuses, deriveStatus, LOG_ROWS, pushStateOf, rowState, STATUS_COPY, STUCK_DAYS, WORKING_MINUTES } from "@/lib/agent-status";
import {
  AWAY_MINUTES, BEAT_SECONDS, listSubscriptions, MAX_SUBS, PUSH_CALLS_PER_HOUR, pushConfig, pushEndpoint, pushForActivity, pushLogin, pushText,
  saveSubscription, vapidJwt,
} from "@/lib/push";
import AgentStatusBoard from "@/components/app/AgentStatusBoard";
import * as subRoute from "@/app/api/push/route";
import * as seenRoute from "@/app/api/push/seen/route";
import * as latestRoute from "@/app/api/push/latest/route";

/**
 * Rules 2550-2573: each agent's state at a glance and phone notifications while the owner is away (study 2026-10-19
 * pattern 8, after Orca). docs/system/tests/2550-agent-status-push.md lists what each test pins.
 */
const read = (p: string) => readFileSync(p, "utf8");
const MIN = 60_000, DAY = 86_400_000;
const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const row = (kind: Activity["kind"], over: Partial<Activity> = {}): Activity => ({ at: ago(MIN), kind, agent: "noor", by: { kind: "owner" }, via: "app", ...over });

// A real P-256 pair, as the founder would generate it: the public point and the private scalar, base64url.
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = pair.privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
const PUB = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
const PRIV = jwk.d;
const pushOnEnv = () => { vi.stubEnv("PUSH_VAPID_PUBLIC_KEY", PUB); vi.stubEnv("PUSH_VAPID_PRIVATE_KEY", PRIV); };

let n = 0;
const ep = (host = "fcm.googleapis.com") => `https://${host}/fcm/send/device-${++n}-${Math.random().toString(36).slice(2)}`;
const me = async () => (await currentUser()) as User;
const sub = (endpoint: string) => subRoute.POST(json("/api/push", "POST", { endpoint }));
const unsub = (endpoint: string) => subRoute.DELETE(json("/api/push", "DELETE", { endpoint }));

beforeEach(() => {
  safeFetch.mockReset();
  safeFetch.mockResolvedValue(new Response(null, { status: 201 }));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("rule 2550: what one activity row says about its agent", () => {
  it("a started render is working, failures and stuck skips are stuck, finished work is done, the rest says nothing", () => {
    expect(rowState(row("image_started"))).toBe("working");
    for (const k of ["cap_reached", "no_credits", "render_failed", "run_held"] as const) expect(rowState(row(k))).toBe("stuck");
    expect(rowState(row("routine_skipped", { outcome: "no_credits" }))).toBe("stuck");
    expect(rowState(row("routine_skipped", { outcome: "nothing_new" }))).toBeNull();
    expect(rowState(row("handoff_run", { outcome: "failed:timeout" }))).toBe("stuck");
    expect(rowState(row("handoff_run"))).toBe("done");
    for (const k of ["generated", "published", "render_done", "routine_ran", "file_written"] as const) expect(rowState(row(k))).toBe("done");
    expect(rowState(row("decision"))).toBeNull();
  });
});

describe("rule 2551: precedence and time windows", () => {
  it("stuck beats waiting beats working beats done; nothing at all is quiet", () => {
    expect(deriveStatus("noor", [row("render_failed")], 3, NOW).state).toBe("stuck");
    expect(deriveStatus("noor", [row("generated")], 2, NOW).state).toBe("waiting");
    expect(deriveStatus("noor", [row("image_started")], 0, NOW).state).toBe("working");
    expect(deriveStatus("noor", [row("image_started")], 1, NOW).state).toBe("waiting");
    expect(deriveStatus("noor", [row("published")], 0, NOW).state).toBe("done");
    expect(deriveStatus("noor", [], 0, NOW).state).toBeNull();
  });
  it(`a render left working past ${WORKING_MINUTES} minutes is stuck; a failure older than ${STUCK_DAYS} days is old news`, () => {
    expect(deriveStatus("noor", [row("image_started", { at: ago((WORKING_MINUTES + 1) * MIN) })], 0, NOW).state).toBe("stuck");
    expect(deriveStatus("noor", [row("image_started", { at: ago((WORKING_MINUTES - 1) * MIN) })], 0, NOW).state).toBe("working");
    const old = row("render_failed", { at: ago((STUCK_DAYS + 1) * DAY) });
    expect(deriveStatus("noor", [old, row("generated", { at: ago((STUCK_DAYS + 2) * DAY) })], 0, NOW).state).toBe("done");
    expect(deriveStatus("noor", [old], 0, NOW).state).toBeNull();
  });
  it("a newer finished row clears an older failure (the newest row that says anything decides)", () => {
    expect(deriveStatus("noor", [row("render_done", { at: ago(MIN) }), row("render_failed", { at: ago(5 * MIN) })], 0, NOW).state).toBe("done");
  });
});

describe("rule 2552: the short log", () => {
  it(`shows the agent's own newest ${LOG_ROWS} rows, kind and time only, never a note`, () => {
    const rows = Array.from({ length: 8 }, (_, i) => row("generated", { at: ago(i * MIN), note: `secret note ${i}` } as Partial<Activity>));
    const s = deriveStatus("noor", [...rows, row("generated", { agent: "sami" })], 0, NOW);
    expect(s.log).toHaveLength(LOG_ROWS);
    expect(s.log[0]).toEqual({ at: rows[0].at, kind: "generated", state: "done" });
    expect(JSON.stringify(s.log)).not.toContain("secret note");
  });
});

describe("rule 2553: one state per agent with deliverable work", () => {
  it("lists every agent but Reem, in roster order, and counts each waiting draft for the agent that owns its type", () => {
    const list = agentStatuses([row("published", { agent: "dana" })], [{ type: "social" }, { type: "article" }, { type: "prd" }], NOW);
    expect(list.map((s) => s.agent)).toEqual(["noor", "sami", "razan", "faris", "dana", "majed", "layan"]);
    expect(list.find((s) => s.agent === "noor")).toMatchObject({ state: "waiting", waiting: 2 });
    expect(list.find((s) => s.agent === "layan")).toMatchObject({ state: "waiting", waiting: 1 });
    expect(list.find((s) => s.agent === "dana")?.state).toBe("done");
    expect(list.find((s) => s.agent === "sami")?.state).toBeNull();
  });
});

describe("rule 2554: the four states in Arabic and English", () => {
  it("names every state in both languages, with the Arabic words of the brief", () => {
    expect(STATUS_COPY.ar.state).toEqual({ working: "يعمل", waiting: "ينتظرك", done: "انتهى", stuck: "متعثر" });
    for (const lang of ["ar", "en"] as const) for (const s of AGENT_STATES) expect(STATUS_COPY[lang].state[s]).toBeTruthy();
    expect(STATUS_COPY.ar.drafts(2)).toBe("مسودتان");
    expect(STATUS_COPY.en.drafts(1)).toBe("1 draft");
  });
});

describe("rule 2555: the state is derived, never stored", () => {
  it("agent-status.ts reads no store and writes no key", () => {
    const src = read("src/lib/agent-status.ts");
    expect(src).not.toMatch(/from "\.\/db"|from "@\/lib\/db"|\bdb\./);
  });
});

describe("rule 2556: the board on the app's home", () => {
  it("renders each agent's badge in the page's language, the waiting count, a folded log, and quiet without a badge", () => {
    const statuses = agentStatuses([row("render_failed", { agent: "dana" })], [{ type: "social" }], NOW);
    const html = renderToStaticMarkup(h(AgentStatusBoard, { lang: "ar", statuses, kinds: appDict.ar.activity.kinds }));
    expect(html).toContain(STATUS_COPY.ar.title);
    expect(html).toMatch(/data-agent="noor" data-state="waiting"/);
    expect(html).toMatch(/data-agent="dana" data-state="stuck"/);
    expect(html).toMatch(/data-agent="sami" data-state="quiet"/);
    expect(html).toContain("ينتظرك");
    expect(html).toContain(STATUS_COPY.ar.drafts(1));
    expect(html).toContain(STATUS_COPY.ar.quiet);
    expect(html).toContain("<details");
    const en = renderToStaticMarkup(h(AgentStatusBoard, { lang: "en", statuses, kinds: appDict.en.activity.kinds }));
    expect(en).toContain("Waiting for you");
    expect(en).toContain("Stuck");
  });
});

describe("rule 2557: the page reads the state in its one round of reads", () => {
  it("adds the activity rows to the existing Promise.all under sc(u) and renders the board before the inbox", () => {
    const page = read("src/app/[lang]/app/b/[brand]/page.tsx");
    expect(page).toMatch(/await Promise\.all\(\[listTasks\(sc\(u\)\)[^\n]*recentActivity\(sc\(u\), STATUS_ROWS\)[^\n]*\]\)/);
    expect(page).toMatch(/agentStatuses\(activity, tasks\.filter\(isWaiting\)\)/);
    expect(page.indexOf("<AgentStatusBoard")).toBeLessThan(page.indexOf("<Inbox"));
  });
});

describe("rule 2560: push is off until both VAPID keys are set and valid", () => {
  it("needs both variables, a 65-byte uncompressed point and a 32-byte scalar Node accepts", () => {
    expect(pushConfig({})).toBeNull();
    expect(pushConfig({ PUSH_VAPID_PUBLIC_KEY: PUB })).toBeNull();
    expect(pushConfig({ PUSH_VAPID_PRIVATE_KEY: PRIV })).toBeNull();
    expect(pushConfig({ PUSH_VAPID_PUBLIC_KEY: "not-a-key", PUSH_VAPID_PRIVATE_KEY: PRIV })).toBeNull();
    expect(pushConfig({ PUSH_VAPID_PUBLIC_KEY: PUB, PUSH_VAPID_PRIVATE_KEY: Buffer.alloc(32).toString("base64url") })).toBeNull();
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }) as { d: string };
    expect(pushConfig({ PUSH_VAPID_PUBLIC_KEY: PUB, PUSH_VAPID_PRIVATE_KEY: other.d })).toBeNull(); // not this pair
    expect(pushConfig({ PUSH_VAPID_PUBLIC_KEY: PUB, PUSH_VAPID_PRIVATE_KEY: PRIV })?.publicKey).toBe(PUB);
  });
  it("names the variables in docs/system/variables.md and nowhere else in docs", () => {
    expect(read("docs/system/variables.md")).toMatch(/PUSH_VAPID_PUBLIC_KEY[\s\S]*PUSH_VAPID_PRIVATE_KEY/);
    expect(read("docs/system/architecture.md")).not.toMatch(/PUSH_VAPID_/);
  });
});

describe("rule 2561: only a browser's push service is ever posted to", () => {
  it("accepts FCM, Mozilla, Apple and Windows endpoints and refuses anything else", () => {
    for (const host of ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "wns2-par02p.notify.windows.com"]) expect(pushEndpoint(ep(host))).toBeTruthy();
    for (const bad of [
      "http://fcm.googleapis.com/x", "https://evil.example/x", "https://fcm.googleapis.com.evil.example/x", "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x", "https://169.254.169.254/x", `https://fcm.googleapis.com/${"a".repeat(1100)}`, 42, null,
    ]) expect(pushEndpoint(bad)).toBeNull();
  });
});

describe("rule 2562: subscribe", () => {
  it("authenticates first, answers 503 while push is off, and refuses a founder's view of the account", async () => {
    signOut();
    expect((await sub(ep())).status).toBe(401);
    const u = await newUser("push");
    await signIn(u.email);
    expect((await sub(ep())).status).toBe(503);
    pushOnEnv();
    vi.stubEnv("ADMIN_EMAILS", "founder-push@test.example");
    await signIn(u.email, { imp: "founder-push@test.example" });
    expect((await sub(ep())).status).toBe(403);
    expect(await listSubscriptions(sc(u))).toEqual([]);
  });
  it("stores the device under the caller's own workspace only, and refuses a foreign endpoint", async () => {
    pushOnEnv();
    const a = await newUser("pusha"), b = await newUser("pushb");
    await signIn(a.email);
    expect((await sub("https://evil.example/hook")).status).toBe(400);
    const e = ep();
    expect((await sub(e)).status).toBe(200);
    const mine = await listSubscriptions(sc(await me()));
    expect(mine.map((x) => [x.endpoint, x.login])).toEqual([[e, a.email.toLowerCase()]]);
    await signIn(b.email);
    expect(await listSubscriptions(sc(await me()))).toEqual([]);
    // b removing a's endpoint touches b's workspace only.
    expect((await unsub(e)).status).toBe(200);
    expect(await listSubscriptions(sc(a))).toHaveLength(1);
  });
  it("lets a member add a device to the workspace they act in", async () => {
    pushOnEnv();
    const owner = await newUser("pusho");
    const m = await newMember(owner);
    await signIn(m.email);
    expect((await sub(ep())).status).toBe(200);
    const subs = await listSubscriptions(sc(await me()));
    expect(subs.map((x) => x.login)).toEqual([m.email.toLowerCase()]);
  });
  it(`keeps at most ${MAX_SUBS} devices per workspace, dropping the oldest`, async () => {
    const u = await newUser("pushcap");
    const s = sc(u);
    const eps = Array.from({ length: MAX_SUBS + 2 }, () => ep());
    for (const [i, e] of eps.entries()) await saveSubscription(s, u.email, e, new Date(NOW + i * 1000));
    const left = await listSubscriptions(s);
    expect(left).toHaveLength(MAX_SUBS);
    expect(left.map((x) => x.endpoint)).not.toContain(eps[0]);
    expect(left[0].endpoint).toBe(eps.at(-1));
  });
  it(`is rate limited per login (${PUSH_CALLS_PER_HOUR} an hour)`, async () => {
    pushOnEnv();
    const u = await newUser("pushrate");
    await signIn(u.email);
    const e = ep();
    for (let i = 0; i < PUSH_CALLS_PER_HOUR; i++) expect((await sub(e)).status).toBe(200);
    expect((await sub(e)).status).toBe(429);
  });
  it("only tokens of a person's own session count: an MCP token or a founder has no login here", () => {
    expect(pushLogin({ kind: "owner", email: " A@B.example " })).toBe("a@b.example");
    expect(pushLogin({ kind: "member", email: "m@b.example" })).toBe("m@b.example");
    expect(pushLogin({ kind: "founder", email: "a@b.example" })).toBeNull();
    expect(pushLogin({ kind: "token", email: "a@b.example" })).toBeNull();
    expect(pushLogin(undefined)).toBeNull();
  });
});

describe("rule 2563: unsubscribe and expiry clean-up", () => {
  it("DELETE removes the device; a 404 or 410 from the push service removes it too", async () => {
    pushOnEnv();
    const u = await newUser("pushgone");
    await signIn(u.email);
    const keep = ep(), drop = ep();
    await sub(keep);
    await sub(drop);
    expect((await unsub(drop)).status).toBe(200);
    expect((await listSubscriptions(sc(u))).map((x) => x.endpoint)).toEqual([keep]);
    safeFetch.mockResolvedValue(new Response(null, { status: 410 }));
    expect(await pushForActivity(sc(u), [row("generated")])).toBe(0);
    expect(await listSubscriptions(sc(u))).toEqual([]);
  });
  it("the worker unsubscribes itself when its session is gone, and re-subscribes when the push service rotates it", () => {
    const sw = read("public/sw.js");
    expect(sw).toMatch(/status === 401[\s\S]*getSubscription\(\)[\s\S]*unsubscribe\(\)/);
    expect(sw).toMatch(/"pushsubscriptionchange"[\s\S]*pushManager\.subscribe[\s\S]*fetch\("\/api\/push", \{ method: "POST"/);
  });
});

describe("rule 2564: the heartbeat", () => {
  it(`marks the login present for ${AWAY_MINUTES} minutes, beats well inside that, and is mounted only for a person's own session`, async () => {
    expect(BEAT_SECONDS).toBeLessThan(AWAY_MINUTES * 60);
    signOut();
    expect((await seenRoute.POST()).status).toBe(401);
    pushOnEnv();
    const u = await newUser("pushseen");
    await signIn(u.email);
    expect((await seenRoute.POST()).status).toBe(200);
    expect(await db.get(accountKey.tabSeen(u.email.toLowerCase()))).toBeTruthy();
    vi.stubEnv("ADMIN_EMAILS", "founder-seen@test.example");
    await signIn(u.email, { imp: "founder-seen@test.example" });
    expect((await seenRoute.POST()).status).toBe(403);
    const layout = read("src/app/[lang]/app/layout.tsx");
    expect(layout).toMatch(/pushOn\(\) && \(actor\?\.kind === "owner" \|\| actor\?\.kind === "member"\) && <TabBeat \/>/);
    expect(read("src/components/app/TabBeat.tsx")).toMatch(/visibilityState !== "visible"/);
  });
});

describe("rules 2565-2566: who gets a push, for what, and how often", () => {
  it("only devices of logins with no visible tab; only waiting or stuck; once per agent and state per window", async () => {
    pushOnEnv();
    const owner = await newUser("pushaway");
    const m = await newMember(owner);
    await signIn(owner.email);
    const ownerEp = ep();
    await sub(ownerEp);
    await signIn(m.email);
    const s = sc(await me());
    const memberEp = ep();
    await sub(memberEp);
    await seenRoute.POST(); // the member has the app open
    expect(await pushForActivity(s, [row("published"), row("image_started"), row("decision")])).toBe(0);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(await pushForActivity(s, [row("generated")])).toBe(1);
    expect(safeFetch.mock.calls.map((c) => c[0])).toEqual([ownerEp]);
    expect(await pushForActivity(s, [row("generated"), row("routine_ran", { count: 3 })])).toBe(0); // same agent and state
    expect(await pushForActivity(s, [row("render_failed")])).toBe(1); // a new state
    expect(await pushForActivity(s, [row("generated", { agent: "dana" })])).toBe(1); // another agent
  });
  it("a routine that wrote nothing, a done row and an unknown agent never push", () => {
    expect(pushStateOf(row("routine_ran", { count: 0 }))).toBeNull();
    expect(pushStateOf(row("published"))).toBeNull();
    expect(pushStateOf(row("handoff_proposed"))).toBe("waiting");
    expect(pushStateOf(row("cap_reached"))).toBe("stuck");
  });
});

describe("rule 2567: the push carries nothing; the text is minimal", () => {
  it("posts no body, and the worker reads the app name and one agent's state in the person's language", async () => {
    pushOnEnv();
    const u = await newUser("pushtext");
    await signIn(u.email);
    await sub(ep());
    await pushForActivity(sc(u), [row("generated", { title: "Secret launch post" } as Partial<Activity>)]);
    expect(safeFetch.mock.calls[0][1]?.body).toBeUndefined();
    const res = await latestRoute.GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ ok: true, title: "ذكين", body: `${agentById("noor").name.ar}: ينتظرك`, href: "/ar/app" });
    expect(JSON.stringify(body)).not.toMatch(/Secret|@/);
    expect(pushText(null, "en")).toEqual({ title: "Thakeen", body: STATUS_COPY.en.generic, href: "/en/app" });
    expect(pushText({ agent: "nobody", state: "waiting" }, "ar").body).toBe(STATUS_COPY.ar.generic);
    signOut();
    expect((await latestRoute.GET()).status).toBe(401);
  });
});

describe("rule 2568: VAPID, sent through safeFetch over https", () => {
  it("signs an ES256 token for the push service's origin that the public key verifies", async () => {
    pushOnEnv();
    const u = await newUser("pushjwt");
    await signIn(u.email);
    const e = ep();
    await sub(e);
    await pushForActivity(sc(u), [row("run_held")]);
    const [url, init, opts] = safeFetch.mock.calls[0];
    expect(url).toBe(e);
    expect(opts).toEqual({ httpsOnly: true });
    const auth = (init?.headers as Record<string, string>).Authorization;
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth)!;
    expect(m[2]).toBe(PUB);
    const [hd, pl, sig] = m[1].split(".");
    expect(verify("sha256", Buffer.from(`${hd}.${pl}`), { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(pl, "base64url").toString());
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(12 * 3600);
    const cfg = pushConfig({ PUSH_VAPID_PUBLIC_KEY: PUB, PUSH_VAPID_PRIVATE_KEY: PRIV })!;
    expect(JSON.parse(Buffer.from(vapidJwt(cfg, "https://a.example", "https://b.example", 100).split(".")[1], "base64url").toString())).toEqual({ aud: "https://a.example", exp: 100 + 12 * 3600, sub: "https://b.example" });
  });
});

describe("rule 2569: rule 683 narrowed to one push-only worker", () => {
  it("the worker has no fetch handler and no cache, and only the push switch registers it", () => {
    const sw = read("public/sw.js");
    expect(sw).not.toMatch(/addEventListener\(\s*["']fetch["']|\bcaches\b/);
    expect(read("src/components/app/PushToggle.tsx")).toMatch(/serviceWorker\.register\("\/sw\.js"/);
  });
});

describe("rule 2570: the permission is asked only after the person presses the switch", () => {
  it("requestPermission sits in the click handler, the switch hides where Web Push is missing, and the page passes a key only while on", () => {
    const t = read("src/components/app/PushToggle.tsx");
    expect(t).toMatch(/const enable = async \(\) => \{[\s\S]*Notification\.requestPermission\(\)/);
    expect(t.indexOf("requestPermission")).toBeGreaterThan(t.indexOf("const enable"));
    expect(t).toMatch(/if \(phase === "unsupported"\) return null/);
    expect(read("src/app/[lang]/app/b/[brand]/page.tsx")).toMatch(/\? pushPublicKey\(\) : null/);
  });
});

describe("rule 2571: deleting the account deletes its devices and markers", () => {
  it("wipeAccount removes the workspace's devices and the owner's tab and text markers", async () => {
    pushOnEnv();
    const u = await newUser("pushwipe");
    await signIn(u.email);
    await sub(ep());
    await seenRoute.POST();
    const login = u.email.toLowerCase();
    await db.set(accountKey.pushLast(login), { agent: "noor", state: "waiting", at: new Date().toISOString() });
    await wipeAccount(acct(u));
    expect(await db.hgetall(wsKey.pushSubs(sc(u)))).toEqual({});
    expect(await db.get(accountKey.tabSeen(login))).toBeNull();
    expect(await db.get(accountKey.pushLast(login))).toBeNull();
  });
});

describe("rule 2572: a push never stands in the action's way", () => {
  it("recordActivity sends after the response, and a failing push service changes nothing", async () => {
    pushOnEnv();
    const u = await newUser("pushafter");
    await signIn(u.email);
    await sub(ep());
    safeFetch.mockRejectedValue(new Error("network down"));
    await recordActivity(sc(u), [row("generated")]);
    expect(safeFetch).not.toHaveBeenCalled();
    await settle();
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(await listSubscriptions(sc(u))).toHaveLength(1); // a failure is not "gone"
  });
  it("with push off, recording activity schedules nothing", async () => {
    const u = await newUser("pushoff");
    await recordActivity(sc(u), [row("generated")]);
    await settle();
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe("rule 2573: no new dependency and no third-party gateway", () => {
  it("package.json has no web-push library; the sender posts only to the subscription's own endpoint", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /push|vapid/i.test(d))).toEqual([]);
    expect(read("src/lib/push.ts")).toMatch(/safeFetch\(endpoint,/);
  });
});
