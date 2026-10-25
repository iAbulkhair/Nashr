import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as workspaceRoute from "@/app/api/account/workspace/route";
import * as declineRoute from "@/app/api/team/decline/route";
import * as acceptRoute from "@/app/api/team/accept/route";
import { acct, currentUser, getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountKey, storedAccountId } from "@/lib/keys";
import { createInvite, declineInvite, inviteId, peekInvite } from "@/lib/team";
import { readTeamLog } from "@/lib/teamlog";
import { listNotifs } from "@/lib/notifications";
import { wsHandle } from "@/lib/ws-handle";
import { workspaceFree } from "@/lib/ws-path";
import { WORKSPACE_NAME_MAX, cleanWorkspaceName, workspaceLabel } from "@/lib/workspace-name";
import { railCollapsed, railCookie } from "@/lib/rail";
import { RAIL_COOKIE } from "@/lib/cookie-names";
import { appDict } from "@/lib/app-i18n";
import { json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { randomBytes } from "crypto";

vi.mock("next/navigation", () => ({
  usePathname: () => "/ar/app/chat",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

/**
 * Workspace settings and rail (2026-10-23, branch claude/sup-workspace-ui, rules 3115-3129): the owner renames the
 * workspace (PUT /api/account/workspace), the holder of an invite link declines it (POST /api/team/decline), and the
 * desktop rail folds to icons and remembers it in a cookie the layout reads.
 */

const read = (f: string) => readFileSync(f, "utf8");
let ipN = 0;
const ip = () => ({ "x-forwarded-for": `198.18.${Math.floor(++ipN / 250) % 250}.${(ipN % 250) + 1}` });
const rename = (name: unknown) => workspaceRoute.PUT(json("/api/account/workspace", "PUT", { name }));
const decline = (body: Record<string, unknown>, headers = ip()) => declineRoute.POST(json("/api/team/decline", "POST", body, headers));

/** An address with no login yet: an invite to it is the plain path (no sign-in needed), with the flag off or on. */
const fresh = (p: string) => ({ email: `${p}-${randomBytes(3).toString("hex")}@test.example` });
const pro = async (u: User) => { const x = { ...(await getUser(acct(u)))!, plan: "pro" as const, seats: 10 }; await saveUser(x); return x; };
async function owner(prefix: string) {
  const u = await pro(await newUser(prefix, { shadow: false }));
  await signIn(u.email);
  const me = (await currentUser())!;
  signOut();
  return { u, me, actor: me.actor!, aid: storedAccountId(acct(u)) };
}

describe("rules 3115-3118: the owner renames the workspace", () => {
  it("rule 3115: the owner's rename is stored on the session's account; the handle does not change", async () => {
    const A = await owner("rn");
    const before = wsHandle(A.aid);
    await signIn(A.u.email);
    const res = await rename("  وكالة   النخبة  ");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "وكالة النخبة" });
    expect((await getUser(acct(A.u)))!.workspaceName).toBe("وكالة النخبة");
    expect(wsHandle(A.aid)).toBe(before);
  });

  it("rule 3115: an admin and a member get 403 and nothing is written; no session is 401", async () => {
    const A = await owner("rr");
    await signIn(A.u.email);
    expect((await rename("Before")).status).toBe(200);
    for (const role of ["admin", "member"] as const) {
      const m = await newMember(A.u, role, `rr${role}`);
      await signIn(m.email);
      const res = await rename("Hijack");
      expect(res.status).toBe(403);
    }
    expect((await getUser(acct(A.u)))!.workspaceName).toBe("Before");
    signOut();
    expect((await rename("Nobody")).status).toBe(401);
  });

  it("rule 3116: the body names no account: an aid or email in it is ignored", async () => {
    const A = await owner("ri");
    const B = await owner("rj");
    await signIn(A.u.email);
    const res = await workspaceRoute.PUT(json("/api/account/workspace", "PUT", { name: "Mine", aid: B.aid, email: B.u.email, handle: wsHandle(B.aid) }));
    expect(res.status).toBe(200);
    expect((await getUser(acct(A.u)))!.workspaceName).toBe("Mine");
    expect((await getUser(acct(B.u)))!.workspaceName).not.toBe("Mine");
  });

  it("rule 3118: the name is cleaned and checked: empty is required, over the limit is too_long, never cut", async () => {
    expect(cleanWorkspaceName("  a \n\t b ")).toEqual({ ok: true, name: "a b" });
    expect(cleanWorkspaceName("x‮y⁦z\u0000")).toEqual({ ok: true, name: "xyz" });
    expect(cleanWorkspaceName("   ")).toEqual({ ok: false, error: "required" });
    expect(cleanWorkspaceName(42)).toEqual({ ok: false, error: "required" });
    expect(cleanWorkspaceName("a".repeat(WORKSPACE_NAME_MAX))).toEqual({ ok: true, name: "a".repeat(WORKSPACE_NAME_MAX) });
    expect(cleanWorkspaceName("a".repeat(WORKSPACE_NAME_MAX + 1))).toEqual({ ok: false, error: "too_long" });
    const A = await owner("rv");
    await signIn(A.u.email);
    const empty = await rename(" ");
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ ok: false, error: "required" });
    const long = await rename("ب".repeat(WORKSPACE_NAME_MAX + 1));
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ ok: false, error: "too_long" });
    expect((await getUser(acct(A.u)))!.workspaceName).toBeUndefined();
  });

  it("rule 3117: ten renames an hour per account, then 429 with Retry-After", async () => {
    const A = await owner("rl");
    await signIn(A.u.email);
    for (let i = 0; i < 10; i++) expect((await rename(`Name ${i}`)).status).toBe(200);
    const res = await rename("One more");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(await res.json()).toEqual({ ok: false, error: "slow_down" });
    expect((await getUser(acct(A.u)))!.workspaceName).toBe("Name 9");
    expect(await db.get(`rate:${accountKey.workspaceNameBucket(acct(A.u))}`)).not.toBeNull();
  });

  it("rule 3116: the name the owner set comes before the brand's, then the owner's name; invites carry it", async () => {
    expect(workspaceLabel({ workspaceName: "Set", name: "Owner" }, { name: "Brand" })).toBe("Set");
    expect(workspaceLabel({ workspaceName: "  ", name: "Owner" }, { name: "Brand" })).toBe("Brand");
    expect(workspaceLabel({ name: "Owner" }, null)).toBe("Owner");
    expect(workspaceLabel(null, null)).toBe("");
    const A = await owner("rp");
    await signIn(A.u.email);
    expect((await rename("Renamed Co")).status).toBe(200);
    const B = fresh("rpb");
    const inv = await createInvite((await getUser(acct(A.u)))!, A.actor, B.email, "member", "en");
    if (!inv.ok) throw new Error(inv.error);
    expect((await peekInvite(inv.token))!.team).toBe("Renamed Co");
    for (const f of ["src/lib/workspaces.ts", "src/lib/admin-people.ts", "src/lib/team.ts"]) expect(read(f), f).toContain("workspaceLabel(");
  });

  it("rule 3115: the settings card is the owner's only and posts to the rename route", () => {
    const card = read("src/components/app/settings/AccountSettings.tsx");
    expect(card).toMatch(/\{stored\.owner && \(\s*<SettingsCard title=\{T\.ws\}/);
    expect(card).toContain('fetch("/api/account/workspace", { method: "PUT"');
    expect(card).toContain("maxLength={WORKSPACE_NAME_MAX}");
    const page = read("src/app/[lang]/app/settings/account/page.tsx");
    expect(page).toContain("const workspaceName = owner ? workspaceLabel(u, await getBrand(acct(u))) : undefined;");
  });
});

