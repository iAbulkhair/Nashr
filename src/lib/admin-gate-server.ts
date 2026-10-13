import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, consoleIdentity, type ConsoleIdentity } from "@/lib/auth";
import { safeNext } from "@/lib/safe-next";

/** What a console page renders: the section (`ended: false`), or the "key session ended" notice (`ended: true`). */
export type AdminGate =
  | { ended: false; keySession: boolean; founder: boolean; staff: ConsoleIdentity["staff"] }
  | { ended: true; keySession: true; founder: false; staff: null };

/** The staff sign-in page, with where to go back to once signed in (through `safeNext`, rule 1652). */
export function adminLoginHref(lang: "ar" | "en", here: string): string {
  const next = safeNext(here);
  return next && next.startsWith(`/${lang}/admin`) ? `/${lang}/admin/login?next=${encodeURIComponent(next)}` : `/${lang}/admin/login`;
}

/**
 * The founder console's page gate: a staff session, a key session, or (expand only, rule 1649) the founder's own
 * customer session while that path is open. Every /{lang}/admin section page calls this first; the APIs under
 * /api/admin check `adminActor(req)`. `keySession` decides the "end key session" button and where an ended session
 * sends the founder back; `founder` decides the «العودة للتطبيق» link; `staff` is the signed-in staff member.
 *
 * Without any of them the page redirects to the staff sign-in page (rule 1652, replacing the 404 of rule 870): the staff
 * cookie is `SameSite=Strict`, so a link to the console opened from email or chat arrives without it, and the sign-in
 * page is public anyway. `here` is the page's own path, kept as `?next=` only when it is a console path.
 *
 * One exception: a browser that still carries a key session cookie whose session is over (15 idle minutes, or 12 hours)
 * gets `ended: true`, and the page shows the notice with the link to the key form, as before.
 */
export async function requireAdmin(lang: "ar" | "en", here: string): Promise<AdminGate> {
  const who = await consoleIdentity();
  if (!who.staff && !who.keySession && !who.founder) {
    const id = (await cookies()).get(ADMIN_COOKIE)?.value;
    if (id && /^[0-9a-f]{64}$/.test(id)) return { ended: true, keySession: true, founder: false, staff: null };
    redirect(adminLoginHref(lang, here));
  }
  // A staff session is the console identity even when a key cookie is also present (adminActor reads it first).
  return { ended: false, keySession: !who.staff && who.keySession, founder: !who.staff && who.founder, staff: who.staff };
}
