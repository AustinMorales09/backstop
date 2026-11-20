// Next.js calls register() once at server start. We use it to run scheduled backups.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const g = globalThis as unknown as { __backupTimer?: NodeJS.Timeout };
  if (g.__backupTimer) return; // already running (dev hot reload)

  const { runDueBackups } = await import("./lib/runner");
  const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS ?? 30_000);
  let busy = false;
  g.__backupTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueBackups();
    } catch (err) {
      console.error("[scheduler] failed", err);
    } finally {
      busy = false;
    }
  }, intervalMs);
}
