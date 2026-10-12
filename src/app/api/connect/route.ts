import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { PROVIDERS, isAvailable, routedViaComposio } from "@/lib/connectors/registry";
import { PROVIDER_TOOLKITS } from "@/lib/connectors/composio-catalog";
import { listConnections } from "@/lib/connectors/store";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const conns = await listConnections(sc(u));
  return NextResponse.json({
    ok: true,
    providers: PROVIDERS.filter((p) => !p.secretary).map((p) => ({ id: p.id, name: p.name, kind: p.kind, capabilities: p.capabilities, available: isAvailable(p), keyFields: p.keyFields, docs: p.docs, needsShop: !!p.oauth?.needsShop, toolkits: routedViaComposio(p.id) ? PROVIDER_TOOLKITS[p.id] : undefined })),
    connections: conns,
  });
}
