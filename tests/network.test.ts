import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext } from "playwright";
import { pageResult, isTransientNetworkError } from "../src/v2ex.js";

const account = { id: "test", username: "test", enabled: true, createdAt: "now", updatedAt: "now" };

test("only explicit connection errors and navigation timeouts are retryable", () => {
  for (const message of [
    "page.goto: net::ERR_CONNECTION_RESET at https://www.v2ex.com/mission/daily",
    "page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.v2ex.com/mission/daily",
    "page.goto: Timeout 45000ms exceeded.",
    "page.waitForNavigation: Timeout 30000ms exceeded."
  ]) assert.equal(isTransientNetworkError(new Error(message)), true, message);

  for (const error of [
    new Error("locator.click: Timeout 10000ms exceeded."),
    new Error("browserType.launch: Executable doesn't exist"),
    new Error("page.goto: net::ERR_CERT_AUTHORITY_INVALID"),
    new Error("Target page, context or browser has been closed"),
    new Error("Cookie 已失效"), new Error("Cloudflare challenge"), "timeout", null
  ]) assert.equal(isTransientNetworkError(error), false, String(error));
});

const ready = '<a href="/mission/daily/redeem?once=42">领取铜币</a>';
const cases = [
  { name: "server error", html: ["Service Unavailable"], http: 503, retryable: true, ok: false },
  { name: "server error cannot report a cached success", html: ["今日奖励已领取"], http: 502, retryable: true, ok: false },
  { name: "server error cannot follow a stale redeem link", html: [ready], http: 503, retryable: true, ok: false },
  { name: "challenge takes precedence over HTTP 503", html: ["Just a moment..."], http: 503, retryable: false, ok: false },
  { name: "authentication takes precedence over HTTP 503", html: ["You need to sign in"], http: 503, retryable: false, ok: false },
  { name: "rate limit is not automatically retried", html: ["Too many requests"], http: 429, retryable: false, ok: false, message: /请求过于频繁/ },
  { name: "rate limit overrides a stale success", html: ["今日奖励已领取"], http: 429, retryable: false, ok: false, message: /请求过于频繁/ },
  { name: "HTTP unauthorized", html: ["Unauthorized"], http: 401, retryable: false, ok: false, message: /重新登录.*浏览器会话/ },
  { name: "HTTP forbidden", html: ["Forbidden"], http: 403, retryable: false, ok: false, message: /403/ },
  { name: "other HTTP errors cannot report success", html: ["今日奖励已领取"], http: 404, retryable: false, ok: false, message: /404/ },
  { name: "unknown layout", html: ["New page layout"], http: 200, retryable: false, ok: false },
  { name: "already claimed", html: ["今日奖励已领取"], http: 200, retryable: false, ok: true },
  { name: "redeem succeeds", html: [ready, "已成功领取每日登录奖励"], http: 200, retryable: false, ok: true },
  { name: "redeem requires verification", html: [ready, "Verify you are human"], http: 200, retryable: false, ok: false },
  { name: "redeem loses authentication", html: [ready, "请先登录"], http: 200, retryable: false, ok: false },
  { name: "redeem confirms coins in text", html: [ready, "done"], text: "获得了 20 铜币", http: 200, retryable: false, ok: true },
  { name: "redeem is unconfirmed", html: [ready, "unknown"], http: 200, retryable: false, ok: false },
  { name: "initial browser settings rejection", html: ['你的浏览器有一些奇奇怪怪的设置，请用一个干净安装的浏览器重试一下吧'], http: 200, retryable: false, ok: false, message: /浏览器会话.*拒绝/ },
  { name: "redeem browser settings rejection", html: [ready, '你的浏览器有一些奇奇怪怪的设置，请用一个干净安装的浏览器重试一下吧'], http: 200, retryable: false, ok: false, message: /浏览器会话.*拒绝/ },
  { name: "browser rejection is not a transient server error", html: [ready, '你的浏览器有一些奇奇怪怪的设置'], http: 200, redeemHttp: 503, retryable: false, ok: false, message: /浏览器会话.*拒绝/ },
  { name: "redeem server error", html: [ready, "Service Unavailable"], http: 200, redeemHttp: 503, retryable: true, ok: false },
  { name: "redeem server error cannot report cached success", html: [ready, "已成功领取每日登录奖励"], http: 200, redeemHttp: 502, retryable: true, ok: false },
  { name: "redeem rate limit", html: [ready, "Too many requests"], http: 200, redeemHttp: 429, retryable: false, ok: false, message: /请求过于频繁/ },
  { name: "redeem challenge overrides server error", html: [ready, "Verify you are human"], http: 200, redeemHttp: 503, retryable: false, ok: false },
  { name: "redeem auth overrides server error", html: [ready, "请先登录"], http: 200, redeemHttp: 503, retryable: false, ok: false },
  { name: "redeem HTTP unauthorized", html: [ready, "Unauthorized"], http: 200, redeemHttp: 401, retryable: false, ok: false, message: /重新登录.*浏览器会话/ },
  { name: "redeem HTTP forbidden", html: [ready, "Forbidden"], http: 200, redeemHttp: 403, retryable: false, ok: false, message: /403/ },
  { name: "redeem other HTTP error", html: [ready, "已成功领取每日登录奖励"], http: 200, redeemHttp: 400, retryable: false, ok: false, message: /400/ },
  { name: "connection reset", html: [], http: 200, error: "page.goto: net::ERR_CONNECTION_RESET", retryable: true, ok: false },
  { name: "selector timeout", html: [], http: 200, error: "locator.click: Timeout 10000ms exceeded.", retryable: false, ok: false },
];

for (const item of cases) {
  test(`browser result classifies ${item.name}`, async t => {
    let pageClosed = false;
    let index = 0;
    const page = {
      close: async () => { pageClosed = true; },
      goto: async () => { if (item.error) throw new Error(item.error); return { status: () => item.http }; },
      content: async () => item.html[Math.min(index++, item.html.length - 1)],
      waitForTimeout: async () => {}, waitForNavigation: async () => ({ status: () => item.redeemHttp ?? 200 }),
      locator: () => ({ first: () => ({ click: async () => {} }), innerText: async () => item.text || "" })
    };
    const context = { newPage: async () => page } as unknown as BrowserContext;
    if (item.error) {
      await assert.rejects(pageResult(context, account), error => isTransientNetworkError(error) === item.retryable);
      assert.equal(pageClosed, true);
      return;
    }
    const result = await pageResult(context, account);
    assert.equal(result.ok, item.ok);
    assert.equal(Boolean(result.retryable), item.retryable);
    if (item.message) assert.match(result.message, item.message);
    assert.equal(pageClosed, true);
  });
}
