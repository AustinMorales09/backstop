import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const dataDir = process.env.DATA_DIR ?? (process.env.VERCEL ? demoDataDir() : path.join(process.env.APP_DIR ?? process.cwd(), "data"));

// Vercel deployments are read-only: copy the bundled demo snapshot (seed/) to /tmp once per instance and work there.
// Changes last as long as the instance does, so the public demo resets itself.
function demoDataDir(): string {
  const dir = "/tmp/data";
  const seed = path.join(process.cwd(), "seed");
  if (!fs.existsSync(path.join(dir, "app.db")) && fs.existsSync(seed)) fs.cpSync(seed, dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const backupDir = process.env.BACKUP_DIR ?? path.join(dataDir, "backups");

function init(): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "app.db"));
  db.exec(`
    PRAGMA busy_timeout = 5000; -- first, so parallel build workers wait instead of failing
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      webhook_url TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    -- kind: sqlite | postgres | mysql. The connection string/path is encrypted at rest.
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      conn_enc TEXT NOT NULL,
      conn_hint TEXT NOT NULL,
      schedule_s INTEGER NOT NULL,
      retention INTEGER NOT NULL,
      verify_after INTEGER NOT NULL DEFAULT 1,
      paused INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER,
      last_status TEXT,
      created_at INTEGER NOT NULL
    );

    -- status: running | success | failed      verify_status: null | passed | failed
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      raw_bytes INTEGER,
      stored_bytes INTEGER,
      sha256 TEXT,
      file_path TEXT,
      error TEXT,
      verify_status TEXT,
      verify_detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(source_id, id DESC);
  `);
  // A server restart mid-backup leaves runs stuck as "running"; mark them failed.
  db.prepare("UPDATE runs SET status = 'failed', error = 'Interrupted (server restarted)', finished_at = ? WHERE status = 'running'").run(Date.now());
  return db;
}

const g = globalThis as unknown as { __db?: DatabaseSync };
export const db: DatabaseSync = g.__db ?? (g.__db = init());

export type Kind = "sqlite" | "postgres" | "mysql";
export type Source = {
  id: number;
  user_id: number;
  name: string;
  kind: Kind;
  conn_enc: string;
  conn_hint: string;
  schedule_s: number;
  retention: number;
  verify_after: number;
  paused: number;
  next_run_at: number | null;
  last_status: string | null;
  created_at: number;
};
export type Run = {
  id: number;
  source_id: number;
  trigger: "schedule" | "manual";
  status: "running" | "success" | "failed";
  started_at: number;
  finished_at: number | null;
  raw_bytes: number | null;
  stored_bytes: number | null;
  sha256: string | null;
  file_path: string | null;
  error: string | null;
  verify_status: "passed" | "failed" | null;
  verify_detail: string | null;
};

export const KIND_LABEL: Record<Kind, string> = { sqlite: "SQLite", postgres: "PostgreSQL", mysql: "MySQL" };
