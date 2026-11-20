import fs from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { db, type Run, type Source } from "@/lib/db";
import { openSealed } from "@/lib/crypto";
import { dumpExt } from "@/lib/runner";

// Streams a backup decrypted (but still gzipped) so it can be restored with standard tools.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await ctx.params;
  const row = db
    .prepare(
      `SELECT r.*, s.name AS source_name, s.kind AS source_kind FROM runs r JOIN sources s ON s.id = r.source_id
       WHERE r.id = ? AND s.user_id = ? AND r.status = 'success'`,
    )
    .get(Number(id), user.id) as (Run & { source_name: string; source_kind: Source["kind"] }) | undefined;
  if (!row?.file_path || !fs.existsSync(row.file_path)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const safe = row.source_name.replace(/[^\w.-]+/g, "-").slice(0, 40);
  const stamp = new Date(row.started_at).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const filename = `${safe}-${stamp}${dumpExt(row.source_kind)}.gz`;

  return new NextResponse(Readable.toWeb(openSealed(row.file_path)) as ReadableStream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-SHA256": row.sha256 ?? "",
      "Cache-Control": "no-store",
    },
  });
}
