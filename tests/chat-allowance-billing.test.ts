import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "@/lib/db";
import { saveUser, type User } from "@/lib/auth";
import { CHAT_ALLOWANCE, chatOverflowHold, formatCount } from "@/lib/pricing";
import { chatCredKey, chatMsgKey, chatOverKey, chatTrialKey } from "@/lib/usage";
import type { ChatStatus } from "@/lib/chat-allowance";
import { chatHoldFor, chatPremiumHold } from "@/lib/models/credits";
import ChatAllowanceCard from "@/components/app/ChatAllowanceCard";
import { json, newMember, newUser, signIn, signOut } from "./helpers/session";
import * as profileRoute from "@/app/api/profile/route";
import * as overflowRoute from "@/app/api/billing/chat-overflow/route";
import BillingPage from "@/app/[lang]/app/billing/page";

// The billing page also renders client components that read the router (the partner-code field of a trial owner,
// src/components/app/PartnerCodeForm.tsx); outside Next there is none. Server-only helpers (redirect, notFound) stay real.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/app/billing",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * Rule 315: what the owner (and every seat) is shown about the account's chat messages. The profile API carries the
 * status for everyone in the account; the billing page shows messages used of the allowance, the period, the runway and
 * what happens when they run out, with the "continue on credits" switch for the owner of a paid plan only. Every number
 * comes from the status (src/lib/chat-allowance.ts), never the copy.
 */

type AsyncPage = (p: { params: Promise<{ lang: string }> }) => Promise<ReactElement>;
const billing = async (lang: "ar" | "en" = "en") => renderToStaticMarkup(await (BillingPage as unknown as AsyncPage)({ params: Promise.resolve({ lang }) }));
const profile = async () => (await (await profileRoute.GET()).json()) as { ok: boolean; chat?: ChatStatus };
/** React escapes apostrophes in text; compare against what the markup really contains. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An owner on `plan` with `used` messages counted this period (and `over` continued on credits, billed `billed` credits). */
async function account(plan: User["plan"] = "starter", used = 0, extra: Partial<User> = {}, over = 0, billed = 0): Promise<User> {
  const u = await newUser("cab");
  const saved = { ...u, plan, credits: 300, ...extra };
  await saveUser(saved);
  if (used) await db.set(plan === "trial" ? chatTrialKey(u.email) : chatMsgKey(u.email), used);
  if (over) await db.set(chatOverKey(u.email), over);
  if (billed) await db.set(chatCredKey(u.email), billed);
  return saved;
}
const HOLD = chatOverflowHold();

describe("rule 315: GET /api/profile carries the account's chat messages", () => {
  it("the owner and a member see the same status: the allowance is the account's", async () => {
    const o = await account("starter", 7);
    await signIn(o.email);
    const mine = await profile();
    expect(mine.ok).toBe(true);
    expect(mine.chat).toEqual({ used: 7, allowance: CHAT_ALLOWANCE.starter, left: CHAT_ALLOWANCE.starter - 7, counted: 7, period: "month", overflow: { on: false, available: true, used: 0, credits: 0, hold: HOLD } });
    for (const role of ["member", "admin"] as const) {
      const m = await newMember(o, role);
      await signIn(m.email);
      const theirs = await profile();
      expect(theirs.ok, role).toBe(true);
      expect(theirs.chat, role).toEqual(mine.chat);
    }
  });

  it("a trial counts once for the trial, with no over-allowance option", async () => {
    const o = await account("trial", 4);
    await signIn(o.email);
    const j = await profile();
    expect(j.chat).toMatchObject({ used: 4, allowance: CHAT_ALLOWANCE.trial, left: CHAT_ALLOWANCE.trial - 4, period: "trial" });
    expect(j.chat?.overflow.available).toBe(false);
  });

  it("messages continued on credits this month, and the credits they were billed, are reported; a founder override is the allowance shown", async () => {
    const o = await account("pro", 40, { chatOverflow: true, chatAllowance: 40 }, 3, 4);
    await signIn(o.email);
    const j = await profile();
    expect(j.chat).toMatchObject({ used: 40, allowance: 40, left: 0, counted: 40, overflow: { on: true, available: true, used: 3, credits: 4, hold: HOLD } });
  });

  it("an allowance lowered below what was already counted: `used` stops at the allowance, `counted` keeps the raw count", async () => {
    const o = await account("starter", 60, { chatAllowance: 50 });
    await signIn(o.email);
    expect((await profile()).chat).toMatchObject({ used: 50, allowance: 50, left: 0, counted: 60 });
  });

  it("signed out: 401, no status", async () => {
    signOut();
    const res = await profileRoute.GET();
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("chat");
  });
});

