import type { BrowserContext } from "playwright";
import type { Account, CheckinResult, CheckinStatus } from "./types.js";

const MISSION_URL = "https://www.v2ex.com/mission/daily";

export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^page\.(?:goto|waitForNavigation): Timeout \d+ms exceeded\./.test(error.message)
    || /net::ERR_(?:CONNECTION_(?:RESET|CLOSED|REFUSED|TIMED_OUT)|NETWORK_CHANGED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|TIMED_OUT|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR)\b/.test(error.message);
}

export function classifyMission(html: string): CheckinStatus | "ready" | "auth_required" | "challenge" | "browser_rejected" | "unknown" {
  if (/Just a moment|cf-chl-|Cloudflare Ray ID|Verify you are human/i.test(html)) return "challenge";
  if (/V2EX\s*(?:›|&gt;)\s*Sign In|You need to sign in|请先登录/i.test(html)) return "auth_required";
  if (/你的浏览器有一些奇奇怪怪的设置|请用一个干净安装的浏览器重试/.test(html)) return "browser_rejected";
  if (/已成功领取每日登录奖励|每日登录奖励已领取|今日登录奖励已领取|今日奖励(?:已经|已)领取|查看我的账户余额|daily login reward (?:has been )?claimed/i.test(html)) return "already_checked_in";
  if (/\/mission\/daily\/redeem\?once=|value=["'][^"']*领取[^"']*铜币/i.test(html)) return "ready";
  return "unknown";
}

function httpFailure(account: Account, status: number | undefined): CheckinResult | null {
  if (status === 401) return result(account, false, "failed", "V2EX 未接受当前登录状态（HTTP 401），请重新登录并保存浏览器会话");
  if (status === 403) return result(account, false, "failed", "V2EX 拒绝访问（HTTP 403），请检查 VPS 网络出口或浏览器验证");
  if (status === 429) return result(account, false, "failed", "V2EX 请求过于频繁（HTTP 429），请稍后手动重试，不自动重试");
  if (status && status >= 500 && status < 600) return result(account, false, "failed", `V2EX 服务暂时不可用（HTTP ${status}），请稍后重试`, true);
  if (status && status >= 400) return result(account, false, "failed", `V2EX 返回异常响应（HTTP ${status}），未确认签到成功`);
  return null;
}

export async function pageResult(context: BrowserContext, account: Account): Promise<CheckinResult> {
  const page = await context.newPage();
  try {
  const response = await page.goto(MISSION_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_200);
  let state = classifyMission(await page.content());

  if (state === "challenge") return result(account, false, "failed", "V2EX 要求完成浏览器验证，请在 VPS 检查网络出口");
  if (state === "auth_required") return result(account, false, "failed", "浏览器会话已失效，请重新登录并保存浏览器会话");
  if (state === "browser_rejected") return result(account, false, "failed", "V2EX 浏览器会话被拒绝：网站要求使用干净安装的浏览器，请手动检查该账号，不自动重试");
  const initialFailure = httpFailure(account, response?.status());
  if (initialFailure) return initialFailure;
  if (state === "already_checked_in") return result(account, true, state, "今日奖励已领取，无需重复签到");
  if (state !== "ready") {
    return result(account, false, "failed", "未找到签到入口，V2EX 页面可能已变更");
  }

  const redeem = page.locator('a[href*="/mission/daily/redeem?once="], input[onclick*="/mission/daily/redeem?once="]').first();
  const [redeemResponse] = await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    redeem.click({ timeout: 10_000 })
  ]);
  await page.waitForTimeout(800);
  state = classifyMission(await page.content());
  if (state === "challenge") return result(account, false, "failed", "V2EX 要求完成浏览器验证，请检查 VPS 网络出口后再试");
  if (state === "auth_required") return result(account, false, "failed", "V2EX 未接受当前登录状态，请重新登录并保存浏览器会话");
  if (state === "browser_rejected") return result(account, false, "failed", "V2EX 浏览器会话被拒绝：网站要求使用干净安装的浏览器，请手动检查该账号，不自动重试");
  const redeemFailure = httpFailure(account, redeemResponse?.status());
  if (redeemFailure) return redeemFailure;
  const text = await page.locator("body").innerText().catch(() => "");
  if (state === "already_checked_in" || /已成功领取每日登录奖励|获得了?\s*\d+\s*铜币/i.test(text)) {
    return result(account, true, "checked_in", "签到成功，今日奖励已领取");
  }
  return result(account, false, "failed", "V2EX 未确认签到成功，请稍后重试");
  } finally { await page.close(); }
}

function result(account: Account, ok: boolean, status: CheckinStatus, message: string, retryable = false): CheckinResult {
  return { accountId: account.id, username: account.username, ok, status, message, checkedAt: new Date().toISOString(), ...(retryable ? { retryable: true } : {}) };
}
