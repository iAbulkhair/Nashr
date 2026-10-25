import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as detailRoute from "@/app/api/admin/workspaces/[email]/route";
import { acct, getUser, type User } from "@/lib/auth";
import { accountForChosen } from "@/lib/admin-workspace";
import { rowOf, type WsAgg } from "@/lib/admin-workspaces";
import { ownerOf } from "@/lib/membership";
import { getPerson } from "@/lib/person";
import { createWorkspace } from "@/lib/workspaces";
import { wsHandle } from "@/lib/ws-handle";
import { json, newUser, params, signOut } from "./helpers/session";

/**
 * Workspaces visible in both dashboards (rules 4700-4702, docs/system/tests/4700-workspace-visibility.md), `MULTI_ORG` on:
 * 4700 the console opens the exact workspace of a person who holds several (`?ws=`, matched among the ones they hold);
 * 4701 the workspace page's Team tab lists each member's workspaces on demand; 4702 the app's switcher shows with one.
 */

const KEY = "test-admin-key-ws-pick-0123456789";
beforeEach(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); vi.stubEnv("CONNECT_SECRET", "ws-pick-connect-secret-one"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); signOut(); });

async function ownerOfTwo(): Promise<{ u: User; second: User }> {
  const u = await newUser("wspick", { shadow: false });
  const person = (await getPerson(ownerOf(u)))!;
  const made = await createWorkspace(person, { name: "Second", lang: "ar" });
  if (!made.ok) throw new Error(`createWorkspace: ${made.error}`);
  return { u, second: (await getUser(made.aid))! };
}

const agg: WsAgg = { name: "n", ownerName: "o", seatsUsed: 1, brandsActive: 1, active7: 0, tasks30: 0, creditsUsed: 0, lastActivityAt: null };
const detail = (email: string, ws: string) =>
  detailRoute.GET(json(`/api/admin/workspaces/${encodeURIComponent(email)}?ws=${ws}`, "GET", undefined, { "x-admin-key": KEY }), params({ email: encodeURIComponent(email) }));

describe("rule 4700: the console opens the chosen workspace", () => {
  it("picks the second workspace by its handle, the home one without, and nothing for a handle the person does not hold", async () => {
    const { u, second } = await ownerOfTwo();
    expect(acct(second)).not.toBe(acct(u));
    expect(acct((await accountForChosen(u.email))!.owner)).toBe(acct(u));
    const picked = (await accountForChosen(u.email, wsHandle(acct(second))))!;
    expect(acct(picked.owner)).toBe(acct(second));
    expect(picked.openedFrom).toBeNull();
    const other = await newUser("wspicko", { shadow: false });
    expect(await accountForChosen(u.email, wsHandle(acct(other)))).toBeNull();
    // A value of another shape is no selector: the address alone decides.
    expect(acct((await accountForChosen(u.email, "a_not-a-handle"))!.owner)).toBe(acct(u));
  });

  it("a list row carries its handle, and the detail route answers for the workspace it names", async () => {
    const { u, second } = await ownerOfTwo();
    expect(rowOf(second, agg).handle).toBe(wsHandle(acct(second)));
    const r = await detail(u.email, wsHandle(acct(second)));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { view: { workspaceName: string | null } };
    expect(j.view.workspaceName).toBe("Second");
    expect((await detail(u.email, "w_aaaaaaaaaaaaaaaa")).status).toBe(404);
  });

  it("the customers list links each row with its handle", () => {
    expect(readFileSync("src/components/admin/Customers.tsx", "utf8")).toContain("<Link href={here(r.email, r.handle)}");
  });
});

describe("rule 4701: a member's workspaces on the Team tab", () => {
  it("reads the people view only on demand and links each workspace by handle", () => {
    const src = readFileSync("src/components/admin/WorkspacePage.tsx", "utf8");
    expect(src).toContain("<PersonWorkspaces lang={lang} email={m.email} />");
    const fn = src.slice(src.indexOf("function PersonWorkspaces"));
    expect(fn.indexOf("/api/admin/people/")).toBeGreaterThan(fn.indexOf("async function show()"));
    expect(fn).not.toContain("useEffect");
    expect(fn).toContain("?ws=${encodeURIComponent(w.handle)}");
  });
});

describe("rule 4702: the switcher shows with one workspace", () => {
  it("is drawn with one row and offers all workspaces", () => {
    const src = readFileSync("src/components/app/WorkspaceSwitcher.tsx", "utf8");
    expect(src).toContain("rows.length < 1) return null;");
    expect(src).toContain('key: "all"');
  });
});
