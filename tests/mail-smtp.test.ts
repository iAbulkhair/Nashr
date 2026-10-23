import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sendEmail, mailReady } from "@/lib/notify";
import {
  PRIMARY_BUDGET_MS,
  SMTP_BUDGET_MS,
  consoleProvider,
  mailConfigured,
  mailProblem,
  mailProvider,
  plainAddress,
  resendProvider,
  smtpProvider,
  smtpSettings,
  smtpTransportOptions,
  withFallback,
  type MailMessage,
} from "@/lib/mail-provider";

/**
 * Rules 3570-3576 (docs/system/tests/3570-mail-smtp.md): the SMTP provider on Nodemailer, behind the same seam as Resend.
 * Both libraries are mocked: no network, no real connection. The mocks record what they were given and answer as each
 * case says.
 */

const SECRET = "hunter2-smtp-password-value";
const h = vi.hoisted(() => ({
  resend: { calls: [] as Record<string, unknown>[], reply: (async () => ({ data: { id: "re_1" }, error: null })) as (m: Record<string, unknown>) => Promise<unknown> },
  smtp: { options: [] as Record<string, unknown>[], mails: [] as Record<string, unknown>[], closes: 0, send: (async () => ({ messageId: "x" })) as (m: Record<string, unknown>) => Promise<unknown> },
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (msg: Record<string, unknown>) => { h.resend.calls.push(msg); return h.resend.reply(msg); } };
  },
}));
vi.mock("nodemailer", () => ({
  createTransport: (options: Record<string, unknown>) => {
    h.smtp.options.push(options);
    return { sendMail: (m: Record<string, unknown>) => { h.smtp.mails.push(m); return h.smtp.send(m); }, close: () => { h.smtp.closes++; } };
  },
}));

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const msg = (over: Partial<MailMessage> = {}): MailMessage => ({ from: "Noor at Thakeen <noor@thakeen.example>", to: "reader@test.example", subject: "Subject", text: "Text 482913", ...over });

function smtpEnv(over: Record<string, string> = {}) {
  const env = { SMTP_HOST: "smtp.test.example", SMTP_PORT: "587", SMTP_USER: "mailer", SMTP_PASSWORD: SECRET, SMTP_FROM: "Thakeen <hello@thakeen.example>", ...over };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}
const resendOn = () => { vi.stubEnv("RESEND_API_KEY", "re_test_key_value_000"); vi.stubEnv("MAIL_FROM", "Noor at Thakeen <noor@thakeen.example>"); };
const resendFails = (error: { name: string; message: string; statusCode: number | null }) => { h.resend.reply = async () => ({ data: null, error }); };

