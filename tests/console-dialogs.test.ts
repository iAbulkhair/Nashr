// Founder console changes in one in-page form (rules 1100-1102, docs/system/tests/1100-console-dialogs.md): the form's
// bookkeeping and parsers driven directly, the components read as source (no DOM in this suite).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { formGate, formReady, initialValues, type FieldSpec } from "@/components/admin/ActionDialog";
import { parseChat, parseCreditDelta, parseDealForm, parseRefundForm, parseSeats, parseTopupForm } from "@/lib/admin-input";
import { AGENCY_MIN, MAX_SEAT_OVERRIDE, TOPUP_PACKS, topupPriceSar } from "@/lib/pricing";

const read = (f: string) => readFileSync(f, "utf8");
const users = read("src/components/admin/Users.tsx");
const dialog = read("src/components/admin/ActionDialog.tsx");
/** One handler's source, from `async function name(` to its `if (!v` guard: the form it asks, and nothing it sends. */
const handler = (fn: string) => {
  const at = users.indexOf(`async function ${fn}(`);
  expect(at, fn).toBeGreaterThan(0);
  return users.slice(at, users.indexOf("if (!v", at));
};

describe("rule 1100: a cancelled form sends nothing, and one form is open at a time", () => {
  it("opens a native <dialog> with showModal, and Escape and Cancel answer null", () => {
    expect(dialog).toMatch(/d\.showModal\(\)/);
    expect(dialog).toMatch(/onClose=\{\(\) => answer\(null\)\}/);
    expect(dialog).toMatch(/<button type="button" onClick=\{\(\) => answer\(null\)\} className="btn btn-secondary btn-sm">\{S\.cancel\}<\/button>/);
    // The answer is given once: the close event that close() itself fires after a submit is ignored.
    expect(dialog).toMatch(/if \(answered\.current\) return;\n\s*answered\.current = true;/);
    // A refused value keeps the form open with its error.
    expect(dialog).toMatch(/if \(!p\.ok\) \{ setErr\(p\.error\); return; \}/);
  });

  it("answers a second question asked while one is open with null at once, and a late answer does nothing", async () => {
    const gate = formGate();
    const shown: number[] = [];
    const first = gate.ask<{ a: number }>((n) => shown.push(n));
    expect(await gate.ask((n) => shown.push(n))).toBeNull();
    expect(shown).toEqual([1]);
    gate.answer({ a: 1 });
    expect(await first).toEqual({ a: 1 });
    gate.answer({ a: 2 });
    const cancelled = gate.ask((n) => shown.push(n));
    gate.answer(null);
    expect(await cancelled).toBeNull();
    expect(shown).toEqual([1, 2]);
  });
});

