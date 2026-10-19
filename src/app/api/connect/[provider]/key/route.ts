import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getProvider } from "@/lib/connectors/registry";
import { getConnection, saveConnection } from "@/lib/connectors/store";
import { dropSnapshotIfStoreChanged, storeIdentity } from "@/lib/store-sales";
import { verifyWordPress } from "@/lib/connectors/wordpress";
import { verifyWoo } from "@/lib/connectors/woocommerce";
import { verifyBrevo, verifyOdoo, verifyPrestaShop, verifyTelegram } from "@/lib/connectors/keyed";
import { forbid } from "@/lib/roles";
import { wsKey } from "@/lib/keys";
import { KEY_CHECK_FAILS_PER_DAY, KEY_CHECK_FAILS_PER_HOUR, WINDOW, allow, giveBack, retryLater } from "@/lib/rate";

/** POST key-based credentials → verify → store encrypted. Admin and owner only (src/lib/roles.ts "connectors"). */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "connectors");
  if (no) return no;
  const { provider } = await ctx.params;
  const p = getProvider(provider);
  // A calendar provider of Reem (`secretary`) is never a stored connection, whatever its kind (ruling R4).
  if (!p || p.secretary || p.kind !== "key") return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  const data: Record<string, string> = {};
  for (const f of p.keyFields ?? []) {
    const v = (b[f.name] ?? "").toString().trim();
    if (!v) return NextResponse.json({ ok: false, error: `missing_${f.name}` }, { status: 400 });
    data[f.name] = f.type === "url" ? (v.startsWith("http") ? v : "https://" + v) : v;
  }
  // Each check below asks an outside service whether these credentials work (a WordPress site's password, a bot token,
  // an API key), so the route must not become a way to try passwords from our servers: a failed check keeps its hit,
  // ten an hour and thirty a day per workspace; one that passes gives it back (rule 2240, the rule 1183 pattern).
  const buckets = [wsKey.keyCheckBucket(sc(u), "hour"), wsKey.keyCheckBucket(sc(u), "day")] as const;
  const [hour, day] = await Promise.all([allow(buckets[0], KEY_CHECK_FAILS_PER_HOUR, WINDOW.hour), allow(buckets[1], KEY_CHECK_FAILS_PER_DAY, WINDOW.day)]);
  if (!day) return retryLater({ ok: false, error: "slow_down" }, WINDOW.day);
  if (!hour) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const meta: Record<string, string> = {};
  if (provider === "wordpress") {
    const v = await verifyWordPress(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.site = data.site;
    meta.account = v.name ?? data.username;
  } else if (provider === "woocommerce") {
    const v = await verifyWoo(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.site = data.site;
  } else if (provider === "odoo") {
    const v = await verifyOdoo(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.site = data.url;
  } else if (provider === "prestashop") {
    const v = await verifyPrestaShop(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.site = data.site;
  } else if (provider === "telegram") {
    const v = await verifyTelegram(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.account = v.name ?? data.chatId;
  } else if (provider === "brevo") {
    const v = await verifyBrevo(data);
    if (!v.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: v.error }, { status: 400 });
    meta.account = v.name ?? "";
  } else if (provider === "klaviyo") {
    const r = await fetch("https://a.klaviyo.com/api/accounts/", { headers: { Authorization: `Klaviyo-API-Key ${data.apiKey}`, revision: "2024-10-15" } });
    if (!r.ok) return NextResponse.json({ ok: false, error: "verify_failed", detail: `HTTP ${r.status}` }, { status: 400 });
  }
  await Promise.all(buckets.map((b) => giveBack(b)));
  const conn = { provider, data, meta, connectedAt: new Date().toISOString() };
  // Another WooCommerce site replaces this one: its totals go before the new site's first sync (rule 2207).
  const before = storeIdentity(conn) ? await getConnection(sc(u), provider).catch(() => null) : null;
  await saveConnection(sc(u), conn);
  await dropSnapshotIfStoreChanged(sc(u), before, conn);
  await track(u.email, "connect");
  return NextResponse.json({ ok: true, meta });
}
