import { APP_SCREEN_COPY as C, SCREEN_AGENTS } from "@/lib/home-app-screen";
import type { Lang } from "@/lib/i18n";

/** A grey bar where a line of text would be: the sketch shows no real words, no figures and no results. */
function Bar({ w, strong = false }: { w: string; strong?: boolean }) {
  return <span className={`block h-2 rounded-full ${strong ? "bg-foreground-subtle" : "bg-border"}`} style={{ width: w }} />;
}

/** An agent's mark: the first letter of a real agent's name on that agent's own colour. */
function Mark({ id, name }: { id: string; name: string }) {
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold text-inverse-foreground" style={{ background: `var(--color-agent-${id})` }}>
      {name.slice(0, 1)}
    </span>
  );
}

const card = "rounded-xl border border-border bg-background p-3";

/**
 * The drawing of Thakeen's own screen (rules 3348-3350): side menu, approvals waiting, the week's tasks, the agents and an
 * empty reports panel. One image to assistive technology (its `aria-label` says what it shows); everything inside is
 * decoration. No digit, count, price or result anywhere in it (tests/marketing-analytics.test.ts scans the markup).
 */
export default function AppScreen({ lang }: { lang: Lang }) {
  const [draft, review, approved] = C.states;
  return (
    <figure className="m-0">
      <div role="img" aria-label={C.alt[lang]} className="overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-xl">
        <div aria-hidden className="flex items-center gap-2 border-b border-border bg-surface-muted px-4 py-2">
          <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
          <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
          <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
          <span className="ms-3 h-4 flex-1 rounded-full bg-background" />
        </div>
        <div aria-hidden className="grid sm:grid-cols-[11rem_1fr]">
          <ul className="hidden border-e border-border p-3 text-sm sm:block">
            {C.nav.map((n, i) => (
              <li key={n.en} className={`rounded-lg px-3 py-2 ${i === 1 ? "bg-background font-semibold text-foreground" : "text-foreground-muted"}`}>{n[lang]}</li>
            ))}
          </ul>
          <div className="grid gap-3 p-3 text-sm">
            <div className={card}>
              <p className="font-semibold">{C.approvals[lang]}</p>
              {SCREEN_AGENTS.slice(0, 2).map((a, i) => (
                <div key={a.id} className="mt-3 flex items-center gap-3">
                  <Mark id={a.id} name={a.name[lang]} />
                  <span className="grid flex-1 gap-1.5">
                    <Bar w={i ? "55%" : "70%"} strong />
                    <Bar w={i ? "80%" : "60%"} />
                  </span>
                  <span className="hidden rounded-full border border-border px-2 py-0.5 text-xs sm:inline">{C.edit[lang]}</span>
                  <span className="rounded-full bg-foreground px-2 py-0.5 text-xs text-background">{C.approve[lang]}</span>
                </div>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className={card}>
                <p className="font-semibold">{C.tasks[lang]}</p>
                {[draft, review, approved].map((s, i) => (
                  <div key={s.en} className="mt-3 flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${i === 2 ? "bg-success-tint" : i === 1 ? "bg-warning-tint" : "bg-surface-muted"}`}>{s[lang]}</span>
                    <span className="flex-1"><Bar w={["75%", "60%", "85%"][i]} /></span>
                  </div>
                ))}
              </div>
              <div className={card}>
                <p className="font-semibold">{C.agents[lang]}</p>
                <ul className="mt-2 grid gap-2">
                  {SCREEN_AGENTS.map((a) => (
                    <li key={a.id} className="flex items-center gap-2">
                      <Mark id={a.id} name={a.name[lang]} />
                      <span className="min-w-0">
                        <span className="block font-semibold leading-tight">{a.name[lang]}</span>
                        <span className="block truncate text-xs text-foreground-muted">{a.role[lang]}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className={card}>
              <p className="font-semibold">{C.reports[lang]}</p>
              <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-foreground-muted">{C.empty[lang]}</p>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-2 text-sm text-foreground-muted">{C.note[lang]}</figcaption>
    </figure>
  );
}
