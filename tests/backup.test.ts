import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBackup, restoreBackup, verifyBackup } from "../src/backup.js";
import { encryptJson } from "../src/security.js";
import { EncryptedStore } from "../src/store.js";

const key = Buffer.alloc(32, 10).toString("base64");
const data = { accounts: [{ id: "one", username: "one", cookie: "A2=private", enabled: true }], history: [] };

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-backup-"));
  const envFile = path.join(dir, ".env");
  const dataFile = path.join(dir, "store.enc");
  const backupDir = path.join(dir, "backups");
  await writeFile(envFile, `ADMIN_PASSWORD=private-password\nMASTER_KEY=${key}\n`, { mode: 0o600 });
  await writeFile(dataFile, encryptJson(data, key), { mode: 0o600 });
  return { dir, envFile, dataFile, backupDir };
}

test("backup keeps matching configuration and encrypted data private and can be restored", async () => {
  const f = await fixture();
  try {
    const result = await createBackup(f);
    assert.equal(result.accounts, 1);
    assert.equal(JSON.stringify(result).includes("private-password"), false);
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.equal((await stat(f.backupDir)).mode & 0o777, 0o700);
    assert.equal((await stat(result.file)).mode & 0o777, 0o600);
    assert.equal((await readFile(result.file, "utf8")).includes("A2=private"), false);
    assert.equal((await verifyBackup(result.file)).accounts, 1);
    const restored = path.join(f.dir, "restored");
    await restoreBackup(result.file, restored);
    assert.deepEqual(await new EncryptedStore(restored, key).read(), data);
    assert.equal(await readFile(path.join(restored, ".env"), "utf8"), await readFile(f.envFile, "utf8"));
    assert.equal((await stat(path.join(restored, ".env"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(restored, "store.enc"))).mode & 0o777, 0o600);
    await assert.rejects(restoreBackup(result.file, restored));
    assert.deepEqual(await new EncryptedStore(restored, key).read(), data);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("retention removes only owned backup files after a new backup succeeds", async () => {
  const f = await fixture();
  try {
    const first = await createBackup({ ...f, keep: 2 });
    await writeFile(path.join(f.backupDir, "unrelated.backup"), "preserve me");
    await new Promise(resolve => setTimeout(resolve, 5));
    await createBackup({ ...f, keep: 2 });
    await new Promise(resolve => setTimeout(resolve, 5));
    await createBackup({ ...f, keep: 2 });
    const names = await readdir(f.backupDir);
    assert.equal(names.filter(name => name.startsWith("v2ex-backup-")).length, 2);
    assert.ok(names.includes("unrelated.backup"));
    await assert.rejects(readFile(first.file));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("invalid snapshots and mismatched keys never prune existing backups", async () => {
  const f = await fixture();
  try {
    const original = await createBackup(f);
    await writeFile(f.dataFile, "corrupted encrypted store");
    await assert.rejects(createBackup({ ...f, keep: 1 }));
    assert.deepEqual(await readdir(f.backupDir), [path.basename(original.file)]);
    await writeFile(f.dataFile, encryptJson(data, Buffer.alloc(32, 11).toString("base64")));
    await assert.rejects(createBackup(f));
    assert.equal((await verifyBackup(original.file)).accounts, 1);
    const bundle = JSON.parse(await readFile(original.file, "utf8"));
    bundle.store = "corrupt";
    const damaged = path.join(f.dir, "damaged.backup");
    await writeFile(damaged, JSON.stringify(bundle));
    await assert.rejects(verifyBackup(damaged));
    const restoreDir = path.join(f.dir, "invalid-restore");
    await assert.rejects(restoreBackup(damaged, restoreDir));
    await assert.rejects(stat(restoreDir));
    await assert.rejects(createBackup({ ...f, keep: 0 }));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("backup rejects symlink destinations and invalid configuration", async () => {
  const f = await fixture();
  try {
    await symlink(f.dir, f.backupDir, "dir");
    await assert.rejects(createBackup(f), /symlink/);
    await rm(f.backupDir);
    await writeFile(f.envFile, "MASTER_KEY=invalid-key\n");
    await assert.rejects(createBackup(f), /Invalid backup key/);
    await writeFile(f.envFile, `MASTER_KEY=${key}\n`);
    await writeFile(f.dataFile, encryptJson({ accounts: "invalid", history: [] }, key));
    await assert.rejects(createBackup(f), /Invalid backup data/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("backup CLI reports only safe metadata and does not overwrite restore targets", async () => {
  const f = await fixture();
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/backup.ts", ...args], { encoding: "utf8" });
  try {
    const created = cli("create", f.envFile, f.dataFile, f.backupDir);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.stdout.includes("private-password"), false);
    assert.equal(created.stdout.includes(key), false);
    const file = JSON.parse(created.stdout).file;
    assert.equal(cli("verify", file).status, 0);
    const restoreDir = path.join(f.dir, "cli-restore");
    assert.equal(cli("restore", file, restoreDir).status, 0);
    const rejected = cli("restore", file, restoreDir);
    assert.equal(rejected.status, 1);
    assert.equal(cli("unknown").status, 1);
    assert.equal(rejected.stderr.includes("private-password"), false);
    assert.equal(rejected.stderr.includes(key), false);
    await writeFile(file, '{"version":2}');
    assert.equal(cli("verify", file).status, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
