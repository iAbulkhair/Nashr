import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acct } from "@/lib/account-id";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { json, newUser, signIn, signOut } from "./helpers/session";
import { EMAIL_TEMPLATES, renderEmail } from "@/emails";
import { verifyCode } from "@/emails/verify-code";
import { dailyBrief } from "@/emails/daily-brief";
import { renderSamples } from "@/emails/samples";
import { sendEmail } from "@/lib/notify";
import { clearConsoleOutbox, consoleOutbox, consoleProvider, mailProvider } from "@/lib/mail-provider";
import { MAX_STRING, log, scrub, withRequest } from "@/lib/log";
import { REQUEST_ID_HEADER, REQUEST_ID_SHAPE, requestId } from "@/lib/request-id";
import { proxy } from "@/proxy";
import { onRequestError } from "@/instrumentation";
import { listNotifs, pushNotif } from "@/lib/notifications";
import * as notifRoute from "@/app/api/notifications/route";
import { POST_FIELDS, listPosts, postProblems } from "@/lib/blog";
import { articleJsonLd, ldJson } from "@/lib/home-ld";
import { ADMIN_SECTIONS } from "@/lib/admin-gate";

/**
 * Rules 1960-1979 (docs/system/tests/1960-mail-logs-tooling.md): the supastarter quick wins in mail, logs and tooling.
 * Mail goes through one provider and a typed template registry; the verify code and Noor's brief have HTML parts; the
 * console previews every template; one logger writes only safe fields; every request carries an id; Next's request
 * errors are logged; one bell entry can be marked read; the environment names are in `.env.example`; blog posts carry an
 * Article and refuse to build when their front matter is wrong.
 */

type Msg = { from: string; to: string; subject: string; text: string; html?: string };
const sent: Msg[] = [];
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (msg: Msg) => { sent.push(msg); return msg.to.startsWith("refuse") ? { data: null, error: { name: "validation_error", message: "refused" } } : { data: { id: "re_1" }, error: null }; } };
  },
}));

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const logged = (spy: ReturnType<typeof vi.spyOn>) => JSON.stringify(spy.mock.calls);

beforeEach(() => { sent.length = 0; clearConsoleOutbox(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); signOut(); });

describe("rule 1960: the verify-code email has an HTML part", () => {
  it("shows the code alone, left to right, in the reader's language, and carries no link", () => {
    const ar = verifyCode({ lang: "ar", code: "482913" });
    expect(ar).toMatch(/<span[^>]*dir="ltr"[^>]*>482913<\/span>/);
    expect(ar).toContain('lang="ar"');
    expect(ar).toContain("رمز التحقق");
    // No button: the only link is the layout's footer, to the site's home.
    expect(ar).not.toContain("display:inline-block;padding:12px 24px");
    expect(ar.match(/<a\s/g)?.length).toBe(1);
    expect(verifyCode({ lang: "en", code: "482913" })).toContain("Your verification code");
  });
  it("keeps digits only, at most 12, so nothing else can ride in the code slot", () => {
    const h = verifyCode({ lang: "en", code: "12<b>34</b>5678901234567" });
    expect(h).not.toContain("<b>");
    expect(h).toMatch(/>123456789012<\/span>/);
  });
});

