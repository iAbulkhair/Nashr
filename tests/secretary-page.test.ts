import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToReadableStream } from "react-dom/server.edge";
import { json, newUser, signIn } from "./helpers/session";
import { saveBrand, saveTask, type Brand } from "@/lib/brand";
import { runTool } from "@/lib/chat";
import { formatWhen, riyadhDay } from "@/lib/secretary-agenda";
import * as listRoute from "@/app/api/secretary/route";

// Rule 171 in docs/system/tests.md: the My to-dos page renders complete on the server.

// The app router only exists inside Next: the page's client component gets a router whose refresh does nothing.
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
import Page from "@/app/[lang]/app/todo/page";

const BRAND: Brand = { name: "Rif", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-09-29" };
const render = async (lang: "ar" | "en") => new Response(await renderToReadableStream(await Page({ params: Promise.resolve({ lang }) }))).text();
const add = async (body: Record<string, unknown>) => (await (await listRoute.POST(json("/api/secretary", "POST", body))).json()).item;

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
    const html = await render("ar");
    expect(html).toContain("مهامي");
    expect(html).toContain("خلال 7 أيام");
    expect(html).toContain("بانتظار غيرك");
    expect(html).toContain("تحتاج تأكيدك");
    expect(html).toContain(formatWhen(soon.dueAt, false, "ar", Date.now()));
    expect(html).toContain("لـمؤسسة النخبة");
    expect(html).toContain("على أحمد");
    expect(html).toContain("حوّلت المبلغ اليوم");
    for (const label of ["تمت", "أجّل", "غيّر الموعد", "احذف", "نعم، تمت", "ليس بعد", "أضف مهمة"]) expect(html).toContain(label);
    expect(html).toContain("عنصر واحد بانتظار موافقتك");
    expect(html).toContain("التذكير على واتساب وتيليجرام غير متاح بعد");
    const en = await render("en");
    expect(en).toContain("My to-dos");
    expect(en).toContain(formatWhen(soon.dueAt, false, "en", Date.now()));
  });

  it("uses logical properties only, so it reads right to left", () => {
    const src = readFileSync("src/components/app/TodoPanel.tsx", "utf8");
    expect(src.match(/\b(ml|mr|pl|pr|left|right|text-left|text-right)-[\w[]/g) ?? []).toEqual([]);
  });
});
