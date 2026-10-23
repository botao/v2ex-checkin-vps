import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeEnv } from "../scripts/setup.mjs";

test("setup creates private random credentials and preserves existing keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-setup-"));
  try {
    assert.equal(await initializeEnv(dir), true);
    const file = path.join(dir, ".env");
    const original = await readFile(file, "utf8");
    const key = original.match(/^MASTER_KEY=(.+)$/m)?.[1];
    assert.equal(Buffer.from(key, "base64").length, 32);
    assert.match(original, /^ADMIN_PASSWORD=[A-Za-z0-9_-]{32}$/m);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await initializeEnv(dir), false);
    assert.equal(await readFile(file, "utf8"), original);
    const concurrent = await Promise.all([initializeEnv(dir), initializeEnv(dir)]);
    assert.deepEqual(concurrent, [false, false]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
