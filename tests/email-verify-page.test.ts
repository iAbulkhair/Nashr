import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { retryWait, typedDigits, waitLabel } from "@/lib/verify-client";

/**
 * Rule 754: the verify page and the redirect to it. Source-level where a render needs Next internals (the layout and the
 * page are async server components), as the other screen tests do.
 */
const read = (p: string) => readFileSync(p, "utf8");
const LAYOUT = "src/app/[lang]/app/layout.tsx";
const PAGE = "src/app/[lang]/app/verify/page.tsx";
const FORM = "src/components/app/VerifyForm.tsx";

describe("layout sends an unverified owner to verify (rule 754)", () => {
  const src = read(LAYOUT);

  it("verify is a public path, so the page can render for a signed-out reading", () => {
    expect(src).toMatch(/const PUBLIC = \[[^\]]*"\/verify"/);
  });

  it("currentUser() runs first; the unverified read happens only when it is null and the path is not public", () => {
    const first = src.indexOf("await currentUser()");
    const unverified = src.indexOf("await currentUserUnverified()");
    expect(first).toBeGreaterThan(-1);
    expect(unverified).toBeGreaterThan(first);
    expect(src).toMatch(/const pending = !user && !isPublic && path \? await currentUserUnverified\(\) : null;/);
  });

  it("an unverified owner goes to verify before the login redirect, keeping the requested page in next", () => {
    const toVerify = src.indexOf("redirect(`/${lang}/app/verify${back ?");
    expect(src).toMatch(/const back = safeNext\(path\);/);
    expect(src).toContain("?next=${encodeURIComponent(back)}");
    const toLogin = src.indexOf("redirect(`/${lang}/app/login`)");
    expect(toVerify).toBeGreaterThan(-1);
    expect(toLogin).toBeGreaterThan(toVerify);
    expect(src).toMatch(/pending\?\.actor\?\.kind === "owner"/);
  });
});

