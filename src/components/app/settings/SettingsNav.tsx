"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "../Icons";
import { SETTINGS_COPY, SETTINGS_SECTIONS, settingsHref, type SettingsSection } from "@/lib/settings-nav";
import type { Lang } from "@/lib/i18n";

/** The section a settings path is on, or null for the settings index. */
export function sectionOf(path: string): SettingsSection | null {
  const seg = path.split("/")[4];
  return (SETTINGS_SECTIONS as readonly string[]).includes(seg) ? (seg as SettingsSection) : null;
}

/**
 * The settings area's own navigation (rule 1140): every section as a link, the one on show marked `aria-current="page"`.
 * The layout places it as a column at the start side on a wide screen; on a phone the settings index shows the same list
 * full width (`variant="list"`, with each section's line), and a section page offers a link back to it instead.
 */
export default function SettingsNav({ lang, variant = "column", current }: { lang: Lang; variant?: "column" | "list"; current?: SettingsSection | null }) {
  const path = usePathname() ?? "";
  const on = current !== undefined ? current : sectionOf(path);
  const C = SETTINGS_COPY[lang];
  if (variant === "list") {
    return (
      <nav aria-label={C.nav}>
        <ul className="grid gap-2 sm:grid-cols-2">
          {SETTINGS_SECTIONS.map((s) => (
            <li key={s}>
              <Link href={settingsHref(lang, s)} className={`flex min-h-[var(--hit-min)] items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 hover:border-border-strong ${s === "danger" ? "text-danger" : "text-foreground"}`}>
                <span className="min-w-0">
                  <span className="block font-semibold">{C.sections[s].name}</span>
                  <span className="block text-sm text-foreground-muted">{C.sections[s].sub}</span>
                </span>
                <Icon name="next" mirror className="h-4 w-4 shrink-0 text-foreground-muted" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    );
  }
  return (
    <nav aria-label={C.nav}>
      <ul className="grid gap-0.5">
        {SETTINGS_SECTIONS.map((s) => (
          <li key={s}>
            <Link
              href={settingsHref(lang, s)}
              aria-current={on === s ? "page" : undefined}
              className={`flex min-h-[var(--hit-min)] items-center rounded-lg px-3 text-sm transition pointer-fine:min-h-9 ${on === s ? "bg-background-muted font-semibold text-foreground" : s === "danger" ? "text-danger hover:bg-background-muted/60" : "text-foreground-muted hover:bg-background-muted/60 hover:text-foreground"}`}
            >
              {C.sections[s].name}
            </Link>
          </li>
        ))}
      </ul>
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
