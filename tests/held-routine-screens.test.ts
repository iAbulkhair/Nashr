import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The panel calls useRouter; rendered outside the app router, a stand-in is enough (nothing navigates on render).
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }) }));

import TasksPanel from "@/components/app/TasksPanel";
import { CronList } from "@/components/admin/Usage";
import { OV } from "@/components/admin/shared";
import { appDict } from "@/lib/app-i18n";
import { DEFAULT_SCHEDULE } from "@/lib/schedule";
import { ROUTINES, type RoutineView } from "@/lib/routines";

/**
 * Rules 2533-2535 (numbered 2530-2532 when they merged in #413; moved because #415 uses those): the two screens of the paid-cron work (#404) that no browser check could reach. A held routine needs a
 * run killed more than 10 minutes before, and the cron counts need a cron run and a founder sign-in, neither of which the
 * end-to-end server has (it runs with `APP_ENV=test` only, no cron secret, no admin credentials, and no route that seeds
 * data). So each screen is rendered here as the server renders it, in both languages; the Run request itself is pinned
 * by `tests/paid-cron-held.test.ts` (rule 2479).
 */
/** Text as React writes it into HTML. */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const views = (heldId?: string): RoutineView[] => ROUTINES.map((r) => ({ id: r.id, agent: r.agent, type: r.type, cadence: r.cadence, ...(r.id === heldId ? { held: true } : {}) }));

describe("rule 2533: Scheduled tasks shows a held routine with its note and a Run button", () => {
  const held = ROUTINES[0].id;

  it("only the held routine gets the block, in both languages", () => {
    for (const lang of ["ar", "en"] as const) {
      const t = appDict[lang];
      const html = renderToStaticMarkup(createElement(TasksPanel, { t, initial: DEFAULT_SCHEDULE, routines: views(held) }));
      expect(html.match(/data-held="/g), lang).toHaveLength(1);
      expect(html).toContain(`data-held="${held}"`);
      expect(html).toContain(esc(t.tasks.held));
      expect(html).toContain(`>${esc(t.tasks.runHeld)}</button>`);
    }
  });

  it("no held routine, no block", () => {
    const html = renderToStaticMarkup(createElement(TasksPanel, { t: appDict.en, initial: DEFAULT_SCHEDULE, routines: views() }));
    expect(html).not.toContain("data-held=");
    expect(html).not.toContain(esc(appDict.en.tasks.held));
  });

  it("a read-only member still gets Run: running a held routine is a request, open to every role like the cards'", () => {
    const html = renderToStaticMarkup(createElement(TasksPanel, { t: appDict.ar, initial: DEFAULT_SCHEDULE, routines: views(held), readOnly: true }));
    expect(html).toContain(`data-held="${held}"`);
    expect(html).toMatch(new RegExp(`<button type="button" class="[^"]*">${esc(appDict.ar.tasks.runHeld)}</button>`));
  });
});

describe("rule 2534: the founder's Usage page shows each job's last batch counts under its heartbeat", () => {
  const report = { total: 40, alreadyDone: 5, processed: 30, failed: 2, held: 1, remaining: 2 };

  it("the counts line, in both languages, only for a job that has a report", () => {
    for (const lang of ["ar", "en"] as const) {
      const html = renderToStaticMarkup(createElement(CronList, { O: OV[lang], crons: [
        { job: "daily", status: "ok", lastRunAt: "2026-10-20T03:05:00.000Z", ageSec: 60, maxAgeSec: 90000, report },
        { job: "weekly", status: "waiting", lastRunAt: null, ageSec: null, maxAgeSec: 700000 },
      ] }));
      expect(html.match(/data-cron-report="/g), lang).toHaveLength(1);
      const line = OV[lang].cronReport.replace("{d}", "5").replace("{p}", "30").replace("{h}", "1").replace("{f}", "2").replace("{r}", "2").replace("{t}", "40");
      expect(html).toContain(`data-cron-report="daily">${esc(line)}</span>`);
      expect(html).toContain(esc(OV[lang].cronWaiting));
    }
  });
});

describe("rule 2535: the Usage page still renders the list through CronList", () => {
  it("the section passes the overview's crons to the extracted component", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/components/admin/Usage.tsx", "utf8")).toContain("<CronList crons={ov.crons ?? []} O={O} />");
  });
});
