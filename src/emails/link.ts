import { appOrigin } from "../lib/origin";

/**
 * Every link in an email points into the app, at the one canonical origin (src/lib/origin.ts), never at a host read from
 * a request header (rule 687). A template refuses any other href by throwing: callers build each link from `appOrigin()`,
 * so a throw here is a programming error caught by the tests, never a link quietly sent somewhere else. The origin is
 * compared after parsing as well as by prefix, so `https://thakeen.com.evil.example/` and `https://thakeen.com@evil/`
 * are refused, and the bare origin must be followed by a path.
 */
export function appLink(href: string): string {
  const origin = appOrigin();
  let parsed: string | null = null;
  try {
    parsed = new URL(href).origin;
  } catch {
    parsed = null;
  }
  if (!href.startsWith(`${origin}/`) || parsed !== origin || /[\s<>"']/.test(href)) throw new Error("email link outside the app origin");
  return href;
}
