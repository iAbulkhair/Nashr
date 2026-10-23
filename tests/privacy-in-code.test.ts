import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { json, newMember, newUser, signIn, signOut, type Fixture, seedActiveBrand } from "./helpers/session";
import { accountByLogin, acct, createUser, currentUser, getLogin, getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { saveBrands } from "@/lib/brands";
import { saveConnection } from "@/lib/connectors/store";
import { writeFile } from "@/lib/files";
import { createConversation } from "@/lib/conversations";
import { createMcpToken } from "@/lib/mcp";
import { consentOf, signupConsent } from "@/lib/consent";
import { LEGAL, PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal";
import { HELP, helpTopics } from "@/lib/help";
import { can } from "@/lib/roles";
import { dict } from "@/lib/i18n";
import { AGENT_PAGES, SITE } from "@/lib/site";
import { TOOLS } from "@/lib/tools";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { COMPARE_PAGE } from "@/lib/pages-compare";
import { listPosts } from "@/lib/blog";
import { SITE_DEFAULT } from "@/lib/page-meta";
import { ACCOUNT_EXPORTS_PER_DAY, ACCOUNT_EXPORTS_PER_HOUR, EXPORT_FORMAT, SECRETISH, connectionView, type AccountExport } from "@/lib/privacy-export";
import * as exportRoute from "@/app/api/account/export/route";
import * as signupRoute from "@/app/api/auth/signup/route";

/**
 * Rules 1320-1330: the privacy duties in code (360 study C-002, D-005, E-014; leftovers L045, L099). The owner downloads
 * the account's own data, signup records which terms and privacy versions were agreed to, and the privacy and help text
 * name the processors the code actually uses. docs/system/tests/1320-privacy-in-code.md lists them.
 */

const SECRET_TOKEN = "xoxb-secret-access-token-value";
const SECRET_KEY = "sk_live_should_never_leave";
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

const download = async (): Promise<{ res: Response; body: AccountExport }> => {
  const res = await exportRoute.GET();
  expect(res.status).toBe(200);
  return { res, body: JSON.parse(await res.clone().text()) as AccountExport };
};

/** An owner with a brand, an added brand, tasks past the inbox's 200, a file, a conversation and a connection. */
async function seededOwner(prefix: string, fx: Fixture = {}): Promise<User> {
  const u = await newUser(prefix, fx);
  const e = acct(u);
  await saveBrands(e, [{ id: "default", name: "Main", createdAt: "2026-10-01T00:00:00.000Z", status: "active" }, { id: "b2", name: "Second", createdAt: "2026-10-02T00:00:00.000Z", status: "active" }]);
  await db.set(`brand:${e}`, { name: `brand-of-${prefix}`, website: "https://example.test" });
  await db.set(`brand:${e}#b2`, { name: `second-of-${prefix}` });
  // 205 tasks: the export reads every one, not the inbox's newest 200.
  const ids = Array.from({ length: 205 }, (_, i) => `t${i}`);
  await Promise.all(ids.map((id) => db.set(`task:${e}:${id}`, { id, type: "social", channel: "x", title: `title-${prefix}-${id}`, body: "b", status: "approved", createdAt: "2026-10-03T00:00:00.000Z", lang: "ar" })));
  await Promise.all(ids.map((id) => db.lpush(`tasks:${e}`, id)));
  await db.set(`task:${e}#b2:s1`, { id: "s1", type: "social", channel: "x", title: `second-task-${prefix}`, body: "b", status: "pending", createdAt: "2026-10-03T00:00:00.000Z", lang: "en" });
  await db.lpush(`tasks:${e}#b2`, "s1");
  await writeFile(e, "notes.md", `file-of-${prefix}`, "user");
  const c = await createConversation(e, `conv-of-${prefix}`);
  await db.lpush(`chat:${e}:${c.id}`, JSON.stringify({ role: "user", content: `hello-${prefix}`, at: "2026-10-04T00:00:00.000Z" }));
  await db.lpush(`chat:${e}:${c.id}`, JSON.stringify({ role: "assistant", content: `reply-${prefix}`, at: "2026-10-04T00:00:01.000Z", agent: "noor" }));
  await saveConnection(e, { provider: "telegram", data: { token: SECRET_TOKEN, apiKey: SECRET_KEY }, meta: { account: `@chan-${prefix}`, accessToken: SECRET_TOKEN, apiKey: SECRET_KEY }, connectedAt: "2026-10-05T00:00:00.000Z" });
  return u;
}

describe("rule 1320: the export is the owner's, never a member's or a founder's, and needs a session", () => {
  it("401 signed out; 403 for an admin, a member and a founder viewing the account; 200 for the owner", async () => {
    signOut();
    expect((await exportRoute.GET()).status).toBe(401);
    const u = await newUser("px-gate");
    for (const role of ["admin", "member"] as const) {
      const m = await newMember(u, role);
      await signIn(m.email);
      expect((await exportRoute.GET()).status, role).toBe(403);
    }
    await signIn(u.email, { imp: "founder@test.example" });
    expect(can(await currentUser(), "account.export")).toBe(false);
    expect((await exportRoute.GET()).status).toBe(403);
    await signIn(u.email);
    expect((await exportRoute.GET()).status).toBe(200);
  });
});

describe("rule 1321: only the signed-in account's data, whatever another account holds", () => {
  it("two owners each get their own brands, tasks, files, chats and connections and nothing of the other", async () => {
    const a = await seededOwner("pxa");
    const b = await seededOwner("pxb");
    await signIn(b.email);
    const { body } = await download();
    const text = JSON.stringify(body);
    expect(body.account.email).toBe(b.email);
    for (const s of ["brand-of-pxb", "second-of-pxb", "title-pxb-t0", "file-of-pxb", "hello-pxb", "@chan-pxb"]) expect(text, s).toContain(s);
    for (const s of ["-pxa", a.email, acct(a)]) expect(text, s).not.toContain(s);
    // The handler takes no request at all: there is nothing to read a scope, email or id from.
    expect(exportRoute.GET.length).toBe(0);
  });

  it("the active brand is the session's scope (sc(u)), and every brand of the account is exported under its own scope", async () => {
    const u = await seededOwner("pxsc");
    await seedActiveBrand(u.email, "b2");
    await signIn(u.email);
    const { body } = await download();
    expect(body.brands.map((b) => [b.id, b.active])).toEqual([["default", false], ["b2", true]]);
    expect(body.brands[1].tasks.map((t) => t.title)).toEqual(["second-task-pxsc"]);
    expect(body.brands[1].profile?.name).toBe("second-of-pxsc");
  });
});

describe("rule 1322: no password, token or secret leaves in the export", () => {
  it("no hash, no connection credential, no MCP token; credential-like meta keys dropped", async () => {
    const u = await seededOwner("pxsec");
    const token = await createMcpToken(acct(u));
    await signIn(u.email);
    const { body } = await download();
    const text = JSON.stringify(body);
    const stored = (await getUser(acct(u)))!;
    for (const s of [stored.passHash, SECRET_TOKEN, SECRET_KEY, token, '"enc"', "passHash", "sessionsAfter"]) expect(text, s).not.toContain(s);
    expect(body.brands[0].connections).toEqual([{ provider: "telegram", connectedAt: "2026-10-05T00:00:00.000Z", details: { account: "@chan-pxsec" } }]);
  });

  it("the meta filter drops every key that looks like a credential and keeps display data", () => {
    for (const k of ["token", "accessToken", "refresh_token", "apiKey", "api_key", "clientSecret", "password", "privateKey", "credentials", "enc", "sessionCookie"]) expect(SECRETISH.test(k), k).toBe(true);
    for (const k of ["account", "shop", "site", "pageName", "via", "liOrg", "gaProperty", "storeId"]) expect(SECRETISH.test(k), k).toBe(false);
    expect(connectionView({ provider: "x", connectedAt: "t", enc: "iv.tag.data", meta: { account: "@me", accessToken: "t0k" }, needsReconnect: "401" })).toEqual({ provider: "x", connectedAt: "t", needsReconnect: true, details: { account: "@me" } });
  });
});

describe("rule 1323: the export is rate limited per account", () => {
  it(`${ACCOUNT_EXPORTS_PER_HOUR} an hour and ${ACCOUNT_EXPORTS_PER_DAY} a day, then 429 slow_down with Retry-After`, async () => {
    const u = await newUser("px-rate");
    await signIn(u.email);
    for (let i = 0; i < ACCOUNT_EXPORTS_PER_HOUR; i++) expect((await exportRoute.GET()).status).toBe(200);
    const slow = await exportRoute.GET();
    expect([slow.status, ((await slow.json()) as { error: string }).error, slow.headers.get("retry-after")]).toEqual([429, "slow_down", "3600"]);
    await db.del(`rate:accountexport:h:${u.email}`);
    await db.set(`rate:accountexport:d:${u.email}`, ACCOUNT_EXPORTS_PER_DAY);
    expect((await exportRoute.GET()).status).toBe(429);
    expect(ACCOUNT_EXPORTS_PER_HOUR).toBe(3);
  });

  it("the route calls allow() from src/lib/rate.ts before reading anything", () => {
    const src = readFileSync("src/app/api/account/export/route.ts", "utf8");
    expect(src).toMatch(/from "@\/lib\/rate"/);
    expect(src.indexOf("allow(")).toBeLessThan(src.indexOf("buildExport(u)"));
  });
});

describe("rule 1324: what the export holds, read without a command per record", () => {
  it("account, consent, plan and credits, every task past 200, files, conversations with messages, connections", async () => {
    const u = await seededOwner("pxall");
    await signIn(u.email);
    const { res, body } = await download();
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="thakeen-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.format).toBe(EXPORT_FORMAT);
    expect(body.account).toMatchObject({ email: u.email, name: "Test", lang: "ar" });
    expect(body.plan).toMatchObject({ plan: "trial", credits: u.credits, trialEnds: u.trialEnds });
    expect(body.consent).toMatchObject({ recorded: true, terms: TERMS_VERSION, privacy: PRIVACY_VERSION });
    const main = body.brands[0];
    expect(main.tasks).toHaveLength(205);
    expect(main.files.map((f) => [f.name, f.content])).toEqual([["notes.md", "file-of-pxall"]]);
    expect(main.conversations).toHaveLength(1);
    expect(main.conversations[0].messages).toEqual([
      { role: "user", content: "hello-pxall", at: "2026-10-04T00:00:00.000Z" },
      { role: "assistant", content: "reply-pxall", at: "2026-10-04T00:00:01.000Z", agent: "noor" },
    ]);
  });

  it("the builder never awaits the store inside a loop (Upstash is HTTP per command)", () => {
    const src = readFileSync("src/lib/privacy-export.ts", "utf8");
    expect(src).not.toMatch(/for\s*\([^)]*\)\s*\{?[^}]*await db\./);
    expect(src).not.toMatch(/\.forEach\([^)]*async/);
    expect(src).toMatch(/db\.mget/);
  });
});

describe("rules 1325-1326: the consent record at signup, and accounts that have none (expand)", () => {
  it("signup stores the terms and privacy versions in code, the time and the language", async () => {
    const email = `px-signup-${Date.now()}@test.example`;
    const before = Date.now();
    const res = await signupRoute.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "N", lang: "en" }, { "x-forwarded-for": ip() }));
    expect(res.status).toBe(200);
    const u = (await accountByLogin(email))!;
    expect(u.consent).toMatchObject({ terms: TERMS_VERSION, privacy: PRIVACY_VERSION, lang: "en", via: "signup_notice" });
    expect(new Date(u.consent!.at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(consentOf(u)).toMatchObject({ recorded: true, terms: TERMS_VERSION, privacy: PRIVACY_VERSION });
  });

  it("the request cannot choose the versions or the time", async () => {
    const email = `px-signup-forge-${Date.now()}@test.example`;
    await signupRoute.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "N", consent: { terms: "1999-01-01", privacy: "1999-01-01", at: "1999-01-01T00:00:00.000Z" }, termsVersion: "1999-01-01" }, { "x-forwarded-for": ip() }));
    const u = (await accountByLogin(email))!;
    expect(u.consent?.terms).toBe(TERMS_VERSION);
    expect(JSON.stringify(u.consent)).not.toContain("1999");
  });

  it("the versions are each document's own last-updated day", () => {
    expect(LEGAL.en.privacy.updated).toBe(`Last updated: ${PRIVACY_VERSION}`);
    expect(LEGAL.en.terms.updated).toBe(`Last updated: ${TERMS_VERSION}`);
    expect(LEGAL.ar.privacy.updated).toBe(`آخر تحديث: ${PRIVACY_VERSION}`);
    expect(signupConsent("ar", new Date("2026-10-12T08:00:00.000Z"))).toEqual({ terms: TERMS_VERSION, privacy: PRIVACY_VERSION, at: "2026-10-12T08:00:00.000Z", lang: "ar", via: "signup_notice" });
  });

  it("an account written before the record existed reads as not recorded, and exports without a made-up date", async () => {
    const u = await createUser({ email: `px-old-${Date.now()}@test.example`, name: "Old", phone: "", password: "abc12345", lang: "ar" });
    const stored = (await getUser(acct(u)))!;
    delete stored.consent; // the old shape: no field at all
    stored.emailVerifiedAt = new Date().toISOString();
    await saveUser(stored);
    const old = (await getUser(acct(u)))!;
    expect(old.consent).toBeUndefined();
    expect(consentOf(old)).toEqual({ recorded: false, note: expect.stringContaining("created before consent was recorded") });
    expect(consentOf({ consent: { terms: 1 } as never })).toMatchObject({ recorded: false });
    await signIn(u.email);
    const { body } = await download();
    expect(body.consent).toMatchObject({ recorded: false });
    expect(JSON.stringify(body.consent)).not.toContain(old.createdAt);
  });

  it("a record with the field keeps it through an unrelated save", async () => {
    const fresh = await newUser("px-keep");
    const kept = (await getUser(acct(fresh)))!;
    kept.name = "Renamed";
    await saveUser(kept);
    expect((await getUser(acct(fresh)))!.consent).toEqual(fresh.consent);
  });
});

