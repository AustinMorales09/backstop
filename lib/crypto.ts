import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { dataDir } from "./db";

// One master key encrypts both stored connection strings and backup files (AES-256-GCM).
// Set BACKUP_MASTER_KEY (64 hex chars) in production. Otherwise a key is generated once
// into data/master.key. Lose that file and every existing backup becomes unreadable.

let cachedKey: Buffer | null = null;

export function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.BACKUP_MASTER_KEY;
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) throw new Error("BACKUP_MASTER_KEY must be 64 hex characters");
    return (cachedKey = Buffer.from(fromEnv, "hex"));
  }
  const file = path.join(dataDir, "master.key");
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  return (cachedKey = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex"));
}

// ---------- small secrets (connection strings) ----------

export function encryptText(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decryptText(sealed: string): string {
  const [iv, tag, enc] = sealed.split(".").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// ---------- backup files ----------
// File layout: [12-byte IV][gzip data, encrypted][16-byte GCM tag]

/** Gzips + encrypts src into dest. Returns sizes and the SHA-256 of the *original* data. */
export async function sealFile(src: string, dest: string): Promise<{ rawBytes: number; storedBytes: number; sha256: string }> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const hash = crypto.createHash("sha256");
  let rawBytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      rawBytes += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  out.write(iv);
  await pipeline(fs.createReadStream(src), tap, zlib.createGzip({ level: 6 }), cipher, out, { end: false });
  await new Promise<void>((resolve, reject) => out.end(cipher.getAuthTag(), () => resolve()).on("error", reject));
  return { rawBytes, storedBytes: fs.statSync(dest).size, sha256: hash.digest("hex") };
}

/** Streams the decrypted (still gzipped) contents of a sealed file. Integrity is checked at the end. */
export function openSealed(file: string): Readable {
  const size = fs.statSync(file).size;
  if (size < 28) throw new Error("Backup file is truncated");
  const fd = fs.openSync(file, "r");
  const iv = Buffer.alloc(12);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, iv, 0, 12, 0);
  fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return fs.createReadStream(file, { start: 12, end: size - 17 }).pipe(decipher);
}

/** Fully decrypts + decompresses a sealed file to dest and returns the SHA-256 of the result. */
export async function unsealFile(file: string, dest: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(openSealed(file), zlib.createGunzip(), tap, fs.createWriteStream(dest));
  return hash.digest("hex");
}
