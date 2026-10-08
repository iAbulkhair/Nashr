import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Rule 315, the chat side: what the owner and the members see of the account's chat messages. The line under the message
 * box (messages left, from the server's ChatStatus), a refused message going back into the box with the reason, and the
 * limit dialog's chat kinds. The counting itself is pinned in tests/chat-allowance.test.ts (rules 308-314).
 *
 * Past the allowance with "continue on credits" on, nothing is taken before a message: it needs at least
 * `overflow.hold` credits in the balance and is billed what it actually cost, at most that. No string says credits are
 * held, reserved or given back, or guesses what a message usually costs.
 */

// ChatPanel reads the router; outside Next there is none. Server-only helpers (redirect, notFound) stay real.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/app/chat",
  useSearchParams: () => new URLSearchParams(),
}));

import { db } from "@/lib/db";
import { getUser, saveUser, type User } from "@/lib/auth";
import { appDict, type AppDict } from "@/lib/app-i18n";
import { CHAT_ALLOWANCE, chatOverflowHold, formatCount } from "@/lib/pricing";
import { chatMsgKey, chatTrialKey } from "@/lib/usage";
import type { ChatStatus } from "@/lib/chat-allowance";
import ChatPanel, { chatLine, refusalOf } from "@/components/app/ChatPanel";
import { limitText, raiseLimit, type LimitKind } from "@/components/app/LimitModal";
import ChatPage from "@/app/[lang]/app/chat/page";
import { newMember, newUser, signIn, signOut } from "./helpers/session";

const LANGS = ["ar", "en"] as const;
const { ar, en } = appDict;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
const HOLD = chatOverflowHold();
/** React escapes apostrophes in text; compare against what the markup really contains. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A status as the server sends it. */
const status = (allowance: number, used: number, period: ChatStatus["period"] = "month", overflow: Partial<ChatStatus["overflow"]> = {}): ChatStatus => ({
  used, allowance, left: Math.max(0, allowance - used), counted: used, period,
  overflow: { on: false, available: period === "month", used: 0, credits: 0, hold: HOLD, ...overflow },
});
const BRAND = { name: "Roastery", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "beans", audience: "Riyadh", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "Riyadh", updatedAt: "2026-10-01" };

/** An owner with a brand (so the chat page renders the workspace thread), on `plan`, with `used` messages counted. */
async function account(plan: User["plan"], used: number, extra: Partial<User> = {}): Promise<User> {
  const u = await newUser("caui");
  await db.set(`brand:${u.email}`, BRAND);
  await saveUser({ ...(await getUser(u.email))!, plan, ...extra });
  if (used) await db.set(plan === "trial" ? chatTrialKey(u.email) : chatMsgKey(u.email), used);
  return (await getUser(u.email))!;
}
const chatPage = async (lang: "ar" | "en") => renderToStaticMarkup((await ChatPage({ params: Promise.resolve({ lang }), searchParams: Promise.resolve({}) } as never)) as ReactElement);

afterEach(() => {
  signOut();
  vi.unstubAllGlobals();
});

