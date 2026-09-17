import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { PROVIDERS, isAvailable } from "@/lib/connectors/registry";
import { listConnections } from "@/lib/connectors/store";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const conns = await listConnections(u.email);
  return NextResponse.json({
    ok: true,
    providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, kind: p.kind, capabilities: p.capabilities, available: isAvailable(p), keyFields: p.keyFields, docs: p.docs, needsShop: !!p.oauth?.needsShop })),
    connections: conns,
  });
}
