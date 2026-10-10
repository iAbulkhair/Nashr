import { notFound, redirect } from "next/navigation";
import { isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { entitlements } from "@/lib/entitlements";
import { skippedCount } from "@/lib/agent-instructions";
import { getBrand } from "@/lib/brand";
import { listFileNames } from "@/lib/files";
import { refRecords, refsAvailable } from "@/lib/instruction-refs";
import { summarizeRevision } from "@/lib/instructions-diff";
import { editBase, getLayer, isPaused, listHistory } from "@/lib/instructions-store";
import { publicLayer, publicRevision } from "@/lib/instructions-http";
import { testOptionsFor } from "@/lib/instructions-test";
import { can } from "@/lib/roles";
import InstructionsPanel from "@/components/app/InstructionsPanel";

export const dynamic = "force-dynamic";

/**
 * The customer's "Agent instructions" page (agent skills portal, spec 8.1; rule 957). Server-rendered from the caller's
 * own workspace `sc(u)` only: the live set, the draft, the newest versions as counts, the plan's limits, the workspace
 * files, the imported reference files and the price of each test. Nothing is read from the request but the language.
 * Every role reads it; the panel is read-only below admin (the routes refuse those roles in code too). The platform's own
 * instructions are never read here, so they cannot reach the page.
 */
export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const scope = sc(u);
  const limits = entitlements(u).instructions;
  const readOnly = !can(u, "instructions.write");
  const canTest = can(u, "instructions.test");
  const [layer, history, files, refs, brand, paused, googleOn] = await Promise.all([
    getLayer(scope),
    listHistory(scope),
    listFileNames(scope),
    refRecords(scope),
    getBrand(scope),
    isPaused(),
    limits.refs ? refsAvailable(scope) : Promise.resolve(false),
  ]);
  return (
    <InstructionsPanel
      t={appDict[lang]}
      lang={lang}
      layer={publicLayer(layer)}
      base={editBase(layer)}
      limits={limits}
      skipped={skippedCount(layer.active, limits)}
      history={history.slice(0, 20).map((r) => summarizeRevision(publicRevision(r)))}
      files={files}
      refs={refs}
      readOnly={readOnly}
      canTest={canTest}
      googleOn={googleOn}
      paused={paused}
      testOptions={canTest ? testOptionsFor(u, brand) : []}
    />
  );
}
