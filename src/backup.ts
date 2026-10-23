import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { decryptJson } from "./security.js";
import type { StoreData } from "./types.js";

interface Snapshot { version: 1; createdAt: string; env: string; store: string }
interface BackupOptions { envFile: string; dataFile: string; backupDir: string; keep?: number }
const BACKUP_NAME = /^v2ex-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.backup$/;

function validate(snapshot: Snapshot): StoreData {
  if (snapshot.version !== 1 || typeof snapshot.env !== "string" || typeof snapshot.store !== "string") throw new Error("Invalid backup format");
  const key = parseEnv(snapshot.env).MASTER_KEY;
  if (!key || !/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error("Invalid backup key");
  const data = decryptJson<StoreData>(snapshot.store, key);
  if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.history)) throw new Error("Invalid backup data");
  return data;
}

export async function createBackup({ envFile, dataFile, backupDir, keep = 14 }: BackupOptions) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Error("Invalid retention count");
  const snapshot: Snapshot = { version: 1, createdAt: new Date().toISOString(), env: await readFile(envFile, "utf8"), store: await readFile(dataFile, "utf8") };
  const data = validate(snapshot);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(backupDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Backup destination must be a directory, not a symlink");
  await chmod(backupDir, 0o700);
  const file = path.join(backupDir, `v2ex-backup-${snapshot.createdAt.replace(/[:.]/g, "-")}-${randomUUID()}.backup`);
  const temp = `${file}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  // Prune only this tool's regular files, and only after a valid new snapshot exists.
  const backups = (await readdir(backupDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && BACKUP_NAME.test(entry.name)).map(entry => entry.name).sort().reverse();
  for (const name of backups.slice(keep)) await unlink(path.join(backupDir, name));
  return { file, accounts: data.accounts.length, history: data.history.length };
}

export async function verifyBackup(file: string) {
  const snapshot: Snapshot = JSON.parse(await readFile(file, "utf8"));
  const data = validate(snapshot);
  return { file, createdAt: snapshot.createdAt, accounts: data.accounts.length, history: data.history.length };
}

export async function restoreBackup(file: string, targetDir: string) {
  const snapshot: Snapshot = JSON.parse(await readFile(file, "utf8"));
  const data = validate(snapshot);
  // An existing directory is never accepted, even when it appears empty.
  await mkdir(targetDir, { mode: 0o700 });
  await writeFile(path.join(targetDir, ".env"), snapshot.env, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(targetDir, "store.enc"), snapshot.store, { flag: "wx", mode: 0o600 });
  return { directory: targetDir, accounts: data.accounts.length, history: data.history.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    let result;
    if (command === "create" && args.length === 3) result = await createBackup({ envFile: args[0]!, dataFile: args[1]!, backupDir: args[2]! });
    else if (command === "verify" && args.length === 1) result = await verifyBackup(args[0]!);
    else if (command === "restore" && args.length === 2) result = await restoreBackup(args[0]!, args[1]!);
    else throw new Error("Invalid arguments");
    console.log(JSON.stringify({ event: `backup_${command}_completed`, ...result }));
  } catch {
    console.error(JSON.stringify({ event: "backup_operation_failed", hint: "Check arguments, permissions, available disk space, and matching backup data/key. Existing restore directories are never overwritten." }));
    process.exitCode = 1;
  }
}
