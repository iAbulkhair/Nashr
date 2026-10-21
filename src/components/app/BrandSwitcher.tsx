"use client";
import { usePathname, useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { switchBrandPath } from "@/lib/brand-path";
import { settingsHref } from "@/lib/settings-nav";
import { appHref } from "@/lib/ws-path";
import { useAppLink } from "./WorkspaceContext";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { Icon } from "./Icons";

/** A brand as `GET /api/brands` lists it (names filled in from the brand file; archived ones are in the list too). */
export type SwitcherBrand = { id: string; name: string; status?: "active" | "archived" };

const COPY = {
  ar: { label: "تبديل البراند", add: "أضف براند", manage: "إدارة البراندات", current: "الحالي", unnamed: "براند بلا اسم", failed: "تعذّر تبديل البراند. حاول مرة أخرى." },
  en: { label: "Switch brand", add: "Add a brand", manage: "Manage brands", current: "current", unnamed: "Unnamed brand", failed: "Could not switch brand. Try again." },
} as const;

/**
 * The menu's rows (rule 893), pure so a test can read them: the ACTIVE brands only (an archived brand is managed on the
 * brands page, never offered here), the current one marked, then "Add a brand" (only when `canAdd`: owner or admin under
 * the plan's cap, display only, `POST /api/brands` is the check) and "Manage brands". A brand row has no link: picking
 * it asks the server to remember the choice, then navigates (`pickBrand`). The current brand's row does nothing. `to` is
 * the page's link builder (`useAppLink`, so the workspace stays in the link); without it, the link has no workspace.
 */
export function brandMenuItems({ lang, brands, current, canAdd, onPick, to }: { lang: Lang; brands: SwitcherBrand[]; current: string; canAdd: boolean; onPick: (id: string) => void; to?: (path: string) => string }): MenuItem[] {
  const c = COPY[lang];
  const rows: MenuItem[] = brands
    .filter((b) => b.status !== "archived")
    .map((b) => ({
      key: `b-${b.id}`,
      label: (
        <span className="flex w-full min-w-0 items-center justify-between gap-2">
          <span className="clip" dir="auto">{b.name || c.unnamed}</span>
          {b.id === current && <><Icon name="check" className="h-4 w-4 shrink-0" /><span className="sr-only">{c.current}</span></>}
        </span>
      ),
      onSelect: b.id === current ? undefined : () => onPick(b.id),
    }));
  const href = settingsHref(to ?? ((p) => appHref(lang, p)), "brands");
  return [...rows, ...(canAdd ? [{ key: "add", label: c.add, href }] : []), { key: "manage", label: c.manage, href }];
}

/**
 * Switch to brand `id` from the page at `pathname`: the server remembers it as this person's last brand in the account
 * (`POST /api/brands` switch, the one place the choice is written, rule 892), then the browser goes to the same section
 * of that brand (`switchBrandPath`: a record page falls back to its section). The page's own brand header rides along
 * (the fetch wrapper) as a selector and picks nothing here. False, and no navigation, when the server refuses or the
 * request fails.
 */
export async function pickBrand(id: string, pathname: string, push: (href: string) => void, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await f("/api/brands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "switch", id }) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (!res.ok || !j.ok) return false;
  } catch {
    return false;
  }
  push(switchBrandPath(pathname, id));
  return true;
}

/**
 * The brand you work on, as a menu button (rule 893). `brands` is null until the rail has loaded the list (it asks when the
 * menu is first opened, `onOpen`), so the closed button and a not-yet-loaded menu show the current brand alone.
 */
export default function BrandSwitcher({ lang, brands, current, canAdd, sub, onOpen, onPicked }: { lang: Lang; brands: SwitcherBrand[] | null; current: { id: string; name: string }; canAdd: boolean; sub?: string; onOpen?: () => void; onPicked?: () => void }) {
  const c = COPY[lang];
  const path = usePathname();
  const r = useRouter();
  const toast = useToast();
  const to = useAppLink(lang);
  const name = current.name.trim();
  const initial = (name || (lang === "ar" ? "ع" : "B")).charAt(0);
  async function onPick(id: string) {
    if (await pickBrand(id, path, (h) => r.push(h))) onPicked?.();
    else toast.danger(c.failed);
  }
  const items = brandMenuItems({ lang, brands: brands ?? [{ id: current.id, name: current.name, status: "active" }], current: current.id, canAdd, onPick: (id) => { void onPick(id); }, to });
  return (
    <Menu
      label={c.label}
      className="min-w-0 flex-1"
      items={items.map((it) => (it.href ? { ...it, onSelect: onPicked } : it))}
      trigger={(props, isOpen) => (
        <button
          {...props}
          onClick={(e) => { props.onClick?.(e); onOpen?.(); }}
          onKeyDown={(e) => { props.onKeyDown?.(e); if (e.key === "ArrowDown" || e.key === "ArrowUp") onOpen?.(); }}
          aria-label={`${c.label}: ${name || c.unnamed}`}
          className="flex w-full min-w-0 items-center gap-3 rounded-lg px-1 py-1 text-start hover:bg-background-muted/60"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border-[1.5px] border-border-strong bg-background-muted font-display text-lg font-bold text-foreground" aria-hidden>{initial}</span>
          <span className="min-w-0 flex-1"><span className="clip block text-sm font-semibold text-foreground" dir="auto">{name || (lang === "ar" ? "علامتك" : "Your brand")}</span>{sub && <span className="block text-xs text-foreground-muted">{sub}</span>}</span>
          <Icon name="chevron" className={`h-4 w-4 shrink-0 text-foreground-muted transition ${isOpen ? "rotate-180" : ""}`} />
        </button>
      )}
    />
  );
}
