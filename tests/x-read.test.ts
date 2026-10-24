import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { json, newMember, newUser, signIn } from "./helpers/session";
import { fakeComposio, ok, type Answer } from "./helpers/composio-fake";
import { db } from "@/lib/db";
import { acct, currentUser, getUser, saveUser, sc } from "@/lib/auth";
import { wipeAccount } from "@/lib/account";
import * as credits from "@/lib/credits";
import { agentSpendFor } from "@/lib/credits";
import { getConnection, saveConnection, type Connection } from "@/lib/connectors/store";
import { setComposioClientForTests } from "@/lib/connectors/composio";
import { EMPTY_TOTALS, SOCIAL_KEY, SOCIAL_PUB_KEY, socialDataBlock, syncSocialIfDue } from "@/lib/social-stats";
import { XSTATS_KEY, getXStats, refreshX, xForPage, type XRefresh, type XStats } from "@/lib/x-stats";
import * as connRoute from "@/app/api/connect/[provider]/route";
import SocialStats from "@/components/app/SocialStats";

// The card's Refresh X button reads the router; outside Next there is none. Server-only helpers stay real.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
}));

/**
 * Rules 744 and 745 (spec docs/superpowers/specs/2026-10-08-social-analytics-reports-design.md C3): X is read only on a
 * click, paid by the account. One credit is charged in code before the read, under Dana's monthly cap, at most once per
 * workspace per UTC day (the claim `xread:{scope}:{day}` held on the account record); it is refunded once on every failure
 * unless a read landed that day, and never taken for a Composio-routed X record. One refresh is two requests to X, one page
 * of at most ten posts. X's 402, 403 and 429 are the app's, never the owner's token. Six refreshes an hour per workspace
 * (rule 735). Rule 747: wipeAccount and disconnecting X delete `xstats:{scope}`. X is a stub of `fetch`: only calls to api.x.com are recorded.
 */
const NOW = new Date("2026-10-08T09:00:00Z");
const START = 10;
const USER_ID = "1449";

type Init = RequestInit | undefined;
let fetched: string[];
let inits: Init[];
let answer: (url: string, init: Init) => Response | Promise<Response>;

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const me = (followers: unknown = 1500, id: unknown = USER_ID) => ({ data: { id, name: "Oud", username: "oudroastery", public_metrics: { followers_count: followers, following_count: 10, tweet_count: 300 } } });
const tweet = (id: string, at: string, metrics: Record<string, unknown> = {}) => ({
  id, text: "New roast <b>today</b>\n#coffee", created_at: at,
  public_metrics: { retweet_count: 2, reply_count: 3, like_count: 40, quote_count: 0, bookmark_count: 5, impression_count: 900, ...metrics },
});
const ME_URL = "https://api.x.com/2/users/me?user.fields=public_metrics";
const isMe = (url: string) => url.startsWith("https://api.x.com/2/users/me");
const isTweets = (url: string) => url.startsWith(`https://api.x.com/2/users/${USER_ID}/tweets`);
/** X's answers: the account, then its posts in the window (none answers with no `data`, as X does). */
const xAnswers = (posts: unknown[] = [tweet("1844000000000000001", "2026-10-05T10:00:00.000Z")]) => (url: string) =>
  isMe(url) ? res(200, me()) : isTweets(url) ? res(200, posts.length ? { data: posts, meta: { result_count: posts.length } } : { meta: { result_count: 0 } }) : res(404, {});