describe("rule 315: the billing page's chat card", () => {
  it("the owner of a paid plan: used of allowance, the renewal, and the continue-on-credits switch with its cost", async () => {
    const o = await account("starter", 12);
    await signIn(o.email);
    const h = await billing();
    expect(h).toContain("data-chat-allowance");
    expect(h).toContain(`${formatCount(12)} / ${formatCount(CHAT_ALLOWANCE.starter)}`);
    expect(h).toContain("They renew on the 1st of each month (UTC)");
    expect(h).toContain('role="switch"');
    expect(h).toContain('aria-checked="false"');
    expect(h).toContain("Off (the default)");
    // The terms: the least the balance must hold, and the most a message is billed, from pricing.ts; nothing is held.
    expect(h).toContain(`each extra message needs at least ${HOLD} credits in your balance and is billed what it actually cost, at most ${HOLD} credits.`);
    expect(h).toContain(`With fewer than ${HOLD} credits in your balance, chat pauses.`);
    expect(h).not.toMatch(/held before|comes back|usually under one credit/);
    const ar = await billing("ar");
    expect(ar).toContain(`تحتاج كل رسالة إضافية ${HOLD} كريدت على الأقل في رصيدك، وتُحسب بما كلّفته فعلاً، ${HOLD} كريدت على الأكثر.`);
    expect(ar).not.toMatch(/يُحجز|تُحجز|ويعود ما لم|عادةً أقل من كريدت/);
    expect(h).not.toContain("The account owner decides this.");
    // Its own markup: the plan cards are still found by data-tier, and the card adds none.
    expect(h.split('data-tier="').length - 1).toBe(4);
  });

  it("turning it on through the route is what the page then shows", async () => {
    const o = await account("pro", 3);
    await signIn(o.email);
    const res = await overflowRoute.POST(json("/api/billing/chat-overflow", "POST", { on: true }));
    expect(res.status).toBe(200);
    const h = await billing();
    expect(h).toContain('aria-checked="true"');
    expect(h).toContain(esc("On: when the messages run out, chat continues on the account's credits."));
  });

  it("an admin and a member see the setting read-only, with no switch", async () => {
    const o = await account("business", 0, { chatOverflow: true });
    for (const role of ["admin", "member"] as const) {
      const m = await newMember(o, role);
      await signIn(m.email);
      const h = await billing();
      expect(h, role).toContain("data-chat-allowance");
      expect(h, role).toContain(`0 / ${formatCount(CHAT_ALLOWANCE.business)}`);
      expect(h, role).not.toContain('role="switch"');
      expect(h, role).toContain(esc("On: when the messages run out, chat continues on the account's credits."));
      expect(h, role).toContain("The account owner decides this.");
    }
  });

  it("a trial: no switch, the trial's messages and when it ends", async () => {
    const o = await account("trial", 2);
    await signIn(o.email);
    for (const lang of ["en", "ar"] as const) {
      const h = await billing(lang);
      expect(h, lang).not.toContain('role="switch"');
      expect(h, lang).toContain(lang === "en"
        ? `Your trial includes ${formatCount(CHAT_ALLOWANCE.trial)} messages for the whole trial (ends ${o.trialEnds.slice(0, 10)}).`
        : `تجربتك تشمل ${formatCount(CHAT_ALLOWANCE.trial)} رسالة لفترة التجربة كلها (تنتهي ${o.trialEnds.slice(0, 10)}).`);
    }
  });

  it("used up and paused: the bar is full and the page says until when, in both languages", async () => {
    const o = await account("starter", CHAT_ALLOWANCE.starter);
    await signIn(o.email);
    const en = await billing("en");
    expect(en).toContain("This month&#x27;s messages are used up: chat is paused until ");
    expect(en).toContain("width:100%");
    const ar = await billing("ar");
    expect(ar).toContain("استُخدمت رسائل هذا الشهر: الدردشة متوقفة حتى ");
    expect(ar).toContain("رسائل الدردشة");
  });

  it("the numbers are the status's: a founder override shows as the allowance", async () => {
    const o = await account("starter", 5, { chatAllowance: 77 });
    await signIn(o.email);
    expect(await billing()).toContain(`${formatCount(5)} / ${formatCount(77)}`);
  });

  it("messages continued on credits: how many, and the credits they were billed this month", async () => {
    const o = await account("pro", CHAT_ALLOWANCE.pro, { chatOverflow: true }, 3, 4);
    await signIn(o.email);
    expect(await billing("en")).toContain("3 more this month, continued on credits: 4 credits billed.");
    expect(await billing("ar")).toContain("3 رسالة إضافية هذا الشهر على الكريدت، خُصم عليها 4 كريدت.");
  });

  it("used up with the switch on but the balance below the hold: the card says chat is paused, not that it continues", async () => {
    const o = await account("pro", CHAT_ALLOWANCE.pro, { chatOverflow: true, credits: HOLD - 1 });
    await signIn(o.email);
    const en = await billing("en");
    expect(en).toContain(esc(`This month's messages are used up, and chat is paused: your balance is below the ${HOLD} credits a message on credits needs.`));
    expect(en).not.toContain(esc("chat continues on credits until the renewal"));
    const ar = await billing("ar");
    expect(ar).toContain(`استُخدمت رسائل هذا الشهر، والدردشة متوقفة: رصيدك أقل من ${HOLD} كريدت`);
    // With enough credits, the same account continues on credits.
    const rich = await account("pro", CHAT_ALLOWANCE.pro, { chatOverflow: true, credits: HOLD });
    await signIn(rich.email);
    expect(await billing("en")).toContain(esc("This month's messages are used up: chat continues on credits until the renewal."));
  });

  it("chat turned off for the account (a founder override of 0): not available, contact support, no renewal date", async () => {
    const o = await account("starter", 0, { chatAllowance: 0 });
    await signIn(o.email);
    const en = await billing("en");
    expect(en).toContain("Chat is not available on this account. Contact support.");
    expect(en).not.toMatch(/chat is paused until|chat pauses until the 1st/);
    expect(en).toContain("Off: this account has no chat messages at the moment.");
    expect(await billing("ar")).toContain("الدردشة غير متاحة في هذا الحساب. تواصل مع الدعم.");
  });

  it("a trial already past its end: no runway line promising a day that is gone", async () => {
    const o = await account("trial", 10, { trialEnds: new Date(Date.now() - 2 * 864e5).toISOString() });
    await signIn(o.email);
    for (const lang of ["en", "ar"] as const) {
      const h = await billing(lang);
      expect(h, lang).toContain("data-chat-allowance");
      expect(h, lang).not.toMatch(lang === "en" ? /At this pace your messages/ : /بهذا المعدل/);
    }
  });
});

