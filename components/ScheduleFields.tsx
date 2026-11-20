import { RETENTIONS, SCHEDULES } from "@/lib/format";

export default function ScheduleFields({ schedule = 86400, retention = 7, verify = true }: { schedule?: number; retention?: number; verify?: boolean }) {
  return (
    <>
      <div style={{ minWidth: 150 }}>
        <label htmlFor="schedule_s">Back up</label>
        <select id="schedule_s" name="schedule_s" defaultValue={schedule}>
          {SCHEDULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div style={{ minWidth: 150 }}>
        <label htmlFor="retention">Keep</label>
        <select id="retention" name="retention" defaultValue={retention}>
          {RETENTIONS.map((n) => <option key={n} value={n}>Last {n} backups</option>)}
        </select>
      </div>
      <label style={{ display: "inline-flex", gap: 6, alignItems: "center", margin: 0, color: "var(--text)", alignSelf: "center" }}>
        <input type="checkbox" name="verify_after" value="1" defaultChecked={verify} /> Restore-check every backup
      </label>
    </>
  );
}
