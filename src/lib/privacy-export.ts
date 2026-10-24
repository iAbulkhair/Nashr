import { sc, type User } from "./auth";
import type { Brand, Task } from "./brand";
import type { BrandMeta } from "./brands";
import type { ChatMsg } from "./chat";
import type { Conversation } from "./conversations";
import type { WFile } from "./files";
import { listBrands, scopeFor } from "./brands";
import { consentOf, type ConsentView } from "./consent";
import { CAPS, db } from "./db";
import { pmap } from "./parallel";
import { foundingView } from "./founding";
import { workspaceScope, wsKey, type Scope } from "./keys";
import { acct } from "./account-id";

/**
 * The owner's own copy of their data (PDPL access and portability; rules 1320-1324): GET /api/account/export.
 *
 * Every key is built from the signed-in owner's email (`u.email`, set by `currentUser` from the session) and the brand
 * scopes of that account (`workspaceScope(acct(u), id)` over `listBrands(acct(u))`, exactly as `wipeAccount` finds them);
 * nothing comes from the request. Reads go out together: `mget` in chunks for records, `pmap` for lists, never one
 * command per record in a loop.
 *
 * What is left out on purpose: the password hash and every session stamp, connection credentials (the encrypted `enc`
 * blob is never decrypted, and meta keys that look like a credential are dropped), MCP tokens and OAuth grants, the
 * Paymob card token and transaction references, and every internal hold, lock and counter.
 */
export const EXPORT_FORMAT = "thakeen-export/1";
/** Keys per `mget`: one HTTP command each, sent a few at a time. */
const CHUNK = 100;

/** Meta keys that could hold a credential, dropped whatever their value (display meta has none today: rule 1322). */
export const SECRETISH = /token|secret|password|passwd|api.?key|private|credential|cookie|^enc$/i;

type StoredConnection = { provider: string; meta?: Record<string, string>; connectedAt: string; expiresAt?: string; needsReconnect?: string; enc?: string };
export type ExportConnection = { provider: string; connectedAt: string; expiresAt?: string; needsReconnect?: boolean; details: Record<string, string> };
export type ExportConversation = Conversation & { messages: { role: ChatMsg["role"]; content: string; at: string; agent?: string }[] };
export type ExportBrand = {
  id: string;
  name: string;
  status: BrandMeta["status"];
  createdAt: string;
  active: boolean;
  profile: Brand | null;
  tasks: Task[];
  files: WFile[];
  conversations: ExportConversation[];
  connections: ExportConnection[];
};
export type AccountExport = {
  format: typeof EXPORT_FORMAT;
  exportedAt: string;
  account: { email: string; name: string; phone: string; lang: "ar" | "en"; createdAt: string; emailVerifiedAt?: string };
  consent: ConsentView;
  plan: {
    plan: User["plan"];
    credits: number;
    trialEnds: string;
    renewedAt?: string;
    seats?: number;
    topups: { credits: number; left: number; at: string; expiresAt: string }[];
    subscription?: { plan: string; status: string; paidThrough: string; autoRenew: boolean; card?: { brand: string; last4: string } };
    /** The founding seat and the price lock, when the account has either (rule 1712). */
    founding?: ReturnType<typeof foundingView>;
  };
  partner?: { referredAt: string; via: "link" | "code" };
  brands: ExportBrand[];
};

async function mgetAll<T>(keys: readonly string[]): Promise<(T | null)[]> {
  const chunks = Array.from({ length: Math.ceil(keys.length / CHUNK) }, (_, i) => keys.slice(i * CHUNK, (i + 1) * CHUNK));
  return (await pmap(chunks, (c) => db.mget<T>(c), 6)).flat();
}

const parseMsg = (raw: string): ChatMsg | null => {
  try { return JSON.parse(raw) as ChatMsg; } catch { return null; }
};
/** A chat thread as stored (`chat:{scope}[:{id}]`, newest first, capped at CAPS.chat), oldest first, text only. */
const messagesOf = (rows: string[]): ExportConversation["messages"] =>
  rows.map(parseMsg).filter((m): m is ChatMsg => !!m).reverse().map((m) => ({ role: m.role, content: m.content, at: m.at, ...(m.agent ? { agent: m.agent } : {}) }));

/** A connection's display data only: never `enc`, never a meta key that looks like a credential. */
export function connectionView(s: StoredConnection): ExportConnection {
  const details = Object.fromEntries(Object.entries(s.meta ?? {}).filter(([k, v]) => !SECRETISH.test(k) && typeof v === "string"));
  return { provider: s.provider, connectedAt: s.connectedAt, ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}), ...(s.needsReconnect ? { needsReconnect: true } : {}), details };
}

