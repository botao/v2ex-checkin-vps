import assert from "node:assert/strict";
import test from "node:test";
import { createShutdown } from "../src/shutdown.js";

test("shutdown stops scheduling and drains HTTP before waiting for persisted jobs", async () => {
  const events: string[] = [];
  const shutdown = createShutdown({
    stopSchedule: async () => { events.push("schedule"); },
    closeServer: async () => { events.push("http"); },
    waitForJob: async () => { events.push("job"); },
    finish: code => { events.push(`exit:${code}`); },
    timeoutMs: 1000
  });
  await Promise.all([shutdown(), shutdown()]);
  assert.deepEqual(events, ["schedule", "http", "job", "exit:0"]);
});

test("shutdown waits for the running job and exits only once", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const exits: number[] = [];
  const shutdown = createShutdown({
    stopSchedule: async () => {}, closeServer: async () => {},
    waitForJob: () => gate, finish: code => { exits.push(code); }, timeoutMs: 1000
  });
  const pending = shutdown();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, []);
  release();
  await pending;
  assert.deepEqual(exits, [0]);
});

test("shutdown times out instead of hanging forever", async () => {
  const exits: number[] = [];
  const shutdown = createShutdown({
    stopSchedule: async () => {}, closeServer: () => new Promise<void>(() => {}),
    waitForJob: async () => { assert.fail("HTTP drain has not finished"); },
    finish: code => { exits.push(code); }, timeoutMs: 10
  });
  await shutdown();
  assert.deepEqual(exits, [1]);
});

test("shutdown reports failure without exposing underlying error details", async () => {
  const exits: number[] = [];
  const shutdown = createShutdown({
    stopSchedule: async () => { throw new Error("sensitive detail"); },
    closeServer: async () => {}, waitForJob: async () => {},
    finish: code => { exits.push(code); }, timeoutMs: 1000
  });
  await shutdown();
  assert.deepEqual(exits, [1]);
});