/** Every string of a copy module, flattened. */
const strings = (v: unknown, out: string[] = [], seen = new Set<object>()): string[] => {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object" && !seen.has(v)) { seen.add(v); Object.values(v).forEach((x) => strings(x, out, seen)); }
  return out;
};
const privacy = (lang: "ar" | "en") => LEGAL[lang].privacy.sections.flatMap((s) => s.p).join(" ");
const helpAnswer = (en: string) => {
  const item = HELP.flatMap((t) => t.items).find((i) => i.q.en === en);
  if (!item) throw new Error(`no help answer for "${en}"`);
  return item.a;
};
/** The services the code calls (docs/system/variables.md), as the privacy text names them. */
const PROCESSORS = ["Hostinger", "Upstash", "Anthropic", "Straitly", "fal.ai", "kie.ai", "Higgsfield", "Vercel Blob", "Resend", "Composio", "Cloudflare Turnstile", "Paymob"];

describe("rule 1327: the privacy text names the processors the code uses, in both languages", () => {
  it("every processor, Straitly as off by default, and Vercel only as the media storage", () => {
    for (const lang of ["ar", "en"] as const) {
      const p = privacy(lang);
      for (const name of PROCESSORS) expect(p, `${lang}: ${name}`).toContain(name);
      // The app is no longer hosted on Vercel (rules 987-990): the name stays only for the Blob media store.
      expect(p.replace(/Vercel Blob/g, ""), lang).not.toContain("Vercel");
    }
    expect(privacy("en")).toContain("the Straitly gateway may carry text-model requests to the text provider (it is off by default and used only if we switch it on)");
    expect(privacy("ar")).toContain("بوابة Straitly قد تنقل طلبات نماذج النصوص إلى مزوّد النصوص (موقفة افتراضياً ولا تُستخدم إلا إن شغّلناها)");
  });

  it("the code still wires each named service (an env name in docs/system/variables.md)", () => {
    const vars = readFileSync("docs/system/variables.md", "utf8");
    for (const env of ["KV_REST_API_URL", "ANTHROPIC_API_KEY", "STRAITLY_API_KEY", "FAL_KEY", "KIE_API_KEY", "HIGGSFIELD_API_KEY_ID", "BLOB_READ_WRITE_TOKEN", "RESEND_API_KEY", "COMPOSIO_API_KEY", "TURNSTILE_SECRET_KEY", "PAYMOB_SECRET_KEY"]) expect(vars, env).toContain(`\`${env}\``);
    expect(readFileSync("docs/system/architecture.md", "utf8")).toContain("deployed on Hostinger");
  });
});

