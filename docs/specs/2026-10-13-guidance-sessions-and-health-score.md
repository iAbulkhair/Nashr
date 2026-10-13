# Guidance sessions and the customer health score

Status: proposed, not built. Written 2026-10-13 against `main` at `4c0264b4`. Build order: 6 of 8. Rule numbers are assigned when it is built. Source of the decisions: `docs/PRD-Thakeen.md` sections 11.4 and 11.5 (founder session of 2026-10-05).

## ملخص

قرارا المؤسس (5 أكتوبر): (1) جلسة إرشاد كل أسبوعين لكل الباقات، 15 دقيقة، يقودها ماجد، مخرجها تقرير مكتوب وخطة جديدة للأسبوعين من 3 إلى 5 بنود يؤكدها العميل، ويُتحقق من التنفيذ من المنصات حيثما أمكن؛ العميل يطلب أول جلسة بزر، والتذكير سطر في تقرير الصباح يوم 3 وبطاقة في الصندوق، ولا تشغيل تلقائي؛ العمق يختلف بالباقة. (2) درجة صحة العميل: أحمر إن لم يوافق على شيء خلال 3 أيام من التسجيل أو لم يدخل 7 أيام؛ أصفر إن استخدم أقل من 20% من الرصيد بعد 14 يوماً أو بقي 20% مع بقاء 10 أيام؛ أخضر إن وافق على الأقل مرة أسبوعياً على مخرجات الوكيل. الدرجة داخلية للمؤسس (جدول في لوحته) تُحسب يومياً من أحداث موجودة ولا تُعرض للعميل. المطلوب من المؤسس قرارات مفتوحة في آخر الوثيقة (هل الجلسة مجانية من الرصيد، وما عمق كل باقة بالضبط).

## Goal

1. Give every paying customer a regular, written, low-effort way to decide what to do next, led by Majed (the executive advisor agent).
2. Tell the founder early which customers are slipping, so the personal follow-up of the first twenty customers (WhatsApp, by the founder) goes to the right people.

## Today (checked 2026-10-13)

- Majed exists (`src/lib/agents.ts`, tasks `strategy_review`, `okrs`, `decision_memo`). No guidance session, plan-of-two-weeks object or reminder exists.
- Events per account are counted (`src/lib/track.ts`: `signup login onboard generate chat approve reject publish connect image error`); `lastActive`, `firstEvent` and `userEvents` exist. Credits and the month's allowance are on the user record (`PLAN_CREDITS`). The founder overview computes `activated`, `paying`, stalled sign-ups.
- Reem's morning brief and the bell (`notifs:{email}`) carry reminders; the Inbox shows cards.
- Platforms: Composio-based reads for Meta, LinkedIn page, ads (dormant until keys); store sales reads exist. Verification of "did you do it" is therefore partial.

## User flow: guidance session

