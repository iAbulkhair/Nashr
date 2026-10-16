import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api-handler";
import { CORE_FILES, FileLimitError, MAX_FILES, deleteFile, listFiles, readFile, safeName, writeFile } from "@/lib/files";
import { WINDOW } from "@/lib/rate";
import { forbid } from "@/lib/roles";

export const GET = handler({ auth: "user", query: z.object({ name: z.string().optional() }) }, async ({ scope, query }) => {
  if (query.name) return NextResponse.json({ ok: true, file: await readFile(scope, query.name) });
  return NextResponse.json({ ok: true, files: await listFiles(scope) });
});

/** A file is capped at 40,000 characters by writeFile; this rejects an oversized body before it is parsed. */
const MAX_BODY_BYTES = 200_000;
const fileBody = z.object({ name: z.string().min(1), content: z.string() });

// Every other write in the codebase is throttled; this one was not, so one account could sit in a loop creating
// files until its index was unusable for everyone reading it.
export const PUT = handler(
  { auth: "user", rate: { bucket: "files", max: 60, window: WINDOW.hour, per: "scope" }, maxBytes: MAX_BODY_BYTES, input: fileBody, invalid: "missing" },
  async ({ u, scope, input: b }) => {
    // A core file is what every agent reads on every turn; writing one empty is deleting it (memoryBlock skips empty
    // files). So it needs what DELETE needs, compared after the same normalisation writeFile applies.
    if (CORE_FILES.includes(safeName(b.name))) {
      const no = forbid(u, "files.core.write");
      if (no) return no;
    }
    try {
      return NextResponse.json({ ok: true, file: await writeFile(scope, b.name, b.content, "user") });
    } catch (e) {
      if (e instanceof FileLimitError) return NextResponse.json({ ok: false, error: "file_limit", limit: MAX_FILES }, { status: 409 });
      throw e;
    }
  },
);

export const DELETE = handler({ auth: "user", query: z.object({ name: z.string().min(1) }) }, async ({ u, scope, query: { name } }) => {
  // Compared after the same normalisation deleteFile applies, so "Brand.MD" cannot slip past as a different name.
  if (CORE_FILES.includes(safeName(name))) {
    const no = forbid(u, "files.core.delete");
    if (no) return no;
  }
  await deleteFile(scope, name);
  return NextResponse.json({ ok: true });
});
