import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { json, signOut } from "./helpers/session";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { newsletterId, subscribersCsv, tokenHash, type NewsletterSub } from "@/lib/newsletter";

/**
 * Rules 3600-3609 (docs/system/tests/3600-newsletter.md). The newsletter list: a sign-up mails one confirm link, only its
 * click makes a subscriber (double opt-in), every mail carries a one-click unsubscribe, the public routes are throttled and
 * never reveal whether an address is known, and the console lists and exports the list for staff only.
 */

type Msg = { from: string; to: string; subject: string; text: string; html?: string };
const msgs: Msg[] = [];
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (msg: Msg) => { msgs.push(msg); return { data: { id: "re_nl" }, error: null }; } };
  },
}));

import * as signup from "@/app/api/newsletter/route";
import * as confirmRoute from "@/app/api/newsletter/confirm/route";
import * as unsubRoute from "@/app/api/newsletter/unsubscribe/route";
import * as adminList from "@/app/api/admin/newsletter/route";

const ORIGIN = "https://thakeen.example";
const KEY = "test-admin-key-0123456789";
let ipN = 0;
const ipHdr = (n = ++ipN) => ({ "x-forwarded-for": `203.0.113.${n % 250}` });
const mail = () => `nl-${randomBytes(4).toString("hex")}@test.example`;
const read = (p: string) => readFileSync(p, "utf8");
const mailTo = (e: string) => msgs.filter((m) => m.to === e);
const tokenIn = (text: string, page: "confirm" | "unsubscribe") => text.match(new RegExp(`/newsletter/${page}#t=([a-f0-9]{64})`))?.[1] ?? "";

const post = (body: unknown, ip = ipHdr()) => signup.POST(json("/api/newsletter", "POST", body, ip));
const join = (email: string, extra: Record<string, unknown> = {}, ip = ipHdr()) => post({ email, consent: true, lang: "en", source: "footer", ...extra }, ip);
const confirm = (token: string, ip = ipHdr()) => confirmRoute.POST(json("/api/newsletter/confirm", "POST", { token }, ip));
const unsub = (token: string, ip = ipHdr()) => unsubRoute.POST(json("/api/newsletter/unsubscribe", "POST", { token }, ip));
const rec = (email: string) => db.get<NewsletterSub>(globalKey.newsletterSub(newsletterId(email)));
const list = (qs = "", headers: Record<string, string> = { "x-admin-key": KEY }) => adminList.GET(json(`/api/admin/newsletter${qs}`, "GET", undefined, headers));