1. Day 3 after sign-up: one line in Noor's morning brief and one inbox card: "Ask Majed for your first guidance session" / «اطلب جلسة الإرشاد الأولى من ماجد». No automatic start.
2. The owner (or a member with the permission) presses the button. One request per brand per 14 days; a second press shows the date it opens.
3. Majed reads the workspace data (the same sources Dana's reports use: brand file, last two weeks of approved and rejected items, results where connected) and writes a report: what happened, what worked, one honest observation, and a plan of 3 to 5 items for the next two weeks. Depth by plan: Starter short; Pro adds Majed's reading and one priority; Business per brand with a comparison.
4. The owner opens the session page, edits or removes items, and presses "Confirm the plan". Unconfirmed plans stay drafts; nothing is created or published by confirming (publishing stays a separate owner approval).
5. Two weeks later the card says the plan's items and, where a platform read is available, whether each looks done; otherwise it asks the owner ("done / not done"). Majed's next session starts from that.

## User flow: health score (founder only)

Founder console > a "Customers" health view: one row per paying or trialling account with state (green, yellow, red), the reasons in words, days since sign-up, last login, credits used, and a link to the account. It supports the first-twenty follow-up. Customers never see their own colour; the owner-facing equivalents are the existing credit and trial notices.

## Score rules (from the PRD; thresholds are constants in one file)

- Red: no `approve` event within 3 days of sign-up, or no `login` for 7 days.
- Yellow: less than 20% of the month's credits used 14 days after sign-up; or 20% of credits left with 10 days left in the month.
- Green: at least one approval a week, and the person has approved something an agent produced (not only edited their own notes).
- Order of precedence: red, then yellow, then green; an account with too little history is "new" (no colour) until day 3. Paid and trial accounts are scored; suspended and deleted accounts are not.

## Data shape (rule 679: only new keys)

- `guidance:{scope}` (scope from `sc(u)`, per brand): an array capped at 26 of `{ id, requestedAt, status: "writing" | "ready" | "confirmed" | "closed", depth: "short" | "standard" | "full", report?: string, plan?: { id: string; text: string; state: "open" | "done" | "not_done" | "unknown"; checkedBy?: "owner" | "platform" }[], confirmedAt? }`. Model text is stored as plain text and rendered through `render` (`src/lib/md.ts`).
- `health:{email}` (account level): `{ state, reasons: string[], since, at }`. It is derived, so it can be recomputed from events at any time; deleting it loses nothing. No change to the user record.
- `wipeAccount` and the data download include both keys.

## Routes and auth

- `POST /api/guidance/request`: `currentUser()`, the caller's own scope from `sc(u)`; refuses a trial that has ended, a locked subscription, and a second request inside 14 days; rate limited; starts the writing as a background task like the other long agent tasks.
- `GET /api/guidance`: the caller's sessions only.
- `POST /api/guidance/{id}/confirm` { items }: owner or member with the plan permission; the id is looked up inside the caller's scope list, never as a key.
- `GET /api/admin/health`: `adminActor`; read only (no second factor needed for reads, as in the console today). No customer write path touches `health:*`.
- Daily cron: `health` recompute for each account with `pmap`, no `await db.*` in a loop; adds the day-3 line to the brief for accounts with no session yet.
- Documented in `permissions.md`, `flows.md`, `architecture.md`.

## Environment variables

None new.

## Risks

- Model cost: one Majed call per session per brand. It goes through `metered` (rule 980) so the cost is counted. Open decision below on who pays.
- Honesty: the report must say what it could not see (no platform connected, no data). Prompts must forbid invented results and numbers; platform data is untrusted input like all connector data. Add the session prompt to the golden set before launch.
- Over-promising: "verified from platforms" is true only where a read exists. The UI says "checked from Instagram" or "you told us" per item.
- Health is a hint, not a verdict: a green account can churn. The founder console shows reasons, never just a colour.
- Privacy: health is derived from behaviour the person already generates; it is internal and listed in the privacy text with the other founder analytics (lawyer item).
- Tenant isolation: scope only from `sc(u)`; the admin view reads by listing accounts, not by keys from a request.

## Test plan

- Score table: fixed clocks for each rule edge (day 2 vs 3, 6 vs 7 idle days, exactly 20%, day 13 vs 14, 10 days left) and precedence.
- Idempotent recompute: running twice changes `since` only when the state changes.
- Request: second request inside 14 days refused; trial ended refused; another account's scope cannot be named.
- Confirm: only items of that session; empty list refused; more than 5 items refused; HTML in an item is escaped on render.
- Prompt: the session never states a figure that is absent from the data it was given (golden/eval case, run before launch).
- Admin: 404 or 401 without the founder; no customer route returns `health:*`.

## Open decisions for the founder (defaults in brackets)

1. Does a session cost the customer credits? [included in the plan, metered against the founder's cost budget, shown as "0 credits" before pressing.]
2. Exact depth of Starter, Pro and Business sessions. [As in the PRD: short, plus a reading and one priority, per brand with comparison.]
3. Does a member (not the owner) confirm a plan? [owner only in v1.]

## Rough size

Large: a new agent task type and prompt, two storage helpers, four routes, a daily job step, a session page, a founder view, golden cases, docs and tests. Two pull requests: (a) health score and founder view, (b) guidance sessions.
