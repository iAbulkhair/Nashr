import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createUser, currentUser, currentUserUnverified, emailVerified, getUser, saveUser } from "@/lib/auth";
import { newMember, newUser, signIn } from "./helpers/session";

/** Rules 751-752: a password-signup owner who has not proved the address reads as signed out, everywhere. */
describe("email verification gate", () => {
  it("unverified owner reads as signed out", async () => {
    const u = await newUser("g", { verified: false });
    await signIn(u.email);
    expect(await currentUser()).toBeNull();
    expect((await currentUserUnverified())!.email).toBe(u.email);
  });

  it("verified owner passes", async () => {
    const u = await newUser("g");
    await signIn(u.email);
    const me = await currentUser();
    expect(me!.email).toBe(u.email);
    expect(me!.actor!.kind).toBe("owner");
  });

  it("founder impersonation passes the gate", async () => {
    const u = await newUser("g", { verified: false });
    await signIn(u.email, { imp: "founder@test.example" });
    const me = await currentUser();
    expect(me).not.toBeNull();
    expect(me!.actor!.kind).toBe("founder");
  });

  it("member of an unverified owner signs in", async () => {
    const owner = await newUser("g", { verified: false });
    const m = await newMember(owner);
    await signIn(m.email);
    const me = await currentUser();
    expect(me).not.toBeNull();
    expect(me!.actor!.kind).toBe("member");
  });

  it("createUser marks gatedSignup and no emailVerifiedAt", async () => {
    const u = await createUser({ email: "gated-new@test.example", name: "T", phone: "", password: "abc12345", lang: "ar" });
    expect(u.gatedSignup).toBe(true);
    expect(u.emailVerifiedAt).toBeUndefined();
    expect(emailVerified(u)).toBe(false);
    expect(emailVerified({ emailVerifiedAt: "2026-01-01T00:00:00.000Z" })).toBe(true);
  });

  it("suspended stays null in both resolvers", async () => {
    const u = await newUser("g", { verified: false });
    const stored = (await getUser(u.email))!;
    stored.suspended = true;
    await saveUser(stored);
    await signIn(u.email);
    expect(await currentUser()).toBeNull();
    expect(await currentUserUnverified()).toBeNull();
  });

  // Rule 752: only the app layout, the verify page, the three verify routes and the resolver itself may call
  // `currentUserUnverified`. Anywhere else an unverified owner would read as signed in.
  it("currentUserUnverified has exactly the allowed callers", () => {
    const callers = (readdirSync("src", { recursive: true }) as string[])
      .map((f) => join("src", f))
      .filter((f) => /\.(?:ts|tsx)$/.test(f) && /currentUserUnverified\(/.test(readFileSync(f, "utf8")))
      .sort();
    expect(callers).toEqual(
      [
        "src/app/[lang]/app/layout.tsx",
        "src/app/[lang]/app/verify/page.tsx",
        "src/app/api/auth/verify/check/route.ts",
        "src/app/api/auth/verify/email/route.ts",
        "src/app/api/auth/verify/send/route.ts",
        "src/lib/auth.ts",
      ].sort(),
    );
  });
});
