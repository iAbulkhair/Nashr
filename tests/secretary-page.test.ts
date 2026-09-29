import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToReadableStream } from "react-dom/server.edge";
import { json, newUser, signIn } from "./helpers/session";
import { saveBrand, saveTask, type Brand } from "@/lib/brand";
import { appDict } from "@/lib/app-i18n";
import { DEFAULT_GOV } from "@/lib/governance";
import { createElement } from "react";
import { runTool } from "@/lib/chat";
import { formatWhen, riyadhDay } from "@/lib/secretary-agenda";
import * as listRoute from "@/app/api/secretary/route";
import * as itemRoute from "@/app/api/secretary/[id]/route";
import GovernancePanel from "@/components/app/GovernancePanel";

// Rule 171 in docs/system/tests.md: the My to-dos page renders complete on the server; and the governance page of rule 169.

// The app router only exists inside Next: the page's client component gets a router whose refresh does nothing.
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
import Page from "@/app/[lang]/app/todo/page";

const BRAND: Brand = { name: "Rif", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-09-29" };
const render = async (lang: "ar" | "en") => new Response(await renderToReadableStream(await Page({ params: Promise.resolve({ lang }) }))).text();
const add = async (body: Record<string, unknown>) => (await (await listRoute.POST(json("/api/secretary", "POST", body))).json()).item;
const patch = (id: string, body: unknown) => itemRoute.PATCH(json(`/api/secretary/${id}`, "PATCH", body), { params: Promise.resolve({ id }) });

describe("the My to-dos page renders complete on the server (rule 171)", () => {
  it("shows every bucket with Riyadh dates, the row actions, the approvals line and the add form", async () => {
    const u = await newUser("todopage");
    await saveBrand(u.email, BRAND);
    await signIn(u.email);
    await saveTask(u.email, { id: "dddddddddddd0001", type: "social", channel: "instagram", title: "Post", body: "b", status: "pending", createdAt: new Date().toISOString(), lang: "ar" }, true);
    const day = riyadhDay(Date.now() + 3 * 864e5);
    const soon = await add({ title: "أرسل عرض السعر", dueAt: `${day}T10:00`, owedTo: "مؤسسة النخبة" });
    await add({ title: "فاتورة من أحمد", direction: "they_owe", owedBy: "أحمد", dueAt: `${day}T12:00` });
    const proposed = await add({ title: "ادفع للمطبعة" });
    await runTool(u, "todo_propose_done", { id: proposed.id, evidence: "حوّلت المبلغ اليوم" }, []);
    const noted = await add({ title: "احجز القاعة" });
    await runTool(u, "todo_update", { id: noted.id, note: "المورّد قال الأحد" }, []);
    await patch(noted.id, { action: "add_note", text: "سقف الميزانية 5 آلاف", private: true });
    const sentBack = await add({ title: "أرسل العقد" });
    await runTool(u, "todo_propose_done", { id: sentBack.id, evidence: "أرسلته أمس" }, []);
    await patch(sentBack.id, { action: "reject_done" });
    const html = await render("ar");
    expect(html).toContain("مهامي");
    expect(html).toContain("خلال 7 أيام");
    expect(html).toContain("بانتظار غيرك");
    expect(html).toContain("تحتاج تأكيدك");
    expect(html).toContain(formatWhen(soon.dueAt, false, "ar", Date.now()));
    expect(html).toContain("لـمؤسسة النخبة");
    expect(html).toContain("على أحمد");
    expect(html).toContain("حوّلت المبلغ اليوم");
    // "Proposed as done by" in a form that does not depend on who proposed it.
    expect(html).toContain("اقتراح إغلاق من");
    expect(html).not.toContain("تقول إنها تمت");
    // Notes are shown to the owner: an agent's, the owner's own private one, and the "Not yet" note in Arabic.
    expect(html).toContain("المورّد قال الأحد");
    expect(html).toContain("سقف الميزانية 5 آلاف");
    expect(html).toContain("لم تُنجز بعد (المقترح: أرسلته أمس)");
    for (const label of ["تمت", "أجّل", "غيّر الموعد", "احذف", "نعم، تمت", "ليس بعد", "أضف مهمة"]) expect(html).toContain(label);
    expect(html).toContain("عنصر واحد بانتظار موافقتك");
    expect(html).toContain("التذكير على واتساب وتيليجرام غير متاح بعد");
    const en = await render("en");
    expect(en).toContain("My to-dos");
    expect(en).toContain("Not done yet (proposed: أرسلته أمس)");
    expect(en).toContain("Proposed as done by");
    expect(en).toContain(formatWhen(soon.dueAt, false, "en", Date.now()));
  });

  it("uses logical properties only, so it reads right to left", () => {
    const src = readFileSync("src/components/app/TodoPanel.tsx", "utf8");
    expect(src.match(/\b(ml|mr|pl|pr|left|right|text-left|text-right)-[\w[]/g) ?? []).toEqual([]);
  });

  it("shows Undo as a toast pinned in view that goes away on its own, and a restore from the Deleted list clears it", () => {
    const src = readFileSync("src/components/app/TodoPanel.tsx", "utf8");
    expect(src).toMatch(/role="status" className="fixed inset-x-4 bottom-4/);
    expect(src).toMatch(/setTimeout\(\(\) => setUndo\(null\), UNDO_MS\)/);
    expect(src).toMatch(/undo === row\.id\) setUndo\(null\)/);
  });
});

describe("the governance page offers a monthly cap only where it applies (rule 169)", () => {
  it("lists every agent that owns a paid type and leaves Reem out", async () => {
    const t = appDict.en;
    const html = await new Response(await renderToReadableStream(createElement(GovernancePanel, { t, initial: DEFAULT_GOV, spend: {} }))).text();
    for (const id of ["noor", "sami", "razan", "faris", "dana", "majed", "layan"] as const) expect(html, id).toContain(t.governance.capFor.replace("{name}", t.agents[id].name));
    expect(html).not.toContain(t.governance.capFor.replace("{name}", t.agents.reem.name));
  });
});
