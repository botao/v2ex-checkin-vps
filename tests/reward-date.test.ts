import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext } from "playwright";
import { pageResult } from "../src/v2ex.js";

const account = { id: "one", username: "alice", enabled: true, createdAt: "before", updatedAt: "before" };

for (const scenario of [
  { name: "already claimed previous day", main: "每日登录奖励 20261023", claimed: true, expected: "2026-10-23" },
  { name: "successful redemption preserves original mission date", main: "每日登录奖励 20261024", claimed: false, expected: "2026-10-24" },
  { name: "mission key", main: "v2ex:member:123:20261024", claimed: true, expected: "2026-10-24" },
  { name: "invalid calendar date", main: "每日登录奖励 20260230", claimed: true, expected: undefined },
  { name: "missing date is never inferred from execution time", main: "已连续登录 3 天", claimed: true, expected: undefined },
  { name: "unrelated date is ignored", main: "主题发布时间 20261024", claimed: true, expected: undefined },
  { name: "conflicting mission dates are not trusted", main: "每日登录奖励 20261023 v2ex:member:123:20261024", claimed: true, expected: undefined }
]) {
  test(`reward date: ${scenario.name}`, async () => {
    let redeemed = false;
    const page = {
      goto: async () => ({ status: () => 200 }),
      waitForTimeout: async () => {},
      waitForNavigation: async () => ({ status: () => 200 }),
      close: async () => {},
      content: async () => scenario.claimed || redeemed ? "今日奖励已领取" : '<input onclick="location.href=\'/mission/daily/redeem?once=42\'" value="领取铜币">',
      locator: (selector: string) => ({
        innerText: async () => selector === "#Main" && !redeemed ? scenario.main : "已成功领取每日登录奖励",
        first: () => ({ click: async () => { redeemed = true; } })
      })
    };
    const result = await pageResult({ newPage: async () => page } as unknown as BrowserContext, account);
    assert.equal(result.ok, true);
    assert.equal((result as typeof result & { rewardDate?: string }).rewardDate, scenario.expected);
    assert.equal(result.status, scenario.claimed ? "already_checked_in" : "checked_in");
  });
}
