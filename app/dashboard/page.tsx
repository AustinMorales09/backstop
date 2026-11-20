import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createSource } from "@/lib/actions";
import { db, KIND_LABEL, type Source } from "@/lib/db";
import { sqliteRoot } from "@/lib/engines";
import { ago, formatBytes, scheduleLabel, until } from "@/lib/format";
import ScheduleFields from "@/components/ScheduleFields";
import AutoRefresh from "@/components/AutoRefresh";

type Row = Source & { last_success: number | null; stored: number | null; copies: number; last_verify: string | null };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const { error } = await searchParams;
  const now = Date.now();
  const sources = db
    .prepare(
      `SELECT s.*,
         (SELECT MAX(finished_at) FROM runs r WHERE r.source_id = s.id AND r.status = 'success') AS last_success,
         (SELECT SUM(stored_bytes) FROM runs r WHERE r.source_id = s.id AND r.status = 'success') AS stored,
         (SELECT COUNT(*) FROM runs r WHERE r.source_id = s.id AND r.status = 'success') AS copies,
         (SELECT verify_status FROM runs r WHERE r.source_id = s.id AND r.status = 'success' ORDER BY id DESC LIMIT 1) AS last_verify
       FROM sources s WHERE s.user_id = ? ORDER BY s.last_status = 'failed' DESC, s.name`,
    )
    .all(user.id) as Row[];
  const totalStored = sources.reduce((sum, s) => sum + (s.stored ?? 0), 0);
  const root = sqliteRoot();

  return (
    <main className="container">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Databases</h1>
        <AutoRefresh intervalMs={5000} />
      </div>

      {sources.length > 0 && (
        <div className="summary">
          <div className="card"><div className="num">{sources.length}</div><div className="small muted">Databases</div></div>
          <div className="card"><div className="num status-err">{sources.filter((s) => s.last_status === "failed").length}</div><div className="small muted">Failing</div></div>
          <div className="card"><div className="num">{sources.reduce((n, s) => n + s.copies, 0)}</div><div className="small muted">Backups stored</div></div>
          <div className="card"><div className="num">{formatBytes(totalStored)}</div><div className="small muted">Storage used</div></div>
        </div>
      )}

      <div className="card">
        <h2>Add a database</h2>
        {error && <p className="error">{error}</p>}
        <form action={createSource}>
          <div className="row">
            <div style={{ minWidth: 140 }}>
              <label htmlFor="kind">Type</label>
              <select id="kind" name="kind" defaultValue="postgres">
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="sqlite">SQLite file</option>
              </select>
            </div>
            <div className="grow">
              <label htmlFor="conn">Connection URL (or SQLite file path)</label>
              <input id="conn" name="conn" type="text" required autoComplete="off" placeholder="postgres://backup_user:password@db.example.com:5432/app" />
            </div>
            <div style={{ minWidth: 160 }}>
              <label htmlFor="name">Name (optional)</label>
              <input id="name" name="name" type="text" placeholder="Production DB" />
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <ScheduleFields />
            <button type="submit">Add &amp; run first backup</button>
          </div>
        </form>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Credentials are encrypted at rest. Use a read-only database user. Postgres/MySQL need <code>pg_dump</code> /{" "}
          <code>mysqldump</code> on the backup server.{" "}
          {root ? <>SQLite files must be inside <code>{root}</code>.</> : <>SQLite sources are disabled on this server.</>}
        </p>
      </div>

      <div className="card">
        {sources.length === 0 ? (
          <p className="muted">No databases yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr><th>Status</th><th>Database</th><th>Schedule</th><th>Last good backup</th><th>Next</th><th>Copies</th></tr>
              </thead>
              <tbody>
                {sources.map((s) => {
                  const status = s.paused ? "paused" : s.last_status === "failed" ? "down" : s.last_status === "success" ? "up" : "new";
                  return (
                    <tr key={s.id}>
                      <td><span className={`badge badge-${status}`}>{s.paused ? "paused" : s.last_status === "failed" ? "failing" : s.last_status === "success" ? "ok" : "pending"}</span></td>
                      <td>
                        <Link href={`/sources/${s.id}`}><strong>{s.name}</strong></Link>
                        <div className="small muted">{KIND_LABEL[s.kind]} · {s.conn_hint}</div>
                      </td>
                      <td className="small">{scheduleLabel(s.schedule_s)}</td>
                      <td className="small">
                        {ago(s.last_success, now)}
                        {s.last_verify && <div className={s.last_verify === "passed" ? "status-ok" : "status-err"}>restore check {s.last_verify}</div>}
                      </td>
                      <td className="small muted">{s.paused ? "paused" : until(s.next_run_at, now)}</td>
                      <td className="small">{s.copies} · {formatBytes(s.stored)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
