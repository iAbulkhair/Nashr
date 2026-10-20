import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToReadableStream } from "react-dom/server.edge";
import { json, newMember, newUser, signIn } from "./helpers/session";
import { saveBrand, saveTask, updateTask, type Brand } from "@/lib/brand";
import { appDict } from "@/lib/app-i18n";
import { DEFAULT_GOV } from "@/lib/governance";
import { createElement } from "react";
import { runTool } from "@/lib/chat";
import { formatWhen, riyadhDay } from "@/lib/secretary-agenda";
import * as listRoute from "@/app/api/secretary/route";
import * as itemRoute from "@/app/api/secretary/[id]/route";
import GovernancePanel from "@/components/app/GovernancePanel";

// Rules 204, 210 (the page's part) and 211 in docs/system/tests.md: the My to-dos page renders complete on the server,
// in the brand's zone, with an agent's claim next to the fact code checked; and the governance page of rule 202.

// The app router only exists inside Next: the page's client component gets a router whose refresh does nothing.
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
import Page from "@/app/[lang]/app/b/[brand]/todo/page";

const BRAND: Brand = { name: "Rif", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "", products: "", audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: [], city: "", updatedAt: "2026-09-29" };
const render = async (lang: "ar" | "en") => new Response(await renderToReadableStream(await Page({ params: Promise.resolve({ lang }) }))).text();
const add = async (body: Record<string, unknown>) => (await (await listRoute.POST(json("/api/secretary", "POST", body))).json()).item;
const patch = (id: string, body: unknown) => itemRoute.PATCH(json(`/api/secretary/${id}`, "PATCH", body), { params: Promise.resolve({ id }) });

