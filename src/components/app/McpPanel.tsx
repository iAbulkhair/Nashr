"use client";
import { useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n";
import { Icon } from "./Icons";
import ReadOnlyNote from "./ReadOnlyNote";
import Scribble from "@/components/Scribble";

/**
 * `canToken` / `canGrants`: the personal token and the connected apps are the owner's in v1, so other roles see neither
 * and nothing is fetched for them; the routes refuse them regardless. A founder viewing the account sees the apps only.
 */
export default function McpPanel({ lang, origin, draftsPerHour, canToken = true, canGrants = true }: { lang: Lang; origin: string; draftsPerHour: number; canToken?: boolean; canGrants?: boolean }) {
  const ar = lang === "ar";
  const [exists, setExists] = useState(false);
  const [token, setToken] = useState("");
  const [grants, setGrants] = useState<{ id: string; client_name: string; createdAt: string; lastIssuedAt: string }[]>([]);
  useEffect(() => {
    if (canToken) fetch("/api/mcp/token").then((r) => r.json()).then((j) => setExists(!!j.exists)).catch(() => {});
    if (canGrants) fetch("/api/mcp/grants").then((r) => r.json()).then((j) => setGrants(j.grants ?? [])).catch(() => {});
  }, [canToken, canGrants]);
  async function disconnect(id: string) {
    const r = await fetch(`/api/mcp/grants?id=${id}`, { method: "DELETE" });
    if (r.ok) setGrants((g) => g.filter((x) => x.id !== id));
  }
  async function gen() {
    const j = await (await fetch("/api/mcp/token", { method: "POST" })).json();
    setToken(j.token); setExists(true);
  }
  async function revoke() { await fetch("/api/mcp/token", { method: "DELETE" }); setToken(""); setExists(false); }
  const url = `${origin}/api/mcp`;
  const tok = token || "nashr_…";
  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="mcppanel-t1" />{ar ? "نور داخل Claude و ChatGPT (MCP)" : "Noor inside Claude and ChatGPT (MCP)"}</span></h1>
      <p className="mt-2 text-ink/70">{ar ? "اربط نور بأي مساعد يدعم MCP. تكتب في Claude «جهزي 10 منشورات» وتظهر في صندوق موافقتك هنا." : "Connect Noor to any MCP-capable assistant. Type “prepare 10 posts” in Claude and they land in your inbox here."}</p>
      {/* Connected apps without the token is a founder viewing the account: the token is refused while impersonating, the
          apps are not. Anyone else without the token is a member or admin, for whom both are the owner's alone. */}
      {!canToken && <ReadOnlyNote className="mt-4" text={canGrants
        ? (ar ? "أثناء تصفّح هذا الحساب كمؤسس لا يُنشأ الرمز الشخصي ولا يُعرض. تستطيع مراجعة التطبيقات المتصلة وفصلها أدناه." : "While you view this account as the founder, the personal token cannot be created or shown. You can review and disconnect the connected apps below.")
        : (ar ? "ربط نور بـ Claude و ChatGPT يديره مالك الحساب: الرمز الشخصي والتطبيقات المتصلة له وحده." : "The account owner manages connecting Noor to Claude and ChatGPT: the personal token and connected apps are theirs alone.")} />}
      {canToken && <div className="mt-6 card">
        <p className="text-xs uppercase tracking-wide text-ink/50">{ar ? "رمز الوصول" : "Access token"}</p>
        {token ? <code className="mt-1 block break-all rounded bg-lilac p-3 text-sm" dir="ltr">{token}</code> : <p className="mt-1 text-sm text-ink/60">{exists ? (ar ? "يوجد رمز نشط. أنشئ رمزاً جديداً لعرضه (القديم يُلغى)." : "A token exists. Generate a new one to see it (old one is revoked).") : ar ? "لا يوجد رمز بعد." : "No token yet."}</p>}
        {token && <p className="mt-2 text-xs text-danger">{ar ? "يظهر مرة واحدة. انسخه الآن." : "Shown once. Copy it now."}</p>}
        <div className="mt-3 flex gap-2">
          <button onClick={gen} className="btn btn-primary btn-pill">{ar ? "أنشئ رمزاً" : "Generate token"}</button>
          {exists && <button onClick={revoke} className="rounded-full border border-danger px-4 py-2 text-sm text-danger">{ar ? "ألغِ" : "Revoke"}</button>}
        </div>
      </div>}
      {canGrants && <div className="mt-6 rounded-xl border border-ink/30 bg-white p-5">
        <h2 className="font-display text-xl font-bold">{ar ? "الطريقة الأسهل: OAuth (بدون رمز)" : "Easiest: OAuth (no token)"}</h2>
        <p className="mt-1 text-sm text-ink/70">{ar ? "في Claude (الويب/سطح المكتب) → Settings → Connectors → Add custom connector → الصق الرابط. سيفتح صفحة تسجيل دخول ذكين ثم «Allow»." : "In Claude (web/desktop) → Settings → Connectors → Add custom connector → paste the URL. It opens Thakeen login, then “Allow”."}</p>
        <code className="mt-2 block break-all rounded bg-lilac p-3 text-sm" dir="ltr">{url}</code>
        <p className="mt-4 text-xs uppercase tracking-wide text-ink/50">{ar ? "التطبيقات المتصلة" : "Connected apps"}</p>
        {grants.length === 0 ? <p className="mt-1 text-sm text-ink/60">{ar ? "لا يوجد تطبيق متصل عبر OAuth." : "No app is connected through OAuth."}</p> : (
          <ul className="mt-1 divide-y divide-ink/10">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0"><span className="block truncate font-medium" dir="auto">{g.client_name}</span><span className="text-xs text-ink/50">{ar ? "متصل منذ" : "Connected"} <span className="font-mono" dir="ltr">{g.createdAt.slice(0, 10)}</span> · {ar ? "آخر تجديد" : "last renewed"} <span className="font-mono" dir="ltr">{g.lastIssuedAt.slice(0, 10)}</span></span></span>
                <button onClick={() => disconnect(g.id)} className="shrink-0 rounded-full border border-danger px-4 py-2 text-sm text-danger">{ar ? "افصل" : "Disconnect"}</button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-ink/50">{ar ? "الفصل يوقف وصول التطبيق فوراً. إعادة تعيين كلمة المرور تفصل كل التطبيقات." : "Disconnecting stops the app's access at once. Resetting your password disconnects every app."}</p>
      </div>}
      {canToken && <>
        <h2 className="mt-8 font-display text-xl font-bold">Claude Code {ar ? "(برمز شخصي)" : "(personal token)"}</h2>
        <pre className="mt-2 max-w-full overflow-x-auto rounded-xl bg-ink p-4 text-xs text-lilac" dir="ltr">{`claude mcp add --transport http thakeen ${url} --header "Authorization: Bearer ${tok}"`}</pre>
        <h2 className="mt-6 font-display text-xl font-bold">Claude Desktop / {ar ? "أي عميل MCP" : "any MCP client"}</h2>
        <pre className="mt-2 max-w-full overflow-x-auto rounded-xl bg-ink p-4 text-xs text-lilac" dir="ltr">{JSON.stringify({ mcpServers: { thakeen: { type: "http", url, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2)}</pre>
      </>}
      <section className="mt-6 rounded-xl border border-ink/25 bg-ink/5 p-4">
        <p className="flex items-center gap-2 font-display font-bold text-ink"><Icon name="shield" className="h-5 w-5" />{ar ? "علامتك داخل ChatGPT وClaude" : "Your brand inside ChatGPT and Claude"}</p>
        <p className="mt-1 text-sm text-ink/70">{ar ? "بعد الربط، يقرأ مساعدك قواعد علامتك بأداة get_brand_rules، ويفحص أي مسودة يكتبها بأداة check_brand، بنفس الكود الذي يستخدمه زر الاعتماد في ذكين. مجاناً، بدون رصيد." : "Once connected, your assistant reads your brand rules with get_brand_rules and checks any draft it writes with check_brand, using the same code as Thakeen's approve button. Free, no credits."}</p>
        <p className="mt-2 rounded-lg bg-white px-3 py-2 font-mono text-xs text-ink/70" dir="ltr">&quot;{ar ? "Use Thakeen: get my brand rules, write 3 Instagram captions, then check_brand each one." : "Use Thakeen: get my brand rules, write 3 Instagram captions, then check_brand each one."}&quot;</p>
      </section>
      <section className="mt-6 rounded-xl border-[1.5px] border-ink bg-white p-5" data-testid="own-subscription">
        <h2 className="font-display text-xl font-bold">{ar ? "استخدم اشتراكك في Claude أو ChatGPT" : "Use your own Claude or ChatGPT subscription"}</h2>
        <p className="mt-1 text-sm text-ink/70">{ar ? "يكتب مساعدك المسودة باشتراكك أنت، ثم يحفظها في صندوق الموافقة هنا بأداة save_draft. تُفحص بقواعد علامتك عند الحفظ، ولا تُعتمد ولا تُنشر إلا بقرارك." : "Your assistant writes the draft on your own subscription, then saves it to the approvals inbox here with save_draft. It is checked against your brand rules when saved, and nothing is approved or published until you decide."}</p>
        <ol className="mt-3 grid list-decimal gap-2 ps-5 text-sm text-ink/80">
          <li><span className="font-semibold">Claude</span>: {ar ? "Settings → Connectors → Add custom connector، الصق الرابط أعلاه، ثم سجّل الدخول واضغط «Allow»." : "Settings → Connectors → Add custom connector, paste the URL above, then sign in and press “Allow”."}</li>
          <li><span className="font-semibold">ChatGPT</span>: {ar ? "فعّل وضع المطوّر (Developer mode) من إعدادات التطبيقات والموصلات، ثم أنشئ موصلاً جديداً والصق الرابط نفسه واختر OAuth. الميزة متاحة في بعض خطط ChatGPT فقط، وقد تختلف أسماء القوائم." : "Turn on Developer mode in the Apps & Connectors settings, create a new connector, paste the same URL and choose OAuth. This is available on some ChatGPT plans only, and menu names may differ."}</li>
        </ol>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg bg-ink/5 p-3">
            <p className="font-semibold text-ink">{ar ? "مجانية، بدون رصيد" : "Free, no credits"}</p>
            <p className="mt-1 font-mono text-xs text-ink/70" dir="ltr">save_draft · check_brand · get_brand_rules · list_inbox · read_file · list_files · agenda_get · todo_create · todo_update · todo_propose_done</p>
            <p className="mt-1 text-xs text-ink/60">{ar ? `save_draft: حتى ${draftsPerHour} مسودة في الساعة لكل حساب.` : `save_draft: up to ${draftsPerHour} drafts an hour per account.`}</p>
          </div>
          <div className="rounded-lg bg-agent-sami/20 p-3">
            <p className="font-semibold text-danger">{ar ? "تستهلك رصيداً" : "Spend credits"}</p>
            <p className="mt-1 font-mono text-xs text-ink/70" dir="ltr">generate_content · ask_noor</p>
            <p className="mt-1 text-xs text-ink/60">{ar ? "تعمل على نماذج ذكين: generate_content يخصم رصيداً دائماً، وask_noor يخصم عندما تنشئ نور محتوى." : "They run on Thakeen's models: generate_content always spends credits, ask_noor spends them when Noor creates content."}</p>
          </div>
        </div>
        <p className="mt-3 rounded-lg bg-lilac px-3 py-2 font-mono text-xs text-ink/70" dir="ltr">&quot;Use Thakeen: get my brand rules, write 3 Instagram captions, check_brand each one, then save_draft the ones that pass.&quot;</p>
      </section>
      <h2 className="mt-6 font-display text-xl font-bold">{ar ? "الأدوات المتاحة" : "Tools exposed"}</h2>
      <ul className="mt-2 grid gap-1 text-sm text-ink/80" dir="ltr">{["ask_noor — chat with Noor; over MCP she never publishes, imports the catalog or rewrites core memory files, and a change to the offers or a banned-word removal waits for your Save in the app", "generate_content — weekly_plan | social | article | whatsapp | ads | gbp", "list_inbox — pending / approved / rejected", "read_file / list_files — brand.md, products.md, strategy.md…", "get_brand_rules — tone, dialect, audience, enforced banned words (free)", "check_brand — pass or the rule that fired, with the matched word (free)", "save_draft — save your own draft to the approvals inbox as pending (free)", "agenda_get — Reem's to-do agenda in the brand's time, plus approvals waiting (free)", "todo_create / todo_update — add or change a to-do on your list, with an optional repeat (every, interval, weekdays, month_day, until, count, remind_before); stopping or ending a repeat is yours, in the app (free)", "todo_propose_done — ask you to confirm an item is done; only you close it, in the app (free)"].map((x) => <li key={x} className="font-mono text-xs">• {x}</li>)}</ul>
    </div>
  );
}
