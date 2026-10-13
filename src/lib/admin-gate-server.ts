import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { ADMIN_COOKIE, consoleIdentity, type ConsoleIdentity } from "@/lib/auth";

/** What a console page renders: the section (`ended: false`), or the "key session ended" notice (`ended: true`). */
export type AdminGate =
  | { ended: false; keySession: boolean; founder: boolean; staff: ConsoleIdentity["staff"] }
  | { ended: true; keySession: true; founder: false; staff: null };

/**
 * The founder console's page gate (rule 870): a key session or a founder signed in as themselves (`isAdminCookie`),
 * else a plain 404 so the console never advertises itself. `keySession` decides the "end key session" button and where
 * an ended session sends the founder back; `founder` decides the «العودة للتطبيق» link (a key session alone has no app
 * sign-in to go back to). Every /{lang}/admin page calls this first; the APIs under /api/admin check `isAdmin(req)`.
 *
 * One exception to the 404: a browser that still carries a key session cookie whose session is over (15 idle minutes, or
 * 12 hours) gets `ended: true`, and the page shows the same notice a 401 shows on screen, with the link to the key form.
 * The sections are separate pages, so the next click after the idle limit reaches this gate before any admin call could
 * answer 401. Only a browser that once held a key session sees it; the key form at ?login=1 is no more secret than this.
 * A founder whose own sign-in ended gets the 404: every customer carries a session cookie, so that case cannot be told
 * apart without telling customers the console exists.
 */
export async function requireAdmin(): Promise<AdminGate> {
  const who = await consoleIdentity();
  if (!who.staff && !who.keySession && !who.founder) {
    const id = (await cookies()).get(ADMIN_COOKIE)?.value;
    if (id && /^[0-9a-f]{64}$/.test(id)) return { ended: true, keySession: true, founder: false, staff: null };
    notFound();
  }
  return { ended: false, keySession: who.keySession, founder: who.founder, staff: who.staff };
}