describe("rule 1328: the privacy and help text point at the self-serve export; vendor names stay out of marketing copy", () => {
  it("the retention section and the help answers name the download, in both languages", () => {
    expect(privacy("en")).toContain("You can download a copy of your data yourself from Settings, Danger zone (“Download my data”)");
    expect(privacy("ar")).toContain("يمكنك تنزيل نسخة من بياناتك بنفسك من «الإعدادات» ثم «منطقة الخطر» (زر «نزّل بياناتي»)");
    for (const lang of ["ar", "en"] as const) expect(privacy(lang)).not.toMatch(/To request an export|لطلب تصدير بياناتك/);
    expect(helpAnswer("How do I get a copy of my data?").en).toContain(`${ACCOUNT_EXPORTS_PER_HOUR} times an hour`);
    expect(helpAnswer("How do I get a copy of my data?").ar).toContain(`${ACCOUNT_EXPORTS_PER_HOUR} مرات في الساعة`);
    // The help names no model maker (rule 514): the text provider is named in the privacy policy only, which the answer points to.
    for (const lang of ["ar", "en"] as const) for (const name of PROCESSORS.filter((n) => n !== "Anthropic")) expect(helpAnswer("Who processes my data?")[lang], `${lang}: ${name}`).toContain(name);
    expect(helpAnswer("Who processes my data?").en).toContain("The privacy policy has the full list.");
    expect(helpAnswer("Who processes my data?").ar).toContain("القائمة كاملة في سياسة الخصوصية.");
  });

  it("the privacy text says the consent is recorded, in both languages", () => {
    expect(privacy("en")).toContain("When you sign up we record which version of the terms of service and of this privacy policy you were shown, and when you agreed.");
    expect(privacy("ar")).toContain("عند التسجيل نحفظ إصدار شروط الاستخدام وسياسة الخصوصية المعروضين عليك ووقت موافقتك.");
  });

  it("no infrastructure vendor is named in the marketing site's copy (founder default: privacy and help only)", () => {
    const copy = strings([dict, SITE, SITE_DEFAULT, AGENT_PAGES, INDUSTRY_PAGES, COMPARE_PAGE, TOOLS, listPosts("ar"), listPosts("en")]).join("\n");
    for (const name of ["Hostinger", "Upstash", "Straitly", "Composio", "Higgsfield", "kie.ai", "Vercel", "Resend"]) expect(copy, name).not.toContain(name);
  });
});