describe("the My to-dos page renders complete on the server (rule 204)", () => {
  it("shows every bucket with Riyadh dates, the row actions, the approvals line and the add form", async () => {
    const u = await newUser("todopage");
    await saveBrand(u.email, BRAND);
    await signIn(u.email);
    await saveTask(u.email, { id: "dddddddddddd0001", type: "social", channel: "instagram", title: "Post", body: "b", status: "pending", createdAt: new Date().toISOString(), lang: "ar" }, true);
    const day = riyadhDay(Date.now() + 3 * 864e5);
    const soon = await add({ title: "أرسل عرض السعر", dueAt: `${day}T10:00`, owedTo: "مؤسسة النخبة" });
    await add({ title: "فاتورة من أحمد", direction: "they_owe", owedBy: "أحمد", dueAt: `${day}T12:00` });
    await add({ title: "عينات من المورّد", direction: "they_owe", owedBy: "المورّد" }); // undated: expected in two working days
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
    // The agent's words are its claim, attributed with the right verb, next to what the app checked (here: nothing).
    expect(html).toContain("ريم تقول: «حوّلت المبلغ اليوم»");
    expect(html).toContain("ادعاء لم يتحقق منه التطبيق");
    expect(html).toContain("تحقّق التطبيق:");
    expect(html).toContain("لا شيء في التطبيق يؤكد ذلك");
    // Someone else owes it: "Followed up" and when it is expected.
    expect(html).toContain("تابعت");
    expect(html).toContain("متوقع حتى");
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
    expect(en).toContain("Reem says: «حوّلت المبلغ اليوم»");
    expect(en).toContain("Nothing in the app confirms this");
    expect(en).toContain(formatWhen(soon.dueAt, false, "en", Date.now()));
  });

  it("shows an agent's 'done' as a claim and, next to it, the fact code read from the linked inbox item (rule 211)", async () => {
    const u = await newUser("todofact");
    await saveBrand(u.email, BRAND);
    await signIn(u.email);
    const post = (id: string, title: string) => ({ id, type: "social" as const, channel: "instagram", title, body: "b", status: "pending" as const, createdAt: new Date().toISOString(), lang: "ar" as const });
    await saveTask(u.email, post("dddddddddddd0101", "منشور اليوم الوطني"), true);
    await saveTask(u.email, post("dddddddddddd0102", "منشور العرض"), true);
    const waits = await add({ title: "انتظر منشور اليوم الوطني", taskId: "dddddddddddd0101" });
    // Sami claims the linked post was approved and published; the stored task says it is still pending.
    await runTool(u, "todo_propose_done", { id: waits.id, evidence: "The post was approved and published on Instagram" }, [], [], undefined, { lang: "en", agent: "sami" });
    const closes = await add({ title: "انتظر منشور العرض", taskId: "dddddddddddd0102" });
    await updateTask(u.email, "dddddddddddd0102", (t) => ({ ...t, status: "approved", decidedAt: "2026-10-01T07:00:00.000Z", published: [{ provider: "x", url: "https://x.example/1", status: "published", at: "2026-10-01T08:00:00.000Z" }] }));
    const html = await render("ar");
    expect(html).toContain("سامي يقول: «The post was approved and published on Instagram»");
    expect(html).toContain("العنصر المرتبط «منشور اليوم الوطني» ما زال بانتظار موافقتك.");
    // The claim's words never become the checked fact.
    expect(html).not.toMatch(/تحقّق التطبيق:<\/span> <!-- -->[^<]*(approved|published)/);
    // The item closed by code shows, under "done", when the owner approved it and where it was published.
    expect(html).toContain("العنصر المرتبط «منشور العرض» اعتمدته أنت");
    expect(html).toContain("ونُشر على x");
    expect(closes.id).toBeTruthy();
    const en = await render("en");
    expect(en).toContain("Sami says: «The post was approved and published on Instagram»");
    expect(en).toContain("The linked inbox item «منشور اليوم الوطني» is still waiting for your approval.");
    expect(en).toContain("You approved the linked inbox item «منشور العرض»");
    const agenda = await runTool(u, "agenda_get", {}, []);
    expect(agenda).toContain("claimed done by Sami (a claim, not checked)");
    expect(agenda).toContain("checked by the app: The linked inbox item «منشور اليوم الوطني» is still waiting for your approval.");
  });

  it("writes dates and the zone name in the brand's own time zone (rule 210)", async () => {
    const u = await newUser("todozone");
    await saveBrand(u.email, { ...BRAND, city: "دبي", timeZone: "Asia/Dubai" });
    await signIn(u.email);
    const day = riyadhDay(Date.now() + 3 * 864e5);
    const it = await add({ title: "اجتماع دبي", dueAt: `${day}T10:00` });
    // 10:00 in Dubai is 06:00 UTC.
    expect(it.dueAt).toBe(`${day}T06:00:00.000Z`);
    const html = await render("ar");
    expect(html).toContain("بتوقيت دبي");
    expect(html).toContain(formatWhen(it.dueAt, false, "ar", Date.now(), "Asia/Dubai"));
    expect(html).toContain("10:00 ص");
  });

  it("hides the closing controls from a plain member (rule 212)", async () => {
    const o = await newUser("todoroles");
    await saveBrand(o.email, BRAND);
    await signIn(o.email);
    const it = await add({ title: "Shared item" });
    await runTool(o, "todo_propose_done", { id: it.id, evidence: "Done in the shop" }, []);
    await add({ title: "Another shared item" });
    const m = await newMember(o, "member", "todom");
    await signIn(m.email);
    const html = await render("en");
    expect(html).toContain("Shared item");
    for (const label of [">Done<", ">Delete<", ">Yes, it&#x27;s done<", ">Not yet<"]) expect(html, label).not.toContain(label);
    expect(html).toContain(">Snooze<");
    await signIn(o.email);
    const ownerHtml = await render("en");
    for (const label of [">Done<", ">Delete<", ">Not yet<"]) expect(ownerHtml, label).toContain(label);
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

describe("the governance page offers a monthly cap only where it applies (rule 202)", () => {
  it("lists every agent that owns a paid type and leaves Reem out", async () => {
    const t = appDict.en;
    const html = await new Response(await renderToReadableStream(createElement(GovernancePanel, { t, lang: "en", initial: DEFAULT_GOV, spend: {}, history: [], historyCap: 100 }))).text();
    for (const id of ["noor", "sami", "razan", "faris", "dana", "majed", "layan"] as const) expect(html, id).toContain(t.governance.capFor.replace("{name}", t.agents[id].name));
    expect(html).not.toContain(t.governance.capFor.replace("{name}", t.agents.reem.name));
  });
});
