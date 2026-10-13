# In-app diagram page (founder console)

Status: proposed, not built. Written 2026-10-13 against `main` at `4c0264b4`. Build order: 7 of 8. Rule numbers are assigned when it is built. Settles ledger item F-055 ("diagram merged as #253, in-app page undone").

## ملخص

عندنا رسومات Archify جاهزة (مخطط النظام، ومخطط سير المنتج، و16 مخططاً تسلسلياً لرحلات العميل) محفوظة في `.archify/` على `main` وحجمها نحو 27 ميغابايت مع ملفات الفحص. المقترح صفحة في لوحة المؤسس `/{lang}/admin/diagrams` تعرضها للقراءة فقط: قائمة بعناوين عربية وإنجليزية وتاريخ التوليد ورقم الـ commit الذي أُخذ منه الرسم، وعرض كل رسم داخل iframe معزول (`sandbox`) حتى لا يصل سكربته لكوكي اللوحة. لا تُنشر هذه الملفات للعموم (لا في `public/`) بل يخدمها مسار محمي. المقترح تنظيف النسخة: نأخذ ملفات HTML النهائية فقط (حوالي 20 ملفاً، كل منها نحو 0.8 ميغابايت) إلى `content/diagrams/`. القرار المفتوح: هل ندرج 16 ميغابايت في المستودع، أم نكتفي بالمخططين الرئيسيين ونترك التسلسلات خارج التطبيق.

## Goal

Let the founder (and nobody else) open the system diagram, the product workflow diagram and the 16 journey sequence diagrams inside the console, with the date and commit each was drawn from, so a diagram that is out of date says so.

## Today (checked 2026-10-13)

- `.archify/` on `main` holds three families: `architecture-nashr-system-20260930-092953/nashr-system.html`, `workflow-nashr-product-20260930-094525/nashr-product.html`, and `sequence-nashr-journey-20260930-105952/` with 17 pages (an overview and sixteen journeys, plus `index.html`, `artifact-index.html` and `catalog.html`). Each diagram is one self-contained HTML file of about 0.8 MB with inline scripts and links to `github.com/iAbulkhair/Nashr` source lines at an old commit. Check files (`*.json`, `visual-*`, `.bak`) are about the rest of the 27 MB.
- The diagrams were drawn on 2026-09-30; the code has changed a lot since (#298 to #347). A refresh pass was left unfinished (ledger F-055).
- The founder console is a separate shell (`src/app/[lang]/admin/`), gated by `requireAdmin()` on pages and `isAdmin(req)` / `adminActor` on routes.

## User flow

1. Console navigation gets "Diagrams" / «المخططات».
2. The page lists each diagram: title (ar, en), kind (system, product, journey), "drawn on <date> from commit <sha>", and a staleness note computed at build time: "N commits on main since" (from a manifest, not a live git call).
3. Opening one shows it full width in an iframe with `sandbox="allow-scripts"` (no `allow-same-origin`, no top navigation, no forms), with an "open in a new tab" link to the same protected route and a "download" link.
4. Nothing else: no editing, no regeneration from the page. Regenerating is a Claude task the founder asks for ("continue the diagram"), which commits new files and a new manifest row.

## Data shape

No Redis, no stored shape. Files plus one manifest:
- `content/diagrams/manifest.json`: `[{ id, kind, title: {ar, en}, file, drawnOn, fromCommit, commitsBehindAtBuild }]`.
- `content/diagrams/<id>.html`: the final HTML only (no check JSON, no `.bak`, no screenshots).
- Rule 679 does not apply (no stored data).

## Routes and auth

- Page `GET /{lang}/admin/diagrams` and `/{lang}/admin/diagrams/[id]`: `requireAdmin()` first (404 for everyone else, so the console does not advertise itself).
- `GET /api/admin/diagrams/[id]`: `isAdmin(req)` first, then the id is matched against the manifest (an allow-list), never joined into a file path; returns the HTML with `Content-Type: text/html; charset=utf-8`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:` (the diagram needs its inline script and styles and nothing from the network).
- Read only; no second-factor step (reads stay on the key or founder sign-in, as the console's reads do, rule 1370 family).

## Environment variables

None.

## Risks

- Repository size: about 16 MB of HTML in git for the full set. Alternative: keep the sequences out and ship only the system and product diagrams (about 1.5 MB). Decision below.
- Stale diagrams read as truth. The manifest shows the draw date and the commits since, and the page header says "snapshot, not live".
- The files contain inline script. They are served only to the founder, only inside a sandboxed frame with a CSP that forbids network access; the allow-list prevents path traversal.
- They link to source lines at old commits; those links may point at moved code. Shown as-is, labelled snapshot.
- Do not publish them under `public/`: the diagrams describe internals (routes, stores).
- The inline script comes from a tool we ran ourselves; if diagrams are regenerated, re-check that no external URL or third-party script appears (a test greps the files).

## Test plan

- Page and route refuse without the founder session (404 on the page, 401 on the route); allow with it.
- The route serves only ids in the manifest; `../`, an absolute path and an unknown id all fail; headers are exactly as above.
- A static test over `content/diagrams/*.html`: no `src="http` / `href="http` that loads a resource (links to GitHub are anchors only), no `fetch(`, no `XMLHttpRequest`.
- Manifest test: every row has a file, both titles, a date and a commit; no orphan files.
- Arabic and English strings both present for the page chrome.

## Open decision

Full set (about 16 MB in git, 18 diagrams) or the two main diagrams only (about 1.5 MB). [Default: the two main diagrams first; add the journeys when someone asks for them, from a refreshed run.]

## Rough size

Small: one manifest, one lib to read it, one page, one route, a nav entry, tests, docs. One pull request. The refresh of the diagrams themselves is a separate Claude task, not part of this build.