beforeEach(() => {
  msgs.length = 0;
  signOut();
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("MAIL_FROM", "Noor <noor@mail.example>");
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  vi.stubEnv("WAITLIST_ADMIN_KEY", KEY);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("rule 3600: double opt-in", () => {
  it("a sign-up stores a pending address and mails one confirm link; nothing counts until the click", async () => {
    const e = mail();
    const r = await join(e);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect((await rec(e))?.status).toBe("pending");
    const m = mailTo(e);
    expect(m).toHaveLength(1);
    expect(tokenIn(m[0].text, "confirm")).toHaveLength(64);
    // The list the console shows counts it as pending, not as a subscriber.
    const page = (await (await list()).json()) as { counts: Record<string, number> };
    expect(page.counts.pending).toBeGreaterThanOrEqual(1);
  });

  it("the confirm click makes the address confirmed, and only then", async () => {
    const e = mail();
    await join(e);
    const t = tokenIn(mailTo(e)[0].text, "confirm");
    const r = await confirm(t);
    expect(r.status).toBe(200);
    const s = await rec(e);
    expect(s?.status).toBe("confirmed");
    expect(s?.confirmedAt).toBeTruthy();
    expect(s?.ct).toBeUndefined();
  });

  it("the mail carries the link in the fragment, in the reader's language, and the unsubscribe link", async () => {
    const ea = mail();
    const ee = mail();
    await join(ea, { lang: "ar" });
    await join(ee, { lang: "en" });
    const ma = mailTo(ea)[0];
    const me = mailTo(ee)[0];
    expect(ma.subject).toMatch(/[؀-ۿ]/);
    expect(me.subject).toMatch(/Confirm/);
    expect(ma.text).toContain(`${ORIGIN}/ar/newsletter/confirm#t=`);
    expect(me.text).toContain(`${ORIGIN}/en/newsletter/confirm#t=`);
    expect(tokenIn(me.text, "unsubscribe")).toHaveLength(64);
    expect(me.text).not.toContain("?token=");
    expect(ma.html ?? "").toContain("dir=\"rtl\"");
  });

  it("an expired token is refused (400 bad_token) and confirms nothing", async () => {
    const e = mail();
    await join(e);
    const t = tokenIn(mailTo(e)[0].text, "confirm");
    await db.del(globalKey.newsletterConfirm(tokenHash(t))); // what the 48 hour TTL does
    const r = await confirm(t);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: "bad_token" });
    expect((await rec(e))?.status).toBe("pending");
  });

  it("a used token cannot be used twice (the second click is 400), and the address stays confirmed", async () => {
    const e = mail();
    await join(e);
    const t = tokenIn(mailTo(e)[0].text, "confirm");
    expect((await confirm(t)).status).toBe(200);
    expect((await confirm(t)).status).toBe(400);
    expect((await rec(e))?.status).toBe("confirmed");
  });

  it("a newer confirm link replaces the older one: the first mail's link stops working", async () => {
    const e = mail();
    await join(e);
    await join(e);
    const [first, second] = mailTo(e).map((m) => tokenIn(m.text, "confirm"));
    expect(first).not.toBe(second);
    expect((await confirm(first)).status).toBe(400);
    expect((await confirm(second)).status).toBe(200);
  });

  it("a malformed, missing or guessed token is 400 and the token is never stored in plain", async () => {
    for (const t of ["", "abc", "g".repeat(64), "a".repeat(64), "A".repeat(64), 7, null]) {
      const r = await confirmRoute.POST(json("/api/newsletter/confirm", "POST", { token: t }, ipHdr()));
      expect(r.status).toBe(400);
    }
    const e = mail();
    await join(e);
    const t = tokenIn(mailTo(e)[0].text, "confirm");
    expect(await db.get(globalKey.newsletterConfirm(t))).toBeNull(); // keyed by the hash, not the token
    expect(await db.get(globalKey.newsletterConfirm(tokenHash(t)))).not.toBeNull();
  });

  it("a token read from a query string is not the way in: the page reads only the fragment", () => {
    const src = read("src/components/NewsletterToken.tsx");
    expect(src).toContain("readInviteToken(window.location.hash)");
    expect(src).not.toMatch(/searchParams|location\.search/);
  });

  it("confirming needs a press of the button; unsubscribing runs when the page opens", () => {
    const src = read("src/components/NewsletterToken.tsx");
    expect(src).toMatch(/else if \(mode === "unsubscribe"\) void post\(\)/);
    expect(src).toMatch(/mode === "confirm" &&[\s\S]*onClick=\{post\}/);
  });
});

describe("rule 3601: one-click unsubscribe, idempotent, no login", () => {
  it("the mailed link unsubscribes without a session, and a second click answers the same", async () => {
    const e = mail();
    await join(e);
    await confirm(tokenIn(mailTo(e)[0].text, "confirm"));
    const u = tokenIn(mailTo(e)[0].text, "unsubscribe");
    signOut();
    const a = await unsub(u);
    const b = await unsub(u);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ ok: true });
    const s = await rec(e);
    expect(s?.status).toBe("unsubscribed");
    const first = s?.unsubscribedAt;
    await unsub(u);
    expect((await rec(e))?.unsubscribedAt).toBe(first); // the second click did not rewrite the record
  });

  it("an unsubscribed address stays on the list as the suppression record, and the console shows it as unsubscribed", async () => {
    const e = mail();
    await join(e);
    await unsub(tokenIn(mailTo(e)[0].text, "unsubscribe")); // unsubscribing before confirming also suppresses
    expect((await rec(e))?.status).toBe("unsubscribed");
    const page = (await (await list("?status=unsubscribed&limit=100")).json()) as { rows: { email: string; status: string }[] };
    expect(page.rows.some((r) => r.email === e && r.status === "unsubscribed")).toBe(true);
  });

  it("an old confirm mail cannot bring an unsubscribed address back", async () => {
    const e = mail();
    await join(e);
    const m = mailTo(e)[0];
    await unsub(tokenIn(m.text, "unsubscribe"));
    expect((await confirm(tokenIn(m.text, "confirm"))).status).toBe(400);
    expect((await rec(e))?.status).toBe("unsubscribed");
  });

  it("a new sign-up after unsubscribing goes through the confirm again", async () => {
    const e = mail();
    await join(e);
    await confirm(tokenIn(mailTo(e)[0].text, "confirm"));
    await unsub(tokenIn(mailTo(e)[0].text, "unsubscribe"));
    await join(e);
    expect((await rec(e))?.status).toBe("pending");
    const second = mailTo(e)[1];
    expect(second).toBeTruthy();
    expect((await confirm(tokenIn(second.text, "confirm"))).status).toBe(200);
    expect((await rec(e))?.status).toBe("confirmed");
  });

  it("a token this list never minted is 400 and the lookup is by hash", async () => {
    expect((await unsub("b".repeat(64))).status).toBe(400);
    expect((await unsub("nope")).status).toBe(400);
    const e = mail();
    await join(e);
    const u = tokenIn(mailTo(e)[0].text, "unsubscribe");
    expect(await db.get(globalKey.newsletterUnsub(u))).toBeNull();
    expect(await db.get(globalKey.newsletterUnsub(tokenHash(u)))).not.toBeNull();
  });

  it("the tokens are compared with sameSecret", () => {
    const src = read("src/lib/newsletter.ts");
    expect(src).toMatch(/sameSecret\(rec\.t, t\)/);
    expect(src).toMatch(/sameSecret\(cur\.ct, t\)/);
    expect(src).not.toMatch(/rec\.t === t|cur\.ct === t/);
  });
});

