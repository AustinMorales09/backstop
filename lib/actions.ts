"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, type Kind, type Run, type Source } from "./db";
import { createSession, destroySession, hashPassword, requireUser, verifyPassword } from "./auth";
import { encryptText } from "./crypto";
import { connectionHint, validateConnection } from "./engines";
import { RETENTIONS, SCHEDULES } from "./format";
import { applyRetention, deleteSourceFiles, runBackup, sendTestAlert, verifyRun } from "./runner";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const q = (msg: string) => encodeURIComponent(msg);

// ---------- auth ----------

export async function signup(form: FormData) {
  const email = str(form, "email").toLowerCase();
  const password = str(form, "password");
  if (!/^\S+@\S+\.\S+$/.test(email)) redirect(`/signup?error=${q("Enter a valid email")}`);
  if (password.length < 8) redirect(`/signup?error=${q("Password must be at least 8 characters")}`);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
    redirect(`/signup?error=${q("That email is already registered")}`);
  }
  const { lastInsertRowid } = db
    .prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)")
    .run(email, hashPassword(password), Date.now());
  await createSession(Number(lastInsertRowid));
  redirect("/dashboard");
}

export async function login(form: FormData) {
  const email = str(form, "email").toLowerCase();
  const password = str(form, "password");
  const user = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email) as
    | { id: number; password_hash: string }
    | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) {
    redirect(`/login?error=${q("Wrong email or password")}`);
  }
  await createSession(user.id);
  redirect("/dashboard");
}

export async function logout() {
  await destroySession();
  redirect("/");
}

// ---------- sources ----------

async function ownSource(id: number): Promise<Source> {
  const user = await requireUser();
  const s = db.prepare("SELECT * FROM sources WHERE id = ? AND user_id = ?").get(id, user.id) as Source | undefined;
  if (!s) redirect("/dashboard");
  return s;
}

const pickSchedule = (f: FormData, fallback: number) => {
  const n = Number(f.get("schedule_s"));
  return SCHEDULES.some(([v]) => v === n) ? n : fallback;
};
const pickRetention = (f: FormData, fallback: number) => {
  const n = Number(f.get("retention"));
  return RETENTIONS.includes(n) ? n : fallback;
};

export async function createSource(form: FormData) {
  const user = await requireUser();
  const kind = str(form, "kind") as Kind;
  if (!["sqlite", "postgres", "mysql"].includes(kind)) redirect(`/dashboard?error=${q("Pick a database type")}`);
  const conn = str(form, "conn");
  const problem = validateConnection(kind, conn);
  if (problem) redirect(`/dashboard?error=${q(problem)}`);

  const name = (str(form, "name") || connectionHint(kind, conn).split(/[\\/]/).slice(-2).join("/")).slice(0, 60);
  const schedule = pickSchedule(form, 86400);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO sources (user_id, name, kind, conn_enc, conn_hint, schedule_s, retention, verify_after, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      name,
      kind,
      encryptText(kind === "sqlite" ? connectionHint(kind, conn) : conn),
      connectionHint(kind, conn),
      schedule,
      pickRetention(form, 7),
      form.get("verify_after") ? 1 : 0,
      Date.now(), // first backup runs on the scheduler's next tick
      Date.now(),
    );
  redirect(`/sources/${lastInsertRowid}`);
}

export async function updateSource(form: FormData) {
  const s = await ownSource(Number(form.get("source_id")));
  const schedule = pickSchedule(form, s.schedule_s);
  const retention = pickRetention(form, s.retention);
  db.prepare("UPDATE sources SET name = ?, schedule_s = ?, retention = ?, verify_after = ?, next_run_at = ? WHERE id = ?").run(
    (str(form, "name") || s.name).slice(0, 60),
    schedule,
    retention,
    form.get("verify_after") ? 1 : 0,
    // Re-base the next run on the new schedule.
    schedule !== s.schedule_s ? Date.now() + schedule * 1000 : s.next_run_at,
    s.id,
  );
  if (retention < s.retention) applyRetention({ ...s, retention });
  redirect(`/sources/${s.id}?saved=1`);
}

export async function backupNow(form: FormData) {
  const s = await ownSource(Number(form.get("source_id")));
  await runBackup(s, "manual");
  redirect(`/sources/${s.id}`);
}

export async function verifyNow(form: FormData) {
  const s = await ownSource(Number(form.get("source_id")));
  const run = db.prepare("SELECT * FROM runs WHERE id = ? AND source_id = ? AND status = 'success'").get(Number(form.get("run_id")), s.id) as
    | Run
    | undefined;
  if (run) await verifyRun(run, s);
  redirect(`/sources/${s.id}`);
}

export async function togglePause(form: FormData) {
  const s = await ownSource(Number(form.get("source_id")));
  db.prepare("UPDATE sources SET paused = ?, next_run_at = ? WHERE id = ?").run(
    s.paused ? 0 : 1,
    s.paused ? Date.now() + s.schedule_s * 1000 : s.next_run_at,
    s.id,
  );
  revalidatePath(`/sources/${s.id}`);
}

export async function deleteSource(form: FormData) {
  const s = await ownSource(Number(form.get("source_id")));
  db.prepare("DELETE FROM sources WHERE id = ?").run(s.id);
  deleteSourceFiles(s.id);
  redirect("/dashboard");
}

// ---------- alerts ----------

export async function saveSettings(form: FormData) {
  const user = await requireUser();
  const raw = str(form, "webhook_url");
  let url: string | null = null;
  if (raw) {
    try {
      const u = new URL(raw);
      if (!["http:", "https:"].includes(u.protocol)) throw new Error();
      url = u.toString();
    } catch {
      redirect(`/settings?error=${q("Webhook URL must start with http:// or https://")}`);
    }
  }
  db.prepare("UPDATE users SET webhook_url = ? WHERE id = ?").run(url, user.id);
  redirect("/settings?saved=1");
}

export async function testAlert() {
  const user = await requireUser();
  const { webhook_url } = db.prepare("SELECT webhook_url FROM users WHERE id = ?").get(user.id) as { webhook_url: string | null };
  if (!webhook_url) redirect(`/settings?error=${q("Save a webhook URL first")}`);
  redirect(`/settings?test=${q(await sendTestAlert(webhook_url))}`);
}