describe("rule 1328: the chat prompt keeps its size; the delete answer it carries names the download", () => {
  it("the two new answers stay out of the chat prompt, which still learns of the download from the delete answer", () => {
    const flagged = HELP.flatMap((t) => t.items).filter((i) => i.chat === false).map((i) => i.q.en).sort();
    // The cloud drives answer (2026-10-13, rule 1789) is help-page only too: the chat prompt has no room for it (rule 313).
    // The two-step and devices answer (2026-10-18, rule 2148) is help-page only for the same reason.
    expect(flagged).toEqual(["How do I add images and files from my device, Google Drive, Dropbox, OneDrive or iCloud?", "How do I get a copy of my data?", "How do I turn on two-step sign-in and see my devices?", "Who processes my data?"]);
    // helpTopics keeps the flag, and the chat prompt drops flagged items (src/lib/chat-prompt.ts).
    expect(helpTopics("https://x.example").flatMap((t) => t.items).filter((i) => i.chat === false)).toHaveLength(4);
    expect(readFileSync("src/lib/chat-prompt.ts", "utf8")).toContain("t.items.filter((i) => i.chat !== false).map((i) => `- ${i.q.en} → ${i.a.en}`)");
    expect(helpAnswer("How do I delete my account?").en).toContain("In Settings, Danger zone: “Download my data” gives you a copy");
  });
});

