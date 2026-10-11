# Release R1 (October 2026): main to production

Prepared on 2026-10-11 on branch `claude/r1-release-prep` (not pushed, no pull request yet). Production (thakeen.com, Hostinger, auto-deploys from the `production` branch) is at `487984f` (release #312, 2026-10-09). `main` is at `37b00583`, 80 commits ahead. The process is `docs/system/flows.md` section 52; this file is the list for this one release. Environment variables are named, never valued.

## 1. What the release carries

Pull requests merged into `main` since the last release (`git log --oneline --first-parent origin/production..origin/main`):

| PR | Merged (UTC) | What |
|---|---|---|
| #298 | 2026-10-10 | Model catalog, tiered credits, routing, per-customer model overrides (Straitly; default off, rules 810-866, 902, 903) |
| #311 | 2026-10-10 | Home: scenes heading and line under the cover, looping auto-sliding scenes (rule 775) |
| #315 | 2026-10-10 | Follow-ups of #298: wipeAccount race, brand lock 503, Premium hold on the billing card (rules 905-907) |
| #313 | 2026-10-10 | Partner links (`/p/<code>`) and cron hops use `appOrigin()`, not `req.url` (rule 904): fixes the live redirect to `0.0.0.0:3000` |
| #314 | 2026-10-10 | Reem B2b meeting follow-up and B3 marketing calendar read, PRD v3.2 (rules 910-923). Calendar linking stays off until the calendar app keys are set |
| #318 | 2026-10-10 | Meter every model call Anthropic bills (rules 980-986); 5.5 models only (rules 970-972) |
| #317 | 2026-10-11 | UI/UX phase 0: bugs B-1 to B-11 and quick wins (rules 960-969, 974-977): console Cancel aborts, page titles, skip link, chat a11y, account delete dialog |
| (R1 prep) | not merged | This branch: honesty fixes for the release (rules 924-929, `docs/system/tests/0924-release-honesty.md`). Needs its own pull request into `main` first |

Rule 924-929 changes, carried by the R1 prep branch:
- The line under the home scenes heading says «أمثلة توضيحية» / "Illustrative examples" again; the heading «عملاء جربوا ذكين.» of #311 is kept by founder decision 2026-10-11, and the slider work of #311 stays.
- `hello@nashr.ai` is replaced by `hello@thakeen.com` (one constant, `SUPPORT_EMAIL` in `src/lib/i18n.ts`).
- The unused `waitlist` dictionary (with "first 100 brands get two months free") is removed.
- Paid-tier bullets carry no "coming soon" / «قريباً» item. The Agency line "Dedicated success manager" / «مدير نجاح مخصص» stays (founder decision 2026-10-11).
- The pitch deck generator (`scripts/build_deck.py`) and `docs/Nashr_Pitch_Deck.pptx` lose the invented merchant quote, old prices, the trial length, the invented night-log numbers and the KSA hosting / PDPL claims; the deck says Thakeen / ذكين, Paymob, the brief in the app, connectors waiting on keys and "live at thakeen.com", and marks unsourced figures "TO VERIFY".

## 2. Before the release pull request

- [ ] The R1 prep pull request is reviewed and merged into `main` (draft first, `gh pr ready` once, as CLAUDE.md says).
- [ ] On the release commit: `npm run check` and `npx next build` pass locally.
- [ ] CI is green on the release commit's pull request. A failure outside the code (billing, runner, deploy limit) goes to the founder; no re-run without a change.
- [ ] Staging, if staging.thakeen.com builds from `main`: its `/api/health` shows the release commit, and `node scripts/smoke.mjs https://staging.thakeen.com` passes. If staging is not building yet, say so in the release pull request and open the changed pages on a local production build instead.
- [ ] Stored shapes (rule 679): #298 adds optional fields only (`Conversation.model`, `Brand.model`, `User.chinaHostingOk`): EXPAND. Read #314 and #318 for any new or changed Redis key or field and name the step for each in the release pull request.
- [ ] Environment variables. Added to `docs/system/variables.md` since production: `LLM_PROVIDER`, `STRAITLY_API_KEY`, `STRAITLY_BASE_URL` (all optional; production keeps `LLM_PROVIDER` unset, direct Anthropic) and `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (optional, Outlook calendar). `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` now also serve the Google calendar. None must be set for this release; any one set later is a rebuild and counts as a release.
- [ ] Release window: merge between 22:00 and 00:40 UTC, at minute :05-:10, :20-:25, :35-:40 or :50-:55 (flows.md 52, item 6).

## 3. Founder steps

1. Approve and merge the release pull request `main` to `production` in GitHub with "Create a merge commit" (never squash or rebase). Claude opens it and never merges it.
2. Watch the Hostinger build of `production` start. If no build starts within a few minutes, start a redeploy of the thakeen.com Node.js app in hPanel. Change no environment variable there for this release.
3. Say "done" in chat; Claude then runs the checks below and tags the commit `live-YYYY-MM-DD-N`.

## 4. After the release: smoke list

Warm-up first: one request each to `/ar`, `/en`, `/ar/app`, `/api/health`.

- [ ] `/api/health` on thakeen.com answers 200 and shows the release commit (or, while `commit` is `unknown`, a `built` time later than before).
- [ ] `node scripts/smoke.mjs https://thakeen.com` passes (anonymous checks only).
- [ ] Home heading, Arabic (`/ar`): the scenes section reads «عملاء جربوا ذكين.» with «أمثلة توضيحية: وش عجبهم، وش تعلّموا، ووش ينصحون غيرهم فيه.» under it; «عملاء جربوا ذكين.» appears nowhere.
- [ ] Home heading, English (`/en`): "How owners work with Thakeen." with "Illustrative examples: what they like, what they learned, and what they recommend." under it.
- [ ] `GET https://thakeen.com/p/<any code>` answers a redirect to `https://thakeen.com/ar/app/signup...`, never to `0.0.0.0` (rule 904).
- [ ] Billing page (`/ar/app/billing`, a paid test account without WhatsApp support set, or the plan cards' email button): the address shown is `hello@thakeen.com`; no `nashr.ai` anywhere in the page source.
- [ ] Pricing page (`/ar/pricing`, `/en/pricing`): no plan bullet says «قريباً» / "coming soon"; Agency still lists "Dedicated success manager".
- [ ] Founder console: a reason prompt (for example "change plan") with Cancel changes nothing; "Extend trial" with Cancel sends nothing (rule 960).
- [ ] Page titles: an app screen and a console section show «الشاشة · ذكين» / "Screen · Thakeen" in the browser tab (rule 961).
- [ ] Chat: one message gets an answer on the live site (production stays on direct Anthropic).
- [ ] A wrong commit in `/api/health` 10 minutes after the merge: read the Hostinger build list and the build log; rollback is a revert pull request into `production` (flows.md 52, item 11).

## 5. Founder decisions of 2026-10-11 (kept as they are)

- Home: the Arabic scenes heading «عملاء جربوا ذكين.» stays; the line under it carries «أمثلة توضيحية» / "Illustrative examples" (rule 926).
- Agency bullet "Dedicated success manager" / «مدير نجاح مخصص» stays.
- Pricing line "Pay yearly, get two months free (coming soon)" / «ادفع سنوياً ووفّر شهرين (قريباً)» and the integrations line "X (coming soon)" / «X (قريباً)» stay.
- Deck: every item fixed in `scripts/build_deck.py` (rule 928); the market figures, targets and base case stay with a "TO VERIFY" marker.