/** Everything one brand scope holds that the export covers, read in parallel. */
async function brandData(scope: Scope): Promise<Omit<ExportBrand, "id" | "name" | "status" | "createdAt" | "active">> {
  const [profile, taskIds, fileNames, convIds, connIds, defaultThread] = await Promise.all([
    db.get<Brand>(wsKey.brand(scope)),
    // Every task, not only the newest 200 the inbox reads.
    db.lrange(wsKey.tasks(scope), 0, -1),
    db.smembers(wsKey.files(scope)),
    db.lrange(wsKey.convs(scope), 0, -1),
    db.smembers(wsKey.conns(scope)),
    db.lrange(wsKey.chat(scope), 0, CAPS.chat - 1),
  ]);
  const [tasks, files, convs, conns, threads] = await Promise.all([
    mgetAll<Task>(taskIds.map((id) => wsKey.task(scope, id))),
    mgetAll<WFile>(fileNames.map((n) => wsKey.file(scope, n))),
    mgetAll<Conversation>(convIds.map((id) => wsKey.conv(scope, id))),
    mgetAll<StoredConnection>(connIds.map((p) => wsKey.conn(scope, p))),
    pmap(convIds, (id) => db.lrange(wsKey.chat(scope, id), 0, CAPS.chat - 1)),
  ]);
  const conversations: ExportConversation[] = [];
  // The legacy default thread has no record (src/lib/conversations.ts): exported under the id "default" when it has messages.
  if (defaultThread.length) conversations.push({ id: "default", title: "", createdAt: "", updatedAt: "", count: defaultThread.length, messages: messagesOf(defaultThread) });
  convs.forEach((c, i) => { if (c) conversations.push({ ...c, messages: messagesOf(threads[i]) }); });
  return {
    profile,
    tasks: tasks.filter((t): t is Task => !!t),
    files: files.filter((f): f is WFile => !!f).sort((a, b) => (a.name < b.name ? -1 : 1)),
    conversations,
    connections: conns.filter((c): c is StoredConnection => !!c).map(connectionView),
  };
}

/** The whole export of the signed-in owner `u` (an owner record from `currentUser`, never one named by a request). */
export async function buildExport(u: User, now = new Date()): Promise<AccountExport> {
  // The account key, not the address (rule 2963): brands are listed under `acct(u)`, like `wipeAccount` finds them.
  const owner = acct(u);
  // The brand the session has open (`sc(u)`): marked `active`. Every brand of the account is exported, each read under
  // its own scope derived from the same signed-in owner.
  const activeScope = sc(u);
  const brands = await listBrands(owner);
  const data = await pmap(brands, (b) => brandData(workspaceScope(owner, b.id)), 4);
  return {
    format: EXPORT_FORMAT,
    exportedAt: now.toISOString(),
    account: { email: u.email, name: u.name, phone: u.phone, lang: u.lang, createdAt: u.createdAt, ...(u.emailVerifiedAt ? { emailVerifiedAt: u.emailVerifiedAt } : {}) },
    consent: consentOf(u),
    plan: {
      plan: u.plan,
      credits: u.credits,
      trialEnds: u.trialEnds,
      ...(u.renewedAt ? { renewedAt: u.renewedAt } : {}),
      ...(u.seats !== undefined ? { seats: u.seats } : {}),
      ...(u.extraSeats !== undefined ? { extraSeats: u.extraSeats } : {}),
      topups: (u.topups ?? []).map((t) => ({ credits: t.credits, left: t.left, at: t.at, expiresAt: t.expiresAt })),
      ...(u.founding || u.priceLock ? { founding: foundingView(u) } : {}),
      ...(u.billing ? { subscription: { plan: u.billing.plan, status: u.billing.status, paidThrough: u.billing.paidThrough, autoRenew: u.billing.autoRenew, ...(u.billing.card ? { card: { brand: u.billing.card.brand, last4: u.billing.card.last4 } } : {}) } } : {}),
    },
    ...(u.referredBy ? { partner: { referredAt: u.referredBy.at, via: u.referredBy.via } } : {}),
    brands: brands.map((b, i) => ({ id: b.id, name: b.name, status: b.status, createdAt: b.createdAt, active: scopeFor(owner, b.id) === activeScope, ...data[i] })),
  };
}

/**
 * Downloads per owner (rule 1323): each one reads every task, file and thread of every brand, so a script cannot repeat
 * it. An owner who wants a fresh copy after a change has room to spare.
 */
export const ACCOUNT_EXPORTS_PER_HOUR = 3;
export const ACCOUNT_EXPORTS_PER_DAY = 10;
