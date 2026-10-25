"use client";
import { useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { inputError, type Parsed } from "@/lib/admin-input";
import { useAdminForm } from "./AdminForm";

/** The console workspace edit's words (rules 3550-3569); the same keys in both languages. */
export const WORKSPACE_EDIT_COPY = {
  en: {
    editable: "You can change this workspace for the customer. Every change asks a reason, is written to the audit log and the customer's team log as \"by Thakeen support\", and the owner gets a notice. Opening this tab is written to the audit log too.",
    ownerOnly: "Only a console owner can change a workspace. You can view it.",
    actions: "Change this workspace",
    workspaceName: "Workspace name",
    noName: "None given (the main brand's name or the owner's name is shown)",
    rename: "Rename",
    renameTitle: "Rename this workspace",
    renameMessage: "The customer sees the new name in the workspace switcher when the main brand has no name of its own.",
    newName: "New name",
    invite: "Invite a member",
    inviteTitle: "Invite a member for the customer",
    inviteMessage: "The invitation is emailed to that address only, from the owner, and takes a seat until it is accepted, cancelled or expires (7 days). You never see the join link.",
    inviteEmail: "Their email",
    inviteRole: "Role",
    inviteLang: "Email language",
    langs: { ar: "Arabic", en: "English" },
    roleOptions: { member: "Editor", viewer: "Viewer", admin: "Admin" },
    remove: "Remove",
    removeTitle: "Remove this member?",
    removeMessage: "They lose access to this workspace at once and their seat is freed. Their own login and other workspaces are untouched. This cannot be undone; they can be invited again.",
    cancel: "Cancel invite",
    cancelTitle: "Cancel this invitation?",
    cancelMessage: "The join link stops working at once and the seat is freed.",
    confirmEmail: "Type their email to confirm",
    done: {
      rename: "Renamed. The owner was told.",
      invite: "Invitation emailed. The owner was told.",
      remove: "Member removed. The owner was told.",
      cancel_invite: "Invitation cancelled. The owner was told.",
    },
    errors: {
      forbidden: "Your console role cannot change workspaces.",
      seats: (used: number, limit: number) => `No free seat: ${used} of ${limit} in use. The owner can add seats or free one first.`,
      unavailable: "That address cannot be invited here (already invited, or it already signs in).",
      already_member: "That address is already in this workspace.",
      not_found: "Not found. The list may have changed: reload the tab.",
      mail_unavailable: "Email is not set up, so no invitation can be sent from the console.",
      suspended: "This account is suspended. Lift the suspension before inviting.",
      send_failed: "The email could not be sent, so the invitation was withdrawn.",
      workspace_changed: "This address now opens another workspace. Reload the tab before changing anything.",
      unchanged: "That is already the workspace's name.",
      owner_protected: "The owner cannot be removed. Ownership moves only through the customer's own transfer.",
      invalid_role: "Pick editor, viewer or admin.",
      invalid_email: "Write one valid email address.",
      slow_down: "Too many changes for now. Try again later.",
      audit_failed: "The audit log could not be written, so the change was not kept (or, for a removal, was kept and flagged). Check the log.",
    },
  },
  ar: {
    editable: "تقدر تعدّل مساحة العمل هذه نيابةً عن العميل. كل تعديل يطلب سبباً، ويُكتب في سجل التدقيق وفي سجل فريق العميل بعبارة «من فريق ذكين»، ويصل المالك إشعار. فتح هذا التبويب يُكتب في سجل التدقيق أيضاً.",
    ownerOnly: "تعديل مساحة العمل لمالك لوحة الإدارة فقط. تقدر تطّلع عليها.",
    actions: "تعديل مساحة العمل",
    workspaceName: "اسم مساحة العمل",
    noName: "بلا اسم (يظهر اسم العلامة الأساسية أو اسم المالك)",
    rename: "تغيير الاسم",
    renameTitle: "تغيير اسم مساحة العمل",
    renameMessage: "يرى العميل الاسم الجديد في قائمة مساحات العمل إذا لم يكن للعلامة الأساسية اسم خاص بها.",
    newName: "الاسم الجديد",
    invite: "دعوة عضو",
    inviteTitle: "دعوة عضو نيابةً عن العميل",
    inviteMessage: "تُرسل الدعوة بالبريد إلى هذا العنوان وحده باسم المالك، وتشغل مقعداً حتى تُقبل أو تُلغى أو تنتهي (7 أيام). لن ترى رابط الانضمام.",
    inviteEmail: "بريده",
    inviteRole: "الدور",
    inviteLang: "لغة البريد",
    langs: { ar: "العربية", en: "الإنجليزية" },
    roleOptions: { member: "محرر", viewer: "مشاهد", admin: "مدير" },
    remove: "إزالة",
    removeTitle: "إزالة هذا العضو؟",
    removeMessage: "يفقد الوصول إلى مساحة العمل فوراً ويتحرر مقعده. حسابه ومساحاته الأخرى لا تتغير. لا يمكن التراجع عن هذا، ويمكن دعوته من جديد.",
    cancel: "إلغاء الدعوة",
    cancelTitle: "إلغاء هذه الدعوة؟",
    cancelMessage: "يتوقف رابط الانضمام فوراً ويتحرر المقعد.",
    confirmEmail: "اكتب بريده للتأكيد",
    done: {
      rename: "تغيّر الاسم، ووصل المالك إشعار.",
      invite: "أُرسلت الدعوة بالبريد، ووصل المالك إشعار.",
      remove: "أُزيل العضو، ووصل المالك إشعار.",
      cancel_invite: "أُلغيت الدعوة، ووصل المالك إشعار.",
    },
    errors: {
      forbidden: "دورك في لوحة الإدارة ما يسمح بتعديل مساحات العمل.",
      seats: (used: number, limit: number) => `ما فيه مقعد فاضي: ${used} من ${limit} مستخدمة. يقدر المالك يزيد المقاعد أو يفرّغ واحداً أولاً.`,
      unavailable: "ما يمكن دعوة هذا العنوان هنا (مدعو من قبل، أو له حساب).",
      already_member: "هذا العنوان موجود في مساحة العمل.",
      not_found: "غير موجود. ربما تغيّرت القائمة: أعد تحميل التبويب.",
      mail_unavailable: "البريد غير مفعّل، فما يمكن إرسال دعوة من لوحة الإدارة.",
      suspended: "هذا الحساب موقوف. ارفع الإيقاف قبل الدعوة.",
      send_failed: "ما أُرسل البريد، فسُحبت الدعوة.",
      workspace_changed: "هذا العنوان يفتح الآن مساحة عمل أخرى. أعد تحميل التبويب قبل أي تعديل.",
      unchanged: "هذا هو اسم مساحة العمل الحالي.",
      owner_protected: "ما يمكن إزالة المالك. الملكية تنتقل فقط بنقل الملكية من العميل نفسه.",
      invalid_role: "اختر محرر أو مشاهد أو مدير.",
      invalid_email: "اكتب عنوان بريد صحيحاً واحداً.",
      slow_down: "تعديلات كثيرة الآن. حاول لاحقاً.",
      audit_failed: "ما انكتب سجل التدقيق، فلم يُحفظ التعديل (أو حُفظ وعُلّم إن كان إزالة). راجع السجل.",
    },
  },
} as const;

type Copy = (typeof WORKSPACE_EDIT_COPY)["en"] | (typeof WORKSPACE_EDIT_COPY)["ar"];
type Body = { action: "rename" | "invite" | "remove" | "cancel_invite" } & Record<string, string>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailField = (v: string): Parsed<string> => {
  const e = v.trim().toLowerCase();
  return EMAIL_RE.test(e) ? { ok: true, value: e } : { ok: false, error: "bad_email" };
};

/** The words for one answer of POST .../workspace/edit. */
function errorText(C: Copy, lang: "ar" | "en", j: Record<string, unknown>): string {
  const e = typeof j.error === "string" ? j.error : "";
  if (e === "seats" && typeof j.used === "number" && typeof j.limit === "number") return C.errors.seats(j.used, j.limit);
  if (e === "read_only") return C.errors.forbidden;
  if (e === "rate_limited") return C.errors.slow_down;
  if (e === "bad_name" || e.startsWith("reason_")) return inputError(lang, e);
  const known = C.errors as Record<string, unknown>;
  return typeof known[e] === "string" ? (known[e] as string) : inputError(lang, "failed");
}

/**
 * The console owner's workspace changes (rules 3550-3569): each opens the console form (fields, a reason, and for a
 * removal or a cancellation the person's address typed to confirm), then POST /api/admin/users/{email}/workspace/edit
 * with the owner address the view showed, so a change never lands on another account than the one on screen. The
 * server checks everything again: the role, the second factor, the reason, the limits.
 */
export function useWorkspaceEdit({ lang, email, owner, onDone }: { lang: "ar" | "en"; email: string; owner: string; onDone: () => void }) {
  const C = WORKSPACE_EDIT_COPY[lang];
  const [ask, dialog] = useAdminForm(lang);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function send(body: Body, reason: string | undefined) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await adminFetch(`/api/admin/users/${encodeURIComponent(email)}/workspace/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, owner, reason }),
      });
      const j = ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      if (r.ok && j.ok) {
        setMsg({ tone: "ok", text: C.done[body.action] });
        onDone();
      } else setMsg({ tone: "error", text: errorText(C, lang, j) });
    } catch {
      setMsg({ tone: "error", text: inputError(lang, "failed") });
    } finally {
      setBusy(false);
    }
  }

  async function rename(current: string | null) {
    const v = await ask<{ name: string }>({
      title: C.renameTitle, subject: owner, message: C.renameMessage, submitLabel: C.rename,
      fields: [{ name: "name", label: C.newName, initial: current ?? "", maxLength: 80 }],
      parse: (f) => {
        const name = (f.name ?? "").trim();
        return name && [...name].length <= 80 ? { ok: true, value: { name } } : { ok: false, error: "bad_name" };
      },
    });
    if (v) await send({ action: "rename", name: v.name }, v.reason);
  }

  async function invite() {
    const v = await ask<{ email: string; role: string; lang: string }>({
      title: C.inviteTitle, subject: owner, message: C.inviteMessage, submitLabel: C.invite,
      fields: [
        { name: "email", label: C.inviteEmail, ltr: true, maxLength: 254 },
        { name: "role", label: C.inviteRole, kind: "select", initial: "member", options: [{ value: "member", label: C.roleOptions.member }, { value: "viewer", label: C.roleOptions.viewer }, { value: "admin", label: C.roleOptions.admin }] },
        { name: "lang", label: C.inviteLang, kind: "select", initial: lang, options: [{ value: "ar", label: C.langs.ar }, { value: "en", label: C.langs.en }] },
      ],
      parse: (f) => {
        const e = emailField(f.email ?? "");
        if (!e.ok) return e;
        return { ok: true, value: { email: e.value, role: f.role === "admin" || f.role === "viewer" ? f.role : "member", lang: f.lang === "en" ? "en" : "ar" } };
      },
    });
    if (v) await send({ action: "invite", email: v.email, role: v.role, lang: v.lang }, v.reason);
  }

  async function remove(member: string) {
    const v = await ask<{ email: string }>({
      title: C.removeTitle, subject: member, message: C.removeMessage, submitLabel: C.remove, destructive: true,
      fields: [{ name: "confirm", label: C.confirmEmail, ltr: true, mustMatch: member }],
      parse: () => ({ ok: true, value: { email: member } }),
    });
    if (v) await send({ action: "remove", email: v.email }, v.reason);
  }

  async function cancel(invited: string) {
    const v = await ask<{ email: string }>({
      title: C.cancelTitle, subject: invited, message: C.cancelMessage, submitLabel: C.cancel, destructive: true,
      fields: [{ name: "confirm", label: C.confirmEmail, ltr: true, mustMatch: invited }],
      parse: () => ({ ok: true, value: { email: invited } }),
    });
    if (v) await send({ action: "cancel_invite", email: v.email }, v.reason);
  }

  const status = !msg ? null : msg.tone === "error" ? <p role="alert" className="text-xs text-danger">{msg.text}</p> : <p role="status" className="text-xs text-success">{msg.text}</p>;
  return { C, busy, rename, invite, remove, cancel, dialog, status };
}