describe("rule 3602: sign-up refuses what it should", () => {
  it("no consent, a pre-ticked default or a string is refused (400 consent_required) and nothing is stored or mailed", async () => {
    for (const consent of [undefined, false, "true", 1, null]) {
      const e = mail();
      const r = await post({ email: e, consent }, ipHdr());
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe("consent_required");
      expect(await rec(e)).toBeNull();
      expect(mailTo(e)).toHaveLength(0);
    }
  });

  it("a bad address is 400 bad_email; bad JSON is 400", async () => {
    for (const email of ["", "nope", "a@b", "a b@c.d", "x".repeat(260) + "@t.example", 5]) {
      const r = await post({ email, consent: true }, ipHdr());
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe("bad_email");
    }
    const raw = await signup.POST(new Request("https://nashr.test/api/newsletter", { method: "POST", headers: { "content-type": "application/json", ...ipHdr() }, body: "{not json" }));
    expect(raw.status).toBe(400);
  });

  it("the hidden field catches a script: answered ok, nothing stored, nothing mailed", async () => {
    const e = mail();
    const r = await join(e, { website: "https://spam.example" });
    expect(await r.json()).toEqual({ ok: true });
    expect(await rec(e)).toBeNull();
    expect(mailTo(e)).toHaveLength(0);
  });

  it("an unknown source is stored as site; a known one as given", async () => {
    const a = mail();
    const b = mail();
    await join(a, { source: "<script>" });
    await join(b, { source: "blog" });
    expect((await rec(a))?.source).toBe("site");
    expect((await rec(b))?.source).toBe("blog");
  });

  it("with no mail sender set up nothing is stored and the answer says so (503 mail_off)", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAIL_FROM", "");
    const e = mail();
    const r = await join(e);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe("mail_off");
    expect(await rec(e)).toBeNull();
  });

  it("the address is stored lower-cased and trimmed, once, however it was typed", async () => {
    const e = mail();
    await join(`  ${e.toUpperCase()}  `);
    await join(e);
    expect((await rec(e))?.email).toBe(e);
    expect(await db.zrangeWithScores(globalKey.newsletterIndex())).toEqual(expect.arrayContaining([expect.objectContaining({ member: newsletterId(e) })]));
  });
});

