/**
 * Reem B3, the brand's marketing calendar (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md). Rule 612 is the
 * provider part: `gcal` and `mscal` exist as OAuth providers flagged `secretary`, so the Integrations page, the generic
 * connector routes and the publishing code never show or use them, and only the account owner may link a calendar.
 */
import { describe, expect, it } from "vitest";
import { json, newUser, params, signIn } from "./helpers/session";
import { CAL_PROVIDERS, getProvider } from "@/lib/connectors/registry";
import { MIN_ROLE, can } from "@/lib/roles";
import * as connectList from "@/app/api/connect/route";
import * as connectOne from "@/app/api/connect/[provider]/route";

describe("rule 612a: gcal and mscal exist, are secretary-only and never listed on Integrations", () => {
  it("gcal asks Google for the two read-only calendar scopes and nothing else", () => {
    const g = getProvider("gcal")!;
    expect(g.secretary).toBe(true);
    expect(g.kind).toBe("oauth");
    expect(g.capabilities).toEqual([]);
    expect(g.oauth!.clientIdEnv).toBe("GOOGLE_CLIENT_ID");
    expect(g.oauth!.clientSecretEnv).toBe("GOOGLE_CLIENT_SECRET");
    expect(g.oauth!.authorizeUrl).toBe(getProvider("google")!.oauth!.authorizeUrl);
    expect(g.oauth!.tokenUrl).toBe(getProvider("google")!.oauth!.tokenUrl);
    expect(g.oauth!.scopes).toEqual(["openid", "email", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.owned.readonly"]);
    expect(g.oauth!.extraAuthParams).toEqual({ access_type: "offline", prompt: "consent", include_granted_scopes: "false" });
  });

  it("mscal asks Microsoft for basic calendar reads with PKCE on the common endpoints", () => {
    const m = getProvider("mscal")!;
    expect(m.secretary).toBe(true);
    expect(m.kind).toBe("oauth");
    expect(m.capabilities).toEqual([]);
    expect(m.oauth!.authorizeUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(m.oauth!.tokenUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(m.oauth!.tokenAuth).toBe("body");
    expect(m.oauth!.pkce).toBe(true);
    expect(m.oauth!.scopes).toEqual(["openid", "email", "offline_access", "User.Read", "Calendars.ReadBasic"]);
    expect(m.oauth!.clientIdEnv).toBe("MICROSOFT_CLIENT_ID");
    expect(m.oauth!.clientSecretEnv).toBe("MICROSOFT_CLIENT_SECRET");
  });

  it("CAL_PROVIDERS is exactly the two, and no other provider is flagged secretary", async () => {
    expect([...CAL_PROVIDERS]).toEqual(["gcal", "mscal"]);
    const { PROVIDERS } = await import("@/lib/connectors/registry");
    expect(PROVIDERS.filter((p) => p.secretary).map((p) => p.id)).toEqual(["gcal", "mscal"]);
  });

  it("GET /api/connect as the owner lists neither, and still lists the publishing providers", async () => {
    const o = await newUser("calp");
    await signIn(o.email);
    const r = await connectList.GET();
    const body = (await r.json()) as { ok: boolean; providers: { id: string }[] };
    expect(body.ok).toBe(true);
    const ids = body.providers.map((p) => p.id);
    expect(ids).not.toContain("gcal");
    expect(ids).not.toContain("mscal");
    expect(ids).toContain("google");
    expect(ids).toContain("wordpress");
  });

  it("POST and DELETE /api/connect/{gcal,mscal} answer 404 unknown_provider, as for a provider that does not exist", async () => {
    const o = await newUser("calp");
    await signIn(o.email);
    for (const id of ["gcal", "mscal"]) {
      const post = await connectOne.POST(json(`http://x/api/connect/${id}`, "POST", { action: "sync_ads" }), params({ provider: id }));
      expect(post.status).toBe(404);
      expect(await post.json()).toEqual({ ok: false, error: "unknown_provider" });
      const del = await connectOne.DELETE(json(`http://x/api/connect/${id}`, "DELETE"), params({ provider: id }));
      expect(del.status).toBe(404);
      expect(await del.json()).toEqual({ ok: false, error: "unknown_provider" });
    }
  });
});

describe("rule 612b: only the account owner links a calendar", () => {
  it("the role key calendar.link needs the owner, so an admin or a member is refused", () => {
    expect(MIN_ROLE["calendar.link"]).toBe("owner");
    const as = (kind: "owner" | "member", role: "owner" | "admin" | "member") => ({ email: "a@test.example", actor: { kind, role, email: "a@test.example" } }) as never;
    expect(can(as("owner", "owner"), "calendar.link")).toBe(true);
    expect(can(as("member", "admin"), "calendar.link")).toBe(false);
    expect(can(as("member", "member"), "calendar.link")).toBe(false);
  });
});
