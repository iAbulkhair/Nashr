import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { json, newUser, params, signIn, signOut } from "./helpers/session";
import { getUser, saveUser, type User } from "@/lib/auth";
import { saveBrand, type Brand } from "@/lib/brand";
import { db } from "@/lib/db";
import { appOrigin } from "@/lib/origin";
import { EMAIL_TEMPLATES, COPY, notice, paragraphs, resetPassword, teamInvite } from "@/emails";
import { esc, fillHtml, html, plain, raw } from "@/emails/html";
import { COLORS, FONT } from "@/emails/tokens";
import { renderSamples } from "@/emails/samples";
import { SEC_KEYS, newSecId, newSeriesId } from "@/lib/secretary";
import type { SecItem } from "@/lib/secretary-agenda";

/**
 * Rules 685-689 (docs/superpowers/specs/2026-10-08-supastarter-adoption-design.md §1). Email goes out as text and HTML:
 * the HTML is built by src/emails/ (one layout, one button, one module per template) with a tagged template that escapes
 * every value, carries the reader's language and direction on the document and on every table and cell (Gmail drops
 * them from <html> and <body>), and links only into the app. The callers keep their subject and text word for word.
 */

type Msg = { from: string; to: string; subject: string; text: string; html?: string };
const msgs: Msg[] = [];
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (msg: Msg) => { msgs.push(msg); return { data: { id: "re_html" }, error: null }; } };
  },
}));

import * as forgot from "@/app/api/auth/forgot/route";
import * as invite from "@/app/api/team/invite/route";
import * as listRoute from "@/app/api/secretary/route";
import * as itemRoute from "@/app/api/secretary/[id]/route";
import { lifecycleHtml, lifecycleTemplate, runLifecycle } from "@/lib/lifecycle";
import { sweepReminders } from "@/lib/secretary-remind";
import { warnSeries } from "@/lib/secretary-series";
import { eveningWrap } from "@/lib/secretary-evening";