beforeEach(() => {
  h.resend.calls.length = 0;
  h.resend.reply = async () => ({ data: { id: "re_1" }, error: null });
  h.smtp.options.length = 0;
  h.smtp.mails.length = 0;
  h.smtp.closes = 0;
  h.smtp.send = async () => ({ messageId: "x" });
  for (const k of ["RESEND_API_KEY", "MAIL_FROM", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"]) vi.stubEnv(k, "");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("rule 3570: SMTP exists only when it is fully configured, and sends from SMTP_FROM", () => {
  it("reads host, port, login and sender, and chooses TLS by port when SMTP_SECURE is unset", () => {
    expect(smtpSettings({ SMTP_HOST: "smtp.test.example", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_FROM: "a@test.example" })).toEqual({ host: "smtp.test.example", port: 465, secure: true, user: "u", pass: "p", from: "a@test.example" });
    expect(smtpSettings({ SMTP_HOST: "smtp.test.example", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_FROM: "Name <a@test.example>" })?.secure).toBe(false);
    expect(smtpSettings({ SMTP_HOST: "smtp.test.example", SMTP_PORT: "2525", SMTP_SECURE: "true", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_FROM: "a@test.example" })?.secure).toBe(true);
    expect(smtpSettings({ SMTP_HOST: "smtp.test.example", SMTP_PORT: "465", SMTP_SECURE: "false", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_FROM: "a@test.example" })?.secure).toBe(false);
  });
  it("a partial or malformed set is the same as none", () => {
    const full = { SMTP_HOST: "smtp.test.example", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_FROM: "a@test.example" };
    expect(smtpSettings(full)).not.toBeNull();
    for (const k of Object.keys(full)) expect(smtpSettings({ ...full, [k]: "" }), k).toBeNull();
    expect(smtpSettings({ ...full, SMTP_HOST: "smtps://smtp.test.example" })).toBeNull();
    expect(smtpSettings({ ...full, SMTP_HOST: "smtp.test.example:587" })).toBeNull();
    expect(smtpSettings({ ...full, SMTP_PORT: "0" })).toBeNull();
    expect(smtpSettings({ ...full, SMTP_PORT: "70000" })).toBeNull();
    expect(smtpSettings({ ...full, SMTP_PORT: "5x7" })).toBeNull();
    expect(smtpSettings({ ...full, SMTP_FROM: "not an address" })).toBeNull();
    expect(smtpSettings({ ...full, SMTP_FROM: "a@test.example\nBcc: x@test.example" })).toBeNull();
  });
  it("sends from SMTP_FROM, not from the message's own sender, with the HTML part only when there is one", async () => {
    smtpEnv();
    const p = mailProvider()!;
    expect(p.name).toBe("smtp");
    expect(await p.send(msg())).toEqual({ delivered: true });
    expect(await p.send(msg({ html: "<p>Hi</p>" }))).toEqual({ delivered: true });
    expect(h.smtp.mails[0]).toEqual({ from: "Thakeen <hello@thakeen.example>", to: "reader@test.example", subject: "Subject", text: "Text 482913" });
    expect(h.smtp.mails[1]).toMatchObject({ html: "<p>Hi</p>" });
    expect(h.smtp.closes).toBe(2);
  });
});

describe("rule 3571: which provider a message goes to", () => {
  it("nothing configured keeps the old answers: the console off production, none on production", () => {
    expect(mailProvider()).toBe(consoleProvider);
    vi.stubEnv("APP_ENV", "production");
    expect(mailProvider()).toBeNull();
    expect(mailConfigured()).toBe(false);
    expect(mailReady()).toBe(false);
  });
  it("Resend alone when SMTP is not configured, even with a partial SMTP set", async () => {
    resendOn();
    vi.stubEnv("SMTP_HOST", "smtp.test.example");
    expect(mailProvider()?.name).toBe("resend");
    resendFails({ name: "internal_server_error", message: "down", statusCode: 500 });
    expect(await sendEmail("reader@test.example", "S", "T")).toBe(false);
    expect(h.smtp.options).toHaveLength(0);
  });
  it("SMTP alone, as the primary, when Resend is not configured; it also overrides the console and production's no-provider", () => {
    smtpEnv();
    expect(mailProvider()?.name).toBe("smtp");
    vi.stubEnv("APP_ENV", "production");
    expect(mailProvider()?.name).toBe("smtp");
    expect(mailConfigured()).toBe(true);
  });
  it("a Resend key without MAIL_FROM is not usable when SMTP is configured: SMTP takes over, with no Resend call", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key_value_000");
    smtpEnv();
    expect(mailProvider()?.name).toBe("smtp");
    expect(await sendEmail("reader@test.example", "S", "T")).toBe(true);
    expect(h.resend.calls).toHaveLength(0);
    expect(h.smtp.mails).toHaveLength(1);
  });
  it("Resend with SMTP behind it when both are configured", async () => {
    resendOn();
    smtpEnv();
    expect(mailProvider()?.name).toBe("resend");
    expect(await sendEmail("reader@test.example", "S", "T")).toBe(true);
    expect(h.resend.calls).toHaveLength(1);
    expect(h.smtp.options).toHaveLength(0);
  });
  it("mailReady is true with a working Resend or with complete SMTP settings, false with a key alone", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key_value_000");
    expect(mailReady()).toBe(false);
    vi.stubEnv("MAIL_FROM", "Noor <noor@thakeen.example>");
    expect(mailReady()).toBe(true);
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAIL_FROM", "");
    expect(mailReady()).toBe(false);
    smtpEnv();
    expect(mailReady()).toBe(true);
  });
});