describe("rule 907: the billing card names the hold of a conversation on a Premium model", () => {
  // The account-level status carries the default model's hold (2). A conversation the owner set to Opus 5.5 needs 4 past
  // the allowance (`chatHoldFor`), so the card says so too, with a number the server fills from the catalog.
  const status = (hold: number, period: ChatStatus["period"] = "month"): ChatStatus => ({
    used: 10, allowance: 250, left: 240, counted: 10, period, overflow: { on: true, available: period === "month", used: 0, credits: 0, hold },
  });
  const card = (props: Partial<Parameters<typeof ChatAllowanceCard>[0]>) =>
    renderToStaticMarkup(createElement(ChatAllowanceCard, { lang: "en", status: status(HOLD), owner: true, nextReset: "2026-11-01", trialEnds: "2026-10-20", runway: null, ...props }));

  it("chatPremiumHold is the largest hold of a Premium model a customer may pick for chat: Opus 5.5's, above the default's", () => {
    expect(chatPremiumHold()).toBe(chatHoldFor("claude-opus-5-5"));
    expect(chatPremiumHold()).toBe(4);
    expect(chatPremiumHold()).toBeGreaterThan(HOLD);
  });

  it("the page gives a paid plan's card one more terms line, the Premium hold, in both languages", async () => {
    const o = await account("starter", 12);
    await signIn(o.email);
    const h = await billing();
    expect(h).toContain("data-chat-overflow-premium");
    expect(h).toContain(`In a conversation you set to a Premium model, each extra message needs at least ${chatPremiumHold()} credits in your balance and is billed what it actually cost, at most ${chatPremiumHold()} credits.`);
    // The default's terms are untouched.
    expect(h).toContain(`each extra message needs at least ${HOLD} credits in your balance and is billed what it actually cost, at most ${HOLD} credits.`);
    const ar = await billing("ar");
    expect(ar).toContain("data-chat-overflow-premium");
    expect(ar).toContain(`في المحادثة التي تختار لها نموذجاً متقدّماً: تحتاج كل رسالة إضافية ${chatPremiumHold()} كريدت على الأقل في رصيدك، وتُحسب بما كلّفته فعلاً، ${chatPremiumHold()} كريدت على الأكثر.`);
  });

  it("an admin and a member are told too (the terms are not a setting)", async () => {
    const o = await account("business", 0);
    const m = await newMember(o, "member");
    await signIn(m.email);
    expect(await billing()).toContain("data-chat-overflow-premium");
  });

  it("no line when the Premium hold is not above the default's, when the server gave none, or on a trial", () => {
    expect(card({ premiumHold: 4 })).toContain("data-chat-overflow-premium");
    expect(card({ premiumHold: HOLD })).not.toContain("data-chat-overflow-premium");
    expect(card({ premiumHold: undefined })).not.toContain("data-chat-overflow-premium");
    expect(card({ premiumHold: Number.NaN })).not.toContain("data-chat-overflow-premium");
    expect(card({ premiumHold: 4, status: status(HOLD, "trial") })).not.toContain("data-chat-overflow-premium");
  });

  it("the number is the server's: the card carries no hold of its own", () => {
    const html = card({ premiumHold: 9 });
    expect(html).toContain("needs at least 9 credits in your balance and is billed what it actually cost, at most 9 credits.");
    expect(readFileSync("src/components/app/ChatAllowanceCard.tsx", "utf8")).not.toMatch(/models\/credits|models\/catalog/);
    expect(readFileSync("src/app/[lang]/app/billing/page.tsx", "utf8")).toMatch(/<ChatAllowanceCard [^>]*premiumHold=\{chatPremiumHold\(\)\}/);
  });
});