describe("rule 1101: each multi-field change is one form, checked before it closes", () => {
  it("asks the top-up's pack, amount, date, reference and reason in one form, the amount following the pack", () => {
    const src = handler("addTopup");
    for (const f of ["pack", "paid", "date", "ref"]) expect(src, f).toContain(`name: "${f}"`);
    expect(src).toContain("REASON");
    expect(src).toMatch(/follow: \(f\) => \(isTopupPack\(Number\(f\.pack\)\) \? String\(topupPriceSar\(Number\(f\.pack\)\)\)/);
    const fields: FieldSpec[] = [
      { name: "pack", label: "", initial: String(TOPUP_PACKS[1]) },
      { name: "paid", label: "", follow: (v) => String(topupPriceSar(Number(v.pack))) },
    ];
    expect(initialValues(fields)).toEqual({ pack: String(TOPUP_PACKS[1]), paid: String(topupPriceSar(TOPUP_PACKS[1])) });
    expect(dialog).toMatch(/if \(f\.follow && !touched\.current\.has\(f\.name\)\) next\[f\.name\] = f\.follow\(next\);/);
  });

  it("asks the deal's credits, price, apply-now, seats and reason in one form", () => {
    const src = handler("setDeal");
    for (const f of ["credits", "price", "applyNow", "seats"]) expect(src, f).toContain(`name: "${f}"`);
    expect(src).toContain("REASON");
    // Apply-now is offered only for a change to an existing deal; the first deal always applies.
    expect(src).toMatch(/\.\.\.\(u\.deal \? \[\{ name: "applyNow", label: S\.dealApplyNow, kind: "check" \}/);
  });

  it("asks the refund's date, reference and reason in one form that shows the amount", () => {
    const src = handler("refundTopup");
    for (const f of ["date", "ref"]) expect(src, f).toContain(`name: "${f}"`);
    expect(src).toContain("REASON");
    expect(src).toMatch(/message: S\.confirmRefund\(l\.left, l\.credits, sarText\(unusedRefundSar\(l\)\)\)/);
  });

  it("keeps the old checks: seats, chat, deal, credits, pack, amount, reference", () => {
    expect(parseSeats("0")).toEqual({ ok: true, value: { seats: null } });
    expect(parseSeats(" 7 ")).toEqual({ ok: true, value: { seats: 7 } });
    for (const bad of ["", "abc", "2.5", "-1", String(MAX_SEAT_OVERRIDE + 1)]) expect(parseSeats(bad), bad).toEqual({ ok: false, error: "bad_seats" });

    for (const clear of ["", " plan ", "PLAN", "الخطة"]) expect(parseChat(clear), clear).toEqual({ ok: true, value: { chatAllowance: null } });
    expect(parseChat("0")).toEqual({ ok: true, value: { chatAllowance: 0 } });
    for (const bad of ["-1", "1.5", "abc", "100001"]) expect(parseChat(bad), bad).toEqual({ ok: false, error: "bad_chat" });

    const deal = (credits: string, price: string, seats = "", applyNow = false, has = true) => parseDealForm({ credits, price, seats, applyNow }, has);
    expect(deal(" ", "x")).toEqual({ ok: true, value: { deal: null } });
    expect(deal("2000", "1332", "", false, false)).toEqual({ ok: true, value: { deal: { credits: 2000, priceSar: 1332 }, plan: "agency" } });
    expect(deal("2000", "1332")).toEqual({ ok: true, value: { deal: { credits: 2000, priceSar: 1332 } } });
    expect(deal("2000", "1332", "12", true)).toEqual({ ok: true, value: { deal: { credits: 2000, priceSar: 1332 }, plan: "agency", seats: 12 } });
    expect(deal(String(AGENCY_MIN.credits * 2), String(AGENCY_MIN.priceSar))).toEqual({ ok: false, error: "below_floor" });
    expect(deal("abc", "1332")).toEqual({ ok: false, error: "bad_deal" });
    expect(deal("2000", "1332", "0")).toEqual({ ok: false, error: "bad_seats" });

    expect(parseCreditDelta("-50")).toEqual({ ok: true, value: { addCredits: -50 } });
    for (const bad of ["", "0", "abc"]) expect(parseCreditDelta(bad), bad).toEqual({ ok: false, error: "bad_credits" });

    const topup = (pack: string, paid: string) => parseTopupForm({ pack, paid, date: " 2026-10-11 ", ref: "TR-1" });
    expect(topup("1,000", "0")).toEqual({ ok: true, value: { credits: 1000, paidSar: 0, paidOn: "2026-10-11", ref: "TR-1" } });
    expect(topup("123", "100")).toEqual({ ok: false, error: "bad_pack" });
    for (const bad of ["", "-1", "abc"]) expect(topup("100", bad), bad).toEqual({ ok: false, error: "bad_paid" });

    expect(parseRefundForm({ date: "2026-10-11", ref: "  " })).toEqual({ ok: false, error: "bad_ref" });
    expect(parseRefundForm({ date: " 2026-10-11", ref: "TR-9" })).toEqual({ ok: true, value: { on: "2026-10-11", ref: "TR-9" } });
  });
});

describe("rule 1102: deleting and removing need the email typed, and money-out forms are marked", () => {
  it("keeps the submit button off until the type-to-confirm field holds the email", () => {
    const fields: FieldSpec[] = [{ name: "email", label: "", mustMatch: "owner@example.com" }];
    expect(formReady(fields, { email: "" })).toBe(false);
    expect(formReady(fields, { email: "owner@example.co" })).toBe(false);
    expect(formReady(fields, { email: " Owner@Example.com " })).toBe(true);
    expect(formReady([{ name: "reason", label: "" }], { reason: "" })).toBe(true);
    expect(dialog).toMatch(/<button type="submit" disabled=\{!ready\}/);
    expect(dialog).toMatch(/if \(!ready \|\| answered\.current\) return;/);
  });

  it("asks for the account's or the member's own email, and shows void, refund, delete and removal as destructive", () => {
    expect(handler("deleteAccount")).toMatch(/destructive: true, fields: \[\{ name: "email", label: S\.promptDelete, ltr: true, mustMatch: email \}\]/);
    expect(handler("removeMember")).toMatch(/destructive: true, fields: \[\{ name: "email", label: S\.promptRemoveMember, ltr: true, mustMatch: email \}, REASON\]/);
    for (const fn of ["voidTopup", "refundTopup"]) expect(handler(fn), fn).toContain("destructive: true");
    expect(users).toMatch(/onClick=\{\(\) => deleteAccount\(sel\.user\.email\)\}/);
    expect(users).toMatch(/onClick=\{\(\) => removeMember\(memberSel\.email\)\}/);
  });
});