describe("rule 1329: Settings, Danger zone offers the download to the owner only", () => {
  it("a link to the route for an owner who may export, a note for a founder, nothing for a member, in both languages", () => {
    const src = readFileSync("src/components/app/settings/DangerZone.tsx", "utf8");
    expect(src).toContain('href="/api/account/export" download');
    expect(src).toMatch(/\{owner && \(\s*<SettingsCard title=\{T\.exp\}/);
    expect(src).toMatch(/impersonating \|\| !canExport \? \(\s*<ReadOnlyNote className="" text=\{T\.expFounder\}/);
    for (const s of ["نزّل بياناتي", "Download my data", "Downloading the data is off while you view the account as the founder."]) expect(src).toContain(s);
    expect(src).not.toContain("There is no self-serve export");
    expect(readFileSync("src/app/[lang]/app/settings/danger/page.tsx", "utf8")).toContain('canExport={can(u, "account.export")}');
  });
});

describe("rule 1330: the export route is documented where routes and permissions are", () => {
  it("flows.md and permissions.md name GET /api/account/export and account.export", () => {
    expect(readFileSync("docs/system/flows.md", "utf8")).toContain("GET /api/account/export");
    const perms = readFileSync("docs/system/permissions.md", "utf8");
    expect(perms).toContain("GET /api/account/export");
    expect(perms).toContain("account.export");
  });
});
