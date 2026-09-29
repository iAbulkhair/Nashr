"use client";
import { useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n";
import { Icon } from "./Icons";

export default function McpPanel({ lang, origin, draftsPerHour }: { lang: Lang; origin: string; draftsPerHour: number }) {
  const ar = lang === "ar";
  const [exists, setExists] = useState(false);
  const [token, setToken] = useState("");
  const [grants, setGrants] = useState<{ id: string; client_name: string; createdAt: string; lastIssuedAt: string }[]>([]);
  useEffect(() => {
    fetch("/api/mcp/token").then((r) => r.json()).then((j) => setExists(!!j.exists));
    fetch("/api/mcp/grants").then((r) => r.json()).then((j) => setGrants(j.grants ?? []));
  }, []);
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
    <div className="mx-auto max-w-3xl">
      <h1 className="page-title">{ar ? "نور داخل Claude و ChatGPT (MCP)" : "Noor inside Claude and ChatGPT (MCP)"}</h1>
      <p className="mt-2 text-ink/70">{ar ? "اربط نور بأي مساعد يدعم MCP. تكتب في Claude «جهزي 10 منشورات» وتظهر في صندوق موافقتك هنا." : "Connect Noor to any MCP-capable assistant. Type “prepare 10 posts” in Claude and they land in your inbox here."}</p>
      <div className="mt-6 card">
        <p className="text-xs uppercase tracking-wide text-ink/50">{ar ? "رمز الوصول" : "Access token"}</p>
        {token ? <code className="mt-1 block break-all rounded bg-salt-dim p-3 text-sm" dir="ltr">{token}</code> : <p className="mt-1 text-sm text-ink/60">{exists ? (ar ? "يوجد رمز نشط. أنشئ رمزاً جديداً لعرضه (القديم يُلغى)." : "A token exists. Generate a new one to see it (old one is revoked).") : ar ? "لا يوجد رمز بعد." : "No token yet."}</p>}
        {token && <p className="mt-2 text-xs text-sadu">{ar ? "يظهر مرة واحدة. انسخه الآن." : "Shown once. Copy it now."}</p>}
        <div className="mt-3 flex gap-2">
          <button onClick={gen} className="btn btn-primary btn-pill">{ar ? "أنشئ رمزاً" : "Generate token"}</button>
          {exists && <button onClick={revoke} className="rounded-full border border-sadu/40 px-4 py-2 text-sm text-sadu">{ar ? "ألغِ" : "Revoke"}</button>}
        </div>
      </div>
      <div className="mt-6 rounded-xl border border-oasis/30 bg-white p-5">
        <h2 className="font-display text-xl font-bold">{ar ? "الطريقة الأسهل: OAuth (بدون رمز)" : "Easiest: OAuth (no token)"}</h2>
        <p className="mt-1 text-sm text-ink/70">{ar ? "في Claude (الويب/سطح المكتب) → Settings → Connectors → Add custom connector → الصق الرابط. سيفتح صفحة تسجيل دخول نشر ثم «Allow»." : "In Claude (web/desktop) → Settings → Connectors → Add custom connector → paste the URL. It opens Nashr login, then “Allow”."}</p>
        <code className="mt-2 block rounded bg-salt-dim p-3 text-sm" dir="ltr">{url}</code>
        <p className="mt-4 text-xs uppercase tracking-wide text-ink/50">{ar ? "التطبيقات المتصلة" : "Connected apps"}</p>
        {grants.length === 0 ? <p className="mt-1 text-sm text-ink/60">{ar ? "لا يوجد تطبيق متصل عبر OAuth." : "No app is connected through OAuth."}</p> : (
          <ul className="mt-1 divide-y divide-ink/10">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0"><span className="block truncate font-medium" dir="auto">{g.client_name}</span><span className="text-xs text-ink/50">{ar ? "متصل منذ" : "Connected"} <span className="font-mono" dir="ltr">{g.createdAt.slice(0, 10)}</span> · {ar ? "آخر تجديد" : "last renewed"} <span className="font-mono" dir="ltr">{g.lastIssuedAt.slice(0, 10)}</span></span></span>
                <button onClick={() => disconnect(g.id)} className="shrink-0 rounded-full border border-sadu/40 px-4 py-2 text-sm text-sadu">{ar ? "افصل" : "Disconnect"}</button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-ink/50">{ar ? "الفصل يوقف وصول التطبيق فوراً. إعادة تعيين كلمة المرور تفصل كل التطبيقات." : "Disconnecting stops the app's access at once. Resetting your password disconnects every app."}</p>
      </div>
      <h2 className="mt-8 font-display text-xl font-bold">Claude Code {ar ? "(برمز شخصي)" : "(personal token)"}</h2>
      <pre className="mt-2 overflow-x-auto rounded-xl bg-oasis-deep p-4 text-xs text-mist" dir="ltr">{`claude mcp add --transport http nashr ${url} --header "Authorization: Bearer ${tok}"`}</pre>
      <h2 className="mt-6 font-display text-xl font-bold">Claude Desktop / {ar ? "أي عميل MCP" : "any MCP client"}</h2>
      <pre className="mt-2 overflow-x-auto rounded-xl bg-oasis-deep p-4 text-xs text-mist" dir="ltr">{JSON.stringify({ mcpServers: { nashr: { type: "http", url, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2)}</pre>
      <section className="mt-6 rounded-xl border border-oasis/25 bg-oasis/5 p-4">
        <p className="flex items-center gap-2 font-display font-bold text-oasis"><Icon name="shield" className="h-5 w-5" />{ar ? "علامتك داخل ChatGPT وClaude" : "Your brand inside ChatGPT and Claude"}</p>
        <p className="mt-1 text-sm text-ink/70">{ar ? "بعد الربط، يقرأ مساعدك قواعد علامتك بأداة get_brand_rules، ويفحص أي مسودة يكتبها بأداة check_brand، بنفس الكود الذي يستخدمه زر الاعتماد في نشر. مجاناً، بدون رصيد." : "Once connected, your assistant reads your brand rules with get_brand_rules and checks any draft it writes with check_brand, using the same code as Nashr's approve button. Free, no credits."}</p>
        <p className="mt-2 rounded-lg bg-white px-3 py-2 font-mono text-xs text-ink/70" dir="ltr">&quot;{ar ? "Use Nashr: get my brand rules, write 3 Instagram captions, then check_brand each one." : "Use Nashr: get my brand rules, write 3 Instagram captions, then check_brand each one."}&quot;</p>
      </section>
      <section className="mt-6 rounded-xl border border-saffron/40 bg-white p-5" data-testid="own-subscription">
        <h2 className="font-display text-xl font-bold">{ar ? "استخدم اشتراكك في Claude أو ChatGPT" : "Use your own Claude or ChatGPT subscription"}</h2>
        <p className="mt-1 text-sm text-ink/70">{ar ? "يكتب مساعدك المسودة باشتراكك أنت، ثم يحفظها في صندوق الموافقة هنا بأداة save_draft. تُفحص بقواعد علامتك عند الحفظ، ولا تُعتمد ولا تُنشر إلا بقرارك." : "Your assistant writes the draft on your own subscription, then saves it to the approvals inbox here with save_draft. It is checked against your brand rules when saved, and nothing is approved or published until you decide."}</p>
        <ol className="mt-3 grid list-decimal gap-2 ps-5 text-sm text-ink/80">
          <li><span className="font-semibold">Claude</span>: {ar ? "Settings → Connectors → Add custom connector، الصق الرابط أعلاه، ثم سجّل الدخول واضغط «Allow»." : "Settings → Connectors → Add custom connector, paste the URL above, then sign in and press “Allow”."}</li>
          <li><span className="font-semibold">ChatGPT</span>: {ar ? "فعّل وضع المطوّر (Developer mode) من إعدادات التطبيقات والموصلات، ثم أنشئ موصلاً جديداً والصق الرابط نفسه واختر OAuth. الميزة متاحة في بعض خطط ChatGPT فقط، وقد تختلف أسماء القوائم." : "Turn on Developer mode in the Apps & Connectors settings, create a new connector, paste the same URL and choose OAuth. This is available on some ChatGPT plans only, and menu names may differ."}</li>
        </ol>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg bg-oasis/5 p-3">
            <p className="font-semibold text-oasis">{ar ? "مجانية، بدون رصيد" : "Free, no credits"}</p>
            <p className="mt-1 font-mono text-xs text-ink/70" dir="ltr">save_draft · check_brand · get_brand_rules · list_inbox · read_file · list_files · agenda_get · todo_create · todo_update · todo_propose_done</p>
            <p className="mt-1 text-xs text-ink/60">{ar ? `save_draft: حتى ${draftsPerHour} مسودة في الساعة لكل حساب.` : `save_draft: up to ${draftsPerHour} drafts an hour per account.`}</p>
          </div>
          <div className="rounded-lg bg-sadu/5 p-3">
            <p className="font-semibold text-sadu">{ar ? "تستهلك رصيداً" : "Spend credits"}</p>
            <p className="mt-1 font-mono text-xs text-ink/70" dir="ltr">generate_content · ask_noor</p>
            <p className="mt-1 text-xs text-ink/60">{ar ? "تعمل على نماذج نشر: generate_content يخصم رصيداً دائماً، وask_noor يخصم عندما تنشئ نور محتوى." : "They run on Nashr's models: generate_content always spends credits, ask_noor spends them when Noor creates content."}</p>
          </div>
        </div>
        <p className="mt-3 rounded-lg bg-salt-dim px-3 py-2 font-mono text-xs text-ink/70" dir="ltr">&quot;Use Nashr: get my brand rules, write 3 Instagram captions, check_brand each one, then save_draft the ones that pass.&quot;</p>
      </section>
      <h2 className="mt-6 font-display text-xl font-bold">{ar ? "الأدوات المتاحة" : "Tools exposed"}</h2>
      <ul className="mt-2 grid gap-1 text-sm text-ink/80" dir="ltr">{["ask_noor — chat with Noor (all her tools)", "generate_content — weekly_plan | social | article | whatsapp | ads | gbp", "list_inbox — pending / approved / rejected", "read_file / list_files — brand.md, products.md, strategy.md…", "get_brand_rules — tone, dialect, audience, enforced banned words (free)", "check_brand — pass or the rule that fired, with the matched word (free)", "save_draft — save your own draft to the approvals inbox as pending (free)", "agenda_get — Reem's to-do agenda in Riyadh time, plus approvals waiting (free)", "todo_create / todo_update — add or change a to-do on your list (free)", "todo_propose_done — ask you to confirm an item is done; only you close it, in the app (free)"].map((x) => <li key={x} className="font-mono text-xs">• {x}</li>)}</ul>
    </div>
  );
}