describe("verify page", () => {
  const src = read(PAGE);

  it("signed out goes to login", () => {
    expect(src).toMatch(/const u = await currentUserUnverified\(\);\s*if \(!u\) redirect\(`\/\$\{lang\}\/app\/login`\);/);
  });

  it("a member, a founder session or a verified owner goes to the app (or the safe next)", () => {
    expect(src).toMatch(/u\.actor\?\.kind !== "owner" \|\| emailVerified\(u\)/);
    expect(src).toMatch(/redirect\(next \|\| appHref\(lang\)\)/);
    expect(src).toContain("safeNext(");
  });

  it("sends the first code only when none is waiting, and offers the email change to gated signups", () => {
    expect(src).toMatch(/autoSend = !\(await hasPendingCode\(u\.email\)\)/);
    expect(src).toMatch(/canChangeEmail = !!u\.gatedSignup/);
    expect(src).toMatch(/mailOn = mailReady\(\) \|\| devCodeExposed\(\)/);
  });

  it("takes the address from the session, never from the URL", () => {
    expect(src).toMatch(/email=\{u\.email\}/);
    expect(src).not.toMatch(/sp\.email|searchParams\.get\(["']email|searchParams\.email/);
    // the only query values read are next and sent
    expect(src).toMatch(/Promise<\{ next\?: string \| string\[\]; sent\?: string \| string\[\] \}>/);
  });

  it("passes signup's sent=0 down as copy only", () => {
    expect(src).toMatch(/const mailSent = \(Array\.isArray\(sp\.sent\) \? sp\.sent\[0\] : sp\.sent\) !== "0";/);
    expect(src).toContain("mailSent={mailSent}");
  });
});

describe("VerifyForm", () => {
  const src = read(FORM);

  it("the code box is numeric, one-time-code, wide enough for Arabic digits, and left to right", () => {
    expect(src).toContain('inputMode="numeric"');
    expect(src).toContain('autoComplete="one-time-code"');
    const max = /maxLength=\{(\d+)\}/.exec(src);
    expect(Number(max?.[1])).toBeGreaterThanOrEqual(6);
    expect(src).toContain('dir="ltr"');
  });

  it("the resend button is disabled while the countdown runs", () => {
    expect(src).toMatch(/disabled=\{wait > 0 \|\| /);
  });

  it("sends in an effect only when autoSend is set, once", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!autoSend \|\| !mailOn \|\| sentOnce\.current\) return;/);
    expect(src).toContain("/api/auth/verify/send");
  });

  it("the change-email form shows only when canChangeEmail", () => {
    expect(src).toMatch(/\{canChangeEmail && changing && \(\s*<form onSubmit=\{onChangeEmail\}/);
    expect(src).toMatch(/\{canChangeEmail && !changing && \(\s*<button[^]*?setChanging\(true\)/);
    expect(src).toContain("/api/auth/verify/email");
  });

  it("an email change that sent no code lets the owner ask again at once", () => {
    expect(src).toMatch(/if \(p\.body\.mail === false\) \{\s*setSentMail\(false\);\s*setWait\(0\);\s*setInfo\(S\.notSent\);\s*\} else \{\s*setMailDown\(false\);\s*setSentMail\(true\);\s*setWait\(60\);/);
  });

  it("has the logout button, and mail_unavailable shows the WhatsApp box", () => {
    expect(src).toContain("<LogoutButton");
    expect(src).toMatch(/p\.status === 503 && p\.body\.error === "mail_unavailable"\) \{\s*setSentMail\(false\);\s*return setMailDown\(true\);/);
    expect(src).toMatch(/\{mailDown && \(\s*<div role="status"[^]*?\{whatsapp && <a href=\{whatsapp\}/);
  });

  it("says a code was sent only while a mail is known to have gone", () => {
    // starts neutral unless the first mail went out (signup said so) and no send is still to come
    expect(src).toMatch(/useState\(mailOn && mailSent && !autoSend\)/);
    expect(src).toMatch(/\{sentMail \? S\.sentTo : S\.yourEmail\}/);
    // a successful send turns it on; a 503 and a failed send turn it off
    expect(src).toMatch(/if \(succeeded\(p\)\) \{\s*setMailDown\(false\);\s*setSentMail\(true\);/);
    expect(src).toMatch(/if \(p\.body\.error === "send_failed"\) setSentMail\(false\);/);
    expect(src).toContain('yourEmail: "بريدك:"');
    expect(src).toContain('yourEmail: "Your email:"');
  });

  it("without a WhatsApp number the fallback is labelled as contact, not WhatsApp", () => {
    expect(src).toMatch(/viaWhatsapp = !!whatsapp && whatsapp\.startsWith\("https:\/\/wa\.me\/"\)/);
    expect(src).toMatch(/\{viaWhatsapp \? S\.support : S\.contact\}/);
    expect(src).toMatch(/\{viaWhatsapp \? S\.mailOff : S\.mailOffHelp\}/);
    expect(src).toContain('contact: "تواصل معنا"');
    expect(src).toContain('contact: "Contact us"');
  });

  it("reads the Retry-After of postJson instead of a local fetch copy", () => {
    expect(src).toContain('import { authMessage, failureCode, postJson, succeeded } from "@/lib/auth-client"');
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).toContain("retryWait(p.retry)");
  });

  it("goes on to the safe next, or the app", () => {
    expect(src).toMatch(/window\.location\.assign\(dest\)/);
    expect(src).toMatch(/safeNext\(next\) \|\| appHref\(lang\)/);
  });

  it("never logs or puts the code in a URL", () => {
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/\?code=|&code=/);
  });
});

describe("signup goes to verify", () => {
  const src = read("src/components/app/AuthForm.tsx");

  it("pushes to the verify page carrying the old destination in next", () => {
    expect(src).toMatch(/\/app\/verify\?next=\$\{encodeURIComponent\(/);
    // the old destination: the next param, or the start page with the carried url
    // sent=0 tells the verify page the first mail did not go out (copy only)
    expect(src).toContain('${p.body.mail === false ? "&sent=0" : ""}');
    expect(src).toMatch(/const after = next \|\| appHref\(lang, `\/start\$\{site\.length >= 4 \? `\?url=\$\{encodeURIComponent\(site\)\}` : ""\}`, null, "default"\);/);
  });
});

describe("verify-client helpers", () => {
  it("typedDigits turns Arabic-Indic and Persian digits into Latin and drops the rest", () => {
    expect(typedDigits("١٢٣ ٤٥٦")).toBe("123456");
    expect(typedDigits("۱۲۳۴۵۶")).toBe("123456");
    expect(typedDigits("12-34 56")).toBe("123456");
    expect(typedDigits("abc")).toBe("");
  });

  it("retryWait reads Retry-After in whole seconds and falls back", () => {
    expect(retryWait("42")).toBe(42);
    expect(retryWait("0.2")).toBe(60);
    expect(retryWait("soon")).toBe(60);
    expect(retryWait(null, 5)).toBe(5);
  });

  it("waitLabel is seconds up to two minutes, then minutes", () => {
    expect(waitLabel(45, "ar")).toBe("بعد 45 ث");
    expect(waitLabel(45, "en")).toBe("in 45s");
    expect(waitLabel(3600, "en")).toBe("in 60m");
    expect(waitLabel(3600, "ar")).toBe("بعد 60 د");
  });
});
