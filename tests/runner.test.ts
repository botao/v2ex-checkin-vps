import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EncryptedStore } from "../src/store.js";
import { CheckinRunner } from "../src/runner.js";
import type { Account, CheckinResult } from "../src/types.js";

const accounts: Account[] = ["one", "two"].map(id => ({ id, username: id, enabled: true, createdAt: "now", updatedAt: "now" }));
const success = (account: Account): CheckinResult => ({ accountId: account.id, username: account.username, ok: true, status: "already_checked_in", message: "already claimed", checkedAt: new Date().toISOString() });

test("runner rejects overlapping jobs and saves each account before starting the next", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-runner-"));
  const store = new EncryptedStore(dir, Buffer.alloc(32, 8).toString("base64"));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const secondAccount = new Promise<void>(resolve => { entered = resolve; });
  const runner = new CheckinRunner(store, async account => {
    if (account.id === "two") { entered(); await gate; }
    return success(account);
  });
  try {
    await store.init();
    await store.update(data => ({ ...data, accounts }));
    await runner.init();
    const job = await runner.start();
    assert.equal(job.state, "running");
    await secondAccount;
    await assert.rejects(runner.start("one"), /已有签到任务执行中/);
    const midway = await store.read();
    assert.equal(midway.history.length, 1);
    assert.equal(midway.job?.completed, 1);
    assert.equal(runner.status()?.currentUsername, "two");
    release();
    await runner.wait();
    assert.equal(runner.status()?.state, "completed");
    assert.equal(runner.status()?.succeeded, 2);
    assert.equal((await store.read()).history.length, 2);
    assert.equal(JSON.stringify(runner.status()).includes("test-cookie"), false);
  } finally { release(); await runner.wait(); await rm(dir, { recursive: true, force: true }); }
});

test("an unexpected account error does not stop the next account or future runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-runner-error-"));
  try {
    const store = new EncryptedStore(dir, Buffer.alloc(32, 8).toString("base64"));
    await store.init();
    await store.update(data => ({ ...data, accounts }));
    const runner = new CheckinRunner(store, async account => {
      if (account.id === "one") throw new Error("sensitive upstream details");
      return success(account);
    });
    await runner.init();
    await runner.start();
    await runner.wait();
    assert.equal(runner.status()?.failed, 1);
    assert.equal(runner.status()?.succeeded, 1);
    assert.equal((await store.read()).history.some(result => result.message.includes("sensitive")), false);
    await runner.start("two");
    await runner.wait();
    assert.equal(runner.status()?.succeeded, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("restart marks unfinished jobs interrupted and empty runs are rejected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-runner-restart-"));
  try {
    const store = new EncryptedStore(dir, Buffer.alloc(32, 8).toString("base64"));
    await store.init();
    await store.update(data => ({ ...data, job: {
      id: "unfinished", state: "running", source: "scheduled", total: 2, completed: 1,
      succeeded: 1, failed: 0, currentUsername: "two", startedAt: new Date().toISOString()
    } }));
    const runner = new CheckinRunner(store, async account => success(account));
    await runner.init();
    assert.equal((await store.read()).job?.state, "interrupted");
    assert.equal(runner.status()?.completed, 1);
    await assert.rejects(runner.start(), /没有已启用的账号/);
    await assert.rejects(runner.start("missing"), /账号不存在/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("wait includes a job still loading accounts and persisting its initial state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-runner-start-"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = new EncryptedStore(dir, Buffer.alloc(32, 8).toString("base64"));
  const runner = new CheckinRunner(store, async account => { await gate; return success(account); });
  try {
    await store.init();
    await store.update(data => ({ ...data, accounts: [accounts[0]!] }));
    await runner.init();
    const starting = runner.start();
    let finished = false;
    const waiting = runner.wait().then(() => { finished = true; });
    await starting;
    await Promise.resolve();
    assert.equal(finished, false, "shutdown must not overlook a starting job");
    release();
    await waiting;
    assert.equal((await store.read()).job?.state, "completed");
  } finally { release(); await runner.wait(); await rm(dir, { recursive: true, force: true }); }
});

test("scheduled jobs retry a transient failure once and persist both attempts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-runner-retry-"));
  try {
    const store = new EncryptedStore(dir, Buffer.alloc(32, 8).toString("base64"));
    await store.init();
    await store.update(data => ({ ...data, accounts: [accounts[0]!] }));
    let calls = 0;
    let delays = 0;
    const runner = new CheckinRunner(store, async account => {
      calls++;
      return calls === 1 ? { ...success(account), ok: false, status: "failed", retryable: true, message: "network timeout" } : success(account);
    }, async () => {
      delays++;
      assert.equal((await store.read()).history.length, 1, "the first failure must be saved before waiting");
      assert.match(runner.status()?.message || "", /重试/);
    });
    await runner.init();
    await runner.start(undefined, "scheduled");
    await runner.wait();
    assert.equal(calls, 2);
    assert.equal(delays, 1);
    assert.equal(runner.status()?.succeeded, 1);
    assert.equal(runner.status()?.failed, 0);
    assert.equal(runner.status()?.completed, 1);
    assert.equal(runner.status()?.message, undefined);
    const history = (await store.read()).history;
    assert.equal(history.length, 2);
    assert.equal(history[0]?.attempts, 2);
    assert.equal(history[1]?.attempts, 1);
    assert.equal(history[0]?.ok, true);
    assert.match(history[0]?.message || "", /重试成功/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("retries are bounded and do not apply to manual, authentication or challenge failures", async () => {
  const cases = [
    { source: "scheduled" as const, retryable: true, expected: 2 },
    { source: "manual" as const, retryable: true, expected: 1 },
    { source: "scheduled" as const, retryable: false, expected: 1 },
    { source: "scheduled" as const, retryable: undefined, expected: 1 }
  ];
  for (const item of cases) {
    const dir = await mkdtemp(path.join(tmpdir(), "v2ex-runner-bounded-"));
    try {
      const store = new EncryptedStore(dir, Buffer.alloc(32, 8).toString("base64"));
      await store.init();
      await store.update(data => ({ ...data, accounts: [accounts[0]!] }));
      let calls = 0;
      const runner = new CheckinRunner(store, async account => {
        calls++;
        return { ...success(account), ok: false, status: "failed", retryable: item.retryable };
      }, async () => {});
      await runner.init();
      await runner.start(undefined, item.source);
      await runner.wait();
      assert.equal(calls, item.expected);
      assert.equal(runner.status()?.failed, 1);
      assert.equal(runner.status()?.completed, 1);
      assert.equal((await store.read()).history[0]?.attempts, item.expected);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
