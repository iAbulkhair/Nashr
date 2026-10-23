"use client";
import { useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/i18n";
import { NEWSLETTER_COPY } from "@/lib/newsletter-copy";
import { postJson, succeeded } from "@/lib/auth-client";
import { readInviteToken, withoutFragment } from "@/components/app/inviteToken";

/**
 * The page a newsletter link opens (rules 3600-3609): /{lang}/newsletter/confirm#t=<64 hex> and
 * /{lang}/newsletter/unsubscribe#t=<64 hex>. The token rides in the URL fragment, which no server sees; it is read once,
 * taken out of the address bar and posted in a JSON body. A `?token=` query is never read.
 *
 * Unsubscribing runs when the page opens: it is one click in the mail and nothing more, and a second visit is harmless
 * (the route is idempotent). Confirming waits for the visitor's own press of the button, so a mail scanner that opens the
 * link and runs its scripts cannot subscribe anyone.
 */
export default function NewsletterToken({ lang, mode }: { lang: Lang; mode: "confirm" | "unsubscribe" }) {
  const c = NEWSLETTER_COPY[lang].page;
  const tokenRef = useRef("");
  const started = useRef(false);
  const [state, setState] = useState<"reading" | "ready" | "busy" | "done" | "failed" | "retry" | "missing">("reading");

  async function post() {
    setState("busy");
    const p = await postJson(`/api/newsletter/${mode}`, { token: tokenRef.current });
    if (succeeded(p)) setState("done");
    else setState(p.status === 400 ? "failed" : "retry");
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    tokenRef.current = readInviteToken(window.location.hash);
    if (window.location.hash) window.history.replaceState(window.history.state, "", withoutFragment(window.location));
    // Off the effect body (a microtask), as the other pages that read a fragment do: the state is set from a callback.
    void Promise.resolve().then(() => {
      if (!tokenRef.current) setState("missing");
      else if (mode === "unsubscribe") void post();
      else setState("ready");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on open
  }, []);

  const title = mode === "confirm" ? c.confirm.title : c.unsubscribe.title;
  return (
    <main id="main" tabIndex={-1} className="page-wrap">
      <div className="mx-auto grid max-w-md gap-4 text-start">
        <h1 className="font-display text-2xl font-bold text-foreground">{title}</h1>
        {state === "ready" && mode === "confirm" && (
          <>
            <p>{c.confirm.body}</p>
            <button type="button" onClick={post} className="s-btn justify-self-start">{c.confirm.action}</button>
          </>
        )}
        {(state === "busy" || state === "reading") && <p role="status">{mode === "unsubscribe" ? c.unsubscribe.working : "…"}</p>}
        {state === "done" && <p role="status" data-testid="newsletter-done">{mode === "confirm" ? c.confirm.done : c.unsubscribe.done}</p>}
        {state === "failed" && <p role="alert">{mode === "confirm" ? c.confirm.failed : c.unsubscribe.failed}</p>}
        {state === "missing" && <p role="alert">{c.missing}</p>}
        {state === "retry" && (
          <>
            <p role="alert">{NEWSLETTER_COPY[lang].errors.server}</p>
            <button type="button" onClick={post} className="s-btn justify-self-start">{c.retry}</button>
          </>
        )}
      </div>
    </main>
  );
}