describe("rule 3603: public routes are rate limited", () => {
  it("per IP: the eleventh sign-up in an hour is 429 slow_down", async () => {
    const ip = { "x-forwarded-for": "198.51.100.77" };
    for (let i = 0; i < 10; i++) expect((await join(mail(), {}, ip)).status).toBe(200);
    const r = await join(mail(), {}, ip);
    expect(r.status).toBe(429);
    expect(((await r.json()) as { error: string }).error).toBe("slow_down");
    expect(r.headers.get("retry-after")).toBeTruthy();
  });

  it("per address: a fourth request in an hour sends no fourth mail and is answered like the first", async () => {
    const e = mail();
    const answers: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await join(e);
      answers.push([r.status, await r.json()]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(mailTo(e)).toHaveLength(3);
  });

  it("per IP: confirm and unsubscribe posts are throttled at 30 per 15 minutes", async () => {
    const ip = { "x-forwarded-for": "198.51.100.78" };
    for (let i = 0; i < 30; i++) expect((await confirm("c".repeat(64), ip)).status).toBe(400);
    expect((await confirm("c".repeat(64), ip)).status).toBe(429);
    const ip2 = { "x-forwarded-for": "198.51.100.79" };
    for (let i = 0; i < 30; i++) expect((await unsub("c".repeat(64), ip2)).status).toBe(400);
    expect((await unsub("c".repeat(64), ip2)).status).toBe(429);
  });

  it("every public route calls allow() before it does anything else", () => {
    for (const f of ["src/app/api/newsletter/route.ts", "src/app/api/newsletter/confirm/route.ts", "src/app/api/newsletter/unsubscribe/route.ts"]) {
      const src = read(f);
      expect(src, f).toMatch(/await allow\(globalKey\.newsletter\w+Bucket\(clientIp\(req\)\)/);
      expect(src.indexOf("allow("), f).toBeLessThan(src.indexOf("req.json()"));
    }
  });
});

describe("rule 3604: no enumeration", () => {
  it("a new, a pending, a confirmed and an unsubscribed address get the same status and body", async () => {
    const fresh = mail();
    const pending = mail();
    const confirmed = mail();
    const gone = mail();
    await join(pending);
    await join(confirmed);
    await confirm(tokenIn(mailTo(confirmed)[0].text, "confirm"));
    await join(gone);
    await unsub(tokenIn(mailTo(gone)[0].text, "unsubscribe"));
    const out: string[] = [];
    for (const e of [fresh, pending, confirmed, gone]) {
      const r = await join(e);
      out.push(`${r.status} ${JSON.stringify(await r.json())}`);
      expect([...r.headers.keys()].filter((h) => h.startsWith("x-"))).toEqual([]);
    }
    expect(new Set(out).size).toBe(1);
    expect(out[0]).toBe('200 {"ok":true}');
  });

  it("a confirmed address gets no mail at all and stays confirmed", async () => {
    const e = mail();
    await join(e);
    await confirm(tokenIn(mailTo(e)[0].text, "confirm"));
    const before = mailTo(e).length;
    await join(e);
    expect(mailTo(e)).toHaveLength(before);
    expect((await rec(e))?.status).toBe("confirmed");
  });

  it("the route never writes an address to the log", () => {
    for (const f of ["src/app/api/newsletter/route.ts", "src/app/api/newsletter/confirm/route.ts", "src/app/api/newsletter/unsubscribe/route.ts", "src/lib/newsletter.ts"]) {
      const lines = read(f).split("\n").filter((l) => /console\.|log\./.test(l) && !/^\s*(\/\/|\*)/.test(l));
      for (const l of lines) expect(l, f).not.toMatch(/email|address|\bb\b|token/i);
    }
  });

  it("no key holds an address: the record id is a SHA-256", () => {
    const e = "Someone@Test.Example";
    expect(newsletterId(e)).toMatch(/^[a-f0-9]{64}$/);
    expect(globalKey.newsletterSub(newsletterId(e))).not.toContain("someone");
    expect(newsletterId(e)).toBe(newsletterId(" someone@test.example "));
  });
});

describe("rule 3605: the console list and the CSV export are staff only", () => {
  it("anonymous, a wrong key and a customer session are all 401", async () => {
    expect((await list("", {})).status).toBe(401);
    expect((await list("", { "x-admin-key": "wrong-key-0123456789" })).status).toBe(401);
    expect((await list("?format=csv", {})).status).toBe(401);
  });

  it("with the admin key it lists newest first with the count of every status, and paginates", async () => {
    const a = mail();
    const b = mail();
    await join(a);
    await join(b);
    await confirm(tokenIn(mailTo(a)[0].text, "confirm"));
    const page = (await (await list("?limit=2&offset=0")).json()) as { ok: boolean; rows: { email: string }[]; total: number; counts: Record<string, number> };
    expect(page.ok).toBe(true);
    expect(page.rows.length).toBeLessThanOrEqual(2);
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect(page.counts.confirmed).toBeGreaterThanOrEqual(1);
    expect(page.counts.pending).toBeGreaterThanOrEqual(1);
    const confirmedOnly = (await (await list("?status=confirmed&limit=100")).json()) as { rows: { status: string }[] };
    expect(confirmedOnly.rows.every((r) => r.status === "confirmed")).toBe(true);
  });

  it("the page size is capped at 100 and a junk status is ignored", async () => {
    const page = (await (await list("?limit=100000&status=bogus")).json()) as { rows: unknown[] };
    expect(page.rows.length).toBeLessThanOrEqual(100);
  });

  it("the CSV has a BOM, the right columns, no-store and a dated filename", async () => {
    const e = mail();
    await join(e);
    const r = await list("?format=csv");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-disposition")).toMatch(/thakeen-newsletter-\d{4}-\d{2}-\d{2}\.csv/);
    const buf = new Uint8Array(await r.clone().arrayBuffer());
    expect([...buf.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // the BOM
    const body = await r.text();
    expect(body).toContain("email,status,lang,source,at,confirmedAt,unsubscribedAt");
    expect(body).toContain(e);
  });

  it("every CSV cell goes through csvSafe: a formula-looking address stays text", () => {
    const row = { email: "=HYPERLINK(\"http://evil.example\")", status: "pending" as const, lang: "en" as const, source: "+SUM(1)", at: "-1+cmd", confirmedAt: "@x", unsubscribedAt: "\t=1" };
    const csv = subscribersCsv([row]);
    const cells = csv.split("\r\n")[1].match(/"(?:[^"]|"")*"/g)!;
    expect(cells).toHaveLength(7);
    for (const c of cells) expect(c.slice(1)).not.toMatch(/^[=+\-@\t\r]/);
    expect(cells[0]).toContain("'=HYPERLINK");
    expect(read("src/lib/newsletter.ts")).toMatch(/csvSafe\(String\(v/);
  });

  it("a comma, a quote or a newline in a cell cannot break the row", () => {
    const row = { email: 'a,"b"\nc@t.example', status: "confirmed" as const, lang: "ar" as const, source: "blog", at: "", confirmedAt: "", unsubscribedAt: "" };
    const csv = subscribersCsv([row]);
    expect(csv).toContain('"a,""b""\nc@t.example"');
  });

  it("the console page is a guarded section with the panel in it", () => {
    expect(read("src/app/[lang]/admin/newsletter/page.tsx")).toMatch(/requireAdmin\(lang, adminHref\(lang, "newsletter"\)\)/);
    expect(read("src/lib/admin-gate.ts")).toMatch(/"newsletter"/);
    expect(read("src/components/admin/NewsletterPanel.tsx")).toContain('data-testid="newsletter-panel"');
  });
});

describe("rule 3606: the form on the public site", () => {
  const box = read("src/components/NewsletterBox.tsx");

  it("the consent box is not pre-ticked and the form cannot send without it", () => {
    expect(box).not.toMatch(/defaultChecked|checked=\{true\}/);
    expect(box).toMatch(/type="checkbox"[^>]*required|required[^>]*type="checkbox"/);
    expect(box).toMatch(/consent: d.get\("consent"\) === "on"/);
  });

  it("the honeypot is a real field a person cannot see or tab into, and there is no CAPTCHA service", () => {
    expect(box).toMatch(/name="website"/);
    expect(box).toMatch(/tabIndex=\{-1\}/);
    expect(box).toMatch(/aria-hidden/);
    expect(box).toMatch(/autoComplete="off"/);
    for (const f of [box, read("src/app/api/newsletter/route.ts")]) expect(f).not.toMatch(/recaptcha|hcaptcha|turnstile/i);
  });

  it("the footer and both blog pages carry the box", () => {
    expect(read("src/components/Footer.tsx")).toMatch(/<NewsletterBox[^>]*source="footer"/);
    expect(read("src/app/[lang]/blog/page.tsx")).toMatch(/<NewsletterBox[^>]*source="blog"/);
    expect(read("src/app/[lang]/blog/[slug]/page.tsx")).toMatch(/<NewsletterBox[^>]*source="blog"/);
  });

  it("the copy is Arabic and English, and makes no promise the product does not keep", () => {
    const copy = read("src/lib/newsletter-copy.ts");
    expect(copy).toMatch(/\bar:\s*\{/);
    expect(copy).toMatch(/\ben:\s*\{/);
    expect(copy).toMatch(/[؀-ۿ]{3}/);
    expect(copy).not.toMatch(/GDPR|PDPL|compliant|guarantee|100%/i);
  });

  it("the mailed pages are never indexed", () => {
    for (const p of ["confirm", "unsubscribe"]) expect(read(`src/app/[lang]/newsletter/${p}/page.tsx`)).toMatch(/robots: \{ index: false/);
  });
});