const ORIGIN = "https://thakeen.example";
let ipN = 0;
const ip = () => ({ "x-real-ip": `198.51.100.${++ipN % 250}`, "x-forwarded-host": "evil.example", host: "evil.example" });
const freshEmail = (p = "inv") => `${p}-${randomBytes(4).toString("hex")}@test.example`;
const BRAND: Brand = { name: "Rif", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-10-08" };
const mailTo = (email: string) => msgs.filter((m) => m.to === email);
const withLang = async (u: User, lang: "ar" | "en") => { const x = { ...(await getUser(u.email))!, lang }; await saveUser(x); return x; };
/** What runLifecycle hands lifecycleTemplate: counts from the workspace and the trial's end as a date. */
const CTX: Parameters<typeof lifecycleTemplate>[2] = { pending: 2, approved: 3, trialEnds: "2026-10-12" };

beforeEach(() => {
  msgs.length = 0;
  signOut();
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("MAIL_FROM", "Noor <noor@mail.example>");
  vi.stubEnv("APP_ORIGIN", ORIGIN);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

const FLOW = { ar: { dir: "rtl", align: "right" }, en: { dir: "ltr", align: "left" } } as const;

/**
 * The document and every table, cell, heading and paragraph in it carry `lang` and read in its direction (rule 685).
 * Gmail drops <html> and <body>, so the language must be written on the elements it keeps, or a screen reader reads an
 * Arabic email in the voice of Gmail's own interface language.
 */
function expectFlow(doc: string, lang: "ar" | "en") {
  const { dir, align } = FLOW[lang];
  expect(doc.startsWith("<!doctype html>\n"), "a full document").toBe(true);
  expect(doc).toContain(`<html lang="${lang}" dir="${dir}">`);
  expect(doc).toMatch(new RegExp(`<body lang="${lang}" dir="${dir}" style="[^"]*direction:${dir};`));
  expect(doc).toContain('<meta charset="utf-8">');
  expect(doc).toContain('<meta name="color-scheme" content="light">');
  expect(doc).toContain('<meta name="supported-color-schemes" content="light">');
  const tables = doc.match(/<table\b[^>]*>/g) ?? [];
  const cells = doc.match(/<td\b[^>]*>/g) ?? [];
  const blocks = doc.match(/<(?:h1|p)\b[^>]*>/g) ?? [];
  expect(tables.length).toBeGreaterThan(1);
  expect(cells.length).toBeGreaterThan(1);
  expect(blocks.length).toBeGreaterThan(1);
  // The 560-pixel container and Outlook's fixed 560 table are among them: Gmail keeps the language and the direction
  // only where they are written on the element itself.
  const container = tables.find((t) => t.includes("max-width:560px"));
  expect(container, "the container table").toBeDefined();
  expect(container).toContain(`lang="${lang}" dir="${dir}"`);
  expect(tables.find((t) => t.includes('width="560"')), "Outlook's fixed table").toContain(`lang="${lang}" dir="${dir}"`);
  for (const t of tables) {
    expect(t, t).toContain(`lang="${lang}"`);
    expect(t, t).toContain(`dir="${dir}"`);
    expect(t, t).toContain(`direction:${dir};text-align:${align};`);
  }
  for (const c of cells) {
    expect(c, c).toContain(`lang="${lang}"`);
    expect(c, c).toContain(`dir="${dir}"`);
    expect(c, "Outlook reads align, not CSS").toContain(`align="${align}"`);
    expect(c, c).toContain(`direction:${dir};text-align:${align};`);
  }
  for (const b of blocks) {
    expect(b, b).toContain(`lang="${lang}" dir="${dir}"`);
    expect(b, b).toContain(`direction:${dir};text-align:${align};`);
  }
  // Rule 687: an Arabic email draws no arrow, whether its words come from the shared copy or from its caller.
  if (lang === "ar") expect(doc).not.toMatch(ARROW);
}

/** Every href in a document, entities decoded. */
const hrefs = (doc: string) => [...doc.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
const ARROW = /[\u2190-\u21ff\u27f0-\u27ff\u2900-\u297f\u2b00-\u2bff\u279c-\u27bf]|&[lrhu]arr;/i;

/**
 * One sample of every template in the registry, in `lang`, with links built from `appOrigin()` as the callers build them.
 * The samples live beside the templates (src/emails/samples.ts) since rule 1964, so the console's preview and these
 * tests render the same thing, and a template without a sample does not compile.
 */
function samples(lang: "ar" | "en"): Record<keyof typeof EMAIL_TEMPLATES, string> {
  return renderSamples(lang);
}

describe("rule 685: every templated email is multipart, and its HTML reads in the user's language and direction on the document and on every container", () => {
  it("each template in the registry, in Arabic and in English", () => {
    for (const lang of ["ar", "en"] as const) {
      for (const [id, doc] of Object.entries(samples(lang))) {
        expectFlow(doc, lang);
        expect(doc, id).toContain(`>${COPY[lang].wordmark}</span>`);
      }
    }
  });

  it("the password reset: text as before, word for word, and HTML in the language the form asked for", async () => {
    for (const lang of ["ar", "en"] as const) {
      const u = await newUser("htmlreset");
      expect((await forgot.POST(json("/api/auth/forgot", "POST", { email: u.email, lang }, ip()))).status).toBe(200);
      const [m] = mailTo(u.email);
      expect(m.html, lang).toBeTruthy();
      const link = m.text.match(/https:\/\/\S+\/app\/reset#t=[a-f0-9]{64}/)![0];
      expect(link.startsWith(`${ORIGIN}/${lang}/app/reset#t=`)).toBe(true);
      expect(m.subject).toBe(lang === "ar" ? "إعادة تعيين كلمة المرور في ذكين" : "Reset your Thakeen password");
      expect(m.text).toBe(lang === "ar"
        ? `مرحباً،\n\nوصلنا طلب لإعادة تعيين كلمة مرور حسابك في ذكين. افتح الرابط التالي خلال ساعة واحدة:\n\n${link}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة، ولن يتغير شيء.`
        : `Hello,\n\nWe received a request to reset your Thakeen password. Open this link within one hour:\n\n${link}\n\nIf you did not ask for this, ignore this email and nothing changes.`);
      expectFlow(m.html!, lang);
      expect(hrefs(m.html!), "the button and the fallback carry the same link, fragment and all").toContain(link);
      expect(m.html).toContain(COPY[lang].reset.expiry);
    }
  });

  it("the team invitation: HTML in the invite's language", async () => {
    const owner = { ...(await newUser("htmlown")), plan: "agency" as const };
    await saveUser(owner);
    await signIn(owner.email);
    for (const lang of ["ar", "en"] as const) {
      const to = freshEmail();
      expect((await invite.POST(json("/api/team/invite", "POST", { email: to, role: "member", lang }, ip()))).status).toBe(200);
      const [m] = mailTo(to);
      expect(m.text, lang).toContain(owner.email);
      expectFlow(m.html!, lang);
      expect(m.html).toContain(COPY[lang].invite.roles.member);
      expect(hrefs(m.html!).some((h) => h.startsWith(`${ORIGIN}/${lang}/app/join#t=`))).toBe(true);
    }
  });

  it("a lifecycle note: HTML in the account's language, the bare app address turned into the button", async () => {
    for (const lang of ["ar", "en"] as const) {
      const u = await withLang(await newUser("htmllife"), lang);
      await saveUser({ ...u, createdAt: new Date(Date.now() - 1.5 * 864e5).toISOString(), trialEnds: new Date(Date.now() + 5 * 864e5).toISOString() });
      await saveBrand(u.email, BRAND);
      expect(await runLifecycle((await getUser(u.email))!)).toEqual(["day1"]);
      const [m] = mailTo(u.email);
      expect(m.text).toContain(`${ORIGIN}/${lang}/app`);
      expectFlow(m.html!, lang);
      expect(m.html, "no paragraph that is only the app's address").not.toContain(`<span dir="ltr">${ORIGIN}/${lang}/app</span></p>`);
      expect(hrefs(m.html!)).toContain(`${ORIGIN}/${lang}/app`);
      expect(m.html).toContain(COPY[lang].notice.open);
    }
  });

  it("the trial notes' button opens the subscription page", async () => {
    for (const lang of ["ar", "en"] as const) {
      const u = await withLang(await newUser("htmlbill"), lang);
      for (const key of ["day2", "day3"]) {
        const doc = lifecycleHtml(u, key, lifecycleTemplate(u, key, CTX)!);
        expectFlow(doc, lang);
        expect(hrefs(doc), key).toContain(`${ORIGIN}/${lang}/app/billing`);
        expect(doc).toContain(COPY[lang].notice.billing);
      }
    }
  });

  it("Reem's reminder: HTML in the account's language", async () => {
    for (const lang of ["ar", "en"] as const) {
      const u = await withLang(await newUser("htmlrem"), lang);
      await saveBrand(u.email, BRAND);
      await seedDue(u.email, `Call the bank ${lang}`);
      await sweepReminders(Date.now());
      const [m] = mailTo(u.email);
      expect(m.text).toContain(`Call the bank ${lang}`);
      expectFlow(m.html!, lang);
      expect(hrefs(m.html!)).toContain(`${ORIGIN}/${lang}/app/todo`);
    }
  });

  it("Reem's deletion notice for closed copies of a recurring to-do: HTML in the account's language", async () => {
    const T = Date.parse("2026-10-05T06:00:00Z");
    for (const lang of ["ar", "en"] as const) {
      const u = await withLang(await newUser("htmlser"), lang);
      const sid = newSeriesId();
      await seedCopy(u.email, sid, T - 85 * 864e5, `Water the plants ${lang}`);
      expect(await warnSeries(u.email, T)).toBe(1);
      const [m] = mailTo(u.email);
      expect(m.text).toContain(`Water the plants ${lang}`);
      expectFlow(m.html!, lang);
      expect(hrefs(m.html!)).toContain(`${ORIGIN}/${lang}/app/todo?series=${sid}`);
    }
  });

  it("Reem's evening wrap: HTML in the account's language", async () => {
    // A fixed afternoon, as tests/secretary-phase2.test.ts uses: the item is closed and wrapped on one local day.
    const T0 = Date.parse("2026-10-05T12:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    for (const lang of ["ar", "en"] as const) {
      const u = await withLang(await newUser("htmleve"), lang);
      await saveBrand(u.email, BRAND);
      await signIn(u.email);
      const item = await addItem({ title: `Send the quote ${lang}` });
      expect((await itemRoute.PATCH(json(`/api/secretary/${item.id}`, "PATCH", { action: "complete", result: "Sent" }), params({ id: item.id }))).status).toBe(200);
      expect(await eveningWrap((await getUser(u.email))!, T0)).toBe("sent");
      const [m] = mailTo(u.email);
      expect(m.text).toContain(`Send the quote ${lang}`);
      expectFlow(m.html!, lang);
      expect(hrefs(m.html!)).toContain(`${ORIGIN}/${lang}/app/todo`);
    }
  });

  it("the hidden preheader is cut by code point: an emoji across its edge never leaves a lone surrogate", () => {
    // A task title in the evening wrap or the series warning can put an emoji at character 140 of the first paragraph.
    const out = notice({ lang: "en", title: "T", paragraphs: [`Hi ${"x".repeat(135)} 👋 done`], cta: { href: `${appOrigin()}/en/app/todo` } });
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("rule 686: every value interpolated into an email's HTML is escaped; only constant markup goes in raw", () => {
  const XSS = "<script>alert(1)</script>";
  const ATTR = `" onmouseover="alert(2)`;

  it("the tag escapes the five characters, joins lists, keeps its own markup, and drops nothing as text", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(html`<b>${XSS}</b>`.toString()).toBe("<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>");
    expect(html`<i>${[html`<u>${"a&b"}</u>`, "<x>", 3, null, undefined, false]}</i>`.toString()).toBe("<i><u>a&amp;b</u>&lt;x&gt;3</i>");
    expect(html`<a title="${ATTR}">`.toString()).toBe('<a title="&quot; onmouseover=&quot;alert(2)">');
    expect(html`${raw("<br>")}`.toString()).toBe("<br>");
    // A forged look-alike is text: only the module can make SafeHtml.
    expect(html`${{ toString: () => XSS } as unknown as string}`.toString()).not.toContain("<script");
    const fromVariable: string = XSS;
    // @ts-expect-error raw() takes a string literal written in the source, never a value of type string
    void raw(fromVariable);
  });

  it("copy slots are filled once and escaped: a value that names another slot stays as typed", () => {
    expect(fillHtml("{a} and {b}", { a: "{b}", b: "<b>" }).toString()).toBe("{b} and &lt;b&gt;");
    expect(fillHtml("<{a}>", { a: html`<i>x</i>` }).toString()).toBe("&lt;<i>x</i>&gt;");
  });

  it("a hostile title, paragraph and inviter address come out as text in every template, never as a tag or attribute", () => {
    const o = appOrigin();
    for (const lang of ["ar", "en"] as const) {
      const docs = [
        notice({ lang, title: XSS, paragraphs: [`${XSS}\n${ATTR}`, "<img src=x onerror=alert(3)>"], cta: { href: `${o}/${lang}/app/todo` } }),
        teamInvite({ lang, inviterEmail: `"${XSS}"@test.example`, role: "member", link: `${o}/${lang}/app/join#t=x` }),
        resetPassword({ lang, link: `${o}/${lang}/app/reset#t=a&b=c` }),
      ];
      for (const doc of docs) {
        expect(doc).not.toMatch(/<script|<img|<b>|onmouseover="/i);
      }
      expect(docs[0]).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(docs[0]).toContain("&lt;img src=x onerror=alert(3)&gt;");
      expect(docs[1]).toContain(`<span dir="ltr">&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;@test.example</span>`);
      // A link is an attribute value too: its ampersand goes in as an entity, in the button and in the fallback alike.
      expect(docs[2].match(/href="[^"]*"/g)?.filter((h) => h.includes("/app/reset#t=a&amp;b=c"))).toHaveLength(2);
    }
  });

  it("plain text keeps its line breaks and its addresses left to right, and nothing else", () => {
    expect(plain("a <b>\nواتساب: https://wa.me/966500000000, ثم x@y.example.").toString())
      .toBe('a &lt;b&gt;<br>واتساب: <span dir="ltr">https://wa.me/966500000000</span>, ثم <span dir="ltr">x@y.example</span>.');
    expect(paragraphs("one\ntwo\n\n  \n\nthree\n \nfour")).toEqual(["one\ntwo", "three", "four"]);
  });

  it("a task title the owner or an agent wrote reaches Reem's reminder email as text", async () => {
    const u = await newUser("htmlxss");
    await saveBrand(u.email, BRAND);
    await seedDue(u.email, `${XSS} <img src=x onerror=alert(3)>`);
    await sweepReminders(Date.now());
    const [m] = mailTo(u.email);
    expect(m.text).toContain(XSS);
    expect(m.html).not.toMatch(/<script|<img/i);
    expect(m.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(3)&gt;");
  });

  it("no template renders Markdown or inserts a caller's value raw", () => {
    for (const f of ["notice", "reset-password", "team-invite", "layout", "button"]) {
      const src = readFileSync(`src/emails/${f}.ts`, "utf8");
      expect(src, f).not.toMatch(/from "\.\.\/lib\/md"|render\(/);
      expect(src.match(/raw\(([^)]*)\)/g) ?? [], f).toEqual([]);
    }
    // The one raw() in the family is the constant line break.
    expect(readFileSync("src/emails/html.ts", "utf8").match(/raw\("[^"]*"\)/g)).toEqual(['raw("<br>")']);
  });
});

describe("rule 687: every link in an email points into the app at appOrigin(), and Arabic copy draws no arrows", () => {
  it("every href of every template starts with appOrigin(), whatever host the request came from", () => {
    for (const lang of ["ar", "en"] as const) {
      for (const [id, doc] of Object.entries(samples(lang))) {
        const all = hrefs(doc);
        expect(all.length, id).toBeGreaterThan(0);
        for (const h of all) expect(h.startsWith(`${ORIGIN}/`), `${id}: ${h}`).toBe(true);
      }
    }
  });

  it("a template refuses a link that does not point into the app", () => {
    const bad = [
      "https://evil.example/ar/app/reset#t=x",
      `${ORIGIN}.evil.example/ar/app`,
      `${ORIGIN}`,
      "javascript:alert(1)",
      "/ar/app/todo",
      "https://nashr-tau.vercel.app/ar/app",
      `${ORIGIN}/ar/app" onclick="x`,
    ];
    for (const link of bad) {
      expect(() => resetPassword({ lang: "ar", link }), link).toThrow(/outside the app origin/);
      expect(() => teamInvite({ lang: "en", inviterEmail: "a@test.example", role: "member", link }), link).toThrow(/outside the app origin/);
      expect(() => notice({ lang: "ar", title: "t", paragraphs: [], cta: { href: link } }), link).toThrow(/outside the app origin/);
    }
  });

  it("addresses in a notice's text stay text: only the button is a link", () => {
    const doc = notice({ lang: "ar", title: "t", paragraphs: ["واتساب: https://wa.me/966500000000"], cta: { href: `${ORIGIN}/ar/app` } });
    expect(hrefs(doc).every((h) => h.startsWith(`${ORIGIN}/`))).toBe(true);
    expect(doc).toContain('<span dir="ltr">https://wa.me/966500000000</span>');
  });

  it("every link the callers send starts with appOrigin(), never the request's host", async () => {
    const u = await newUser("htmlhost");
    await forgot.POST(json("/api/auth/forgot", "POST", { email: u.email, lang: "ar" }, ip()));
    const [m] = mailTo(u.email);
    for (const h of hrefs(m.html!)) expect(h.startsWith(`${ORIGIN}/`), h).toBe(true);
    expect(m.html).not.toContain("evil.example");
  });

  it("no Arabic line of the shared email copy, and no Arabic template sample, draws an arrow", () => {
    const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : typeof v === "object" && v ? Object.values(v).flatMap(strings) : []);
    for (const s of strings(COPY.ar)) expect(s, s).not.toMatch(ARROW);
    for (const doc of Object.values(samples("ar"))) expect(doc).not.toMatch(ARROW);
    expect("→ ← &rarr;").toMatch(ARROW);
  });

  it("no Arabic lifecycle note draws an arrow, in its subject, its text or its HTML, whichever variant it sends", async () => {
    // The callers write these words themselves and hand them to notice(); the copy check above never sees them. Reem's
    // reminder, series notice and evening wrap are checked the same way in their rule-685 cases (expectFlow).
    vi.stubEnv("SUPPORT_WHATSAPP", "+966 50 000 0000");
    const base = await withLang(await newUser("htmlarrow"), "ar");
    const variants: [User, string, typeof CTX][] = [
      [base, "day1", CTX],
      [base, "day1", { ...CTX, firstTitle: "منشور القهوة" }],
      [base, "day2", CTX],
      [base, "day3", CTX],
      [{ ...base, firstMonthOffer: { kind: "partner", pct: 15, at: "2026-10-01" }, referredBy: { partner: "p@test.example", code: "RIF15", at: "2026-10-01", via: "code" } }, "day3", CTX],
      [{ ...base, firstPaidOn: "2026-10-02" }, "day3", CTX],
      [base, "day10", CTX],
    ];
    for (const [u, key, ctx] of variants) {
      const tpl = lifecycleTemplate(u, key, ctx)!;
      expect(tpl, key).not.toBeNull();
      expect(tpl.subject, key).not.toMatch(ARROW);
      expect(tpl.body, key).not.toMatch(ARROW);
      expect(lifecycleHtml(u, key, tpl), key).not.toMatch(ARROW);
    }
  });
});

describe("rule 688: the team invitation's HTML names no organisation, brand or display name, only the inviter's address", () => {
  it("a display name and a brand name typed by the sender never reach the invited address", async () => {
    const owner = { ...(await newUser("htmlrelay")), plan: "agency" as const, name: "Thakeen Security Team" };
    await saveUser(owner);
    await saveBrand(owner.email, { ...BRAND, name: "Account locked - verify at evil.example" });
    await signIn(owner.email);
    for (const lang of ["ar", "en"] as const) {
      const to = freshEmail();
      expect((await invite.POST(json("/api/team/invite", "POST", { email: to, role: "member", lang }, ip()))).status).toBe(200);
      const [m] = mailTo(to);
      expect(m.html).toContain(`<span dir="ltr">${owner.email}</span>`);
      for (const part of [m.html!, m.text, m.subject]) {
        expect(part).not.toContain("evil.example");
        expect(part).not.toContain("Thakeen Security Team");
        expect(part).not.toContain("Account locked");
      }
    }
  });

  it("the template has no field that could carry one, and ignores any extra it is handed", () => {
    expect(readFileSync("src/emails/team-invite.ts", "utf8")).toMatch(/export function teamInvite\(p: \{ lang: Lang; inviterEmail: string; role: TeamRole; link: string \}\): string/);
    const extra = { lang: "en", inviterEmail: "a@test.example", role: "admin", link: `${ORIGIN}/en/app/join#t=x`, organizationName: "Evil Org", brand: "Evil Brand", name: "Evil Name" } as Parameters<typeof teamInvite>[0];
    const doc = teamInvite(extra);
    expect(doc).not.toMatch(/Evil/);
  });
});

describe("rule 689: sendEmail passes an HTML part to Resend only when given, always with the text, and sendOnce forwards it", () => {
  it("with html: both parts; without: no html key at all", async () => {
    const { sendEmail } = await import("@/lib/notify");
    expect(await sendEmail("a@test.example", "s", "t", "<p>x</p>")).toBe(true);
    expect(await sendEmail("b@test.example", "s", "t")).toBe(true);
    const [withHtml, plainOnly] = msgs;
    expect(withHtml).toMatchObject({ to: "a@test.example", subject: "s", text: "t", html: "<p>x</p>" });
    expect(plainOnly).toMatchObject({ to: "b@test.example", subject: "s", text: "t" });
    expect("html" in plainOnly, "a text-only message carries no html key").toBe(false);
  });

  it("sendOnce forwards the HTML part, and still sends text only without one", async () => {
    const { sendOnce } = await import("@/lib/notify");
    const a = (await newUser("htmlonce")).email;
    expect(await sendOnce(a, "html:test", "s", "t", "<p>once</p>")).toBe("sent");
    expect(await sendOnce(a, "html:plain", "s", "t")).toBe("sent");
    const [one, two] = mailTo(a);
    expect(one).toMatchObject({ text: "t", html: "<p>once</p>" });
    expect("html" in two).toBe(false);
  });
});

describe("the email palette is the product's: the inline colours equal tokens.css", () => {
  it("ink, muted, paper, ground, lilac, lemon and gold", () => {
    const css = readFileSync("src/app/tokens.css", "utf8");
    const vars = Object.fromEntries([...css.matchAll(/--color-([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().toLowerCase()]));
    for (const [name, value] of Object.entries(COLORS)) expect(value.toLowerCase(), name).toBe(vars[name]);
    expect(Object.keys(COLORS).sort()).toEqual(["gold", "ground", "ink", "lemon", "lilac", "muted", "paper"]);
    expect(FONT).toBe("'IBM Plex Sans Arabic', Tahoma, Arial, sans-serif");
  });
});

/** An item whose reminder time has passed, stored and indexed the way the write path leaves it (tests/secretary-phase2.test.ts). */
async function seedDue(scope: string, title: string): Promise<SecItem> {
  const at = new Date().toISOString();
  const remindAt = new Date(Date.now() - 60_000).toISOString();
  const it: SecItem = { id: newSecId(), kind: "task", title, description: "", result: null, direction: "i_owe", owedBy: "owner", owedTo: null, dueAt: null, allDay: false, snoozeUntil: null, priority: 1, critical: false, links: {}, source: "owner", notes: [], createdAt: at, updatedAt: at, completedAt: null, proposedDone: null, deletedAt: null, expiresAt: null, remindAt, rev: 1 };
  await Promise.all([db.set(SEC_KEYS.item(scope, it.id), it), db.zadd(SEC_KEYS.open(scope), 32503680000000, it.id), db.sadd(SEC_KEYS.all(scope), it.id), db.zadd(SEC_KEYS.due(scope), Date.parse(remindAt), it.id), db.zadd(SEC_KEYS.dueScopes, Date.parse(remindAt), scope)]);
  return it;
}

/** One closed copy of a series, stored and indexed the way a close leaves it (tests/secretary-series.test.ts). */
async function seedCopy(scope: string, sid: string, closedAt: number, title: string): Promise<SecItem> {
  const iso = new Date(closedAt).toISOString();
  const it: SecItem = {
    id: newSecId(), kind: "task", title, description: "", result: "ok", direction: "i_owe", owedBy: "owner", owedTo: null,
    dueAt: iso, allDay: false, snoozeUntil: null, priority: 1, critical: false, links: {}, source: "owner", notes: [], createdAt: iso, updatedAt: iso,
    completedAt: iso, proposedDone: null, deletedAt: null, expiresAt: null, expectBy: null, lastChasedAt: null, remindAt: null, rev: 2, series: { id: sid, n: 1 },
  };
  await Promise.all([
    db.set(SEC_KEYS.item(scope, it.id), it), db.sadd(SEC_KEYS.all(scope), it.id), db.zadd(SEC_KEYS.series(scope, sid), closedAt, it.id), db.sadd(SEC_KEYS.seriesList(scope), sid),
    db.zadd(SEC_KEYS.sdone(scope), closedAt, it.id),
  ]);
  return it;
}

async function addItem(body: Record<string, unknown>): Promise<SecItem> {
  const r = await listRoute.POST(json("/api/secretary", "POST", body));
  const j = (await r.json()) as { item: SecItem };
  expect(r.status, JSON.stringify(j)).toBe(200);
  return j.item;
}