describe("rule 3572: the fallback runs after a retryable Resend failure only, and never sends twice", () => {
  beforeEach(() => { resendOn(); smtpEnv(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });

  for (const statusCode of [500, 502, 503]) {
    it(`a ${statusCode} answer falls back to SMTP, once, and the answer is true`, async () => {
      resendFails({ name: "internal_server_error", message: "down", statusCode });
      expect(await sendEmail("reader@test.example", "S", "T")).toBe(true);
      expect(h.resend.calls).toHaveLength(1);
      expect(h.smtp.mails).toHaveLength(1);
    });
  }
  it("a failure before any answer (no status) and a throw both fall back", async () => {
    resendFails({ name: "application_error", message: "Unable to fetch data", statusCode: null });
    expect(await sendEmail("reader@test.example", "S", "T")).toBe(true);
    expect(h.smtp.mails).toHaveLength(1);
    h.resend.reply = async () => { throw new Error("socket hang up"); };
    expect(await sendEmail("reader@test.example", "S", "T")).toBe(true);
    expect(h.smtp.mails).toHaveLength(2);
  });
  for (const [statusCode, name] of [[400, "validation_error"], [401, "restricted_api_key"], [403, "invalid_from_address"], [422, "invalid_parameter"], [429, "rate_limit_exceeded"]] as const) {
    it(`a ${statusCode} (${name}) is the message's or the account's fault: no fallback, the answer is false`, async () => {
      resendFails({ name, message: "refused", statusCode });
      expect(await sendEmail("reader@test.example", "S", "T")).toBe(false);
      expect(h.resend.calls).toHaveLength(1);
      expect(h.smtp.options).toHaveLength(0);
    });
  }
  it("a validation error the SDK raises itself (no status, not an application error) is not retried either", async () => {
    resendFails({ name: "missing_required_field", message: "Missing `to` field.", statusCode: null });
    expect(await sendEmail("reader@test.example", "S", "T")).toBe(false);
    expect(h.smtp.options).toHaveLength(0);
  });
  it("a success is final: SMTP is never touched, and nothing is sent twice", async () => {
    expect(await sendEmail("reader@test.example", "S", "T")).toBe(true);
    expect(h.resend.calls).toHaveLength(1);
    expect(h.smtp.options).toHaveLength(0);
    expect(h.smtp.mails).toHaveLength(0);
  });
  it("SMTP's own answer is final: when the fallback also fails nothing else is tried, the answer is false", async () => {
    resendFails({ name: "internal_server_error", message: "down", statusCode: 500 });
    h.smtp.send = async () => { throw Object.assign(new Error("connect failed"), { code: "ECONNECTION" }); };
    expect(await sendEmail("reader@test.example", "S", "T")).toBe(false);
    expect(h.resend.calls).toHaveLength(1);
    expect(h.smtp.mails).toHaveLength(1);
  });
  it("a Resend call with no answer in the budget falls back to SMTP", async () => {
    vi.useFakeTimers();
    h.resend.reply = () => new Promise(() => {});
    const p = withFallback(resendProvider("re_test_key_value_000"), smtpProvider(smtpSettings()!)).send(msg());
    await vi.advanceTimersByTimeAsync(PRIMARY_BUDGET_MS + 10);
    expect(await p).toEqual({ delivered: true });
    expect(h.smtp.mails).toHaveLength(1);
  });
  it("the fallback is logged by provider name only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resendFails({ name: "internal_server_error", message: "down", statusCode: 500 });
    await sendEmail("reader@test.example", "S", "T 482913");
    const out = JSON.stringify(warn.mock.calls);
    expect(out).toContain("fallback");
    expect(out).not.toContain("reader@test.example");
    expect(out).not.toContain("482913");
  });
});

