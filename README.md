# 06 · Backstop — Database backups as a service

**Live demo:** https://backstop-demo.vercel.app/demo (signs you in to a shared demo account that resets itself)

Scheduled backups of PostgreSQL, MySQL, and SQLite databases. Every backup is compressed, encrypted, **restored and checked automatically**, and pruned to your retention setting. You get an alert when one fails or recovers.

## Run

```bash
npm install
SQLITE_ALLOWED_ROOT="$(pwd)" npm run dev
```

Open http://localhost:3006, sign up, and add a database. The first backup runs within ~30 seconds.

| Env var | Purpose |
|---------|---------|
| `BACKUP_MASTER_KEY` | 64 hex chars. Encrypts backups and stored credentials. If unset, a key is generated once into `data/master.key`. **Lose it and every backup is unreadable.** |
| `SQLITE_ALLOWED_ROOT` | Folder that SQLite sources must live in. If unset, SQLite sources are disabled, so tenants can't read arbitrary server files. |
| `SCHEDULER_INTERVAL_MS` | How often the scheduler looks for due backups (default 30000). |
| `BACKUP_DIR` | Where encrypted backups are stored (default `data/backups`). |

## How a backup works

1. **Dump.** SQLite uses Node's online backup API, which gives a consistent snapshot while the app keeps writing. Postgres runs `pg_dump --no-owner`. MySQL runs `mysqldump --single-transaction`, with the password passed via an env var so it never appears in the process list.
2. **Seal.** The dump is streamed through gzip and AES-256-GCM, and its SHA-256 is recorded. File layout: `[IV][ciphertext][auth tag]`.
3. **Restore check** (on by default). The backup is decrypted, decompressed, and checksum-compared. Then SQLite files get `PRAGMA integrity_check` plus row counts per table, and SQL dumps are checked for their header and the completion marker.
4. **Retention.** Keep the newest N successful backups and delete older files. Failed runs are pruned after 30 days.
5. **Alerts** go to your webhook (Slack/Discord/custom) on failure, on a failed restore check, and on recovery. There's no repeat spam while a source stays down.

Downloads are decrypted on the fly and delivered gzipped (`.sqlite.gz` / `.sql.gz`), with the SHA-256 in an `X-Content-SHA256` header.

## Verified

- I backed up Flagpole's live SQLite DB (#3): 72 KB was stored as 2.4 KB. The restore check passed with 9 tables and row counts. A download decompressed to a byte-identical file (checksum matched).
- Retention set to 3, after 5 runs: 3 runs and 3 files remain.
- Encryption: neither the stored files nor the database contain the source data or connection details in plain text. Flipping one byte in a stored backup makes its restore check fail ("unable to authenticate data").
- SQLite paths outside `SQLITE_ALLOWED_ROOT` (including `../` tricks) are rejected. Downloads require the owner's session.
- Alerts: the failure alert (Postgres source) and the recovery alert were both delivered to Hookscope (#1).

**Not verified here:** an actual Postgres/MySQL dump. This machine has no `pg_dump`/`mysqldump`, so those sources fail with a clear "isn't installed" error, which is the path I tested. The dump commands follow the standard flags, but they need a real run once the tools are available.

## Stack

Next.js 16 · `node:sqlite` · Node `crypto`/`zlib` streams · plain CSS. Scheduler in `instrumentation.ts`.

## Next steps toward a paid product

- Store backups in S3/R2/B2 (bring your own bucket), with a second copy for cross-region redundancy
- One-click restore into a fresh database, and point-in-time recovery via WAL archiving
- Run dumps in an isolated worker container (pg_dump/mysqldump versions matched to the server)
- Cron-expression schedules, backup windows, and per-plan limits on databases and storage with Stripe billing
- A weekly email report ("12 backups, all verified, 1.2 GB stored")
