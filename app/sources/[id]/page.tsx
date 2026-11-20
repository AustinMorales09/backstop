import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db, KIND_LABEL, type Run, type Source } from "@/lib/db";
import { backupNow, deleteSource, togglePause, updateSource, verifyNow } from "@/lib/actions";
import { ago, formatBytes, formatDuration, scheduleLabel, until } from "@/lib/format";
import ScheduleFields from "@/components/ScheduleFields";
import AutoRefresh from "@/components/AutoRefresh";

export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { saved } = await searchParams;
  const s = db.prepare("SELECT * FROM sources WHERE id = ? AND user_id = ?").get(Number(id), user.id) as Source | undefined;
  if (!s) notFound();
  const now = Date.now();
  const runs = db.prepare("SELECT * FROM runs WHERE source_id = ? ORDER BY id DESC LIMIT 50").all(s.id) as Run[];
  const lastGood = runs.find((r) => r.status === "success");
  const isRunning = runs.some((r) => r.status === "running");
  const restoreHint =
    s.kind === "sqlite"
      ? "gunzip backup.sqlite.gz   # then replace the app's .db file while the app is stopped"
      : s.kind === "postgres"
        ? "gunzip -c backup.sql.gz | psql postgres://user:pass@host:5432/new_db"
        : "gunzip -c backup.sql.gz | mysql -h host -u user -p new_db";

  return (
    <main className="container">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <p className="small" style={{ margin: 0 }}><Link href="/dashboard">← Databases</Link></p>
        <AutoRefresh intervalMs={4000} />
      </div>
      <h1 style={{ marginTop: 12, marginBottom: 4 }}>{s.name}</h1>
      <p className="small muted" style={{ marginTop: 0 }}>{KIND_LABEL[s.kind]} · <code>{s.conn_hint}</code></p>

      <div className="summary">
        <div className="card"><div className="small muted">Last good backup</div><strong>{ago(lastGood?.finished_at ?? null, now)}</strong></div>
        <div className="card"><div className="small muted">Schedule</div><strong>{scheduleLabel(s.schedule_s)}</strong><div className="small muted">keep last {s.retention}</div></div>
        <div className="card"><div className="small muted">Next backup</div><strong>{s.paused ? "paused" : isRunning ? "running now…" : until(s.next_run_at, now)}</strong></div>
        <div className="card">
          <form action={backupNow}>
            <input type="hidden" name="source_id" value={s.id} />
            <button type="submit" disabled={isRunning}>{isRunning ? "Backing up…" : "Back up now"}</button>
          </form>
        </div>
      </div>

      <div className="card">
        <h2>Backups</h2>
        {runs.length === 0 ? (
          <p className="muted small">The first backup will start within a minute.</p>
        ) : (
          <div className="table-wrap">
            <table className="list">
              <thead><tr><th>Started</th><th>Result</th><th>Size</th><th>Restore check</th><th></th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="small">
                      {new Date(r.started_at).toLocaleString()}
                      <div className="muted">{r.trigger}{r.finished_at && ` · ${formatDuration(Math.max(r.finished_at - r.started_at, 1000))}`}</div>
                    </td>
                    <td className="small">
                      {r.status === "success" && <span className="status-ok">✓ success</span>}
                      {r.status === "running" && <span className="status-warn">… running</span>}
                      {r.status === "failed" && <span className="status-err">✕ failed<div style={{ maxWidth: 340 }}>{r.error}</div></span>}
                    </td>
                    <td className="small">
                      {r.raw_bytes !== null && <>{formatBytes(r.raw_bytes)}<div className="muted">stored {formatBytes(r.stored_bytes)}</div></>}
                    </td>
                    <td className="small" style={{ maxWidth: 360 }}>
                      {r.verify_status === "passed" && <span className="status-ok">✓ passed</span>}
                      {r.verify_status === "failed" && <span className="status-err">✕ failed</span>}
                      {r.verify_detail && <div className="muted">{r.verify_detail}</div>}
                    </td>
                    <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                      {r.status === "success" && (
                        <>
                          <a href={`/runs/${r.id}/download`} className="small">Download</a>{" "}
                          <form action={verifyNow} style={{ display: "inline" }}>
                            <input type="hidden" name="source_id" value={s.id} />
                            <input type="hidden" name="run_id" value={r.id} />
                            <button className="secondary" style={{ padding: "4px 8px", fontSize: 12 }}>Check</button>
                          </form>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ marginBottom: 4 }}>
          Downloads are decrypted on the fly and arrive gzipped (the SHA-256 of the uncompressed dump is sent in the{" "}
          <code>X-Content-SHA256</code> header). To restore:
        </p>
        <pre>{restoreHint}</pre>
      </div>

      <div className="card">
        <h2>Settings</h2>
        {saved && <p className="ok-text small">Saved.</p>}
        <form action={updateSource}>
          <input type="hidden" name="source_id" value={s.id} />
          <div className="row">
            <div className="grow">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" defaultValue={s.name} />
            </div>
            <ScheduleFields schedule={s.schedule_s} retention={s.retention} verify={!!s.verify_after} />
            <button type="submit" className="secondary">Save</button>
          </div>
        </form>
        <div className="row" style={{ marginTop: 16 }}>
          <form action={togglePause}>
            <input type="hidden" name="source_id" value={s.id} />
            <button className="secondary">{s.paused ? "Resume schedule" : "Pause schedule"}</button>
          </form>
          <form action={deleteSource}>
            <input type="hidden" name="source_id" value={s.id} />
            <button className="danger">Delete database and all its backups</button>
          </form>
        </div>
      </div>
    </main>
  );
}
