export function formatDuration(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  const diff = now - ts;
  return diff < 5000 ? "just now" : `${formatDuration(diff)} ago`;
}

export function until(ts: number | null, now = Date.now()): string {
  if (!ts) return "—";
  const diff = ts - now;
  return diff > 0 ? `in ${formatDuration(diff)}` : "due now";
}

export function formatBytes(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export const SCHEDULES: [number, string][] = [
  [3600, "Hourly"],
  [6 * 3600, "Every 6 hours"],
  [12 * 3600, "Every 12 hours"],
  [86400, "Daily"],
  [7 * 86400, "Weekly"],
];

export const RETENTIONS: number[] = [3, 7, 14, 30, 90];

export const scheduleLabel = (s: number) => SCHEDULES.find(([v]) => v === s)?.[1] ?? `Every ${formatDuration(s * 1000)}`;
