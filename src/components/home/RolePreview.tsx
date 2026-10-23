import { ROLE_PREVIEW, ROLES_COPY as C, roleRows, type RoleId } from "@/lib/home-app-screen";
import type { Lang } from "@/lib/i18n";

const TONE: Record<RoleId, string> = { owner: "var(--color-agent-noor)", admin: "var(--color-agent-dana)", member: "var(--color-agent-reem)" };

/** A drawn avatar, never a photograph or a real-looking face (rule 3351): a head and shoulders on the role's colour. */
function Avatar({ role }: { role: RoleId }) {
  return (
    <svg viewBox="0 0 48 48" className="h-12 w-12 shrink-0" aria-hidden="true">
      <circle cx="24" cy="24" r="24" fill={TONE[role]} />
      <circle cx="24" cy="19" r="8" fill="var(--color-background)" />
      <path d="M10 40c2-8 8-12 14-12s12 4 14 12" fill="var(--color-background)" />
    </svg>
  );
}

/**
 * The three team roles (rules 3351-3352): Owner, Admin, Member, named as the app's team page names them, each with the
 * same rows, ticked or not by `roleMeets` over MIN_ROLE. A permission changed in src/lib/roles.ts changes this card.
 */
export default function RolePreview({ lang }: { lang: Lang }) {
  return (
    <div className="mt-12">
      <h3 className="text-xl font-bold">{C.h[lang]}</h3>
      <p className="mt-1 text-foreground-muted">{C.sub[lang]}</p>
      <ul className="mt-6 grid gap-4 md:grid-cols-3">
        {ROLE_PREVIEW.map((r) => (
          <li key={r.id} className="rounded-2xl border border-border bg-surface p-4" data-role={r.id}>
            <div className="flex items-center gap-3">
              <Avatar role={r.id} />
              <div>
                <p className="text-lg font-bold">{r.name[lang]}</p>
                <p className="text-sm text-foreground-muted">{r.line[lang]}</p>
              </div>
            </div>
            <ul className="mt-4 grid gap-1.5 text-sm">
              {roleRows(r.id, lang).map((row) => (
                <li key={row.label} className={`flex items-center gap-2 ${row.allowed ? "" : "text-foreground-subtle"}`} data-allowed={row.allowed}>
                  <span aria-hidden="true" className="w-4 text-center font-bold">{row.allowed ? "✓" : "–"}</span>
                  <span>{row.label}</span>
                  <span className="sr-only">{row.allowed ? C.can[lang] : C.cannot[lang]}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
