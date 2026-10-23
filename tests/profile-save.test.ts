import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, markVerified, newMember, newUser, signIn } from "./helpers/session";
import { accountByLogin, acct, getLogin, getUser, saveUser, sc } from "@/lib/auth";
import { getBrand, saveBrand, type Brand } from "@/lib/brand";
import { db } from "@/lib/db";
import * as profile from "@/app/api/profile/route";
import * as signup from "@/app/api/auth/signup/route";

/**
 * Saving the Profile page (#16). Clearing a field showed "Saved" while the server skipped the empty value and kept the old
 * text, and a short phone was dropped in silence. Rules 370-372, 380 and 381 in docs/system/tests.md.
 */
const brand: Brand = { name: "Roastery", website: "roastery.example", sitemap: "https://roastery.example/sitemap.xml", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "Specialty beans", audience: "Riyadh locals", valueProp: "Roasted daily", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "Riyadh", social: { instagram: "@roastery" }, updatedAt: "2026-09-29T00:00:00.000Z" };

async function owner() {
  const u = await newUser("prof");
  await saveUser({ ...(await getUser(acct(u)))!, phone: "+966500000123" });
  await saveBrand(sc(u), brand);
  await signIn(u.email);
  return u;
}
const put = (body: Record<string, string>) => profile.PUT(json("/api/profile", "PUT", body));
type Got = { brand: { name: string; products: string; audience: string; tone: string; valueProp: string; website: string; sitemap: string; social: Record<string, string> }; user: { phone?: string; name: string } };
const read = async () => (await (await profile.GET()).json()) as Got;

describe("clearing a profile field clears it on the server (rule 370)", () => {
  it("an empty description, audience, voice, value proposition, website, sitemap or handle is saved as empty, and the answer says so", async () => {
    await owner();
    const res = await put({ business: "Roastery", products: "", audience: "", tone: "", valueProp: "", website: "", sitemap: "", social_instagram: "", phone: "0501234567" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; saved: { phone: string; brand: Got["brand"] } };
    expect(body.ok).toBe(true);
    expect(body.saved.phone, "the answer carries what was stored").toBe("0501234567");
    expect(body.saved.brand).toMatchObject({ name: "Roastery", products: "", audience: "", tone: "", valueProp: "", website: "", sitemap: "", social: {} });

    const after = await read();
    expect(after.brand).toMatchObject({ products: "", audience: "", tone: "", valueProp: "", website: "", sitemap: "", social: {} });
    expect(after.user.phone).toBe("0501234567");
  });

  it("a field left out of the request is left as it was", async () => {
    await owner();
    expect((await put({ tone: "bold" })).status).toBe(200);
    const after = await read();
    expect(after.brand).toMatchObject({ tone: "bold", products: "Specialty beans", audience: "Riyadh locals", name: "Roastery" });
    expect(after.user.phone).toBe("+966500000123");
  });
});

describe("a value that cannot be saved is refused with the field named, and nothing is written (rule 371)", () => {
  it("an empty business name, full name or phone answers 400 required; a short phone answers 400 bad_phone", async () => {
    const u = await owner();
    const cases: [Record<string, string>, string, string][] = [
      [{ business: "  ", products: "changed" }, "required", "business"],
      [{ name: "", products: "changed" }, "required", "name"],
      [{ phone: "", products: "changed", name: "Changed" }, "required", "phone"],
      [{ phone: "   ", tone: "changed" }, "required", "phone"],
      [{ phone: "12345", products: "changed", name: "Changed" }, "bad_phone", "phone"],
    ];
    for (const [body, error, field] of cases) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error, field });
    }
    // Never a 200 while the server keeps the old text: here, every refused request left everything as it was.
    expect((await getBrand(sc(u)))!).toMatchObject({ name: "Roastery", products: "Specialty beans" });
    expect((await getUser(acct(u)))!).toMatchObject({ phone: "+966500000123", name: "Test" });
  });

  it("a valid phone is saved, trimmed", async () => {
    const u = await owner();
    const res = await put({ phone: " 0501234567 " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { saved: { phone: string } }).saved.phone).toBe("0501234567");
    expect((await getUser(acct(u)))!.phone).toBe("0501234567");
  });
});

describe("the profile's brand write holds the brand lock (rule 372)", () => {
  it("a banned word an agent adds while the form is being saved is not overwritten by the form's older copy", async () => {
    const u = await owner();
    const lock = `brandlock:${sc(u)}`;
    expect(await db.lock(lock, 10)).toBe(true);
    let finished = false;
    const saving = put({ tone: "calm" }).then((r) => ((finished = true), r));
    await new Promise((r) => setTimeout(r, 120));
    expect(finished, "the save waits for the brand lock instead of writing over it").toBe(false);
    // What a proposal the owner applies does under the same lock (src/lib/brand-proposals.ts): read, add a word, save.
    await saveBrand(sc(u), { ...(await getBrand(sc(u)))!, banned: "cheap" });
    await db.unlock(lock);
    expect((await saving).status).toBe(200);
    expect((await getBrand(sc(u)))!).toMatchObject({ tone: "calm", banned: "cheap" });
  });
});