describe("the messages-left line under the chat box (rule 315)", () => {
  const S = CHAT_ALLOWANCE.starter;

  it("says how many of the month's messages are left, in Latin digits, in both languages", () => {
    expect(chatLine(en, status(S, 40))).toEqual({ text: `${S - 40} of ${S} messages left this month`, low: false });
    expect(chatLine(ar, status(S, 40))).toEqual({ text: `تبقّى لك ${S - 40} من ${S} رسالة هذا الشهر`, low: false });
    // Thousands carry the site's comma, never a locale's digits.
    const B = CHAT_ALLOWANCE.business;
    for (const lang of LANGS) expect(chatLine(appDict[lang], status(B, 0)).text, lang).toContain(formatCount(B));
    expect(formatCount(B)).toMatch(/^\d{1,3}(,\d{3})+$/);
  });

  it("the trial says 'in your trial', not 'this month'", () => {
    const T = CHAT_ALLOWANCE.trial;
    expect(chatLine(en, status(T, 4, "trial")).text).toBe(`${T - 4} of ${T} messages left in your trial`);
    expect(chatLine(ar, status(T, 4, "trial")).text).toBe(`تبقّى لك ${T - 4} من ${T} رسالة في تجربتك`);
  });

  it("is in the warning colour at 10% of the allowance or less, and when the messages are used up", () => {
    const tenth = Math.floor(S * 0.1);
    expect(chatLine(en, status(S, S - tenth - 1)).low).toBe(false);
    expect(chatLine(en, status(S, S - tenth)).low).toBe(true);
    expect(chatLine(en, status(S, S - 1)).low).toBe(true);
    for (const lang of LANGS) {
      const t = appDict[lang];
      expect(chatLine(t, status(S, S)), lang).toEqual({ text: fill(t.chat.chatOut, { allowance: formatCount(S) }), low: true });
      expect(chatLine(t, status(CHAT_ALLOWANCE.trial, CHAT_ALLOWANCE.trial, "trial")), lang).toEqual({ text: fill(t.chat.chatOutTrial, { allowance: formatCount(CHAT_ALLOWANCE.trial) }), low: true });
    }
  });

  it("with 'continue on credits' on and the month used up, says messages now go on credits: billed what they cost, at most the hold, needing the hold in the balance", () => {
    for (const lang of LANGS) {
      const t = appDict[lang];
      const on = status(S, S, "month", { on: true, used: 3 });
      // With no balance given, or a balance of at least the hold, chat continues on credits.
      for (const credits of [undefined, HOLD, HOLD + 40]) {
        const line = chatLine(t, on, credits);
        expect(line.low, `${lang} ${credits}`).toBe(true);
        expect(line.text, `${lang} ${credits}`).toBe(fill(t.chat.chatOnCredits, { allowance: formatCount(S), hold: formatCount(HOLD) }));
      }
      const line = chatLine(t, on, HOLD);
      expect(line.text, lang).toContain(`${HOLD} ${lang === "ar" ? "كريدت على الأكثر" : "credits, and needs at least"}`);
      expect(line.text, lang).toMatch(lang === "ar" ? /بما كلّفته فعلاً[\s\S]*على الأقل في رصيدك/ : /billed what it actually cost[\s\S]*at least \d+ credits in your balance/);
      // A trial never continues on credits, whatever the flag says.
      expect(chatLine(t, status(CHAT_ALLOWANCE.trial, CHAT_ALLOWANCE.trial, "trial", { on: true }), 0).text, lang).toBe(fill(t.chat.chatOutTrial, { allowance: formatCount(CHAT_ALLOWANCE.trial) }));
    }
  });

  it("'continue on credits' on but the balance below the hold: chat is paused, not 'continues on credits'", () => {
    for (const lang of LANGS) {
      const t = appDict[lang];
      for (const credits of [0, HOLD - 1]) {
        const line = chatLine(t, status(S, S, "month", { on: true }), credits);
        expect(line, `${lang} ${credits}`).toEqual({ text: fill(t.chat.chatPausedCredits, { allowance: formatCount(S), hold: formatCount(HOLD) }), low: true });
        expect(line.text, lang).toContain(`${HOLD} ${lang === "ar" ? "كريدت" : "credits"}`);
        expect(line.text, lang).not.toBe(fill(t.chat.chatOnCredits, { allowance: formatCount(S), hold: formatCount(HOLD) }));
      }
      // Messages still left: the balance does not matter yet.
      expect(chatLine(t, status(S, 40, "month", { on: true }), 0).text, lang).toBe(fill(t.chat.chatLeft, { left: formatCount(S - 40), allowance: formatCount(S) }));
    }
    expect(en.chat.chatPausedCredits).toMatch(/chat is paused: your balance is below the \{hold\} credits/);
    expect(ar.chat.chatPausedCredits).toMatch(/الدردشة متوقفة: رصيدك أقل من \{hold\} كريدت/);
  });

  it("an allowance of 0 (the founder turned chat off): not available, contact support, and no promise of the 1st", () => {
    for (const lang of LANGS) {
      const t = appDict[lang];
      for (const period of ["month", "trial"] as const) {
        const line = chatLine(t, status(0, 0, period), 100);
        expect(line, `${lang} ${period}`).toEqual({ text: t.chat.chatOff, low: true });
        expect(line.text, lang).not.toMatch(/1st|أول الشهر|subscription|الاشتراك/);
      }
      // Even with "continue on credits" on: the server refuses every message on an allowance of 0, so the line says off.
      expect(chatLine(t, status(0, 0, "month", { on: true }), 100).text, lang).toBe(t.chat.chatOff);
    }
    expect(en.chat.chatOff).toBe("Chat is not available on this account. Contact support.");
    expect(ar.chat.chatOff).toBe("الدردشة غير متاحة في هذا الحساب. تواصل مع الدعم.");
  });

  it("the panel renders the line from the status it is given, and nothing without one", () => {
    const base = { initial: [], credits: 10 };
    for (const lang of LANGS) {
      const t = appDict[lang];
      const html = renderToStaticMarkup(createElement(ChatPanel, { ...base, t, lang, chat: status(S, 40) }));
      expect(html, lang).toContain(esc(chatLine(t, status(S, 40)).text));
      expect(html, lang).toMatch(/class="tnum mt-2 text-xs text-ink\/70" dir="auto">/);
      const low = renderToStaticMarkup(createElement(ChatPanel, { ...base, t, lang, chat: status(S, S) }));
      expect(low, lang).toContain('class="tnum mt-2 text-xs font-semibold text-danger" dir="auto">');
      expect(renderToStaticMarkup(createElement(ChatPanel, { ...base, t, lang })), lang).not.toContain('class="tnum mt-2 text-xs');
      // The panel's own balance decides between "continues on credits" and "paused".
      const over = status(S, S, "month", { on: true });
      expect(renderToStaticMarkup(createElement(ChatPanel, { ...base, credits: HOLD, t, lang, chat: over })), lang).toContain(esc(chatLine(t, over, HOLD).text));
      expect(renderToStaticMarkup(createElement(ChatPanel, { ...base, credits: HOLD - 1, t, lang, chat: over })), lang).toContain(esc(fill(t.chat.chatPausedCredits, { allowance: formatCount(S), hold: formatCount(HOLD) })));
    }
    expect(readFileSync("src/components/app/ChatPanel.tsx", "utf8")).toContain("const line = chatNow ? chatLine(t, chatNow, credits) : null;");
  });

  it("the chat page reads the ACCOUNT's status on the server: the owner and a member see the same count", async () => {
    const u = await account("starter", 40);
    await signIn(u.email);
    expect(await chatPage("en")).toContain(`${S - 40} of ${S} messages left this month`);
    expect(await chatPage("ar")).toContain(`تبقّى لك ${S - 40} من ${S} رسالة هذا الشهر`);
    const m = await newMember(u, "member", "cauim");
    await signIn(m.email);
    expect(await chatPage("en")).toContain(`${S - 40} of ${S} messages left this month`);
  });

  it("the chat page: a trial's line, and an owner continuing on credits sees the hold", async () => {
    const T = CHAT_ALLOWANCE.trial;
    const trial = await account("trial", 29);
    await signIn(trial.email);
    expect(await chatPage("en")).toContain(`${T - 29} of ${T} messages left in your trial`);
    const P = CHAT_ALLOWANCE.pro;
    const pro = await account("pro", P, { chatOverflow: true, credits: HOLD });
    await signIn(pro.email);
    expect(await chatPage("en")).toContain(esc(fill(en.chat.chatOnCredits, { allowance: formatCount(P), hold: formatCount(HOLD) })));
    // Below the hold the same owner is told chat is paused.
    const poor = await account("pro", P, { chatOverflow: true, credits: HOLD - 1 });
    await signIn(poor.email);
    const h = await chatPage("en");
    expect(h).toContain(esc(fill(en.chat.chatPausedCredits, { allowance: formatCount(P), hold: formatCount(HOLD) })));
    expect(h).not.toContain(esc(fill(en.chat.chatOnCredits, { allowance: formatCount(P), hold: formatCount(HOLD) })));
    // A founder override of 0: not available, contact support.
    const off = await account("starter", 0, { chatAllowance: 0 });
    await signIn(off.email);
    expect(await chatPage("en")).toContain(en.chat.chatOff);
    expect(await chatPage("ar")).toContain(ar.chat.chatOff);
  });

  it("ChatPanel takes the status from every answer and from the history it reloads, and only types it from the server", () => {
    const src = readFileSync("src/components/app/ChatPanel.tsx", "utf8");
    // The reply (JSON or the stream's message event), a refusal, and GET /api/chat during the recovery after a drop.
    expect(src.match(/if \(j\.chat\) setChatNow\(j\.chat/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain("useState<ChatStatus | null>(chat0 ?? null)");
    // The chat page passes it in both branches (first run and the workspace thread).
    const page = readFileSync("src/app/[lang]/app/chat/page.tsx", "utf8");
    expect(page.match(/chat=\{chat\}/g)?.length).toBe(2);
    expect(page).toContain('chatStatus(u, route("chat").model)');
    // The workspace thread shows the hold of the conversation's own model (its pick when route() accepts it).
    expect(page).toContain("chatStatus(u, chatRouteFor(u, c).model)");
  });
});

describe("a refused message goes back into the box with the reason (rule 315)", () => {
  it("refusalOf maps only the chat refusals; anything else keeps the old error path", () => {
    expect(refusalOf(402, "chat_allowance")).toBe("chat");
    expect(refusalOf(402, "chat_credits")).toBe("chat_credits");
    expect(refusalOf(429, "slow_down")).toBe("slow_down");
    expect(refusalOf(402, "no_credits")).toBeNull();
    expect(refusalOf(200, "chat_allowance")).toBeNull();
    expect(refusalOf(429, "rate_limited")).toBeNull();
    expect(refusalOf(502, "chat_failed")).toBeNull();
    expect(refusalOf(401, undefined)).toBeNull();
  });

  it("ChatPanel checks the status before the generic error, takes the bubble out, puts the text back and says why", () => {
    const src = readFileSync("src/components/app/ChatPanel.tsx", "utf8");
    for (const code of ["chat_allowance", "chat_credits", "slow_down"]) expect(src, code).toContain(`"${code}"`);
    expect(src).toContain("const why = refusalOf(res.status, j.error);");
    expect(src).toContain("if (why) unsend(why, j); else done(j);");
    // The optimistic bubble is removed by identity, and the typed text comes back unless something new was typed.
    expect(src).toContain("const mine: ChatMsg = { role: \"user\", content: m, at: new Date().toISOString() };");
    expect(src).toContain("setMsgs((p) => p.filter((x) => x !== mine));");
    expect(src).toContain("setText((cur) => cur || m);");
    // 429: its own sentence, no dialog. 402: the chat dialog, with the period and the hold from the server's status.
    expect(src).toContain('if (why === "slow_down") { setNotice(t.chat.slowDown); return; }');
    expect(src).toContain("raiseLimit(why, { period: j.chat?.period, hold: j.chat?.overflow.hold, allowance: j.chat?.allowance });");
    expect(src).toContain("setNotice(t.chat.notSent);");
    expect(src).not.toMatch(/raiseLimit\("credits"\)[^\n]*chat_credits/);
  });

  it("raiseLimit carries the kind and the chat detail to the dialog", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const seen: unknown[] = [];
    target.addEventListener("nashr:limit", (e) => seen.push((e as CustomEvent).detail));
    raiseLimit("chat", { period: "trial", hold: HOLD });
    raiseLimit("chat_credits", { period: "month", hold: HOLD });
    raiseLimit("chat", { period: "month", hold: HOLD, allowance: 0 });
    raiseLimit("credits");
    expect(seen).toEqual([{ kind: "chat", period: "trial", hold: HOLD }, { kind: "chat_credits", period: "month", hold: HOLD }, { kind: "chat", period: "month", hold: HOLD, allowance: 0 }, { kind: "credits" }]);
  });
});

describe("the limit dialog's chat kinds (rule 315)", () => {
  const L = (t: AppDict) => t.limit;
  const text = (t: AppDict, kind: LimitKind, may: boolean, detail: { period?: ChatStatus["period"]; hold?: number; allowance?: number } = {}) => limitText(L(t), { kind, ...detail }, may);

  it("the owner is sent to the Subscription page; a member is told to ask the owner", () => {
    for (const lang of LANGS) {
      const t = appDict[lang];
      expect(text(t, "chat", true, { period: "month" }), lang).toEqual([t.limit.chatTitle, t.limit.chatBody]);
      expect(text(t, "chat", false, { period: "month" }), lang).toEqual([t.limit.chatTitle, t.limit.askOwnerChat]);
      expect(t.limit.chatBody, lang).toMatch(lang === "ar" ? /أول الشهر[\s\S]*رقِّ خطتك[\s\S]*أكمل على الكريدت[\s\S]*صفحة الاشتراك/ : /resumes on the 1st[\s\S]*upgrade your plan[\s\S]*continue on credits[\s\S]*Subscription page/);
      expect(t.limit.askOwnerChat, lang).toMatch(lang === "ar" ? /مالك الحساب/ : /account owner/);
    }
  });

  it("a trial gets the subscribe wording, not the month's", () => {
    for (const lang of LANGS) {
      const t = appDict[lang];
      expect(text(t, "chat", true, { period: "trial" }), lang).toEqual([t.limit.chatTrialTitle, t.limit.chatTrialBody]);
      expect(text(t, "chat", false, { period: "trial" }), lang).toEqual([t.limit.chatTrialTitle, t.limit.askOwnerChatTrial]);
      expect(t.limit.chatTrialBody, lang).not.toMatch(lang === "ar" ? /على الكريدت/ : /continue on credits/);
    }
  });

  it("too few credits to continue: says the hold from the server, or the table's when none came", () => {
    for (const lang of LANGS) {
      const t = appDict[lang];
      for (const may of [true, false]) {
        const [title, body] = text(t, "chat_credits", may, { period: "month", hold: 7 });
        expect(title, lang).toBe(t.limit.chatCreditsTitle);
        expect(body, `${lang} ${may}`).toContain(`7 ${lang === "ar" ? "كريدت" : "credits"}`);
        expect(body, `${lang} ${may}`).not.toContain("{hold}");
        expect(text(t, "chat_credits", may)[1], `${lang} ${may}`).toContain(`${HOLD} ${lang === "ar" ? "كريدت" : "credits"}`);
        // The balance must hold at least that much; nothing is taken or held before the message.
        expect(body, `${lang} ${may}`).toMatch(lang === "ar" ? /(على الأقل|أقل من 7 كريدت)/ : /(at least 7 credits|below the 7 credits)/);
      }
    }
    expect(en.limit.chatCreditsBody).toContain("needs at least {hold} credits in your balance");
    expect(en.limit.chatCreditsBody).toContain("billed what it actually cost, at most {hold} credits");
    expect(ar.limit.chatCreditsBody).toContain("تحتاج {hold} كريدت على الأقل في رصيدك");
    expect(ar.limit.chatCreditsBody).toContain("بما كلّفته فعلاً، {hold} كريدت على الأكثر");
  });

  it("chat turned off for the account (allowance 0): its own dialog, contact support, no renewal promised, no billing button", () => {
    for (const lang of LANGS) {
      const t = appDict[lang];
      for (const period of ["month", "trial"] as const) {
        expect(text(t, "chat", true, { period, allowance: 0 }), `${lang} ${period}`).toEqual([t.limit.chatOffTitle, t.limit.chatOffBody]);
        expect(text(t, "chat", false, { period, allowance: 0 }), `${lang} ${period}`).toEqual([t.limit.chatOffTitle, t.limit.askOwnerChatOff]);
      }
      for (const s of [t.limit.chatOffBody, t.limit.askOwnerChatOff]) {
        expect(s, lang).toMatch(lang === "ar" ? /الدعم/ : /support/);
        expect(s, lang).not.toMatch(/1st|أول الشهر/);
      }
      // Any other allowance keeps the month's dialog.
      expect(text(t, "chat", true, { period: "month", allowance: 250 }), lang).toEqual([t.limit.chatTitle, t.limit.chatBody]);
    }
    const src = readFileSync("src/components/app/LimitModal.tsx", "utf8");
    expect(src).toContain("if (open.allowance === 0) return [L.chatOffTitle, may ? L.chatOffBody : L.askOwnerChatOff];");
    expect(src).toContain('const act = may && !(kind === "chat" && open.allowance === 0);');
    expect(src).toContain("{!act ? null : kind === \"agent_cap\"");
  });

  it("the older kinds read as before", () => {
    for (const lang of LANGS) {
      const t = appDict[lang];
      expect(text(t, "credits", true), lang).toEqual([t.limit.creditsTitle, t.limit.creditsBody]);
      expect(text(t, "trial", false), lang).toEqual([t.limit.trialTitle, t.limit.askOwnerTrial]);
      expect(text(t, "agent_cap", true), lang).toEqual([t.limit.agentCapTitle, t.limit.agentCapBody]);
    }
  });

  it("the month's chat dialogs lead to the Subscription page", () => {
    const src = readFileSync("src/components/app/LimitModal.tsx", "utf8");
    expect(src).toContain('const cta = topup ? L.topup : (kind === "chat" && open.period !== "trial") || kind === "chat_credits" ? L.billing : L.plans;');
    // Out of credits on a paid plan, the same page at its top-up packs (rule 450, tests/topups.test.ts).
    expect(src).toContain("<Link href={`/${lang}/app/billing${topup ? \"#topup\" : \"\"}`} className=\"btn btn-primary\">{cta}</Link>");
  });
});

describe("the copy: both languages, no typed numbers, chat outside the agent caps (rule 315)", () => {
  const CHAT_KEYS = ["chatLeft", "chatLeftTrial", "chatOut", "chatOutTrial", "chatOnCredits", "chatPausedCredits", "chatOff", "notSent", "slowDown"] as const;
  const LIMIT_KEYS = ["chatTitle", "chatBody", "askOwnerChat", "chatTrialTitle", "chatTrialBody", "askOwnerChatTrial", "chatCreditsTitle", "chatCreditsBody", "askOwnerChatCredits", "chatOffTitle", "chatOffBody", "askOwnerChatOff", "billing"] as const;

  it("both dictionaries carry every new string, with its placeholders", () => {
    for (const lang of LANGS) {
      const t = appDict[lang];
      for (const k of CHAT_KEYS) expect(t.chat[k], `${lang} chat.${k}`).toMatch(/\S/);
      for (const k of LIMIT_KEYS) expect(t.limit[k], `${lang} limit.${k}`).toMatch(/\S/);
      for (const k of ["chatLeft", "chatLeftTrial"] as const) for (const ph of ["{left}", "{allowance}"]) expect(t.chat[k], `${lang} ${k}`).toContain(ph);
      for (const k of ["chatOut", "chatOutTrial", "chatOnCredits", "chatPausedCredits"] as const) expect(t.chat[k], `${lang} ${k}`).toContain("{allowance}");
      for (const k of ["chatOnCredits", "chatPausedCredits"] as const) expect(t.chat[k], `${lang} ${k}`).toContain("{hold}");
      for (const k of ["chatCreditsBody", "askOwnerChatCredits"] as const) expect(t.limit[k], `${lang} ${k}`).toContain("{hold}");
    }
    expect(Object.keys(ar.chat).sort()).toEqual(Object.keys(en.chat).sort());
    expect(Object.keys(ar.limit).sort()).toEqual(Object.keys(en.limit).sort());
  });

  it("no allowance or hold is typed into the new strings: they come from the server's status and pricing.ts (rule 248)", () => {
    const numbers = [...Object.values(CHAT_ALLOWANCE), HOLD].flatMap((n) => [String(n), formatCount(n)]);
    const re = new RegExp(`(^|[^\\d{])(${[...new Set(numbers)].map((n) => n.replace(",", "\\,")).join("|")})(?![\\d}])`);
    for (const lang of LANGS) {
      const t = appDict[lang];
      for (const s of [...CHAT_KEYS.map((k) => t.chat[k]), ...LIMIT_KEYS.map((k) => t.limit[k])]) expect(s, `${lang}: ${s}`).not.toMatch(re);
    }
  });

  it("no chat string says credits are held or given back, or guesses what a message usually costs (rule 310)", () => {
    const HELD = /\b(held|holds|hold back|reserved?)\b|comes? back|given back|returned|usually|typically|(تحجز|تُحجز|يُحجز|يحجز|يُعاد|يعود|تعود|عادةً|غالباً)/i;
    for (const lang of LANGS) {
      const t = appDict[lang];
      for (const s of [t.chat.chatOnCredits, t.chat.chatPausedCredits, t.limit.chatCreditsBody, t.limit.askOwnerChatCredits]) expect(s.replace(/\{hold\}/g, ""), `${lang}: ${s}`).not.toMatch(HELD);
    }
  });

  it("Governance says chat messages are not counted in agent caps, while generation asked for in chat is", () => {
    expect(en.governance.agentCapsSub).not.toMatch(/Chat is not charged/);
    expect(en.governance.agentCapsSub).toMatch(/including what you ask for in chat[\s\S]*Chat messages themselves do not count toward a cap: they have their own monthly allowance/);
    expect(ar.governance.agentCapsSub).not.toMatch(/الدردشة لا تخصم كريدت/);
    expect(ar.governance.agentCapsSub).toMatch(/ومنها ما تطلبه في الدردشة[\s\S]*رسائل الدردشة نفسها لا تُحسب في هذا الحد/);
  });

  it("the client components import only the ChatStatus type from the server-only allowance module", () => {
    for (const f of ["src/components/app/ChatPanel.tsx", "src/components/app/LimitModal.tsx"]) {
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n").filter((l) => /from\s+["']@\/lib\/chat-allowance["']/.test(l));
      expect(lines.length, f).toBe(1);
      for (const l of lines) expect(l, f).toMatch(/^import type \{ ChatStatus \} from "@\/lib\/chat-allowance";$/);
      expect(src, f).not.toMatch(/import\(["']@\/lib\/chat-allowance["']\)|require\(["']@\/lib\/chat-allowance["']\)/);
    }
  });
});
