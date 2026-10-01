import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { json, newUser, signIn } from "./helpers/session";
import { getUser, saveUser } from "@/lib/auth";
import { getBrand, saveBrand, type Brand } from "@/lib/brand";
import { db } from "@/lib/db";
import * as profile from "@/app/api/profile/route";

/**
 * Saving the Profile page (#16). Clearing a field showed "Saved" while the server skipped the empty value and kept the old
 * text, and a short phone was dropped in silence. Rules 370-372 and 380 in docs/system/tests.md.
 */
const brand: Brand = { name: "Roastery", website: "roastery.example", sitemap: "https://roastery.example/sitemap.xml", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "Specialty beans", audience: "Riyadh locals", valueProp: "Roasted daily", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "Riyadh", social: { instagram: "@roastery" }, updatedAt: "2026-09-29T00:00:00.000Z" };

async function owner() {
  const u = await newUser("prof");
  await saveUser({ ...(await getUser(u.email))!, phone: "+966500000123" });
  await saveBrand(u.email, brand);
  await signIn(u.email);
  return u;
}
const put = (body: Record<string, string>) => profile.PUT(json("/api/profile", "PUT", body));
type Got = { brand: { name: string; products: string; audience: string; tone: string; valueProp: string; website: string; sitemap: string; social: Record<string, string> }; user: { phone?: string; name: string } };
const read = async () => (await (await profile.GET()).json()) as Got;

describe("clearing a profile field clears it on the server (rule 370)", () => {
  it("an empty description, audience, voice, value proposition, website, sitemap, handle or phone is saved as empty, and the answer says so", async () => {
    await owner();
    const res = await put({ business: "Roastery", products: "", audience: "", tone: "", valueProp: "", website: "", sitemap: "", social_instagram: "", phone: "" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; saved: { phone: string; brand: Got["brand"] } };
    expect(body.ok).toBe(true);
    expect(body.saved.phone, "the answer carries what was stored").toBe("");
    expect(body.saved.brand).toMatchObject({ name: "Roastery", products: "", audience: "", tone: "", valueProp: "", website: "", sitemap: "", social: {} });

    const after = await read();
    expect(after.brand).toMatchObject({ products: "", audience: "", tone: "", valueProp: "", website: "", sitemap: "", social: {} });
    expect(after.user.phone).toBe("");
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
  it("an empty business name or full name answers 400 required; a short phone answers 400 bad_phone", async () => {
    const u = await owner();
    const cases: [Record<string, string>, string, string][] = [
      [{ business: "  ", products: "changed" }, "required", "business"],
      [{ name: "", products: "changed" }, "required", "name"],
      [{ phone: "12345", products: "changed", name: "Changed" }, "bad_phone", "phone"],
    ];
    for (const [body, error, field] of cases) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error, field });
    }
    // Never a 200 while the server keeps the old text: here, every refused request left everything as it was.
    expect((await getBrand(u.email))!).toMatchObject({ name: "Roastery", products: "Specialty beans" });
    expect((await getUser(u.email))!).toMatchObject({ phone: "+966500000123", name: "Test" });
  });

  it("a valid phone is saved, trimmed", async () => {
    const u = await owner();
    const res = await put({ phone: " 0501234567 " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { saved: { phone: string } }).saved.phone).toBe("0501234567");
    expect((await getUser(u.email))!.phone).toBe("0501234567");
  });
});

describe("the profile's brand write holds the brand lock (rule 372)", () => {
  it("a banned word an agent adds while the form is being saved is not overwritten by the form's older copy", async () => {
    const u = await owner();
    const lock = `brandlock:${u.email}`;
    expect(await db.lock(lock, 10)).toBe(true);
    let finished = false;
    const saving = put({ tone: "calm" }).then((r) => ((finished = true), r));
    await new Promise((r) => setTimeout(r, 120));
    expect(finished, "the save waits for the brand lock instead of writing over it").toBe(false);
    // What an agent's update_brand does under the same lock (src/lib/chat.ts): read, add a word, save.
    await saveBrand(u.email, { ...(await getBrand(u.email))!, banned: "cheap" });
    await db.unlock(lock);
    expect((await saving).status).toBe(200);
    expect((await getBrand(u.email))!).toMatchObject({ tone: "calm", banned: "cheap" });
  });
});

describe("a save that cannot take its lock answers busy and writes nothing (rule 380)", () => {
  it("with the brand lock held past its wait, name, phone, language, email preference and brand fields all stay as they were", async () => {
    const u = await owner();
    const before = await db.get(`profile:${u.email}`);
    const lock = `brandlock:${u.email}`;
    expect(await db.lock(lock, 30)).toBe(true);
    try {
      const res = await put({ name: "Changed", phone: "0509999999", lang: "en", emails: "none", tone: "loud" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: "busy" });
    } finally {
      await db.unlock(lock);
    }
    // The brand lock is taken before the first write, so the owner's fields were never reached.
    expect((await getUser(u.email))!).toMatchObject({ name: "Test", phone: "+966500000123", lang: "ar" });
    expect(await db.get(`profile:${u.email}`)).toEqual(before);
    expect((await getBrand(u.email))!).toMatchObject({ tone: "warm" });
  }, 15_000);

  it("the Profile page says nothing was saved only for answers the server gives before writing; any other failure re-reads the profile", () => {
    const src = readFileSync("src/components/app/ProfilePanel.tsx", "utf8");
    const fn = src.slice(src.indexOf("async function save("), src.indexOf("async function password("));
    expect(fn).toContain('j.error === "busy"');
    // The fallback for a dropped connection or a server error: never "Nothing was saved", and the form is re-read.
    const fallback = fn.slice(fn.indexOf("if (refused)"), fn.indexOf("// Show what the server stored"));
    expect(fallback).toContain("fetchProfile()");
    expect(fallback).not.toMatch(/Nothing was saved|لم يُحفظ شيء/);
    expect(fallback).toContain("Could not confirm the save");
  });
});
