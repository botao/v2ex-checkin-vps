import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EncryptedStore } from "../src/store.js";
import { encryptJson, decryptJson } from "../src/security.js";

test("legacy configuration drops manual cookies while preserving sessions, history and jobs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-migration-"));
  const key = Buffer.alloc(32, 8).toString("base64");
  const account = { id: "one", username: "alice", enabled: true, createdAt: "before", updatedAt: "before" };
  const browserSession = { state: { cookies: [{ name: "A2", value: "saved-session" }], origins: [] }, savedAt: "before", viewport: { width: 1280, height: 900 } };
  const legacy = { accounts: [{ ...account, cookie: "A2=manual-secret", mode: "browser", browserSession }, { ...account, id: "two", username: "bob", enabled: false, cookie: "A2=other-secret", mode: "cookie" }], history: [{ message: "preserved" }], job: { state: "completed" } };
  const expected = { ...legacy, accounts: [{ ...account, browserSession }, { ...account, id: "two", username: "bob", enabled: false }] };
  try {
    const file = path.join(dir, "store.enc");
    await writeFile(file, encryptJson(legacy, key));
    const store = new EncryptedStore(dir, key);
    await store.init();
    assert.deepEqual(await store.read(), expected);
    const migrated = await readFile(file, "utf8");
    assert.deepEqual(decryptJson(migrated, key), expected);
    await store.init();
    assert.equal(await readFile(file, "utf8"), migrated, "migration is idempotent without unnecessary rewrites");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dashboard exposes only browser login configuration", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/app.js", "utf8");
  assert.doesNotMatch(html, /cookie|PB3_SESSION|name="mode"/i);
  assert.doesNotMatch(script, /COOKIE_TEMPLATE|elements\.cookie|elements\.mode/);
});
