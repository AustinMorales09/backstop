import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupDir, db, type Run, type Source } from "./db";
import { decryptText, sealFile, unsealFile } from "./crypto";
import { dump, verifyDump } from "./engines";
import { formatBytes } from "./format";

const running = new Set<number>(); // source ids with a backup in progress (this process)

function tmpFile(ext: string) {
  return path.join(os.tmpdir(), `dbbackup-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}
const rm = (f: string) => fs.rmSync(f, { force: true });

export function dumpExt(kind: Source["kind"]) {
  return kind === "sqlite" ? ".sqlite" : ".sql";
}

// ---------- alerts ----------

async function notify(source: Source, text: string, status: "failed" | "recovered" | "verify_failed") {
  const owner = db.prepare("SELECT webhook_url FROM users WHERE id = ?").get(source.user_id) as { webhook_url: string | null } | undefined;
  if (!owner?.webhook_url) return;
  try {
    await fetch(owner.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text, source: source.name, status }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[alert] webhook failed", err);
  }
}

export async function sendTestAlert(url: string): Promise<string> {
  const text = "✅ Test alert from Backstop";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text, test: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? `Delivered (HTTP ${res.status})` : `Webhook responded HTTP ${res.status}`;
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------- restore check ----------

/** Decrypts + decompresses a stored backup to a temp file and checks it can actually be restored. */
export async function verifyRun(run: Run, source: Source): Promise<{ ok: boolean; detail: string }> {
  if (!run.file_path || !fs.existsSync(run.file_path)) return { ok: false, detail: "Backup file is missing" };
  const tmp = tmpFile(dumpExt(source.kind));
  try {
    const sha = await unsealFile(run.file_path, tmp);
    if (sha !== run.sha256) return record(run.id, false, "Checksum mismatch: the stored file is corrupted");
    const res = verifyDump(source.kind, tmp);
    return record(run.id, res.ok, `checksum ok · ${res.detail}`);
  } catch (err) {
    return record(run.id, false, `Couldn't decrypt or decompress: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rm(tmp);
  }
}

function record(runId: number, ok: boolean, detail: string) {
  db.prepare("UPDATE runs SET verify_status = ?, verify_detail = ? WHERE id = ?").run(ok ? "passed" : "failed", detail, runId);
  return { ok, detail };
}

// ---------- backup ----------

export async function runBackup(source: Source, trigger: Run["trigger"]): Promise<number | null> {
  if (running.has(source.id)) return null;
  running.add(source.id);
  const started = Date.now();
  const runId = Number(
    db.prepare("INSERT INTO runs (source_id, trigger, status, started_at) VALUES (?, ?, 'running', ?)").run(source.id, trigger, started)
      .lastInsertRowid,
  );
  // Schedule the next run from now, so a slow or failing source doesn't pile up runs.
  db.prepare("UPDATE sources SET next_run_at = ? WHERE id = ?").run(started + source.schedule_s * 1000, source.id);

  const raw = tmpFile(dumpExt(source.kind));
  const stored = path.join(backupDir, String(source.id), `${new Date(started).toISOString().replace(/[:.]/g, "-")}-${runId}${dumpExt(source.kind)}.gz.enc`);
  const previous = source.last_status;

  try {
    await dump(source.kind, decryptText(source.conn_enc), raw);
    const { rawBytes, storedBytes, sha256 } = await sealFile(raw, stored);
    db.prepare(
      `UPDATE runs SET status = 'success', finished_at = ?, raw_bytes = ?, stored_bytes = ?, sha256 = ?, file_path = ? WHERE id = ?`,
    ).run(Date.now(), rawBytes, storedBytes, sha256, stored, runId);
    db.prepare("UPDATE sources SET last_status = 'success' WHERE id = ?").run(source.id);

    if (source.verify_after) {
      const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Run;
      const v = await verifyRun(run, source);
      if (!v.ok) await notify(source, `🟠 Backup of ${source.name} completed but FAILED the restore check: ${v.detail}`, "verify_failed");
    }
    applyRetention(source);
    if (previous === "failed") await notify(source, `🟢 Backups of ${source.name} are working again (${formatBytes(rawBytes)})`, "recovered");
  } catch (err) {
    rm(stored);
    const message = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?").run(Date.now(), message.slice(0, 2000), runId);
    db.prepare("UPDATE sources SET last_status = 'failed' WHERE id = ?").run(source.id);
    if (previous !== "failed") await notify(source, `🔴 Backup of ${source.name} FAILED: ${message}`, "failed");
  } finally {
    rm(raw);
    running.delete(source.id);
  }
  return runId;
}

/** Keeps the newest N successful backups and deletes older files. Failed runs older than 30 days are pruned too. */
export function applyRetention(source: Source) {
  const old = db
    .prepare(
      `SELECT id, file_path FROM runs WHERE source_id = ? AND status = 'success'
       ORDER BY id DESC LIMIT -1 OFFSET ?`,
    )
    .all(source.id, source.retention) as { id: number; file_path: string | null }[];
  for (const r of old) {
    if (r.file_path) rm(r.file_path);
    db.prepare("DELETE FROM runs WHERE id = ?").run(r.id);
  }
  db.prepare("DELETE FROM runs WHERE source_id = ? AND status = 'failed' AND started_at < ?").run(source.id, Date.now() - 30 * 86400_000);
}

export function deleteSourceFiles(sourceId: number) {
  fs.rmSync(path.join(backupDir, String(sourceId)), { recursive: true, force: true });
}

// ---------- scheduler ----------

export async function runDueBackups(now = Date.now()) {
  const due = db
    .prepare("SELECT * FROM sources WHERE paused = 0 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
    .all(now) as Source[];
  // One at a time keeps disk and CPU usage predictable on a small server.
  for (const s of due) await runBackup(s, "schedule");
  return due.length;
}