describe("rule 3573: TLS is required and every wait is bounded", () => {
  const base = { host: "smtp.test.example", user: "u", pass: "p", from: "a@test.example" };
  it("implicit TLS: secure on, the certificate checked with TLS 1.2 or later", () => {
    const o = smtpTransportOptions({ ...base, port: 465, secure: true });
    expect(o).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false, tls: { minVersion: "TLSv1.2", rejectUnauthorized: true } });
  });
  it("STARTTLS: required, never optional, never ignored", () => {
    const o = smtpTransportOptions({ ...base, port: 587, secure: false });
    expect(o).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false, tls: { rejectUnauthorized: true } });
  });
  it("no combination of settings turns TLS off", () => {
    for (const port of [25, 465, 587, 2525]) for (const secure of [true, false]) {
      const o = smtpTransportOptions({ ...base, port, secure });
      expect(o.secure || o.requireTLS, `${port}/${secure}`).toBe(true);
      expect(o.ignoreTLS).toBe(false);
    }
  });
  it("connect, greeting, socket and DNS have timeouts that fit the send's budget; files, URLs and logging are off", () => {
    const o = smtpTransportOptions({ ...base, port: 587, secure: false });
    for (const t of [o.connectionTimeout, o.greetingTimeout, o.socketTimeout, o.dnsTimeout]) { expect(t).toBeGreaterThan(0); expect(t).toBeLessThanOrEqual(SMTP_BUDGET_MS); }
    expect(PRIMARY_BUDGET_MS + SMTP_BUDGET_MS).toBeLessThan(10_000);
    expect(o).toMatchObject({ disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
  });
  it("the transport handed to Nodemailer carries exactly those options", async () => {
    smtpEnv({ SMTP_PORT: "465" });
    await mailProvider()!.send(msg());
    expect(h.smtp.options[0]).toMatchObject({ host: "smtp.test.example", port: 465, secure: true, requireTLS: false, tls: { rejectUnauthorized: true } });
    smtpEnv({ SMTP_PORT: "587" });
    await mailProvider()!.send(msg());
    expect(h.smtp.options[1]).toMatchObject({ port: 587, secure: false, requireTLS: true, ignoreTLS: false });
  });
  it("a send with no answer in the deadline is a refusal, and the transport is closed", async () => {
    vi.useFakeTimers();
    smtpEnv();
    h.smtp.send = () => new Promise(() => {});
    const p = mailProvider()!.send(msg());
    await vi.advanceTimersByTimeAsync(SMTP_BUDGET_MS + 10);
    expect(await p).toEqual({ delivered: false, refused: "smtp no answer in time" });
    expect(h.smtp.closes).toBe(1);
  });
});

describe("rule 3574: no secret in an error or a log", () => {
  it("a failed login is reported as a fixed category, never Nodemailer's message, the user, the host or the password", async () => {
    smtpEnv();
    h.smtp.send = async () => { throw Object.assign(new Error(`535 5.7.8 Authentication failed for mailer: password ${SECRET} at smtp.test.example`), { code: "EAUTH", responseCode: 535, response: `535 ${SECRET}` }); };
    const res = await mailProvider()!.send(msg());
    expect(res).toEqual({ delivered: false, refused: "smtp EAUTH 535" });
    const out = JSON.stringify(res);
    for (const s of [SECRET, "mailer", "smtp.test.example", "Authentication failed"]) expect(out).not.toContain(s);
  });
  it("an odd error value gives a category too, not its text", async () => {
    smtpEnv();
    h.smtp.send = async () => { throw `boom ${SECRET}`; };
    expect(await mailProvider()!.send(msg())).toEqual({ delivered: false, refused: "smtp ERROR" });
    h.smtp.send = async () => { throw Object.assign(new Error(SECRET), { code: `lower ${SECRET}` }); };
    expect(await mailProvider()!.send(msg())).toEqual({ delivered: false, refused: "smtp ERROR" });
  });
  it("sendEmail writes only the category to the log and the audit trail", async () => {
    smtpEnv();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.smtp.send = async () => { throw Object.assign(new Error(`bad login ${SECRET}`), { code: "EAUTH", responseCode: 535 }); };
    expect(await sendEmail("reader@test.example", "Reset", "Code 482913")).toBe(false);
    const out = JSON.stringify(err.mock.calls);
    expect(out).toContain("smtp EAUTH 535");
    for (const s of [SECRET, "bad login", "reader@test.example", "482913", "smtp.test.example"]) expect(out).not.toContain(s);
  });
  it("neither the module's source nor the thrown paths put a setting's value into a message", () => {
    const all = src("src/lib/mail-provider.ts");
    const code = all.slice(all.indexOf("function smtpReason"), all.indexOf("export function withFallback"));
    expect(code.length).toBeGreaterThan(200);
    expect(code).not.toMatch(/refused:[^\n]*(c\.pass|c\.user|c\.host|\.message)/);
    expect(code).not.toMatch(/log\./);
    expect(all).toMatch(/logger: false/);
  });
});

