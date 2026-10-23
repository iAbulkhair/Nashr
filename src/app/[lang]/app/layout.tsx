import Link from "next/link";
import { getAvatar } from "@/lib/avatar";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { safeNext } from "@/lib/safe-next";
import { appDict } from "@/lib/app-i18n";
import { currentPerson, currentUser, currentUserUnverified, isFounderActor, trialDaysLeft } from "@/lib/auth";
import { MULTI_ORG } from "@/lib/multi-org";
import { WS_HEADER, appHref, asHandle, oldAppTarget, stripWs } from "@/lib/ws-path";
import { handleOf } from "@/lib/ws-handle";
import Sidebar from "@/components/app/Sidebar";
import TrialBanner from "@/components/app/TrialBanner";
import InstallHint from "@/components/app/InstallHint";
import TabBeat from "@/components/app/TabBeat";
import { pushOn } from "@/lib/push";
import ImpersonationBanner from "@/components/app/ImpersonationBanner";
import LangToggle from "@/components/LangToggle";
import Wordmark from "@/components/Wordmark";
import LimitModal from "@/components/app/LimitModal";
import { getBrand, pendingCount } from "@/lib/brand";
import { listNotifs } from "@/lib/notifications";
import { WorkspaceProvider } from "@/components/app/WorkspaceContext";
import { sc } from "@/lib/auth";
import { can } from "@/lib/roles";
import { topupsSold } from "@/lib/pricing";
import { SKIP_TO_CONTENT } from "@/lib/screen-titles";
import { ToastProvider } from "@/components/ui/Toast";
import { acct } from "@/lib/account-id";

/**
 * Paths reachable without a session. `/join` accepts a team invite (the token is in the URL fragment). `/verify` is the
 * page an owner who has not proved the address lands on: `currentUser()` reads that owner as signed out (rule 751), so the
 * page reads the session itself (`currentUserUnverified`, rule 752).
 */
const PUBLIC = ["/login", "/signup", "/forgot", "/reset", "/admin", "/join", "/verify"];

export default async function AppLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = appDict[lang];
  const h = await headers();
  const path = h.get("x-pathname") ?? "";
  const isPublic = PUBLIC.some((p) => path.endsWith(p));
  // Multi-workspace M2 (spec section 7): the page's workspace from its own link (the proxy sets the header from the
  // path); `currentUser()` answers 404 for a handle that is not one of the person's workspaces.
  const handle = MULTI_ORG ? asHandle(h.get(WS_HEADER)) : null;
  const workspacesPage = MULTI_ORG && stripWs(path) === `/${lang}/app/workspaces`;
  const user = await currentUser();
  // An owner who has not verified the address reads as signed out above; send them to the code page, not to login (rule 754).
  const pending = !user && !isPublic && path ? await currentUserUnverified() : null;
  if (pending?.actor?.kind === "owner") {
    // The requested page rides along in `next`, kept to a same-site path, so verifying lands where the owner was going.
    const back = safeNext(path);
    redirect(`/${lang}/app/verify${back ? `?next=${encodeURIComponent(back)}` : ""}`);
  }
  // A valid person without a valid workspace (their last one removed, or none yet) picks one on the workspaces page;
  // that page itself is reachable in that state (it reads `currentPerson()`).
  if (MULTI_ORG && !user && !isPublic && path && (await currentPerson())) {
    if (!workspacesPage) redirect(`/${lang}/app/workspaces`);
  } else if (!user && !isPublic && path) redirect(`/${lang}/app/login`);
  // An old address without `w/{handle}` goes to the same page of the session's workspace, the query kept (307); an old
  // brand section goes straight under the session's brand too (`/w/{handle}/b/{id}/…`, one hop).
  if (MULTI_ORG && user && !isPublic && !handle) {
    const to = oldAppTarget(lang, path, h.get("x-search") ?? "", handleOf(user), user.brandId);
    if (to) redirect(to);
  }

  if (!user) {
    // Rule 1088: one toast region for every screen under the app, signed in or not.
    return (
      <ToastProvider lang={lang}>
      <div className="min-h-screen bg-background">
        <a href="#main" className="skip-link">{SKIP_TO_CONTENT[lang]}</a>
        <header className="border-b-[1.5px] border-border-strong bg-background text-foreground">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
            <Link href={`/${lang}`} className="font-display text-xl font-bold"><Wordmark lang={lang} name={t.appName} /></Link>
            <LangToggle lang={lang} />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{children}</main>
      </div>
      </ToastProvider>
    );
  }

  // Rule 1119: the shell's first numbers (bell, approvals badge) are read here, in one round of parallel reads with the
  // brand, so the rail paints with them instead of fetching them again on every navigation. Scope and email are the
  // session's, never the request's.
  // The acting person's picture (rule 3502) in the same round: the session's person, never one from the request.
  const [brand, notifs, toApprove, avatar] = await Promise.all([getBrand(sc(user)), listNotifs(acct(user)), pendingCount(sc(user)), user.actor ? getAvatar(user.actor.pid) : Promise.resolve(null)]);
  const unread = notifs.filter((n) => !n.read).length;
  // `user` is the ACCOUNT (the owner's record); the person acting is `user.actor`. Plan and credits belong to the account,
  // the name, email and role shown are the actor's. The flags only hide controls; the routes enforce the same `can()`.
  const actor = user.actor;
  const owner = can(user, "billing");
  return (
    <ToastProvider lang={lang}>
    <WorkspaceProvider initial={{ credits: user.credits, unread, pending: toApprove }} brandId={user.brandId ?? null} handle={handle} multiOrg={MULTI_ORG}>
    <div className="flex min-h-dvh flex-col bg-background lg:h-dvh lg:flex-row lg:overflow-hidden">
      {/* Rule 968: past the sidebar's links straight to the screen. */}
      <a href="#main" className="skip-link">{SKIP_TO_CONTENT[lang]}</a>
      <Sidebar t={t} lang={lang} user={{ name: actor?.name ?? user.name, email: actor?.email ?? user.email, role: actor?.role ?? "member", credits: user.credits, plan: user.plan, avatar }} show={{ owner, refer: can(user, "referral"), mcp: can(user, "mcp.token"), partner: !!user.partnerCode && can(user, "partner") }} brandName={brand?.name} admin={isFounderActor(user)} supportWa={(process.env.SUPPORT_WHATSAPP ?? "").replace(/\D/g, "") || undefined} />
      <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col px-4 py-5 sm:px-8 lg:overflow-y-auto">
        {/* Rule 1177: from the session, never the cookie alone; the account's email and the end the founder chose. */}
        {actor?.kind === "founder" && <ImpersonationBanner lang={lang} email={user.email} until={actor.until} />}
        {!path.endsWith("/billing") && !path.endsWith("/start") && !path.endsWith("/join") && <TrialBanner lang={lang} days={trialDaysLeft(user.trialEnds)} plan={user.plan} industry={brand?.industry} owner={owner} to={(p?: string) => appHref(lang, p, handle, user.brandId)} />}
        <InstallHint lang={lang} />
        {pushOn() && (actor?.kind === "owner" || actor?.kind === "member") && <TabBeat />}
        {children}
      </main>
      <LimitModal t={t} lang={lang} owner={owner} governs={can(user, "governance.write")} topups={topupsSold(user.plan)} />
    </div>
    </WorkspaceProvider>
    </ToastProvider>
  );
}
