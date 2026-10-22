// The app's own confirmation dialog and password field (supastarter adoption, work package 4). Source-reading checks
// for the panels and forms, plus the dialog's answer bookkeeping driven directly (no DOM in this suite).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { confirmGate } from "@/components/app/ConfirmDialog";
import { PASSWORD_TOGGLE } from "@/components/app/PasswordField";
import { appDict } from "@/lib/app-i18n";

const read = (f: string) => readFileSync(f, "utf8");
// WishlistPanel moved to the founder console's folder (rule 1181); the others are app panels.
const app = (name: string) => read(name === "WishlistPanel" ? "src/components/admin/WishlistPanel.tsx" : `src/components/app/${name}.tsx`);
const count = (src: string, re: RegExp) => src.match(re)?.length ?? 0;
// A call to the browser's confirm: `confirm(` or `window.confirm(`, not `askConfirm(`, `.confirm(` on another object
// or a `confirm:` key in a dictionary.
const NATIVE_CONFIRM = /(?<![\w$])(?:window\.)?confirm\(/;
// Physical direction utilities: margin, padding, inset and text alignment that do not flip in Arabic.
const PHYSICAL = /(?<![\w-])-?(?:ml|mr|pl|pr|left|right|rounded-l|rounded-r|border-l|border-r|text-left|text-right|float-left|float-right)(?:-[\w./[\]]+)?(?![\w-])/;

describe("rule 695: the Team, Files, Governance and Wishlist panels confirm in the app's own dialog, never the browser's confirm()", () => {
  // GovernancePanel: the restore question, and the auto-run question it asks from two places through askAutoHandoff.
  // TeamPanel's fourth: offering the account's ownership (multi-workspace M3, rule 2750).
  // WorkspacesPanel: deleting one's own login (multi-workspace M3, rule 2754).
  const PANELS = { TeamPanel: 4, FilesPanel: 1, GovernancePanel: 2, WishlistPanel: 1, WorkspacesPanel: 1 } as const;

  it("no panel calls the browser's confirm, and each asks through useConfirm and renders its dialog", () => {
    for (const [name, asks] of Object.entries(PANELS)) {
      const src = app(name);
      expect(src, name).not.toMatch(NATIVE_CONFIRM);
      expect(src, name).toContain(name === "WishlistPanel" ? 'import { useConfirm } from "../app/ConfirmDialog";' : 'import { useConfirm } from "./ConfirmDialog";');
      expect(src, name).toContain("const [ask, confirmDialog] = useConfirm();");
      expect(count(src, /\bask\(\{/g), name).toBe(asks);
      expect(count(src, /\{confirmDialog\}/g), `${name} renders the dialog once`).toBe(1);
    }
  });

  it("each question keeps the message the browser's confirm showed", () => {
    const team = app("TeamPanel");
    expect(team).toContain("message: fill(T.confirmRemove, { name: label })");
    expect(team).toContain("message: fill(T.confirmCancel, { email: inv.email })");
    expect(team).toContain("message: T.confirmLeave");
    expect(team).toContain("message: fill(T.confirmTransfer, { email: xTo })");
    expect(app("WorkspacesPanel")).toContain("message: t.delConfirm, confirmLabel: t.delSubmit, cancelLabel: back, destructive: true");
    expect(app("FilesPanel")).toContain("message: `${f.delete} ${name}?`");
    expect(app("WishlistPanel")).toContain("message: L.confirmDel");
    const gov = app("GovernancePanel");
    expect(gov).toContain("message: g.restoreConfirm");
    expect(gov).toContain("message: g.autoHandoffConfirm");
  });

  it("the action still runs only after a yes, and a seeded wish still hides without asking", () => {
    const team = app("TeamPanel");
    for (const fn of ["remove", "cancel", "leave", "offerTransfer"]) {
      const body = team.slice(team.indexOf(`function ${fn}(`));
      expect(body.slice(0, 400), fn).toMatch(/if \(!\(await ask\(\{[^\n]*\}\)\)\) return;/);
    }
    expect(app("FilesPanel")).toMatch(/if \(!\(await ask\(\{[^\n]*\}\)\)\) return;/);
    const ws = app("WorkspacesPanel");
    expect(ws.slice(ws.indexOf("function deleteLogin("), ws.indexOf("function deleteLogin(") + 400)).toMatch(/if \(!\(await ask\(\{[^\n]*\}\)\)\) return;/);
    expect(app("WishlistPanel")).toMatch(/if \(w\.seeded \|\| \(await ask\(\{[^\n]*\}\)\)\) void act\(\{ action: "delete", id: w\.id \}\)/);
    const gov = app("GovernancePanel");
    // Turning the auto-run switch on asks; turning it off does not. A restore that would turn it on asks the same question.
    expect(gov).toMatch(/if \(on && !\(await askAutoHandoff\(\)\)\) return;/);
    expect(count(gov, /askAutoHandoff\(\)/g), "the switch and the restore").toBe(2);
    expect(gov).toMatch(/if \(!\(await ask\(\{ title: g\.history, message: g\.restoreConfirm[^\n]*destructive: true \}\)\)\) return;/);
  });

  it("deletes, removals and cancellations are destructive questions; their way out is the dictionary's 'Go back'", () => {
    for (const name of ["TeamPanel", "FilesPanel"]) {
      const src = app(name);
      expect(count(src, /cancelLabel: t\.dialog\.back, destructive: true/g), name).toBe(PANELS[name as keyof typeof PANELS]);
    }
    expect(app("WishlistPanel")).toMatch(/confirmLabel: L\.del, cancelLabel: L\.back, destructive: true/);
    expect(appDict.ar.dialog.back).toMatch(/[؀-ۿ]/);
    expect(appDict.en.dialog.back).toBe("Go back");
    // "Cancel" would read as the Members page's own cancel-invite action.
    expect(appDict.ar.dialog.back).not.toBe(appDict.ar.team.cancel);
    expect(appDict.en.dialog.back).not.toBe(appDict.en.team.cancel);
  });

  it("the Governance dialog sits outside the fieldset, whose disabled state would reach its buttons", () => {
    const gov = app("GovernancePanel");
    expect(gov.lastIndexOf("{confirmDialog}")).toBeGreaterThan(gov.lastIndexOf("</fieldset>"));
  });

  it("the auto-run switch is disabled while a restore is in flight, so the restore's own question is never answered no by a busy dialog", () => {
    // One dialog at a time (confirmGate): a second question while one is open resolves false at once. A restore that
    // needs the auto-run question must not find the switch's question already open.
    const gov = app("GovernancePanel");
    expect(gov).toMatch(/<Switch label=\{g\.autoHandoff\} checked=\{gov\.majedAutoHandoff === true\} onChange=\{toggleAuto\} disabled=\{!!restoring\} \/>/);
    // The switch is the shared primitive now (rule 1085); it passes `disabled` to its button.
    expect(read("src/components/ui/Switch.tsx")).toMatch(/role="switch"[^>]*disabled=\{disabled\}/);
  });
});

describe("rule 696: the sign-up, login, reset, join and profile change-password inputs are PasswordFields with a show toggle that never submits", () => {
  // Seven fields: sign-up, login and reset in AuthForm, the invite form in JoinForm, and in Settings, Security (rule 1150,
  // where the old profile page's two moved) the current and new password and the password that confirms "sign out other
  // devices". Account deletion asks in its own masked dialog (rule 964).
  it("the forms use PasswordField and no bare password input remains", () => {
    for (const [name, n] of [["AuthForm", 3], ["JoinForm", 1], ["settings/SecuritySettings", 3]] as const) {
      const src = app(name);
      expect(src, name).not.toContain('type="password"');
      expect(src, name).toMatch(/import PasswordField from "\.\.?\/PasswordField";/);
      expect(count(src, /<PasswordField lang=\{lang\} /g), name).toBe(n);
    }
  });

  it("the login field is the account's current password; the new-password fields keep their refs and rule checks", () => {
    const auth = app("AuthForm");
    const login = auth.slice(auth.indexOf("export function LoginForm"), auth.indexOf("export function ForgotForm"));
    expect(login).toMatch(/<PasswordField [^\n]*name="password"[^\n]*autoComplete="current-password"/);
    const signup = auth.slice(auth.indexOf("export function SignupForm"), auth.indexOf("export function LoginForm"));
    expect(signup).toMatch(/<PasswordField lang=\{lang\} ref=\{pwRef\}[^\n]*autoComplete="new-password" value=\{pw\} onChange=\{\(e\) => setPw\(e\.target\.value\)\}[^\n]*aria-describedby="signup-rules"/);
    const reset = auth.slice(auth.indexOf("export function ResetForm"));
    expect(reset).toMatch(/<PasswordField lang=\{lang\} ref=\{pwRef\}[^\n]*autoFocus autoComplete="new-password" value=\{pw\}[^\n]*aria-describedby="reset-rules"/);
    expect(app("JoinForm")).toMatch(/<PasswordField lang=\{lang\} ref=\{pwRef\}[^\n]*autoComplete="new-password" value=\{pw\}[^\n]*aria-describedby="join-rules"/);
    const security = app("settings/SecuritySettings");
    expect(security).toMatch(/<PasswordField [^\n]*name="currentPassword" autoComplete="current-password"/);
    // The new password shows the sign-up rules live, from the same checks (rule 1150).
    expect(security).toMatch(/<PasswordField [^\n]*name="newPassword" autoComplete="new-password" value=\{pw\}[^\n]*aria-describedby="settings-pw-rules"/);
    expect(security).toMatch(/<PasswordRules id="settings-pw-rules" rules=\{rules\} checks=\{checks\}/);
  });

  it("the toggle is a button that never submits, says whether the password shows, and is named in both languages", () => {
    const src = app("PasswordField");
    expect(src).toMatch(/<button type="button" [^\n]*aria-pressed=\{shown\}/);
    expect(src).toContain("aria-label={PASSWORD_TOGGLE[lang]}");
    expect(src).toContain('type={shown ? "text" : "password"}');
    // The type is the field's own: a caller cannot pass one that would turn the toggle off.
    expect(src).toContain('Omit<React.ComponentProps<"input">, "type">');
    // Shown, it is a text field: no spellcheck service reads it and no keyboard capitalises or corrects it. The three
    // come after the spread, so a caller's props cannot turn them back on.
    expect(src).toMatch(/<input \{\.\.\.input\} [^\n]*spellCheck=\{false\} autoCapitalize="none" autoCorrect="off"/);
    // Submitting hides the password again.
    expect(src).toMatch(/form\.addEventListener\("submit", hide\)/);
    expect(src).toContain("form.removeEventListener(\"submit\", hide)");
    expect(PASSWORD_TOGGLE.ar).toMatch(/[؀-ۿ]/);
    expect(PASSWORD_TOGGLE.en).toBe("Show password");
  });

  it("the toggle sits at the inline end, the text never runs under it, and a shown password keeps the order it was typed in", () => {
    const src = app("PasswordField");
    expect(src).toMatch(/className="absolute inset-y-0 end-0 /);
    // plaintext orders the characters by their own direction but leaves the field's direction (the page's) alone, so
    // pe-10 and end-0 stay on the same side. A dir on the input would move its padding away from the button.
    expect(src).toContain("className={`${className} pe-10 [unicode-bidi:plaintext]`}");
    expect(src).not.toMatch(/<input [^\n]*\bdir=/);
  });
});

describe("rule 697: the confirm dialog is a native modal <dialog> that answers once; Escape or Go back answer no and a click outside it does nothing", () => {
  // Moved into src/components/ui in phase 2 (rule 1110); the app path re-exports it.
  const src = read("src/components/ui/ConfirmDialog.tsx");

  it("opens a native dialog with showModal, named and described for screen readers", () => {
    expect(src).toContain("<dialog");
    expect(src).toContain("d.showModal()");
    expect(src).toContain('role="alertdialog"');
    expect(src).toContain("aria-labelledby={`${id}-title`}");
    expect(src).toContain("aria-describedby={`${id}-message`}");
    expect(src).toContain('id={`${id}-title`}');
    expect(src).toContain('id={`${id}-message`}');
    // No npm package: React and nothing else.
    expect(src.match(/^import .* from "([^"]+)";$/gm)).toEqual(['import { useCallback, useEffect, useId, useRef, useState } from "react";']);
  });

  it("answers once: a ref marks the first answer and the confirm button is disabled after it", () => {
    expect(src).toContain("if (answered.current) return;");
    expect(src).toMatch(/onClick=\{\(e\) => press\(e, true\)\} disabled=\{sent\}/);
    // The dialog answers and never awaits the action, so a slow action cannot leave a live button behind it.
    expect(src).not.toMatch(/await\s+onAnswer|await\s+onConfirm/);
  });

  it("Escape (the dialog's close) and the way-out button answer no; focus starts on the way out for destructive questions", () => {
    expect(src).toContain("onClose={() => answer(false)}");
    expect(src).toMatch(/ref=\{cancelRef\} type="button" onClick=\{\(e\) => press\(e, false\)\}/);
    expect(src).toContain("(destructive ? cancelRef : okRef).current?.focus();");
    expect(src).toMatch(/destructive \? "btn-danger-solid" : "btn-primary"/);
  });

  it("a double click on the button that asked cannot answer: the backdrop does nothing and the buttons ignore a carried-over click", () => {
    // The dialog opens within the first click, so the second lands on the backdrop, which the browser reports as a click
    // on the <dialog> itself (as it does for a text selection released outside the box). The dialog has no click handler.
    const open = src.indexOf("<dialog\n");
    const dialogTag = src.slice(open, src.indexOf("\n    >", open));
    expect(dialogTag).toContain('role="alertdialog"');
    expect(dialogTag).not.toMatch(/onClick|onMouseDown|onPointerDown/);
    expect(src).not.toContain("e.target === e.currentTarget");
    // If the second click lands on a button instead, the browser counts it as the second of a multi-click (detail 2).
    // A first click reports 1 and keyboard activation 0, so both still answer.
    expect(src).toMatch(/function press\(e: React\.MouseEvent, ok: boolean\) \{\s*if \(e\.detail <= 1\) answer\(ok\);\s*\}/);
    expect(count(src, /onClick=\{\(e\) => press\(e, (?:true|false)\)\}/g)).toBe(2);
    expect(count(src, /onClick=/g), "no other click handler").toBe(2);
  });

  it("useConfirm wires the gate to the dialog: each question keys a fresh dialog, and its answer closes it and settles the gate", () => {
    // One gate per panel, kept across renders.
    expect(src).toContain("const [gate] = useState(confirmGate);");
    expect(src).toContain("const ask = useCallback((opts: ConfirmOptions) => gate.ask((n) => setOpen({ ...opts, n })), [gate]);");
    // Without gate.answer the first question would never settle and the gate would answer every later one no unseen.
    expect(src).toMatch(/const answer = useCallback\(\(ok: boolean\) => \{\s*setOpen\(null\);\s*gate\.answer\(ok\);\s*\}, \[gate\]\);/);
    expect(src).toMatch(/<ConfirmDialog key=\{open\.n\} [^\n]*onAnswer=\{answer\} \/>/);
    expect(src).toContain("return [ask, dialog];");
  });

  it("the gate settles each question once, and a second question while one is open is answered no without showing", async () => {
    const gate = confirmGate();
    const shown: number[] = [];
    const first = gate.ask((n) => shown.push(n));
    const second = gate.ask((n) => shown.push(n));
    await expect(second).resolves.toBe(false);
    expect(shown).toEqual([1]);
    gate.answer(true);
    await expect(first).resolves.toBe(true);
    // A late answer (the close event after a click) settles nothing.
    expect(() => gate.answer(false)).not.toThrow();
    const third = gate.ask((n) => shown.push(n));
    expect(shown).toEqual([1, 2]);
    gate.answer(false);
    await expect(third).resolves.toBe(false);
  });

  it("the new components use logical direction classes only", () => {
    for (const name of ["ConfirmDialog", "PasswordField"]) {
      const classes = ((name === "ConfirmDialog" ? read("src/components/ui/ConfirmDialog.tsx") : app(name)).match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) ?? []).join(" ");
      expect(classes, name).not.toBe("");
      expect(classes, name).not.toMatch(PHYSICAL);
    }
  });
});
