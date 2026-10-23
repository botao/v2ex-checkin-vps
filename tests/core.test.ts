import assert from "node:assert/strict";
import test from "node:test";
import { decryptJson, encryptJson, secureEqual } from "../src/security.js";
import { classifyMission } from "../src/v2ex.js";
import { EncryptedStore } from "../src/store.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("encrypts and decrypts stored credentials", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptJson({ cookie: "A2=secret" }, key);
  assert.equal(encrypted.includes("secret"), false);
  assert.deepEqual(decryptJson(encrypted, key), { cookie: "A2=secret" });
});

test("uses timing-safe equality", () => {
  assert.equal(secureEqual("same", "same"), true);
  assert.equal(secureEqual("same", "different"), false);
});

test("classifies V2EX mission states", () => {
  assert.equal(classifyMission('<input value="查看我的账户余额">'), "already_checked_in");
  assert.equal(classifyMission('<input value="领取 X 铜币" onclick="location.href = \'/mission/daily/redeem?once=42\';">'), "ready");
  assert.equal(classifyMission("V2EX › Sign In You need to sign in"), "auth_required");
  assert.equal(classifyMission("Just a moment... Cloudflare Ray ID"), "challenge");
  assert.equal(classifyMission('已连续登录 2 天 <input value="领取 X 铜币">'), "ready");
  assert.equal(classifyMission('<a href="/balance">账户余额</a>'), "unknown");
  assert.equal(classifyMission('你的浏览器有一些奇奇怪怪的设置，请用一个干净安装的浏览器重试一下吧'), "browser_rejected");
  assert.equal(classifyMission('你的浏览器有一些奇奇怪怪的设置 <input value="查看我的账户余额">'), "browser_rejected");
});

test("store recovers after a rejected update and serializes concurrent writes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-store-test-"));
  try {
    const store = new EncryptedStore(dir, Buffer.alloc(32, 7).toString("base64"));
    await store.init();
    await assert.rejects(store.update(() => { throw new Error("invalid edit"); }), /invalid edit/);
    await Promise.all(Array.from({ length: 5 }, (_, i) => store.addHistory([{
      accountId: String(i), username: "test-user", ok: true, status: "already_checked_in",
      message: "already claimed", checkedAt: new Date().toISOString()
    }])));
    assert.equal((await store.read()).history.length, 5);
    assert.equal((await readFile(path.join(dir, "store.enc"), "utf8")).includes("test-user"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
