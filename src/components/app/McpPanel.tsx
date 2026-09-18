"use client";
import { useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n";

export default function McpPanel({ lang, origin }: { lang: Lang; origin: string }) {
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
      <h2 className="mt-6 font-display text-xl font-bold">{ar ? "الأدوات المتاحة" : "Tools exposed"}</h2>
      <ul className="mt-2 grid gap-1 text-sm text-ink/80" dir="ltr">{["ask_noor — chat with Noor (all her tools)", "generate_content — weekly_plan | social | article | whatsapp | ads | gbp", "list_inbox — pending / approved / rejected", "read_file / list_files — brand.md, products.md, strategy.md…"].map((x) => <li key={x} className="font-mono text-xs">• {x}</li>)}</ul>
    </div>
  );
}
