/** Nashr icon set: one stroke weight, 20px box, currentColor. Drawn, not emoji. */
const P: Record<string, React.ReactNode> = {
  chat: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4.2 3.2c-.4.3-.8 0-.8-.5V5.5Z" /></>,
  inbox: <><path d="M4 13V6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5V13" /><path d="M4 13h4.5l1.5 2.5h4l1.5-2.5H20v4.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5V13Z" /></>,
  spark: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></>,
  chart: <><path d="M4 20V4M4 20h16" /><path d="M8 16v-5M12 16V8M16 16v-3M20 16V6" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  folder: <><path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.5l2 2H18A2.5 2.5 0 0 1 20.5 9v8a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17V7Z" /></>,
  gift: <><rect x="3.5" y="9" width="17" height="11" rx="2" /><path d="M3.5 13h17M12 9v11M12 9c-2.5 0-4.5-1-4.5-3a2 2 0 0 1 4-.5c.2.8.5 2.5.5 3.5Zm0 0c2.5 0 4.5-1 4.5-3a2 2 0 0 0-4-.5c-.2.8-.5 2.5-.5 3.5Z" /></>,
  shield: <><path d="M12 3.5 5 6v6c0 4.2 3 7.2 7 8.5 4-1.3 7-4.3 7-8.5V6l-7-2.5Z" /><path d="m9.5 12 1.8 1.8 3.4-3.6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  grid: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>,
  help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.8 9.5a2.3 2.3 0 1 1 3.3 2.1c-.8.4-1.1.9-1.1 1.7M12 16.5h.01" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 1.5h-15L6 16Z" /><path d="M10 19.5a2 2 0 0 0 4 0" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  check: <><path d="m5 12.5 4.5 4.5L19 7.5" /></>,
  x: <><path d="m6 6 12 12M18 6 6 18" /></>,
  chevron: <><path d="m6 9 6 6 6-6" /></>,
  // Points to the inline end in English (forward, "next"); drawn with `mirror` it points the other way in Arabic (rule 1118).
  next: <><path d="m9 6 6 6-6 6" /></>,
  stop: <><rect x="6.5" y="6.5" width="11" height="11" rx="2" /></>,
  retry: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4.5 4.5v3.5H8" /></>,
  send: <><path d="M4 12 20 4l-4 16-4-7-8-1Z" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>,
  share: <><path d="M12 4v12M8 8l4-4 4 4" /><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></>,
  thumbUp: <><path d="M7 11v9H4v-9h3Zm0 0 4-7.5c1.5 0 2.5 1 2.5 2.5V9h5a2 2 0 0 1 2 2.3l-1 6.5a2 2 0 0 1-2 1.7H7" /></>,
  thumbDown: <><path d="M17 13V4h3v9h-3Zm0 0-4 7.5c-1.5 0-2.5-1-2.5-2.5V15H5.5a2 2 0 0 1-2-2.3l1-6.5a2 2 0 0 1 2-1.7H17" /></>,
  instagram: <><rect x="4" y="4" width="16" height="16" rx="4.5" /><circle cx="12" cy="12" r="3.5" /><path d="M16.8 7.2h.01" /></>,
  snapchat: <><path d="M12 4c3 0 4.5 2.2 4.5 4.8V11c.8.3 1.7 0 2.3-.4-.2 1.4-1.5 1.8-2.3 2.2.6 1.6 2 2.7 3.5 3-.3.9-1.5.9-2.4 1.2-.2.7-.4 1.3-.9 1.3-.8 0-1.3-.4-2.2-.3-1 .1-1.5 1.5-2.5 1.5s-1.5-1.4-2.5-1.5c-.9-.1-1.4.3-2.2.3-.5 0-.7-.6-.9-1.3-.9-.3-2.1-.3-2.4-1.2 1.5-.3 2.9-1.4 3.5-3-.8-.4-2.1-.8-2.3-2.2.6.4 1.5.7 2.3.4V8.8C7.5 6.2 9 4 12 4Z" /></>,
  tiktok: <><path d="M14 4v10.5a3.5 3.5 0 1 1-3.5-3.5" /><path d="M14 4c.5 2.5 2 4 4.5 4.3" /></>,
  xcom: <><path d="M5 4h4l10 16h-4L5 4Z" /><path d="m19 4-5.6 6.4M5 20l5.6-6.4" /></>,
  whatsapp: <><path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.8L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5Z" /><path d="M9 9c0 3 3 6 6 6l1.2-1.2-1.8-1-1 .8c-1-.4-2-1.4-2.4-2.4l.8-1-1-1.8L9 9Z" /></>,
  gbp: <><path d="M12 21s6-5.5 6-11a6 6 0 1 0-12 0c0 5.5 6 11 6 11Z" /><circle cx="12" cy="10" r="2.2" /></>,
  blog: <><path d="M5 4h10l4 4v12H5V4Z" /><path d="M15 4v4h4M8 12h8M8 16h8" /></>,
  linkedin: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 10.5V17M8 7.5h.01M12 17v-3.5a2 2 0 0 1 4 0V17M12 10.5V17" /></>,
  email: <><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="m4 7 8 6 8-6" /></>,
  phone: <><path d="M6 4h3l1.5 4-2 1.5a11 11 0 0 0 6 6L16 13.5l4 1.5v3a2 2 0 0 1-2 2C10 20 4 14 4 6a2 2 0 0 1 2-2Z" /></>,
  plan: <><path d="M4 6h16M4 12h10M4 18h7" /></>,
  sales: <><path d="M8 12.5 11 15.5 16.5 9" /><circle cx="12" cy="12" r="8.5" /></>,
  finance: <><path d="M4 18 9 12l3.5 3.5L20 7" /><path d="M15 7h5v5" /></>,
  growth: <><path d="M12 20V9M12 9 7.5 13.5M12 9l4.5 4.5" /><path d="M5 4h14" /></>,
  report: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M8 15v-4M12 15V8M16 15v-2" /></>,
  deck: <><rect x="3.5" y="5" width="17" height="12" rx="2" /><path d="M12 17v3M8 20h8" /></>,
  dashboard: <><circle cx="12" cy="13" r="8" /><path d="M12 13l4-4" /><path d="M4 13h2M18 13h2" /></>,
  strategy: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" /></>,
  product: <><path d="M12 3.5 20 8l-8 4.5L4 8l8-4.5Z" /><path d="M4 8v8l8 4.5 8-4.5V8M12 12.5v8" /></>,
  general: <><circle cx="12" cy="12" r="3" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  seed: <><path d="M12 20c-3.5 0-6-2.6-6-6 0-4 3.5-7.5 6-9 2.5 1.5 6 5 6 9 0 3.4-2.5 6-6 6Z" /><path d="M12 20v-7" /></>,
  sapling: <><path d="M12 21v-9" /><path d="M12 13c-3.5 0-6-2-6-5.5 3.5 0 6 2 6 5.5ZM12 11c0-3.5 2.5-6 6-6 0 3.5-2.5 6-6 6Z" /><path d="M8 21h8" /></>,
  palm: <><path d="M12 21c0-5 .5-8.5 1-11" /><path d="M13 10c-1.5-2.5-4.5-3.5-8-2.5M13 10c.5-3 3-5 6.5-5M13 10c2.5-.5 5 .5 6.5 3M13 10c-2.5 0-5 1.5-6 4.5" /><path d="M8 21h8" /></>,
  oasis: <><path d="M3 20c2.5-1.5 5.5-2 9-2s6.5.5 9 2" /><path d="M9 18c0-4 .3-6.5.8-8.5M9.8 9.5C8.6 7.6 6.2 7 3.5 7.7M9.8 9.5c.4-2.3 2.4-3.8 5.2-3.8M9.8 9.5c2 .1 3.7 1.2 4.6 3.2" /><circle cx="17.5" cy="5" r="1.5" /></>,
  flame: <><path d="M12 21c-3.6 0-6-2.5-6-5.8 0-3.2 2.2-5 3.5-7.7.4 1.6 1.3 2.6 2.3 3 0-3 1.2-5.8 3.7-7.5-.4 2.8.9 4.8 2.2 6.6 1 1.4 1.3 2.6 1.3 4 0 4.4-3 7.4-7 7.4Z" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  trophy: <><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4" /></>,
  plug: <><path d="M9 3v4M15 3v4M7 7h10v3a5 5 0 0 1-10 0V7ZM12 15v6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6" /></>,
  users: <><circle cx="9" cy="8.5" r="3.5" /><path d="M3 19.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.3c2 .7 3.5 2.6 3.5 5.2" /></>,
};
export type IconName = keyof typeof P;
export const CHANNEL_ICON: Record<string, IconName> = { instagram: "instagram", snapchat: "snapchat", tiktok: "tiktok", x: "xcom", whatsapp: "whatsapp", gbp: "gbp", blog: "blog", linkedin: "linkedin", email: "email", call: "phone", meta: "instagram", plan: "plan", sales: "sales", finance: "finance", growth: "growth", report: "report", deck: "deck", dashboard: "dashboard", strategy: "strategy", product: "product" };
/**
 * One icon. `mirror` flips a directional icon (send, next, back) in a right-to-left page (rule 1118), so "forward" points
 * the way the line reads; symbols that mean the same both ways (a check, a bell) leave it off.
 */
export function Icon({ name, className = "h-4 w-4", title, mirror = false }: { name: IconName | string; className?: string; title?: string; mirror?: boolean }) {
  const body = P[name as IconName] ?? P.general;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={mirror ? `${className} rtl:-scale-x-100` : className} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      {body}
    </svg>
  );
}
export const channelIcon = (ch: string): IconName => CHANNEL_ICON[ch] ?? "general";
