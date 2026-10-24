import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const valid = { ADMIN_PASSWORD: "valid-test-password", MASTER_KEY: Buffer.alloc(32, 1).toString("base64") };

test("config validates schedules, timezones and canonical encryption keys before startup", () => {
  assert.equal(loadConfig(valid).CHECKIN_CRON, "10 8 * * *");
  assert.equal(loadConfig({ ...valid, CHECKIN_CRON: "30 8 * * *", TZ: "Asia/Shanghai" }).TZ, "Asia/Shanghai");
  assert.throws(() => loadConfig({ ...valid, TZ: "invalid/timezone" }));
  assert.throws(() => loadConfig({ ...valid, CHECKIN_CRON: "99 9 * * *" }));
  assert.throws(() => loadConfig({ ...valid, CHECKIN_CRON: "* * * * * *" }));
  assert.throws(() => loadConfig({ ...valid, MASTER_KEY: `${valid.MASTER_KEY}junk` }));
});