describe("a save that cannot take its lock answers busy and writes nothing (rule 380)", () => {
  it("with the brand lock held past its wait, name, phone, language, email preference and brand fields all stay as they were", async () => {
    const u = await owner();
    const before = await db.get(`profile:${sc(u)}`);
    const lock = `brandlock:${sc(u)}`;
    expect(await db.lock(lock, 30)).toBe(true);
    try {
      const res = await put({ name: "Changed", phone: "0509999999", lang: "en", emails: "none", tone: "loud" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: "busy" });
    } finally {
      await db.unlock(lock);
    }
    // The brand lock is taken before the first write, so the owner's fields were never reached.
    expect((await getUser(acct(u)))!).toMatchObject({ name: "Test", phone: "+966500000123", lang: "ar" });
    expect(await db.get(`profile:${sc(u)}`)).toEqual(before);
    expect((await getBrand(sc(u)))!).toMatchObject({ tone: "warm" });
  }, 15_000);

  // Since UI/UX phase 3 (rule 1142) every settings card saves through `saveProfile`, and the card re-reads on an unknown result.
  it("a settings card says nothing was saved only for answers the server gives before writing; any other failure re-reads the profile", () => {
    const src = readFileSync("src/components/app/settings/profileSave.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function saveProfile("), src.indexOf("/** GET /api/profile, for a card"));
    expect(fn).toContain('j.error === "busy"');
    // The fallback for a dropped connection or a server error: never "Nothing was saved".
    const fallback = fn.slice(fn.indexOf("if (refused)"));
    expect(fallback).toContain('kind: "unknown"');
    expect(fallback).not.toMatch(/Nothing was saved|لم يُحفظ شيء/);
    expect(fallback).toContain("Could not confirm the save");
    // ... and the cards then read what is stored.
    for (const f of ["AccountSettings", "BrandExtras"]) {
      const card = readFileSync(`src/components/app/settings/${f}.tsx`, "utf8");
      expect(card, f).toMatch(/out\.kind === "unknown"[\s\S]{0,160}readProfile\(\)/);
    }
  });
});

describe("full name, business name, mobile phone and email are required on the Profile (rule 381)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  /** An owner whose account was created without a phone, as signup still allows. */
  async function noPhone() {
    const u = await newUser("nophone");
    await saveBrand(sc(u), brand);
    await signIn(u.email);
    return u;
  }

  it("signup still takes no phone, and that account still reads its profile", async () => {
    const email = `signup-nophone-${Date.now()}@test.example`;
    expect((await signup.POST(json("/api/auth/signup", "POST", { email, name: "No Phone", password: "coffee123", lang: "ar" }))).status).toBe(200);
    expect((await accountByLogin(email))!.phone).toBe("");
    await markVerified(email);
    await signIn(email);
    const res = await profile.GET();
    expect(res.status).toBe(200);
    expect(((await res.json()) as Got).user.phone ?? "").toBe("");
  });

  it("an owner without a stored phone is asked for one on any save, and nothing is written until it is valid", async () => {
    const u = await noPhone();
    for (const body of [{ tone: "bold" }, { name: "Renamed" }, { emails: "none" }, { lang: "en" }] as Record<string, string>[]) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "required", field: "phone" });
    }
    expect((await getBrand(sc(u)))!.tone).toBe("warm");
    expect((await getUser(acct(u)))!).toMatchObject({ name: "Test", lang: "ar", phone: "" });
    expect(await db.get(`profile:${sc(u)}`)).toBeNull();

    const ok = await put({ phone: "0501234567", tone: "bold", name: "Renamed" });
    expect(ok.status).toBe(200);
    expect((await getUser(acct(u)))!).toMatchObject({ phone: "0501234567", name: "Renamed" });
    // Once stored, a save that leaves the phone out is accepted, and the phone cannot be cleared.
    expect((await put({ tone: "calm" })).status).toBe(200);
    expect((await put({ phone: "" })).status).toBe(400);
    expect((await getUser(acct(u)))!.phone).toBe("0501234567");
  });

  it("the founder acting as the owner is held to the same phone; a member's own save is not", async () => {
    const u = await noPhone();
    vi.stubEnv("ADMIN_EMAILS", "founder-required@test.example");
    await signIn(u.email, { imp: "founder-required@test.example" });
    expect((await put({ tone: "bold" })).status).toBe(400);

    const m = await newMember((await getUser(acct(u)))!);
    await signIn(m.email);
    expect((await put({ name: "Member Renamed" })).status, "the phone is the account's, not the member's to set").toBe(200);
  });

  it("the email is shown and cannot be blanked or changed through the profile", async () => {
    const u = await owner();
    for (const email of ["", "other@test.example"]) {
      const res = await put({ email, tone: "bold" });
      expect(res.status, email).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "read_only", field: "email" });
    }
    expect((await getUser(acct(u)))!.email).toBe(u.email);
    expect((await getBrand(sc(u)))!.tone).toBe("warm");
    const got = (await (await profile.GET()).json()) as { me: { email: string } };
    expect(got.me.email).toBe(u.email);
  });

  // Settings, Account since UI/UX phase 3 (rule 1143): the name and the phone are required fields, the email is shown and
  // never sent, the business name is the brand form's own required field.
  it("the account settings mark the fields required and ask an account without a phone for one", () => {
    const src = readFileSync("src/components/app/settings/AccountSettings.tsx", "utf8");
    expect(src).toMatch(/<Field label=\{T\.name\} hideLabel required/);
    expect(src).toMatch(/<Field label=\{T\.phone\} hideLabel required/);
    expect(src).not.toMatch(/name="email"/);
    expect(src).toContain("phoneMissing");
    expect(readFileSync("src/components/app/settings/profileSave.ts", "utf8")).toContain("أضف رقم جوالك أولاً");
    expect(src).not.toMatch(/leave it empty|اتركه فارغاً/);
    // The browser never blocks the save first: every card is noValidate and the phone carries no minLength; Save stays
    // off until the phone has 9 digits, and the server's bad_phone message still shows if one gets through.
    expect(readFileSync("src/components/app/settings/SettingsCard.tsx", "utf8")).toMatch(/onSubmit=\{submit\} noValidate/);
    expect(src).not.toMatch(/name="phone"[^>]*minLength/);
    expect(src).toMatch(/valid=\{phoneValid\(phoneT\)\}/);
  });
});
