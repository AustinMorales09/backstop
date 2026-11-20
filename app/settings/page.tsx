import { requireUser } from "@/lib/auth";
import { saveSettings, testAlert } from "@/lib/actions";
import { db } from "@/lib/db";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; test?: string }> }) {
  const user = await requireUser();
  const { error, saved, test } = await searchParams;
  const { webhook_url } = db.prepare("SELECT webhook_url FROM users WHERE id = ?").get(user.id) as { webhook_url: string | null };

  return (
    <main className="container" style={{ maxWidth: 720 }}>
      <h1>Alerts</h1>
      <div className="card">
        <h2>Webhook</h2>
        <p className="small muted">
          Backstop POSTs here when a backup fails, when a backup fails its restore check, and when a failing database
          recovers. Works with Slack and Discord incoming webhooks (<code>text</code> / <code>content</code>) or your own endpoint.
        </p>
        {error && <p className="error">{error}</p>}
        {saved && <p className="ok-text small">Saved.</p>}
        {test && <p className="small"><strong>Test result:</strong> {test}</p>}
        <form action={saveSettings} className="row">
          <div className="grow">
            <label htmlFor="webhook_url">Webhook URL</label>
            <input id="webhook_url" name="webhook_url" type="text" defaultValue={webhook_url ?? ""} placeholder="https://hooks.slack.com/services/…" />
          </div>
          <button type="submit">Save</button>
        </form>
        {webhook_url && (
          <form action={testAlert} style={{ marginTop: 12 }}>
            <button className="secondary">Send test alert</button>
          </form>
        )}
      </div>
    </main>
  );
}
