import { notFound } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { PLAN_CREDITS, getUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Founder console. Open /{lang}/app/admin?key=WAITLIST_ADMIN_KEY
export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<{ key?: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const { key } = await searchParams;
  if (!process.env.WAITLIST_ADMIN_KEY || key !== process.env.WAITLIST_ADMIN_KEY) notFound();
  const emails = await db.smembers("users:all");
  const users = (await Promise.all(emails.map((e) => getUser(e)))).filter((u): u is NonNullable<typeof u> => !!u).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (
    <div dir="ltr">
      <h1 className="font-display text-2xl font-bold text-oasis">Users ({users.length})</h1>
      <p className="mt-1 text-sm text-ink/60">Set plan: <code>curl -X POST &quot;/api/admin/plan?key=…&quot; -H &quot;Content-Type: application/json&quot; -d &apos;{`{"email":"…","plan":"pro"}`}&apos;</code>. Plans: {Object.keys(PLAN_CREDITS).join(", ")}.</p>
      <table className="mt-4 w-full text-sm">
        <thead><tr className="border-b border-ink/10 text-left"><th className="py-2">Email</th><th>Name</th><th>Phone</th><th>Plan</th><th>Credits</th><th>Trial ends</th><th>Joined</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.email} className="border-b border-ink/5"><td className="py-2">{u.email}</td><td>{u.name}</td><td>{u.phone}</td><td>{u.plan}</td><td>{u.credits}</td><td>{u.trialEnds.slice(0, 10)}</td><td>{u.createdAt.slice(0, 10)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
