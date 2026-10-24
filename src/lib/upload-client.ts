/**
 * The browser half of an image upload (rules 3501, 3611), shared by the profile picture and the workspace logo: plan at
 * `{base}/upload` with the type and size, then either send the bytes straight to the signed grant (a PUT, or a form POST
 * whose fields go first and the file last) and post the server-made `name` back to `base`, or post the image itself to
 * `base`. The server checks the bytes again either way; nothing here decides what is accepted. Browser-only code: no
 * server module is imported.
 */

export type UploadAnswer = { ok: true; url: string } | { ok: false; error: string };
type Plan = { ok?: boolean; error?: string; mode?: "signed" | "server"; name?: string; url?: string; method?: "PUT" | "POST"; headers?: Record<string, string>; fields?: Record<string, string> };

export async function sendImage(base: "/api/account/avatar" | "/api/account/logo", blob: Blob, f: typeof fetch = fetch): Promise<UploadAnswer> {
  try {
    const plan = (await f(`${base}/upload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contentType: blob.type, size: blob.size }) }).then((r) => r.json())) as Plan;
    if (!plan.ok) return { ok: false, error: plan.error ?? "generic" };
    let res: Response;
    if (plan.mode === "signed" && plan.url && plan.name) {
      let body: Blob | FormData = blob;
      if (plan.fields) {
        const form = new FormData();
        for (const [k, v] of Object.entries(plan.fields)) form.append(k, v);
        form.append("file", blob);
        body = form;
      }
      const sent = await f(plan.url, { method: plan.method ?? "PUT", headers: plan.headers, body });
      if (!sent.ok) return { ok: false, error: "generic" };
      res = await f(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: plan.name }) });
    } else {
      res = await f(base, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
    }
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
    return j.ok && j.url ? { ok: true, url: j.url } : { ok: false, error: j.error ?? "generic" };
  } catch {
    return { ok: false, error: "generic" };
  }
}
