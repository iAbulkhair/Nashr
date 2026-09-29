import { describe, expect, it, vi } from "vitest";
import { renderToReadableStream } from "react-dom/server.edge";
import { json, newUser, signIn, signOut } from "./helpers/session";
import { CHANGELOG, SEED_WISHES } from "@/lib/changelog";
import * as vote from "@/app/api/wishlist/vote/route";
import Page from "@/app/[lang]/updates/page";

// The language switch reads the app router, which only exists inside Next. Everything else renders as in production.
vi.mock("@/components/LangToggle", () => ({ default: () => null }));

/** Server-render /{lang}/updates for whoever is signed in, as HTML, the way a visitor without JavaScript gets it. */
async function render(lang: "ar" | "en") {
  const el = await Page({ params: Promise.resolve({ lang }) });
  return new Response(await renderToReadableStream(el)).text();
}

describe("the updates page renders complete on the server (rule 122)", () => {
  it("shows the changelog, the wishlist with real counts, and sign-in links to an anonymous visitor", async () => {
    // One real vote, cast by an account, so the count on the page is not a default.
    const id = SEED_WISHES[10].id;
    const u = await newUser("pagevoter");
    await signIn(u.email);
    await vote.POST(json("/api/wishlist/vote", "POST", { id, on: true }));

    signOut();
    const html = await render("en");
    for (const e of CHANGELOG.slice(0, 3)) expect(html).toContain(e.title.en);
    expect(html).toContain('id="whats-new"');
    expect(html).toContain('id="wishlist"');
    for (const w of SEED_WISHES) expect(html).toContain(w.title.en.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
    expect(html).toContain("Sign in to vote");
    expect(html).toContain(`/en/app/login?next=${encodeURIComponent("/en/updates")}`);
    expect(html).not.toContain("aria-pressed"); // no vote buttons for anonymous visitors
    expect(html).not.toContain("wish-suggest"); // and no suggestion form
    // The item that has a vote shows it, already in the HTML.
    const row = html.slice(html.indexOf(SEED_WISHES[10].title.en));
    expect(row.slice(0, 1500)).toMatch(/dir="ltr">1<\/span>/);
  });

  it("marks the signed-in viewer's own votes as pressed and offers the suggestion form, in Arabic", async () => {
    const u = await newUser("pageowner");
    await signIn(u.email);
    const id = SEED_WISHES[11].id;
    await vote.POST(json("/api/wishlist/vote", "POST", { id, on: true }));
    const html = await render("ar");
    expect(html).toContain("ما الجديد");
    expect(html).toContain("قائمة الأمنيات");
    expect(html).toContain(`aria-pressed="true" aria-label="صوّتَّ: ${SEED_WISHES[11].title.ar}"`);
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect(html).toContain('id="wish-suggest"');
    expect(html).not.toContain("سجّل الدخول للتصويت");
  });
});
