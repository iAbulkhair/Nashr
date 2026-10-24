import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api-handler";
import { CORE_FILES, FileLimitError, MAX_FILES, deleteFile, listFiles, readFile, safeName, writeFile, writeFileChecked } from "@/lib/files";
import { fileSrc } from "@/lib/ref-provenance";
import { WINDOW } from "@/lib/rate";
import { forbid } from "@/lib/roles";

export const GET = handler({ auth: "user", query: z.object({ name: z.string().optional() }) }, async ({ scope, query }) => {
  if (query.name) return NextResponse.json({ ok: true, file: await readFile(scope, query.name) });
  return NextResponse.json({ ok: true, files: await listFiles(scope) });
});

/** A file is capped at 40,000 characters by writeFile; this rejects an oversized body before it is parsed. */
const MAX_BODY_BYTES = 200_000;
/**
 * `baseAt` (rule 2441, expand): the `updatedAt` of the file the editor opened, or null for a new file. When sent, the
 * save is refused with 409 `stale` (changed or deleted since) or `exists` (the new name is taken) and the file as it is
 * now; 503 `busy` when another checked save of it holds the lock. Without it the save is as before (uploads, older pages).
 */
const fileBody = z.object({ name: z.string().min(1), content: z.string(), baseAt: z.string().max(40).nullable().optional() });

// Every other write in the codebase is throttled; this one was not, so one account could sit in a loop creating
// files until its index was unusable for everyone reading it.
export const PUT = handler(
  { auth: "user", role: "files.write", rate: { bucket: "files", max: 60, window: WINDOW.hour, per: "scope" }, maxBytes: MAX_BODY_BYTES, input: fileBody, invalid: "missing" },
  async ({ u, scope, input: b }) => {
    // A core file is what every agent reads on every turn; writing one empty is deleting it (memoryBlock skips empty
    // files). So it needs what DELETE needs, compared after the same normalisation writeFile applies.
    if (CORE_FILES.includes(safeName(b.name))) {
      const no = forbid(u, "files.core.write");
      if (no) return no;
    }
    try {
      if (b.baseAt === undefined) return NextResponse.json({ ok: true, file: await writeFile(scope, b.name, b.content, "user", { src: fileSrc("owner") }) });
      const r = await writeFileChecked(scope, b.name, b.content, "user", b.baseAt, fileSrc("owner"));
      if (r.ok) return NextResponse.json({ ok: true, file: r.file });
      if (r.error === "busy") return NextResponse.json({ ok: false, error: "busy" }, { status: 503 });
      return NextResponse.json({ ok: false, error: r.error, file: r.file }, { status: 409 });
    } catch (e) {
      if (e instanceof FileLimitError) return NextResponse.json({ ok: false, error: "file_limit", limit: MAX_FILES }, { status: 409 });
      throw e;
    }
  },
);

export const DELETE = handler({ auth: "user", role: "files.write", query: z.object({ name: z.string().min(1) }) }, async ({ u, scope, query: { name } }) => {
  // Compared after the same normalisation deleteFile applies, so "Brand.MD" cannot slip past as a different name.
  if (CORE_FILES.includes(safeName(name))) {
    const no = forbid(u, "files.core.delete");
    if (no) return no;
  }
  await deleteFile(scope, name);
  return NextResponse.json({ ok: true });
});
