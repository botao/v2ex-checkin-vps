import assert from "node:assert/strict";
import test from "node:test";
import { formatTime, formatRewardDate, summarizeAccounts } from "../public/dashboard.js";

const accounts = ["one", "two", "three", "disabled"].map(id => ({ id, username: id, enabled: id !== "disabled" }));
const record = (accountId, checkedAt, ok = true) => ({ accountId, checkedAt, rewardDate: checkedAt.slice(0, 10), ok, status: ok ? "already_checked_in" : "failed", message: "result" });

test("today counts unique enabled accounts rather than successful history rows", () => {
  const history = [
    record("one", "2026-10-23T11:00:00Z"), record("one", "2026-10-23T10:00:00Z"),
    record("disabled", "2026-10-23T11:00:00Z"), record("deleted", "2026-10-23T11:00:00Z"),
    record("two", "2026-10-22T10:00:00Z"), record("three", "2026-10-23T10:00:00Z", false)
  ];
  const summary = summarizeAccounts(accounts, history, "Asia/Hong_Kong", new Date("2026-10-23T12:00:00Z"));
  assert.equal(summary.enabled, 3);
  assert.equal(summary.completed, 1);
  assert.equal(summary.attention, 1);
  assert.deepEqual(summary.accounts.map(a => a.dailyState), ["complete", "pending", "attention", "disabled"]);
});

test("date boundaries follow the configured timezone and latest result follows timestamp order", () => {
  const history = [record("one", "2026-10-23T15:00:00Z", false), { ...record("one", "2026-10-23T16:30:00Z"), rewardDate: "2026-10-24" }];
  const now = new Date("2026-10-23T17:00:00Z");
  const hongKong = summarizeAccounts(accounts, history, "Asia/Hong_Kong", now);
  const newYork = summarizeAccounts(accounts, history, "America/New_York", now);
  assert.equal(hongKong.completed, 1);
  assert.equal(hongKong.attention, 0);
  assert.equal(hongKong.accounts[0].latestResult.checkedAt, "2026-10-23T16:30:00Z");
  assert.equal(newYork.completed, 0);
  const yesterdayOnly = summarizeAccounts(accounts, [history[0]], "Asia/Hong_Kong", now);
  assert.equal(yesterdayOnly.completed, 0);
  assert.equal(yesterdayOnly.attention, 1);
  assert.equal(summarizeAccounts(accounts, [record("one", "2026-10-23T15:00:00Z")], "America/New_York", now).completed, 1);
  assert.equal(summarizeAccounts(accounts, [record("one", "2026-10-23T15:00:00Z")], "Asia/Hong_Kong", now).completed, 0);
});

test("a later failure still needs attention even after a reward was claimed today", () => {
  const summary = summarizeAccounts(accounts, [record("one", "2026-10-23T10:00:00Z"), record("one", "2026-10-23T11:00:00Z", false)], "UTC", new Date("2026-10-23T12:00:00Z"));
  assert.equal(summary.completed, 1);
  assert.equal(summary.attention, 1);
  assert.equal(summary.accounts[0].dailyState, "attention");
});

test("empty and invalid records do not break the dashboard", () => {
  assert.equal(summarizeAccounts([], [], "UTC").completed, 0);
  const summary = summarizeAccounts(accounts, [record("one", "not-a-date")], "UTC");
  assert.equal(summary.completed, 0);
  assert.equal(summary.accounts[0].dailyState, "pending");
  assert.equal(formatTime(null, "UTC"), "暂无");
  assert.equal(formatTime("invalid", "UTC"), "暂无");
  assert.notEqual(formatTime("2026-10-23T12:00:00Z", "UTC"), formatTime("2026-10-23T12:00:00Z", "Asia/Hong_Kong"));
});

test("previous reward day cannot count as today's completion after local midnight", () => {
  const history = [{ ...record("one", "2026-10-23T17:00:00Z"), rewardDate: "2026-10-23" }];
  const summary = summarizeAccounts(accounts, history, "Asia/Hong_Kong", new Date("2026-10-24T00:40:00Z"));
  assert.equal(summary.completed, 0);
  assert.equal(summary.accounts[0].dailyState, "pending");
});

test("actual reward date counts independently from execution date; legacy dates stay unknown", () => {
  const history = [
    { ...record("one", "2026-10-23T15:00:00Z"), rewardDate: "2026-10-24" },
    { ...record("two", "2026-10-24T00:20:00Z"), rewardDate: undefined },
    { ...record("three", "2026-10-24T00:20:00Z"), rewardDate: "invalid" }
  ];
  const summary = summarizeAccounts(accounts, history, "Asia/Hong_Kong", new Date("2026-10-24T00:40:00Z"));
  assert.equal(summary.completed, 1);
  assert.deepEqual(summary.accounts.map(a => a.todayComplete), [true, false, false, false]);
});

test("reward date labels validate dates and never turn missing dates into today", () => {
  assert.equal(formatRewardDate("2026-10-24"), "2026-10-24");
  for (const value of [undefined, null, "", "2026-02-30", "20261024", "<script>", "2026-13-01"]) assert.equal(formatRewardDate(value), "未记录");
});
