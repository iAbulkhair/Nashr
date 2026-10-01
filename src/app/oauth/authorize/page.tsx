import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getClient, validRedirectUri } from "@/lib/oauth";
import { can } from "@/lib/roles";

export const dynamic = "force-dynamic";

/** OAuth consent screen. Unauthenticated users are sent to login and bounced back here. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const u = await currentUser();
  const self = "/oauth/authorize?" + new URLSearchParams(Object.entries(q).filter(([, v]) => v != null) as [string, string][]).toString();
  if (!u) redirect(`/ar/app/login?next=${encodeURIComponent(self)}`);
  const client = q.client_id ? await getClient(q.client_id) : null;
  const bad = !client ? "unknown client" : !q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri) ? "redirect_uri not registered" : !validRedirectUri(q.redirect_uri) ? "redirect_uri must be https, or http on the loopback interface" : q.response_type !== "code" ? "response_type must be code" : !q.code_challenge ? "PKCE required" : null;
  // Connecting an app hands it the whole account, so only the owner, signed in as themselves, is offered the form.
  // /api/oauth/approve refuses everyone else in code; this only saves them a form that cannot work.
  const ownerOnly = !can(u, "oauth.approve") ? "Only the account owner can connect apps to this account. Ask the owner to approve it from their own login." : null;
  const who = u.actor?.email ?? u.email;
  // Client registration is open, so the name on this screen is whatever the app called itself — "Nashr Mobile" is a
  // name anyone can claim. The one fact the owner can actually judge is where the authorization code will be sent, so
  // show that host rather than leaving it buried in a hidden input.
  const destination = (() => { try { return new URL(q.redirect_uri ?? "").host; } catch { return ""; } })();
  return (
    <html lang="en" dir="ltr">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#f6f4ee", color: "#101418", margin: 0 }}>
        <main style={{ maxWidth: 440, margin: "10vh auto", background: "#fff", border: "1px solid #e5e2d9", borderRadius: 16, padding: 28 }}>
          <p style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: "#d9503f", margin: 0 }}>Thakeen · Noor</p>
          {bad || ownerOnly ? (
            <><h1 style={{ fontSize: 20 }}>Cannot authorize</h1><p style={{ color: "#666" }}>{bad ?? ownerOnly}</p>{!bad && <p style={{ color: "#888", fontSize: 12 }}>Signed in as <b>{who}</b>.</p>}</>
          ) : (
            <>
              <h1 style={{ fontSize: 22, margin: "8px 0 4px" }}>Allow <b>{client!.client_name || client!.client_id}</b> to use Noor?</h1>
              <p style={{ color: "#555", fontSize: 14 }}>Signed in as <b>{who}</b>. The app will be able to: chat with Noor, create content in your inbox (uses credits), read your workspace files.</p>
              <p style={{ background: "#fdf3f1", border: "1px solid #f0d5cf", borderRadius: 10, padding: "10px 12px", fontSize: 14, color: "#101418" }}>
                Approving sends your authorization code to <b style={{ wordBreak: "break-all" }}>{destination || "an unknown address"}</b>.
                <br />
                <span style={{ color: "#777", fontSize: 12 }}>Any developer can register an app under any name. Only continue if you recognise that address.</span>
              </p>
              <form method="post" action="/api/oauth/approve">
                {(["client_id", "redirect_uri", "state", "scope", "code_challenge", "code_challenge_method"] as const).map((k) => <input key={k} type="hidden" name={k} value={q[k] ?? ""} />)}
                <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
                  <button name="decision" value="allow" style={{ flex: 1, background: "#0f3d3a", color: "#e9f0ec", border: 0, borderRadius: 999, padding: "12px 16px", fontWeight: 600, cursor: "pointer" }}>Allow</button>
                  <button name="decision" value="deny" style={{ flex: 1, background: "#fff", color: "#101418", border: "1px solid #ccc", borderRadius: 999, padding: "12px 16px", cursor: "pointer" }}>Deny</button>
                </div>
              </form>
              <p style={{ fontSize: 12, color: "#888", marginTop: 16 }}>You can revoke access any time from Thakeen → MCP → Revoke, or by generating a new personal token.</p>
            </>
          )}
        </main>
      </body>
    </html>
  );
}
