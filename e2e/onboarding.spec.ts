import { test, expect, appPath, fillWhenReady, open } from "./fixtures/app";
import { signUpVerified } from "./fixtures/accounts";
import { appDict } from "../src/lib/app-i18n";
import { DICT_COPY, MAX_WORDS, SECTORS, START_COPY, WORDS } from "../src/lib/dictionary";
import { BRAND, freshAccount, hydrated, inviteMember, joinAs, useSession } from "./fixtures/workspace";

/**
 * First login (src/app/[lang]/app/b/[brand]/start, src/components/app/DictionaryStart.tsx and StartLaunch.tsx): an account
 * with no brand file is sent to "The Thakeen Dictionary", a seven-step game, and the answers become its brand file. This is
 * the spec auth.setup.ts points to: the shared owner is given a brand so every other spec sees the real pages, and the
 * no-brand redirect and the wizard are driven here with throwaway accounts.
 *
 * The "I have a link" ending (a crawl of the owner's site by Noor) needs the network and the model, so it is not driven here;
 * the ending without a website saves through PUT /api/brand and needs neither. The confirm route that the link ending calls
 * is checked at the API: it only records the address, it crawls nothing.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const D = DICT_COPY;
const S = appDict.en.start;
const en = <T extends { en: string }>(l: T) => l.en;

test("a new account is sent to the Dictionary, plays its seven steps and ends with a saved brand file", async ({ page, failures }) => {
  void failures;
  const account = freshAccount("onboard", "E2E Onboard");
  const signup = await signUpVerified(page.request, { email: account.email, name: account.name, password: account.password, lang: "en" }, "onboarding-wizard");
  expect(signup.ok(), await signup.text()).toBe(true);

  // Without a brand file every workspace page goes to the start page, never to a broken inbox.
  await open(page, "/en/app");
  await page.waitForURL((u) => appPath(u) === "/en/app/b/default/start");
  await open(page, "/en/app/b/default/reports");
  await page.waitForURL((u) => appPath(u) === "/en/app/b/default/start");

  const game = page.getByTestId("dictionary-start");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en(D.title));
  await expect(game).toHaveAttribute("data-step", "1");
  const next = page.getByRole("button", { name: en(D.next), exact: true });
  const back = page.getByRole("button", { name: en(D.back), exact: true });
  await expect(back, "no Back on the first step").toHaveCount(0);

  // Step 1: a name and a sector. Next stays off until both are given; spaces are collapsed and the name is cut at 40.
  const brandField = page.getByLabel(en(D.brandLabel));
  await hydrated(brandField);
  await brandField.fill("x".repeat(60));
  await expect(brandField).toHaveValue("x".repeat(40));
  await brandField.fill("Test   Cafe  Co");
  await expect(brandField).toHaveValue("Test Cafe Co");
  await expect(page.getByText(en(D.greet.text))).toBeVisible();
  await expect(next, "a sector is still missing").toBeDisabled();
  const coffee = SECTORS.find((s) => s.id === "coffee")!;
  await page.getByRole("radio", { name: en(coffee.name) }).check();
  await expect(next).toBeEnabled();
  await next.click();

  // Step 2: exactly five words. The sixth cannot be picked, and taking one away turns Next off again.
  await expect(game).toHaveAttribute("data-step", "2");
  await expect(page.getByRole("heading", { level: 2 })).toContainText(en(D.steps[2]));
  await expect(page.getByText(en(D.counter).replace("{n}", "0"))).toBeVisible();
  await expect(next).toBeDisabled();
  const picks = WORDS.slice(0, MAX_WORDS + 1);
  for (const w of picks.slice(0, MAX_WORDS)) await page.getByRole("button", { name: en(w.name), exact: true }).click();
  await expect(page.getByText(en(D.counter).replace("{n}", String(MAX_WORDS)))).toBeVisible();
  await expect(page.getByRole("button", { name: en(picks[MAX_WORDS].name), exact: true }), "the sixth word is off").toBeDisabled();
  await expect(next).toBeEnabled();
  const first = page.getByRole("button", { name: en(picks[0].name), exact: true });
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "false");
  await expect(next).toBeDisabled();
  await first.click();
  await expect(next).toBeEnabled();
  await next.click();

  // Steps 3 and 4 are samples, tagged as examples and not generated for this owner; Back returns to the step before.
  await expect(game).toHaveAttribute("data-step", "3");
  await expect(page.locator(".badge", { hasText: en(D.example) }).first()).toBeVisible();
  await next.click();
  await expect(game).toHaveAttribute("data-step", "4");
  await back.click();
  await expect(game).toHaveAttribute("data-step", "3");
  await next.click();
  await expect(game).toHaveAttribute("data-step", "4");
  await next.click();

  // Step 5 is the approval: no Next here, only Approve, and the note says nothing goes out before the tap.
  await expect(game).toHaveAttribute("data-step", "5");
  await expect(next).toHaveCount(0);
  await expect(page.getByText(en(D.approveNote))).toBeVisible();
  await page.getByRole("button", { name: en(D.approve), exact: true }).click();

  // Step 6 previews analysis and measurement; step 7 is the launch.
  await expect(game).toHaveAttribute("data-step", "6");
  await expect(page.getByRole("heading", { level: 2 })).toContainText(en(START_COPY.steps6));
  await expect(page.getByText(en(D.measure))).toBeVisible();
  await next.click();
  await expect(game).toHaveAttribute("data-step", "7");
  await expect(next).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2 })).toContainText(en(START_COPY.steps7));

  // The ending without a website: what you sell and who buys, then the brand file is saved and the workspace opens.
  await page.getByRole("button", { name: en(START_COPY.noSite), exact: true }).click();
  const save = page.getByRole("button", { name: en(START_COPY.saveNoSite), exact: true });
  await expect(save, "both fields are required").toBeDisabled();
  await fillWhenReady(page.getByLabel(en(START_COPY.products)), "Roasted beans and brewing gear");
  await expect(save).toBeDisabled();
  await fillWhenReady(page.getByLabel(en(START_COPY.audience)), "Home brewers in the city");
  await hydrated(save);
  await expect(save).toBeEnabled();
  const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/brand" && r.request().method() === "PUT");
  await save.click();
  const res = await saved;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toMatchObject({ name: "Test Cafe Co", industry: en(coffee.name), products: "Roasted beans and brewing gear", audience: "Home brewers in the city", dialect: "english", languages: ["en"], create: true });
  await page.waitForURL((u) => appPath(u) === "/en/app/b/default");

  // The brand file holds the answers, in the words played; the start page now has nothing to ask and goes to the inbox.
  const stored = ((await (await page.request.get("/api/brand")).json()) as { brand: { name: string; industry: string; tone: string } }).brand;
  expect(stored.name).toBe("Test Cafe Co");
  expect(stored.industry).toBe(en(coffee.name));
  for (const w of picks.slice(0, MAX_WORDS)) expect(stored.tone, `tone of "${en(w.name)}"`).toContain(en(w.tone));
  await open(page, "/en/app/b/default/start");
  await page.waitForURL((u) => appPath(u) === "/en/app/b/default");

  // The game's save is create-only: a second save from another tab cannot replace the brand, and a confirm is refused too.
  const again = await page.request.put("/api/brand", { data: { name: "Other Name", industry: "Clinic", products: "x", audience: "y", create: true }, headers: BRAND });
  expect(again.status()).toBe(409);
  expect((await again.json()).error).toBe("exists");
  const confirm = await page.request.post("/api/onboard/confirm", { data: { url: "https://roastery.example" }, headers: BRAND });
  expect(confirm.status()).toBe(409);
  expect((await confirm.json()).error).toBe("already_onboarded");
});

test("the confirm route records an address and nothing else; a member waits while the owner has not built the workspace", async ({ page, request, playwright, baseURL }) => {
  const seed = "onboarding-rules";
  const owner = freshAccount("onboard-rules", "E2E Onboard Rules");
  const member = freshAccount("onboard-member", "E2E Onboard Member");
  const signup = await signUpVerified(request, { email: owner.email, name: owner.name, password: owner.password, lang: "en" }, seed);
  expect(signup.ok(), await signup.text()).toBe(true);

  // POST /api/onboard/confirm {url, answers?}: the address must be one, answers must be a finished game, and nothing is
  // crawled or charged (the first brand is free). Signed out it is a 401.
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    expect((await anonymous.post("/api/onboard/confirm", { data: { url: "https://roastery.example" } })).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
  const tooShort = await request.post("/api/onboard/confirm", { data: { url: "x" }, headers: BRAND });
  expect(tooShort.status()).toBe(400);
  expect((await tooShort.json()).error).toBe("bad_url");
  const unfinished = await request.post("/api/onboard/confirm", { data: { url: "https://roastery.example", answers: { brand: "Only a name" } }, headers: BRAND });
  expect(unfinished.status()).toBe(400);
  expect((await unfinished.json()).error).toBe("bad_answers");
  const ok = await request.post("/api/onboard/confirm", { data: { url: "https://roastery.example" }, headers: BRAND });
  expect(ok.status(), await ok.text()).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: true, cost: 0 });

  // A member who joined before the owner built anything: the start page tells them to wait, and the build is refused to them.
  const token = await inviteMember(request, member.email, "member", seed);
  const memberApi = await joinAs(playwright, baseURL!, token, member, seed);
  try {
    const refused = await memberApi.post("/api/onboard/confirm", { data: { url: "https://roastery.example" }, headers: BRAND });
    expect(refused.status()).toBe(403);
    const brandSave = await memberApi.put("/api/brand", { data: { name: "Member Brand", industry: "x", products: "y", audience: "z", create: true }, headers: BRAND });
    expect(brandSave.status(), "a member cannot write the brand file").toBe(403);

    await useSession(page.context(), memberApi);
    await open(page, "/en/app/b/default/start");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(S.memberTitle);
    await expect(page.getByText(S.memberWait)).toBeVisible();
    await expect(page.getByTestId("dictionary-start")).toHaveCount(0);
  } finally {
    await memberApi.dispose();
  }
});