describe("rule 3575: address and header checks", () => {
  it("a plain address is one address: no name, no list, no brackets, no line break", () => {
    expect(plainAddress("reader@test.example")).toBe(true);
    expect(plainAddress("first.last+tag@sub.test.example")).toBe(true);
    for (const bad of ["Name <a@test.example>", "a@test.example, b@test.example", "a@test.example;b@test.example", "a@test", "@test.example", "a@@test.example", "a@test.example\n", "a b@test.example", ""]) expect(plainAddress(bad), bad).toBe(false);
  });
  it("mailProblem names the field, never the value", () => {
    expect(mailProblem(msg())).toBeNull();
    expect(mailProblem(msg({ to: "Name <a@test.example>" }))).toBe("invalid recipient address");
    expect(mailProblem(msg({ replyTo: "x, y@test.example" }))).toBe("invalid reply-to address");
    expect(mailProblem(msg({ subject: "Hi\r\nBcc: x@test.example" }))).toBe("line break in a header value");
    expect(mailProblem(msg({ from: "A <a@test.example>\nBcc: x@test.example" }))).toBe("line break in a header value");
  });
  it("a refused message opens no connection", async () => {
    smtpEnv();
    for (const bad of [msg({ to: "a@test.example, b@test.example" }), msg({ replyTo: "Name <a@test.example>" }), msg({ subject: "x\nBcc: y@test.example" })]) {
      const res = await mailProvider()!.send(bad);
      expect(res).toMatchObject({ delivered: false });
      expect(JSON.stringify(res)).not.toMatch(/Bcc|test\.example/);
    }
    expect(h.smtp.options).toHaveLength(0);
  });
  it("a good replyTo goes through to SMTP and to Resend; a bad one is refused by Resend's adapter too, with no fallback", async () => {
    smtpEnv();
    await mailProvider()!.send(msg({ replyTo: "support@thakeen.example" }));
    expect(h.smtp.mails[0]).toMatchObject({ replyTo: "support@thakeen.example" });
    resendOn();
    const p = mailProvider()!;
    await p.send(msg({ replyTo: "support@thakeen.example" }));
    expect(h.resend.calls[0]).toMatchObject({ replyTo: "support@thakeen.example" });
    const res = await p.send(msg({ replyTo: "a@test.example, b@test.example" }));
    expect(res).toEqual({ delivered: false, refused: "invalid reply-to address" });
    expect(h.resend.calls).toHaveLength(1);
    expect(h.smtp.options).toHaveLength(1);
  });
  it("Resend's message is unchanged when there is no replyTo (no extra key)", async () => {
    resendOn();
    await mailProvider()!.send(msg());
    expect(Object.keys(h.resend.calls[0]).sort()).toEqual(["from", "subject", "text", "to"]);
  });
});

describe("rule 3576: Nodemailer is pinned, Node only, and its settings are documented", () => {
  const pkg = JSON.parse(src("package.json")) as { dependencies: Record<string, string> };
  it("is an exact version in package.json and in the lockfile", () => {
    expect(pkg.dependencies.nodemailer).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(src("package-lock.json")) as { packages: Record<string, { version?: string }> };
    expect(lock.packages["node_modules/nodemailer"]?.version).toBe(pkg.dependencies.nodemailer);
    expect(Object.keys(lock.packages).filter((k) => k.includes("@rolldown/binding-linux")).length).toBeGreaterThan(0);
  });
  it("is imported only inside mail-provider.ts, at send time, and no source file runs on the edge", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(join(process.cwd(), d))) { const p = `${d}/${n}`; if (statSync(join(process.cwd(), p)).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n)) files.push(p); } };
    walk("src");
    expect(files.filter((f) => /from "nodemailer"|import\("nodemailer"\)|require\("nodemailer"\)/.test(src(f)))).toEqual(["src/lib/mail-provider.ts"]);
    expect(src("src/lib/mail-provider.ts")).not.toMatch(/^import .* from "nodemailer"/m);
    expect(files.filter((f) => /runtime\s*[=:]\s*["']edge["']/.test(src(f)))).toEqual([]);
  });
  it("the six names are in variables.md and .env.example, and the rule is in flows.md", () => {
    for (const n of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"]) {
      expect(src("docs/system/variables.md"), n).toContain(`\`${n}\``);
      expect(src(".env.example"), n).toMatch(new RegExp(`^${n}=$`, "m"));
    }
    expect(src("docs/system/flows.md")).toContain("## Mail providers: Resend first, SMTP as fallback or alone");
  });
});