beforeEach(() => {
  fetched = [];
  inits = [];
  answer = xAnswers();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.x.com/")) return res(200, {});
    fetched.push(url);
    inits.push(init);
    return answer(url, init);
  }));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => { setComposioClientForTests(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

const xConn = (meta: Record<string, string> = {}): Connection => ({ provider: "x", data: { access_token: "t" }, meta: { account: "@oud", ...meta }, connectedAt: NOW.toISOString() });
const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
const post = (body: Record<string, unknown>, provider = "x") => connRoute.POST(json(`/api/connect/${provider}`, "POST", body), ctx(provider));
const sync = () => post({ action: "sync_x" });
const balance = async (id: string) => (await getUser(id))!.credits;

/** An owner with START credits, signed in, with a direct X record unless `conn` is null. */
async function workspace(conn: Connection | null = xConn(), start = START) {
  const owner = await newUser("xo");
  const id = acct(owner);
  await saveUser({ ...(await getUser(id))!, credits: start });
  const scope = sc((await getUser(id))!);
  if (conn) await saveConnection(scope, conn);
  await signIn(owner.email);
  // `id` is the account (the ledger and the record are keyed by it); `email` only signs in.
  return { owner, scope, id, email: owner.email };
}

describe("the X refresh, paid by the account (rules 744, 745)", () => {
  it("one refresh makes exactly two requests with fixed parameters (745)", async () => {
    const { scope } = await workspace();
    const r = await sync();
    expect(r.status).toBe(200);
    expect(fetched).toHaveLength(2);
    expect(fetched[0]).toBe(ME_URL);
    const list = new URL(fetched[1]);
    expect(`${list.origin}${list.pathname}`).toBe(`https://api.x.com/2/users/${USER_ID}/tweets`);
    const q = list.searchParams;
    expect([...q.keys()].sort()).toEqual(["exclude", "max_results", "start_time", "tweet.fields"]);
    expect(q.get("max_results")).toBe("10");
    expect(q.get("start_time")).toBe("2026-09-08T09:00:00Z");
    expect(q.get("exclude")).toBe("retweets");
    expect(q.get("tweet.fields")).toBe("created_at,public_metrics,non_public_metrics,organic_metrics");
    expect(q.has("pagination_token") || q.has("expansions")).toBe(false);
    // Each request carries the owner's token and its own timeout.
    for (const i of inits) {
      expect(new Headers(i?.headers).get("authorization")).toBe("Bearer t");
      expect(i?.signal).toBeInstanceOf(AbortSignal);
    }
    // Parsed tolerantly: shares from retweet_count, saved from bookmarks, views from impressions, no reach; the caption
    // cleaned and capped, the link on x.com with the post's digit id.
    const x = (await getXStats(scope))!;
    expect(x).toMatchObject({ platform: "x", account: "@oudroastery", followers: 1500, range: { from: "2026-09-08", to: "2026-10-08" }, at: NOW.toISOString() });
    expect(x.prev).toBeUndefined();
    expect(Object.values(x.totals).every((v) => v === null)).toBe(true);
    expect(x.posts).toEqual([{ id: "1844000000000000001", date: "2026-10-05", type: "POST", caption: "New roast btoday/b coffee", url: "https://x.com/i/status/1844000000000000001", views: 900, reach: null, likes: 40, comments: 3, shares: 2, saved: 5, fromThakeen: false }]);
    expect(x.history).toEqual([{ month: "2026-10", platform: "x", followers: 1500, totals: x.totals }]);
  });

  it("charges 1 credit before the read with Dana's cap; a second click the same UTC day is free (744)", async () => {
    const { scope, id, email } = await workspace();
    let atRead: number | null = null;
    answer = async (url) => {
      if (isMe(url)) atRead = await balance(id);
      return xAnswers()(url);
    };
    const r = await sync();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, charged: true, x: { platform: "x", followers: 1500 } });
    // The X user id is stored for the history (rule 746) and never sent to the browser.
    expect(body.x).not.toHaveProperty("accountId");
    expect((await getXStats(scope))!.accountId).toBe(USER_ID);
    // The debit was saved before X was asked, and counts against Dana's month.
    expect(atRead).toBe(START - 1);
    expect(await balance(id)).toBe(START - 1);
    expect(agentSpendFor((await getUser(id))!, scope).dana).toBe(1);
    // Later the same UTC day: the stored read, no charge, no call to X.
    vi.setSystemTime(new Date("2026-10-08T21:00:00Z"));
    await signIn(email);
    const again = await sync();
    expect(again.status).toBe(200);
    const stored = await again.json();
    expect(stored).toMatchObject({ ok: true, charged: false, x: { at: NOW.toISOString() } });
    expect(stored.x).not.toHaveProperty("accountId");
    expect(fetched).toHaveLength(2);
    expect(await balance(id)).toBe(START - 1);
  });

  it("two concurrent sync_x calls debit one credit (Review Focus 1)", async () => {
    // The owner double-clicks: two requests through the route at once.
    const a = await workspace();
    const both = await Promise.all([sync(), sync()]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(await balance(a.id)).toBe(START - 1);
    expect(agentSpendFor((await getUser(a.id))!, a.scope).dana).toBe(1);

    // A member's click is charged to the account record, like the owner's.
    const b = await workspace();
    const member = await newMember(b.owner);
    await signIn(member.email);
    expect((await sync()).status).toBe(200);
    expect(await balance(b.id)).toBe(START - 1);

    // The owner and a member at the same moment (the test's one cookie jar cannot hold two sessions in flight, so both
    // run refreshX with the user record currentUser resolved for each login).
    const c = await workspace();
    const other = await newMember(c.owner);
    await signIn(other.email);
    const asMember = (await currentUser())!;
    await signIn(c.email);
    const asOwner = (await currentUser())!;
    expect(sc(asMember)).toBe(c.scope);
    const conn = (await getConnection(c.scope, "x"))!;
    const out = await Promise.all([refreshX(asOwner, conn), refreshX(asMember, conn)]);
    expect(out.every((r) => r.ok)).toBe(true);
    expect(out.filter((r) => r.ok && r.charged)).toHaveLength(1);
    expect(await balance(c.id)).toBe(START - 1);
  });

  it("the free re-read ends at the UTC day boundary (Review Focus 4)", async () => {
    /** A click at `at`, signed in then (a session does not outlive the hours this test skips). */
    const clickAt = async (email: string, at: string) => {
      vi.setSystemTime(new Date(at));
      await signIn(email);
      expect((await sync()).status).toBe(200);
    };
    const late = await workspace();
    await clickAt(late.email, "2026-10-08T23:59:00Z");
    await clickAt(late.email, "2026-10-09T00:01:00Z");
    expect(await balance(late.id)).toBe(START - 2);
    expect(fetched).toHaveLength(4);

    fetched.length = 0;
    vi.setSystemTime(NOW);
    const day = await workspace();
    await clickAt(day.email, "2026-10-08T10:00:00Z");
    await clickAt(day.email, "2026-10-08T22:00:00Z");
    expect(await balance(day.id)).toBe(START - 1);
    expect(fetched).toHaveLength(2);
  });

  it("a zero-post read keeps the charge and saves followers (744)", async () => {
    const { scope, id } = await workspace();
    answer = xAnswers([]);
    const r = await sync();
    expect(r.status).toBe(200);
    expect(await balance(id)).toBe(START - 1);
    expect(await getXStats(scope)).toMatchObject({ followers: 1500, posts: [] });
  });

  it("marks a post Thakeen published, and drops posts outside the window or without a digit id", async () => {
    const { scope } = await workspace();
    await db.sadd(SOCIAL_PUB_KEY(scope), "1844000000000000002");
    answer = xAnswers([
      tweet("1844000000000000001", "2026-10-05T10:00:00.000Z"),
      tweet("1844000000000000002", "2026-10-06T10:00:00.000Z", { retweet_count: undefined, repost_count: 7, impression_count: "N/A" }),
      tweet("1844000000000000001", "2026-10-05T10:00:00.000Z"),
      tweet("12345678901234567890", "2026-10-05T10:00:00.000Z"),
      tweet("abc", "2026-10-05T10:00:00.000Z"),
      tweet("1700000000000000000", "2026-08-01T10:00:00.000Z"),
      { id: "1844000000000000003", created_at: "2026-10-07T10:00:00.000Z" },
    ]);
    expect((await sync()).status).toBe(200);
    const posts = (await getXStats(scope))!.posts;
    expect(posts.map((p) => [p.id, p.fromThakeen])).toEqual([["1844000000000000001", false], ["1844000000000000002", true], ["1844000000000000003", false]]);
    // repost_count wins over retweet_count; a count X did not give is null, never zero.
    expect(posts[1]).toMatchObject({ shares: 7, views: null });
    expect(posts[2]).toMatchObject({ caption: "", views: null, likes: null, comments: null, shares: null, saved: null });
  });

  it("402, 403 and 429 from X refund and never mark the record for reconnect; 429 passes Retry-After (744)", async () => {
    const cases: { status: number; on: "me" | "tweets"; headers?: Record<string, string>; wait?: string }[] = [
      { status: 402, on: "me" },
      { status: 403, on: "tweets" },
      { status: 429, on: "tweets", headers: { "retry-after": "60" }, wait: "60" },
      { status: 429, on: "me", headers: { "x-rate-limit-reset": String(NOW.getTime() / 1000 + 120) }, wait: "120" },
      { status: 429, on: "me", wait: "900" },
    ];
    for (const k of cases) {
      const { scope, id } = await workspace();
      answer = (url) => ((k.on === "me" ? isMe(url) : isTweets(url)) ? res(k.status, { title: "Forbidden 401 403" }, k.headers) : xAnswers()(url));
      const r = await sync();
      const body = await r.json();
      expect(body, `${k.status} on ${k.on}`).toMatchObject({ ok: false, error: "x_unavailable" });
      if (k.status === 429) {
        expect(r.status).toBe(429);
        expect(r.headers.get("Retry-After")).toBe(k.wait);
      } else expect(r.status).toBe(502);
      expect(await balance(id)).toBe(START);
      expect(agentSpendFor((await getUser(id))!, scope).dana ?? 0).toBe(0);
      expect((await getConnection(scope, "x"))?.needsReconnect).toBeUndefined();
      expect(await getXStats(scope)).toBeNull();
    }
  });

  it("a 401 refunds and asks the owner to reconnect (744)", async () => {
    for (const on of ["me", "tweets"] as const) {
      const { scope, id } = await workspace();
      answer = (url) => ((on === "me" ? isMe(url) : isTweets(url)) ? res(401, { title: "Unauthorized" }) : xAnswers()(url));
      const r = await sync();
      expect(r.status).toBe(502);
      expect(await balance(id)).toBe(START);
      expect((await getUser(id))!.paidOnce?.[`xread:${scope}:2026-10-08`]).toBeUndefined();
      expect((await getConnection(scope, "x"))?.needsReconnect).toBeTruthy();
    }
  });

  it("refunds exactly once on a 5xx, a timeout or a malformed answer, and never marks the record", async () => {
    const back = vi.spyOn(credits, "refundOnce");
    const failures: [string, (url: string) => Response | Promise<Response>][] = [
      ["5xx", (url) => (isTweets(url) ? res(503, { title: "Service Unavailable" }) : xAnswers()(url))],
      ["timeout", (url) => (isTweets(url) ? Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")) : xAnswers()(url))],
      ["malformed body", (url) => (isMe(url) ? res(200, "<html>not json</html>") : xAnswers()(url))],
      ["malformed id", (url) => (isMe(url) ? res(200, me(1500, "../../2/tweets")) : xAnswers()(url))],
      ["malformed list", (url) => (isTweets(url) ? res(200, { data: { id: "1" } }) : xAnswers()(url))],
    ];
    for (const [name, fail] of failures) {
      back.mockClear();
      fetched.length = 0;
      const { scope, id } = await workspace();
      answer = fail;
      const r = await sync();
      expect(r.status, name).toBe(502);
      expect(back, name).toHaveBeenCalledTimes(1);
      expect(await balance(id), name).toBe(START);
      expect((await getUser(id))!.paidOnce?.[`xread:${scope}:2026-10-08`], name).toBeUndefined();
      expect((await getConnection(scope, "x"))?.needsReconnect, name).toBeUndefined();
      // A malformed id is never put in a path: the read stops after the account.
      if (name === "malformed id") expect(fetched).toEqual([ME_URL]);
    }
  });

  it("a failure after another click's read landed the same day keeps the charge", async () => {
    const { scope, id } = await workspace();
    let lists = 0;
    answer = async (url) => {
      if (!isTweets(url)) return xAnswers()(url);
      if (++lists === 1) return xAnswers()(url);
      // The second click fails only once the first has saved its read.
      for (let i = 0; i < 200 && !(await db.get(XSTATS_KEY(scope))); i++) await new Promise((r) => setTimeout(r, 5));
      return res(503, {});
    };
    const out = await Promise.all([sync(), sync()]);
    expect(out.map((r) => r.status).sort()).toEqual([200, 502]);
    expect(await balance(id)).toBe(START - 1);
    expect((await getXStats(scope))?.followers).toBe(1500);
  });

  it("the charging click failing first refunds; the click on its hold takes the charge again when its read lands (744)", async () => {
    const { scope, id } = await workspace();
    const u = (await getUser(id))!;
    const claim = `xread:${scope}:2026-10-08`;
    const back = vi.spyOn(credits, "refundOnce");
    const as = (token: string): Connection => ({ ...xConn(), data: { access_token: token } });
    const who = (init: Init) => new Headers(init?.headers).get("authorization");
    const started: { b?: Promise<XRefresh> } = {};
    let bAsked = () => {};
    const bAtX = new Promise<void>((r) => (bAsked = r));
    answer = async (url, init) => {
      // Click A took the charge before asking X: it starts click B, which reads on A's hold, and waits until B asks X.
      if (who(init) === "Bearer a" && isMe(url)) {
        started.b = refreshX(u, as("b"), NOW);
        await bAtX;
        return xAnswers()(url);
      }
      if (isMe(url)) { bAsked(); return xAnswers()(url); }
      // A fails; B's list answers only once A has given its charge back.
      if (who(init) === "Bearer a") return res(503, {});
      for (let i = 0; i < 400 && (await getUser(id))!.paidOnce?.[claim]; i++) await new Promise((r) => setTimeout(r, 5));
      return xAnswers()(url);
    };
    await expect(refreshX(u, as("a"), NOW)).rejects.toThrow("x_status_503");
    const b = await started.b!;
    expect(b).toMatchObject({ ok: true, charged: true });
    expect(back).toHaveBeenCalledTimes(1);
    // One credit stands for the day's one read, under Dana's month, held again for the day.
    expect(await balance(id)).toBe(START - 1);
    expect(agentSpendFor((await getUser(id))!, scope).dana).toBe(1);
    expect((await getUser(id))!.paidOnce?.[claim]).toBeDefined();
    expect((await getXStats(scope))?.followers).toBe(1500);
  });

  it("the click on the hold failing first never refunds; the charging click's read keeps the one credit (744)", async () => {
    const { scope, id } = await workspace();
    const u = (await getUser(id))!;
    const back = vi.spyOn(credits, "refundOnce");
    const as = (token: string): Connection => ({ ...xConn(), data: { access_token: token } });
    const who = (init: Init) => new Headers(init?.headers).get("authorization");
    const started: { b?: Promise<unknown> } = {};
    let bDone = false;
    let bAsked = () => {};
    const bAtX = new Promise<void>((r) => (bAsked = r));
    answer = async (url, init) => {
      if (who(init) === "Bearer a" && isMe(url)) {
        started.b = refreshX(u, as("b"), NOW).catch((e: unknown) => e).finally(() => { bDone = true; });
        await bAtX;
        return xAnswers()(url);
      }
      if (isMe(url)) { bAsked(); return xAnswers()(url); }
      // B fails; A's list answers only once B has finished failing.
      if (who(init) === "Bearer b") return res(503, {});
      for (let i = 0; i < 400 && !bDone; i++) await new Promise((r) => setTimeout(r, 5));
      return xAnswers()(url);
    };
    expect(await refreshX(u, as("a"), NOW)).toMatchObject({ ok: true, charged: true });
    expect(await started.b).toBeInstanceOf(Error);
    expect(back).not.toHaveBeenCalled();
    expect(await balance(id)).toBe(START - 1);
    expect(agentSpendFor((await getUser(id))!, scope).dana).toBe(1);
  });

  it("keeps X's own characters in the handle: an underscore stays, markup goes (744)", async () => {
    const { scope, email } = await workspace();
    answer = (url) => (isMe(url) ? res(200, { data: { ...me().data, username: "reef_roastery<b>\n" } }) : xAnswers()(url));
    expect((await sync()).status).toBe(200);
    expect((await getXStats(scope))!.account).toBe("@reef_roasteryb");

    // No handle left from X: the stored `@handle` stands, through the same rule; a stored label that is not one is cleaned.
    vi.setSystemTime(new Date("2026-10-09T09:00:00Z"));
    await signIn(email);
    await saveConnection(scope, xConn({ account: "@oud_cafe" }));
    answer = (url) => (isMe(url) ? res(200, { data: { ...me().data, username: "@@" } }) : xAnswers()(url));
    expect((await sync()).status).toBe(200);
    expect((await getXStats(scope))!.account).toBe("@oud_cafe");
  });

  it("the X user id decides the history: a renamed handle keeps it, another id drops it, a read stored without one follows the handle (746, 679)", async () => {
    const row = { month: "2026-09", platform: "x" as const, followers: 1000, totals: { ...EMPTY_TOTALS } };
    const stored = (over: Partial<XStats>): XStats => ({ platform: "x", account: "@oldname", range: { from: "2026-08-08", to: "2026-09-08" }, followers: 1000, totals: { ...EMPTY_TOTALS }, posts: [], at: "2026-09-08T09:00:00.000Z", history: [row], ...over });
    const months = async (held: XStats) => {
      const { scope } = await workspace();
      await db.set(XSTATS_KEY(scope), held);
      expect((await sync()).status).toBe(200);
      return (await getXStats(scope))!.history.map((r) => r.month);
    };
    // The same id under a new handle: the same account, its September stays.
    expect(await months(stored({ accountId: USER_ID }))).toEqual(["2026-09", "2026-10"]);
    // Another id under the same handle: another account (the handle was given up and taken).
    expect(await months(stored({ account: "@oudroastery", accountId: "777" }))).toEqual(["2026-10"]);
    // Stored before the id (the expand step): the handles decide.
    expect(await months(stored({ account: "@oudroastery" }))).toEqual(["2026-09", "2026-10"]);
    expect(await months(stored({}))).toEqual(["2026-10"]);
    // The page's copy carries no id.
    expect(xForPage(stored({ accountId: USER_ID }))).not.toHaveProperty("accountId");
  });

  it("the card's footer says X is read only on a click whenever X's row or its button is shown (744)", () => {
    const x: XStats = { platform: "x", account: "@oud", range: { from: "2026-09-08", to: "2026-10-08" }, followers: 40, totals: { ...EMPTY_TOTALS }, posts: [], at: NOW.toISOString(), history: [] };
    const card = (p: Partial<Parameters<typeof SocialStats>[0]> = {}) => renderToStaticMarkup(createElement(SocialStats, { lang: "en", social: null, ...p }));
    expect(card()).toContain("Refreshed daily. Dana uses these figures");
    expect(card()).not.toContain("presses Refresh X");
    expect(card({ x })).toContain("Refreshed daily; X only when someone presses Refresh X.");
    expect(card({ canRefreshX: true, xConnected: true })).toContain("X only when someone presses Refresh X");
    expect(card({ x, lang: "ar" })).toContain("وإكس فقط عند الضغط على «حدّث إكس»");
    expect(card({ lang: "ar" })).not.toContain("وإكس فقط");
  });

  it("a Composio-routed X record is never read or charged (744)", async () => {
    const { id } = await workspace({ provider: "x", data: { x: "ca_x" }, meta: { via: "composio", account: "@oud" }, connectedAt: NOW.toISOString() });
    const r = await sync();
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, error: "x_direct_only" });
    expect(fetched).toEqual([]);
    expect(await balance(id)).toBe(START);
  });

  it("no X connection answers 404 and charges nothing", async () => {
    const { id } = await workspace(null);
    const r = await sync();
    expect(r.status).toBe(404);
    expect(fetched).toEqual([]);
    expect(await balance(id)).toBe(START);
    // sync_x is X's alone.
    await saveConnection(sc((await getUser(id))!), { provider: "linkedin", data: { access_token: "t" }, connectedAt: NOW.toISOString() });
    expect((await post({ action: "sync_x" }, "linkedin")).status).toBe(400);
    expect(fetched).toEqual([]);
  });

  it("agent cap and no credits answer 402 without calling X (744)", async () => {
    const capped = await workspace();
    await db.set(`gov:${capped.scope}`, { agentCaps: { dana: 0 } });
    const r1 = await sync();
    expect(r1.status).toBe(402);
    expect(await r1.json()).toMatchObject({ ok: false, error: "agent_cap", spent: 0, cap: 0 });
    expect(await balance(capped.id)).toBe(START);

    const broke = await workspace(xConn(), 0);
    const r2 = await sync();
    expect(r2.status).toBe(402);
    expect(await r2.json()).toMatchObject({ ok: false, error: "no_credits", need: 1, credits: 0 });

    const ended = await workspace();
    await saveUser({ ...(await getUser(ended.id))!, plan: "trial", trialEnds: "2026-10-01T00:00:00.000Z" });
    const r3 = await sync();
    expect(r3.status).toBe(402);
    expect(await r3.json()).toMatchObject({ ok: false, error: "trial_over" });
    expect(await balance(ended.id)).toBe(START);
    expect(fetched).toEqual([]);
    void broke;
  });

  it("a cron social sync never touches xstats; Dana's block shows X with its own date", async () => {
    const { scope } = await workspace();
    expect((await sync()).status).toBe(200);
    const stored = await db.get<XStats>(XSTATS_KEY(scope));
    // X alone makes a block: X's part with its read date, every other platform not available, no social sync date.
    const read = (block: string) => JSON.parse(block.slice(block.indexOf("<social_data>") + 13, block.indexOf("</social_data>")));
    const alone = read(await socialDataBlock(scope, NOW));
    expect(alone).toMatchObject({ x: { read: "2026-10-08", read_days_ago: 0, account: "@oudroastery", followers: 1500, posts_read: 1 }, instagram: expect.stringContaining("not available") });
    expect(alone.synced).toBeUndefined();

    // The next day's cron reads Instagram through Composio and writes the social snapshot, never xstats.
    const f = fakeComposio();
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubEnv("COMPOSIO_PROVIDERS", "meta");
    setComposioClientForTests(f.client);
    f.answers.INSTAGRAM_GET_USER_INFO = ok({ data: { id: "1784", username: "oud", followers_count: 1200 } }) as Answer;
    f.answers.INSTAGRAM_GET_USER_INSIGHTS = ok({ data: { data: [{ name: "reach", total_value: { value: 5400 } }] } });
    f.answers.INSTAGRAM_GET_IG_USER_MEDIA = ok({ data: { data: [] } });
    await saveConnection(scope, { provider: "meta", data: { instagram: "ca_ig" }, meta: { via: "composio", igId: "1784" }, connectedAt: NOW.toISOString() });
    const later = new Date("2026-10-11T10:00:00Z");
    vi.setSystemTime(later);
    expect(await syncSocialIfDue(scope, later)).toBe(true);
    expect(await db.get(SOCIAL_KEY(scope))).toMatchObject({ v: 2, at: later.toISOString() });
    expect(await db.get(XSTATS_KEY(scope))).toEqual(stored);
    expect(f.calls.some((c) => /TWITTER|X_/.test(c.slug))).toBe(false);

    const both = read(await socialDataBlock(scope, later));
    expect(both).toMatchObject({ synced: "2026-10-11", synced_days_ago: 0, instagram: { followers: 1200 }, x: { read: "2026-10-08", read_days_ago: 3 } });
  });

  it("wipeAccount deletes xstats (747)", async () => {
    const { scope, id } = await workspace();
    expect((await sync()).status).toBe(200);
    expect(await db.get(XSTATS_KEY(scope))).not.toBeNull();
    await wipeAccount(id);
    expect(await db.get(XSTATS_KEY(scope))).toBeNull();
  });

  it("disconnecting X drops its read and history: another account connected the same day reads as its own (747)", async () => {
    const { scope, id } = await workspace();
    expect((await sync()).status).toBe(200);
    expect(await balance(id)).toBe(START - 1);
    const del = await connRoute.DELETE(json("/api/connect/x", "DELETE"), ctx("x"));
    expect(del.status).toBe(200);
    expect(await getConnection(scope, "x")).toBeNull();
    expect(await getXStats(scope)).toBeNull();
    expect(await socialDataBlock(scope, NOW)).toBe("");
    // Another account, connected the same UTC day: read at once on the day's hold, so no second credit, with nothing of
    // the first account's read or history.
    await saveConnection(scope, xConn({ account: "@other" }));
    answer = (url) =>
      isMe(url) ? res(200, me(70, "2001")) : url.startsWith("https://api.x.com/2/users/2001/tweets") ? res(200, { meta: { result_count: 0 } }) : res(404, {});
    const r = await sync();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, charged: false, x: { followers: 70 } });
    expect(await balance(id)).toBe(START - 1);
    const x = (await getXStats(scope))!;
    expect(x).toMatchObject({ accountId: "2001", followers: 70, posts: [] });
    expect(x.history).toEqual([{ month: "2026-10", platform: "x", followers: 70, totals: x.totals }]);
    expect(await socialDataBlock(scope, NOW)).not.toContain("1844000000000000001");
  });

  it("six X refreshes an hour per workspace: failing reads that each refund cannot ask X without end (735, 744)", async () => {
    const { id } = await workspace();
    const back = vi.spyOn(credits, "refundOnce");
    answer = (url) => (isTweets(url) ? res(503, { title: "Service Unavailable" }) : xAnswers()(url));
    for (let i = 1; i <= 6; i++) expect((await sync()).status, `click ${i}`).toBe(502);
    expect(back).toHaveBeenCalledTimes(6);
    expect(await balance(id)).toBe(START);
    const charge = vi.spyOn(credits, "chargeOnce");
    fetched.length = 0;
    const r = await sync();
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("3600");
    expect(await r.json()).toMatchObject({ ok: false, error: "slow_down" });
    expect(charge).not.toHaveBeenCalled();
    expect(fetched).toEqual([]);
    expect(await balance(id)).toBe(START);
  });

  it("a refund that fails never hides X's answer: a 401 still asks the owner to reconnect (744)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(credits, "refundOnce").mockRejectedValue(new Error("user_lock_timeout"));
    const { scope } = await workspace();
    answer = (url) => (isMe(url) ? res(401, { title: "Unauthorized" }) : xAnswers()(url));
    const r = await sync();
    expect(r.status).toBe(502);
    expect((await getConnection(scope, "x"))?.needsReconnect).toBeTruthy();
    expect(err).toHaveBeenCalledWith("x_refund_failed");
    // X's own 429 keeps its wait.
    await workspace();
    answer = (url) => (isMe(url) ? res(429, {}, { "retry-after": "60" }) : xAnswers()(url));
    const r2 = await sync();
    expect(r2.status).toBe(429);
    expect(r2.headers.get("Retry-After")).toBe("60");
  });
});