describe("rule 1961: Noor's brief has an HTML part", () => {
  it("escapes the brief's text, keeps its paragraphs, drops the bare link line and ends with one button into the app", () => {
    const href = "https://thakeen.com/en/app";
    const h = dailyBrief({ lang: "en", date: "2026-10-16", body: `First <b>"line"</b>\n\nSecond line\n\n${href}`, href });
    expect(h).toMatch(/Noor(&#39;|&#x27;|')s brief — 2026-10-16/);
    expect(h).not.toContain("<b>");
    expect(h).toContain("&lt;b&gt;");
    expect(h).toContain("Second line");
    // One button (and the layout's copy-this-link line under it); the bare link line is not a paragraph of its own.
    expect(h.match(/display:inline-block;padding:12px 24px/g)?.length).toBe(1);
    expect(h.match(new RegExp(`href="${href}"`, "g"))?.length).toBe(2);
  });
  it("the daily cron sends the nudge, the brief and the follow-ups with a template", () => {
    const cron = src("src/app/api/cron/daily/route.ts");
    expect(cron).toMatch(/template: "dailyBrief"/);
    expect(cron.match(/template: "notice"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("rule 1962: sendEmail takes a typed template", () => {
  it("renders the template in the given language into the HTML part, the text word for word", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key_value_000");
    expect(await sendEmail({ to: "a@test.example", subject: "S", text: "T 482913", template: "verifyCode", context: { code: "482913" }, locale: "en" })).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("T 482913");
    expect(sent[0].html).toBe(renderEmail("verifyCode", { code: "482913" }, "en"));
  });
  it("every template in the registry renders through renderEmail", () => {
    for (const id of Object.keys(EMAIL_TEMPLATES) as (keyof typeof EMAIL_TEMPLATES)[]) for (const l of ["ar", "en"] as const) expect(renderSamples(l)[id]).toContain(`lang="${l}"`);
  });
  it("the notify call sites outside the owned auth routes use the typed form", () => {
    for (const f of ["src/lib/verify-email.ts", "src/lib/secretary-remind.ts", "src/lib/secretary-series.ts", "src/lib/secretary-evening.ts", "src/app/api/team/invite/route.ts"]) expect(src(f), f).toMatch(/template: "/);
  });
});

describe("rule 1963: one mail provider", () => {
  it("is Resend with a key, the console without one off production, none on production", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key_value_000");
    expect(mailProvider()?.name).toBe("resend");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(mailProvider()).toBe(consoleProvider);
    vi.stubEnv("APP_ENV", "production");
    expect(mailProvider()).toBeNull();
  });
  it("a refusal Resend resolves with is a failed send, not a success", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key_value_000");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendEmail("refuse@test.example", "S", "T")).toBe(false);
  });
  it("the console provider keeps the message, answers not delivered and logs no subject, text or code", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    expect(await sendEmail("owner@test.example", "Your code 482913", "Code: 482913")).toBe(false);
    expect(consoleOutbox().at(-1)).toMatchObject({ to: "owner@test.example", subject: "Your code 482913" });
    expect(logged(debug)).toContain("test.example");
    expect(logged(debug)).not.toMatch(/482913|owner@/);
  });
});

describe("rules 1964-1965: the console's mail preview", () => {
  const page = src("src/app/[lang]/admin/mail/page.tsx");
  it("is an admin section behind requireAdmin", () => {
    expect(ADMIN_SECTIONS).toContain("mail");
    expect(page).toMatch(/requireAdmin\(lang, adminHref\(lang, "mail"\)\)/);
  });
  it("shows every template in both languages in a sandboxed frame, from fixed samples only", () => {
    expect(page).toMatch(/sandbox=""/);
    expect(page).toMatch(/const docs = \{ ar: renderSamples\("ar"\), en: renderSamples\("en"\) \}/);
    expect(page).toMatch(/srcDoc=\{docs\[l\]\[id\]\}/);
    expect(page).not.toMatch(/getUser|listUsers|db\./);
  });
});

describe("rule 1966: one bell entry can be marked read", () => {
  it("marks only that entry, answers the unread count, refuses a bad id and one the account does not hold", async () => {
    const u = await newUser("nb");
    const other = await newUser("nc");
    const a = await pushNotif(acct(u), { kind: "info", title: "A", body: "a", href: "/en/app" }, "fp-a");
    const b = await pushNotif(acct(u), { kind: "info", title: "B", body: "b", href: "/en/app" }, "fp-b");
    const theirs = await pushNotif(acct(other), { kind: "info", title: "C", body: "c", href: "/en/app" }, "fp-c");
    expect(a && b && theirs).toBeTruthy();
    expect((await notifRoute.POST(json("/api/notifications", "POST", { id: a!.id }))).status).toBe(401);
    await signIn(u.email);
    const res = await notifRoute.POST(json("/api/notifications", "POST", { id: a!.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, unread: 1 });
    const mine = await listNotifs(acct(u));
    expect(mine.find((n) => n.id === a!.id)?.read).toBe(true);
    expect(mine.find((n) => n.id === b!.id)?.read).toBeFalsy();
    expect((await notifRoute.POST(json("/api/notifications", "POST", { id: "../x" }))).status).toBe(400);
    expect((await notifRoute.POST(json("/api/notifications", "POST", { id: 7 }))).status).toBe(400);
    expect((await notifRoute.POST(json("/api/notifications", "POST", { id: theirs!.id }))).status).toBe(404);
    expect((await listNotifs(acct(other)))[0].read).toBeFalsy();
  });
  it("with no body it still marks everything read", async () => {
    const u = await newUser("nd");
    await Promise.all([pushNotif(acct(u), { kind: "info", title: "A", body: "a", href: "/en/app" }, "fp-1"), pushNotif(acct(u), { kind: "info", title: "B", body: "b", href: "/en/app" }, "fp-2")]);
    await signIn(u.email);
    const res = await notifRoute.POST(new Request("https://nashr.test/api/notifications", { method: "POST" }));
    expect(await res.json()).toEqual({ ok: true, unread: 0 });
    expect((await listNotifs(acct(u))).every((n) => n.read)).toBe(true);
  });
  it("the bell and the notifications page send the entry's id", () => {
    expect(src("src/components/app/NotificationCenter.tsx")).toMatch(/JSON\.stringify\(\{ id \}\)/);
    expect(src("src/components/app/NotificationsPanel.tsx")).toMatch(/markOneRead\(n\.id\)/);
  });
});

describe("rules 1970-1973: the logger", () => {
  it("1970: four levels, debug dropped on a production deploy, a bare message written alone", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    log.info("plain line");
    expect(info).toHaveBeenCalledWith("plain line");
    log.debug("seen in tests");
    expect(debug).toHaveBeenCalledTimes(1);
    vi.stubEnv("APP_ENV", "production");
    log.debug("dropped");
    expect(debug).toHaveBeenCalledTimes(1);
  });
  it("1971: a field named like a secret is redacted at any depth", () => {
    expect(scrub({ apiKey: "x", nested: { "x-auth-token": "y", password: "z", code: "482913", ok: "fine" } })).toEqual({ apiKey: "[redacted]", nested: { "x-auth-token": "[redacted]", password: "[redacted]", code: "[redacted]", ok: "fine" } });
  });
  it("1972: a value that looks like a credential is redacted wherever it sits; a long path is not", () => {
    for (const v of ["Bearer abc.def", "sk-ant-abcdefghijklmnop", "re_abcdefghijklmnop", "whsec_abcdefghijklmnop", "eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJlMTIz", "a".repeat(40).replace(/a/g, "f"), "A".repeat(60)]) expect(scrub(v), v).toBe("[redacted]");
    expect(scrub("/ar/app/settings/notifications/very/long/path/that/is/not/a/key")).toBe("/ar/app/settings/notifications/very/long/path/that/is/not/a/key");
  });
  it("1973: an Error becomes its class and status, never its message; strings are capped", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("provider failed", new Error("HTTP 503 body echoes sk-secret-token-xyz"));
    expect(err).toHaveBeenCalledWith("provider failed", { error: "Error 503" });
    expect((scrub("ab ".repeat(MAX_STRING)) as string).length).toBe(MAX_STRING + 1);
    const rl = vi.spyOn(console, "warn").mockImplementation(() => {});
    withRequest({ headers: new Headers({ [REQUEST_ID_HEADER]: "abcdef12-3456" }) }).warn("w", { n: 1 });
    expect(rl).toHaveBeenCalledWith("w", { rid: "abcdef12-3456", n: 1 });
  });
});

describe("rule 1974: src/lib writes through the logger", () => {
  it("no raw console call is left but the import-free origin.ts and the logger itself", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));
    const raw = walk(join(process.cwd(), "src/lib")).filter((f) => !/src\/lib\/(log|origin)\.ts$/.test(f) && /\bconsole\.(log|info|warn|error|debug)\(/.test(readFileSync(f, "utf8")));
    expect(raw.map((f) => f.slice(process.cwd().length + 1))).toEqual([]);
  });
});

describe("rule 1975: every request carries an id", () => {
  it("the proxy adds one to the request and the response, and keeps a well-formed one it was given", () => {
    const res = proxy(new NextRequest("https://thakeen.com/en/app"));
    const rid = res.headers.get(REQUEST_ID_HEADER)!;
    expect(rid).toMatch(REQUEST_ID_SHAPE);
    expect(res.headers.get(`x-middleware-request-${REQUEST_ID_HEADER}`)).toBe(rid);
    const kept = proxy(new NextRequest("https://thakeen.com/api/health", { headers: { [REQUEST_ID_HEADER]: "client-given-1234" } }));
    expect(kept.headers.get(REQUEST_ID_HEADER)).toBe("client-given-1234");
    const odd = proxy(new NextRequest("https://thakeen.com/en", { headers: { [REQUEST_ID_HEADER]: "<script>" } }));
    expect(odd.headers.get(REQUEST_ID_HEADER)).not.toBe("<script>");
  });
  it("requestId() accepts only the shape", () => {
    expect(requestId(new Headers({ [REQUEST_ID_HEADER]: "short" }))).toBeNull();
    expect(requestId(new Headers({ [REQUEST_ID_HEADER]: "a".repeat(65) }))).toBeNull();
    expect(requestId(new Headers({ [REQUEST_ID_HEADER]: "abcd-1234" }))).toBe("abcd-1234");
  });
});

describe("rule 1976: Next's request errors are logged safely", () => {
  it("one line with the id, method, path without its query, route and kind; never the message", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await onRequestError(Object.assign(new Error("boom owner@test.example"), { digest: "123" }), { path: "/en/app?token=abc", method: "GET", headers: { [REQUEST_ID_HEADER]: "abcd-1234" } }, { routerKind: "App Router", routePath: "/[lang]/app", routeType: "render", renderSource: "react-server-components", revalidateReason: undefined });
    expect(err).toHaveBeenCalledWith("request failed", { rid: "abcd-1234", method: "GET", path: "/en/app", route: "/[lang]/app", kind: "render", digest: "123", error: "Error" });
    expect(logged(err)).not.toMatch(/boom|token=|owner@/);
  });
});

describe("rule 1977: .env.example names every variable and holds no value", () => {
  const example = src(".env.example");
  const names = (text: string) => new Set([...text.matchAll(/^(?:# )?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  it("matches the names in docs/system/variables.md", () => {
    const doc = src("docs/system/variables.md").split("\n").filter((l) => l.startsWith("| ")).flatMap((l) => [...(l.split("|")[1] ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]));
    expect([...names(example)].sort()).toEqual([...new Set(doc)].sort());
  });
  it("every line is a comment, blank or NAME= with nothing after it, and git keeps the file", () => {
    for (const l of example.split("\n")) expect(l, l).toMatch(/^$|^#.*$|^[A-Z][A-Z0-9_]+=$/);
    expect(example).not.toMatch(/^[A-Z][A-Z0-9_]+=.+$/m);
    expect(src(".gitignore")).toMatch(/^!\.env\.example$/m);
  });
});

describe("rule 1978: a blog post carries an Article", () => {
  it("built from the post's own front matter, with the organisation as author and publisher", () => {
    const p = listPosts("en")[0];
    const ld = articleJsonLd("en", "https://thakeen.com", p);
    expect(ld).toMatchObject({ "@type": "Article", headline: p.title.slice(0, 110), description: p.desc, datePublished: p.date, inLanguage: "en", url: `https://thakeen.com/en/blog/${p.slug}` });
    expect((ld.author as { "@id": string })["@id"]).toBe("https://thakeen.com/#organization");
    expect(JSON.stringify(ld)).not.toMatch(/aggregateRating|review|Person/);
    expect(ldJson({ headline: "</script><b>" })).not.toContain("</script>");
    expect(src("src/app/[lang]/blog/[slug]/page.tsx")).toMatch(/ldJson\(articleJsonLd\(lang, appOrigin\(\), p\)\)/);
  });
});

describe("rule 1979: bad blog front matter fails the build", () => {
  const good = `---\ntitle_ar: ع\ntitle_en: T\ndate: 2026-09-17\ndesc_ar: و\ndesc_en: D\n---\nنص\n---EN---\nText\n`;
  it("every post in content/blog passes", () => {
    const dir = join(process.cwd(), "content/blog");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) expect(postProblems(f, readFileSync(join(dir, f), "utf8")), f).toEqual([]);
  });
  it("names each problem: a missing field, a date that is not a day, no English split, an empty side, a bad slug, no block", () => {
    expect(postProblems("ok-post.md", good)).toEqual([]);
    for (const k of POST_FIELDS) expect(postProblems("p.md", good.replace(new RegExp(`^${k}:.*\\n`, "m"), ""))).toContain(`p.md: ${k} is missing`);
    expect(postProblems("p.md", good.replace("2026-09-17", "2026-02-30")).join()).toMatch(/not a YYYY-MM-DD day/);
    expect(postProblems("p.md", good.replace("2026-09-17", "soon")).join()).toMatch(/not a YYYY-MM-DD day/);
    expect(postProblems("p.md", good.replace("\n---EN---\nText", "")).join()).toMatch(/no ---EN--- line/);
    expect(postProblems("p.md", good.replace("Text", "")).join()).toMatch(/English text is empty/);
    expect(postProblems("Bad Name.md", good).join()).toMatch(/lowercase words/);
    expect(postProblems("p.md", "no front matter")).toEqual(["p.md: no front matter block"]);
  });
  it("every reader of the posts goes through the check", () => {
    const blog = src("src/lib/blog.ts");
    expect(blog.match(/readAll\(\)/g)?.length).toBe(3);
    expect(blog).toMatch(/if \(problems\.length\) throw new Error/);
  });
});
