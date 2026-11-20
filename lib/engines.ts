import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import type { Kind } from "./db";

// Each engine writes a raw dump of the source to `dest`, and can sanity-check a restored dump.

export type VerifyResult = { ok: boolean; detail: string };

// ---------- connection validation ----------

/** SQLite sources must live under SQLITE_ALLOWED_ROOT so tenants can't read arbitrary server files. */
export function sqliteRoot(): string | null {
  const root = process.env.SQLITE_ALLOWED_ROOT;
  return root ? path.resolve(root) : null;
}

export function validateConnection(kind: Kind, conn: string): string | null {
  if (kind === "sqlite") {
    const root = sqliteRoot();
    if (!root) return "SQLite sources are disabled on this server (SQLITE_ALLOWED_ROOT isn't set).";
    const full = path.resolve(conn);
    if (full !== root && !full.startsWith(root + path.sep)) return `The SQLite file must be inside ${root}`;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return "That SQLite file doesn't exist.";
    return null;
  }
  try {
    const u = new URL(conn);
    const ok = kind === "postgres" ? ["postgres:", "postgresql:"].includes(u.protocol) : u.protocol === "mysql:";
    if (!ok) return kind === "postgres" ? "Use a postgres://user:pass@host:5432/db URL" : "Use a mysql://user:pass@host:3306/db URL";
    if (!u.pathname.slice(1)) return "The URL must include a database name.";
    return null;
  } catch {
    return "That connection URL isn't valid.";
  }
}

/** Display-safe version of the connection (password removed). */
export function connectionHint(kind: Kind, conn: string): string {
  if (kind === "sqlite") return path.resolve(conn);
  try {
    const u = new URL(conn);
    return `${u.protocol}//${u.username ? `${decodeURIComponent(u.username)}@` : ""}${u.host}${u.pathname}`;
  } catch {
    return "(invalid)";
  }
}

// ---------- dumps ----------

export async function dump(kind: Kind, conn: string, dest: string): Promise<void> {
  if (kind === "sqlite") {
    // Online backup API: consistent snapshot even while the app is writing.
    const src = new DatabaseSync(path.resolve(conn), { readOnly: true });
    try {
      await sqliteBackup(src, dest);
    } finally {
      src.close();
    }
    return;
  }
  if (kind === "postgres") {
    const u = new URL(conn);
    await runTool(
      "pg_dump",
      ["--no-owner", "--no-privileges", "--format=plain", "-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username), u.pathname.slice(1)],
      { PGPASSWORD: decodeURIComponent(u.password), PGSSLMODE: u.searchParams.get("sslmode") ?? "prefer" },
      dest,
    );
    return;
  }
  const u = new URL(conn);
  await runTool(
    "mysqldump",
    ["--single-transaction", "--routines", "--triggers", "-h", u.hostname, "-P", u.port || "3306", "-u", decodeURIComponent(u.username), u.pathname.slice(1)],
    { MYSQL_PWD: decodeURIComponent(u.password) }, // keeps the password off the process list
    dest,
  );
}

function runTool(cmd: string, args: string[], env: Record<string, string>, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
    let stderr = "";
    child.stdout.pipe(out);
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.on("error", (err: NodeJS.ErrnoException) =>
      reject(new Error(err.code === "ENOENT" ? `${cmd} isn't installed on the backup server` : err.message)),
    );
    child.on("close", (code) => {
      out.end();
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim() || "no output"}`));
    });
  });
}

// ---------- restore check ----------

export function verifyDump(kind: Kind, file: string): VerifyResult {
  if (kind === "sqlite") {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const integrity = (db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check);
      if (integrity.join() !== "ok") return { ok: false, detail: `integrity_check: ${integrity.slice(0, 3).join("; ")}` };
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
      const counts = tables.map((t) => {
        const { n } = db!.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get() as { n: number };
        return `${t}: ${n}`;
      });
      return { ok: true, detail: `integrity ok · ${tables.length} tables · ${counts.join(", ")}`.slice(0, 1000) };
    } catch (err) {
      return { ok: false, detail: `Couldn't open restored file: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      db?.close();
    }
  }
  // SQL text dumps: check the tool's header and that the dump finished.
  const text = fs.readFileSync(file, "utf8");
  const head = text.slice(0, 2000);
  const tail = text.slice(-500);
  const headerOk = kind === "postgres" ? head.includes("PostgreSQL database dump") : head.includes("MySQL dump");
  const complete = kind === "postgres" ? tail.includes("PostgreSQL database dump complete") : tail.includes("Dump completed");
  const tables = (text.match(/CREATE TABLE/g) ?? []).length;
  return headerOk && complete
    ? { ok: true, detail: `dump header and footer present · ${tables} CREATE TABLE statements` }
    : { ok: false, detail: headerOk ? "Dump looks truncated (no completion marker)" : "Not a recognizable dump file" };
}
