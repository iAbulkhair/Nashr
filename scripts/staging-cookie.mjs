// Gets the staging access cookie (rule 675) for the release scripts (probe.mjs, smoke.mjs). Node 22, no dependencies.

/**
 * POSTs the access form and returns the `thakeen_staging=<token>` pair to send as a Cookie header, or null when the
 * route gave none (no code, a wrong code, the route's 5 tries per 15 minutes used up, or an origin that is not
 * staging). `redirect: "manual"` keeps the 303 itself, whose Set-Cookie is the answer. The code travels only in the
 * form body and is never printed.
 * @param {string} origin e.g. https://staging.thakeen.com
 * @param {string | undefined} code
 * @returns {Promise<string | null>}
 */
export async function stagingCookie(origin, code) {
  if (!code) return null;
  const res = await fetch(`${origin}/api/staging-access`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ code, lang: "en" }),
  });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("thakeen_staging=")) ?? null;
}