describe("rule 315: the client card and the profile panel, by source", () => {
  const card = readFileSync("src/components/app/ChatAllowanceCard.tsx", "utf8");
  const panel = readFileSync("src/components/app/ProfilePanel.tsx", "utf8");
  const page = readFileSync("src/app/[lang]/app/billing/page.tsx", "utf8");
  const SERVER = ["@/lib/chat-allowance", "@/lib/db", "@/lib/auth", "@/lib/credits", "@/lib/usage", "@/lib/chat", "@/lib/roles", "@/lib/team"];
  const valueImports = (src: string) => src.split("\n").filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s+type\s/.test(l)).map((l) => /from\s+["']([^"']+)["']/.exec(l)?.[1]).filter((s): s is string => !!s);

  it("the card is a client component that imports only types from server-only code", () => {
    expect(card).toMatch(/^\s*["']use client["']/);
    expect(valueImports(card).filter((s) => SERVER.includes(s))).toEqual([]);
    expect(card).toMatch(/import type \{ ChatStatus \} from "@\/lib\/chat-allowance"/);
    // The profile panel is a client component too.
    expect(valueImports(panel).filter((s) => SERVER.includes(s))).toEqual([]);
  });

  it("the switch posts the owner's boolean to /api/billing/chat-overflow and renders for the owner only", () => {
    expect(card).toContain('fetch("/api/billing/chat-overflow", { method: "POST"');
    expect(card).toContain("JSON.stringify({ on })");
    expect(card).toMatch(/\{owner && \(\s*<button type="button" role="switch"/);
    // The page decides who the owner is with the same check the route makes.
    expect(page).toContain('const owner = can(u, "billing");');
    expect(page).toMatch(/<ChatAllowanceCard [^>]*owner=\{owner\}/);
    // The seats and the chat status are read together in one place, `entitlementView` (one Promise.all, rule 784), once
    // for the whole page (rule 785); the chat card takes the status from that view.
    expect(page).toMatch(/const view = await entitlementView\(u\);/);
    expect(page).toMatch(/const \{ seats: used, chat \} = view\.used;/);
    expect(page).toMatch(/<ChatAllowanceCard [^>]*status=\{chat\}/);
    // The view reads the status for the default chat model, the hold the account-level cards show; the billing card adds the
    // Premium hold as its own line (rule 907), the founder console and the profile row keep the default's (tests.md rule 833).
    expect(readFileSync("src/lib/entitlements.ts", "utf8")).toContain('chatStatus(u, route("chat").model)');
  });

  it("the profile's chat row is the account's count, not a typed 0 credits each", () => {
    const row = panel.split("\n").find((l) => l.includes("data-chat-row"));
    expect(row).toBeDefined();
    expect(row).toContain("chat.used");
    expect(row).toContain("chat.allowance");
    // Credits billed for chat this month count in the credits used (the bar and its runway) and in the overflow row.
    expect(panel).toMatch(/const usedCredits = [^\n]*\+ mediaUsed \+ chatCredits;/);
    expect(panel).toContain("chat.overflow.credits");
    const over = panel.split("\n").find((l) => l.includes("data-chat-overflow-row"));
    expect(over).toContain("data-chat-overflow-credits");
    expect(over).toContain("formatCount(chatCredits)");
    // The runway knows when chat is paused for a low balance, or off for the account.
    expect(panel).toContain("shortOf: short ? chat.overflow.hold : undefined");
    expect(panel).toContain("chatOff");
    // Runway lines under the credit bar and the chat bar, from the shared helper.
    expect(panel).toContain('what: "credits"');
    expect(panel).toContain('what: "messages"');
    expect(panel).toContain('data-runway="credits"');
    expect(panel).toContain('data-runway="messages"');
  });

  it("no locale date formatter in what this rule renders: dates stay YYYY-MM-DD", () => {
    for (const src of [card, panel, page]) expect(src).not.toMatch(/new Intl\.DateTimeFormat|toLocale(Date|Time)?String/);
  });
});
