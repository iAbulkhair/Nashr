import { notFound } from "next/navigation";
import { adminKeySession, currentUser, isAdminCookie, isFounderActor } from "@/lib/auth";

/**
 * The founder console's page gate (rule 870): a key session or a founder signed in as themselves (`isAdminCookie`),
 * else a plain 404 so the console never advertises itself. `keySession` decides the "end key session" button and where
 * an ended session sends the founder back; `founder` decides the «العودة للتطبيق» link (a key session alone has no app
 * sign-in to go back to). Every /{lang}/admin page calls this first; the APIs under /api/admin check `isAdmin(req)`.
 */
export async function requireAdmin(): Promise<{ keySession: boolean; founder: boolean }> {
  if (!(await isAdminCookie())) notFound();
  const [keySession, user] = await Promise.all([adminKeySession(), currentUser()]);
  return { keySession, founder: isFounderActor(user) };
}