describe("rules 3119-3122: declining an invite", () => {
  it("rule 3119-3120: the token's invite is gone (record, index, inbox), the answer says nothing about the account", async () => {
    const A = await owner("da");
    const B = fresh("db");
    const inv = await createInvite(A.me, A.actor, B.email, "admin", "ar");
    const other = await createInvite(A.me, A.actor, `other-${B.email}`, "member", "ar");
    if (!inv.ok || !other.ok) throw new Error("invite");
    const res = await decline({ token: inv.token, aid: "a_forged", email: "x@test.example", id: other.id });
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    expect(await res.json()).toEqual({ ok: true });
    for (const s of [A.aid, A.u.email, inv.id]) expect(text).not.toContain(s);
    expect(await db.get(`invite:${inv.id}`)).toBeNull();
    expect(await db.sismember(accountKey.invites(A.aid), inv.id)).toBeFalsy();
    expect(await db.smembers(accountKey.invitesFor(B.email))).not.toContain(inv.id);
    // The other invite of the same account, named in the body, is untouched.
    expect(await db.get(`invite:${other.id}`)).not.toBeNull();
    expect(inviteId(inv.token)).toBe(inv.id);
  });

  it("rule 3121: one invite_declined row naming the invited address only; rule 3122: the owner's bell says who", async () => {
    const A = await owner("dl");
    const B = fresh("dm");
    const inv = await createInvite(A.me, A.actor, B.email, "member", "ar");
    if (!inv.ok) throw new Error(inv.error);
    const bellBefore = (await listNotifs(acct(A.u))).length;
    expect((await decline({ token: inv.token })).status).toBe(200);
    const rows = (await readTeamLog(A.aid)).filter((r) => r.kind === "invite_declined");
    expect(rows).toHaveLength(1);
    expect(rows[0].target.email).toBe(B.email.toLowerCase());
    expect(rows[0].actor.email).toBe(B.email.toLowerCase());
    expect(rows[0].actor.pid).toBeUndefined();
    expect(rows[0].role).toBe("member");
    const bell = await listNotifs(acct(A.u));
    expect(bell.length).toBe(bellBefore + 1);
    expect(JSON.stringify(bell)).toContain(B.email.toLowerCase());
  });

  it("rule 3119: the link stops working: accept, peek and a second decline all answer invalid", async () => {
    const A = await owner("dx");
    const B = fresh("dy");
    const inv = await createInvite(A.me, A.actor, B.email, "member", "ar");
    if (!inv.ok) throw new Error(inv.error);
    expect((await decline({ token: inv.token })).status).toBe(200);
    expect(await peekInvite(inv.token)).toBeNull();
    const again = await decline({ token: inv.token });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid" });
    const acc = await acceptRoute.POST(json("/api/team/accept", "POST", { token: inv.token, name: "B", password: "abc12345", lang: "ar" }, ip()));
    expect(acc.status).toBe(400);
  });

  it("rule 3119: a malformed, unknown or missing token changes nothing", async () => {
    for (const body of [{}, { token: 42 }, { token: "short" }, { token: "z".repeat(43) }, { token: "A".repeat(43) }]) {
      const res = await decline(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await declineInvite("not a token")).toEqual({ ok: false, error: "invalid" });
  });

  it("rule 3120: ten declines per IP per 15 minutes, then 429; the route is public and outside the workspace guard", async () => {
    const same = ip();
    for (let i = 0; i < 10; i++) expect((await decline({ token: "nope" }, same)).status).toBe(400);
    const res = await decline({ token: "nope" }, same);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(workspaceFree("/api/team/decline")).toBe(true);
    const route = read("src/app/api/team/decline/route.ts");
    expect(route).not.toMatch(/currentUser\(|currentPerson\(|\bsc\(/);
  });

  it("rule 3119: the join page offers decline with one confirm step, in both languages", () => {
    const form = read("src/components/app/JoinForm.tsx");
    expect(form).toContain('fetch("/api/team/decline"');
    expect(form).toContain('setPhase("declined")');
    for (const lang of ["ar", "en"] as const) {
      const J = appDict[lang].join;
      for (const k of ["decline", "declineAsk", "declineConfirm", "declineBack", "declining", "declined", "declinedSub", "declineFailed", "home"] as const) expect(J[k], `${lang}.${k}`).toBeTruthy();
      expect(J.declineAsk).toContain("{team}");
      expect(appDict[lang].team.logKinds.invite_declined).toContain("{target}");
    }
  });
});

describe("rules 3123-3127: the folding rail", () => {
  it("rule 3124: the cookie holds only the word, a year, the whole site, lax, Secure on https", () => {
    expect(RAIL_COOKIE).toBe("thakeen_rail");
    expect(railCookie(true, true)).toBe("thakeen_rail=collapsed; path=/; max-age=31536000; samesite=lax; secure");
    expect(railCookie(false, false)).toBe("thakeen_rail=open; path=/; max-age=31536000; samesite=lax");
    expect(railCollapsed("collapsed")).toBe(true);
    for (const v of ["open", "", undefined, null, "Collapsed", "collapsed;x"]) expect(railCollapsed(v)).toBe(false);
  });

  it("rule 3124: the layout reads the cookie on the server and passes it to the rail", () => {
    const layout = read("src/app/[lang]/app/layout.tsx");
    expect(layout).toContain("railCollapsed((await cookies()).get(RAIL_COOKIE)?.value)");
    expect(layout).toContain("collapsed={railFolded}");
  });

  const props = (collapsed: boolean, lang: "ar" | "en" = "ar") => ({
    t: appDict[lang], lang, collapsed, admin: false,
    user: { name: "Sara", email: "sara@test.example", role: "owner" as const, credits: 120, plan: "pro" },
    show: { owner: true, refer: true, mcp: false },
  });
  const render = async (collapsed: boolean, lang: "ar" | "en" = "ar") => {
    const { default: Sidebar } = await import("@/components/app/Sidebar");
    return renderToStaticMarkup(h(Sidebar, props(collapsed, lang)));
  };

  it("rules 3125-3126: folded, the rail is icons only with names as aria-label and title; the button says expand", async () => {
    const html = await render(true, "en");
    expect(html).toMatch(/<aside[^>]*id="app-rail"[^>]*data-folded="true"[^>]*class="[^"]*\bw-16\b/);
    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).toContain('aria-expanded="false"');
    const X = appDict.en.nav;
    const esc = (v: string) => v.replace(/&/g, "&amp;");
    for (const label of [X.main, X.todo, X.files, X.settings, X.updates]) expect(html).toContain(`aria-label="${esc(label)}" title="${esc(label)}"`);
    // The search box and the group titles are not drawn in the folded rail.
    const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect(aside).not.toContain('type="search"');
    expect(aside).not.toContain(appDict.en.ux.nav.work);
  });

  it("rule 3125: open, the rail is full width and the button says collapse, in Arabic too", async () => {
    const html = await render(false, "ar");
    expect(html).toMatch(/<aside[^>]*id="app-rail"[^>]*class="[^"]*\bw-64\b/);
    expect(html).not.toContain('data-folded="true"');
    expect(html).toContain(`aria-label="${appDict.ar.ux.nav.collapse}"`);
    expect(html).toContain('aria-expanded="true"');
    expect(appDict.ar.ux.nav.expand).toBeTruthy();
  });

  it("rule 3127: the arrow mirrors in RTL; the phone header and sheet never fold", () => {
    const src = read("src/components/app/Sidebar.tsx");
    expect(src).toContain('<Icon name="next" mirror className={`h-4 w-4 ${folded ? "" : "rotate-180"}`} />');
    expect(src).toContain('<header className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b-[1.5px] border-border-strong bg-surface px-4 py-2 text-foreground lg:hidden">');
    expect(src).toContain('{top(false)}{nav("sheet")}{account(false)}');
    expect(src).toContain("document.cookie = railCookie(next, window.location.protocol === \"https:\")");
  });
});
