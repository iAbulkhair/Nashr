"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "../Icons";
import { SETTINGS_COPY, SETTINGS_GROUPS, SETTINGS_SECTIONS, settingsHref, type SettingsSection } from "@/lib/settings-nav";
import type { Lang } from "@/lib/i18n";

/** The section a settings path is on (`/{lang}/app/settings/{s}` or `/{lang}/app/b/{id}/settings/{s}`), or null for the settings index. */
export function sectionOf(path: string): SettingsSection | null {
  const seg = /^\/[^/]+\/app(?:\/b\/[^/]+)?\/settings\/([^/?#]+)/.exec(path)?.[1];
  return seg !== undefined && (SETTINGS_SECTIONS as readonly string[]).includes(seg) ? (seg as SettingsSection) : null;
}

/**
 * The settings area's own navigation (rule 1140): every section as a link, the one on show marked `aria-current="page"`.
 * The layout places it as a column at the start side on a wide screen; on a phone the settings index shows the same list
 * full width (`variant="list"`, with each section's line), and a section page offers a link back to it instead.
 * `brand` (rule 885): the brand sections link under `/b/{brand}`; without one they link the old path, which redirects.
 */
export default function SettingsNav({ lang, variant = "column", current, brand }: { lang: Lang; variant?: "column" | "list"; current?: SettingsSection | null; brand?: string }) {
  const path = usePathname() ?? "";
  const on = current !== undefined ? current : sectionOf(path);
  const C = SETTINGS_COPY[lang];
  // Rule 2006: two labelled groups, «أنت» / "You" then «مساحة العمل» / "Workspace"; each list is named by its heading.
  if (variant === "list") {
    return (
      <nav aria-label={C.nav} className="grid gap-6">
        {SETTINGS_GROUPS.map((g) => (
          <section key={g.id} aria-labelledby={`settings-group-${g.id}`} className="grid gap-2">
            <h2 id={`settings-group-${g.id}`} className="text-xs font-semibold text-foreground-muted">{C.groups[g.id]}</h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {g.sections.map((s) => (
                <li key={s}>
                  <Link href={settingsHref(lang, s, brand)} className={`flex min-h-[var(--hit-min)] items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 hover:border-border-strong ${s === "danger" ? "text-danger" : "text-foreground"}`}>
                    <span className="min-w-0">
                      <span className="block font-semibold">{C.sections[s].name}</span>
                      <span className="block text-sm text-foreground-muted">{C.sections[s].sub}</span>
                    </span>
                    <Icon name="next" mirror className="h-4 w-4 shrink-0 text-foreground-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    );
  }
  return (
    <nav aria-label={C.nav} className="grid gap-4">
      {SETTINGS_GROUPS.map((g) => (
        <div key={g.id} className="grid gap-1">
          <p id={`settings-col-${g.id}`} className="px-3 text-xs font-semibold text-foreground-muted">{C.groups[g.id]}</p>
          <ul aria-labelledby={`settings-col-${g.id}`} className="grid gap-0.5">
            {g.sections.map((s) => (
              <li key={s}>
                <Link
                  href={settingsHref(lang, s, brand)}
                  aria-current={on === s ? "page" : undefined}
                  className={`flex min-h-[var(--hit-min)] items-center rounded-lg px-3 text-sm transition pointer-fine:min-h-9 ${on === s ? "bg-background-muted font-semibold text-foreground" : s === "danger" ? "text-danger hover:bg-background-muted/60" : "text-foreground-muted hover:bg-background-muted/60 hover:text-foreground"}`}
                >
                  {C.sections[s].name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** On a phone, a section page's way back to the list of sections; nothing on the index itself or on a wide screen. */
export function SettingsBack({ lang }: { lang: Lang }) {
  const path = usePathname() ?? "";
  if (!sectionOf(path)) return null;
  return (
    <Link href={settingsHref(lang)} className="mb-3 inline-flex min-h-[var(--hit-min)] items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline lg:hidden">
      <Icon name="next" mirror className="h-4 w-4 rotate-180" />
      {SETTINGS_COPY[lang].back}
    </Link>
  );
}
