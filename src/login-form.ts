import type { Page } from "playwright";
import { z } from "zod";

export const loginCredentials = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
  captcha: z.string().trim().min(1).max(32).regex(/^[a-zA-Z0-9]+$/)
}).strict();
export const loginCode = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const formSubmission = z.object({ revision: z.uuid(), credentials: z.union([loginCredentials, loginCode]) }).strict();

export interface LoginFormView {
  stage: "credentials" | "otp" | "authenticated" | "blocked" | "unsupported";
  captcha?: string;
  message?: string;
}

const signin = (page: Page) => page.locator('form[action="/signin"]').first();
const otp = (page: Page) => page.locator('form').filter({ has: page.locator('input[name="code"], input[name="otp"], input[autocomplete="one-time-code"]') }).first();

export async function readLoginForm(page: Page): Promise<LoginFormView> {
  const url = new URL(page.url());
  if (url.protocol !== "https:" || !["www.v2ex.com", "v2ex.com"].includes(url.hostname)) return { stage: "unsupported", message: "登录页面地址异常，请重新连接" };
  const text = await page.locator("body").innerText();
  if (/Just a moment|cf-chl-|Verify you are human|Cloudflare Ray ID/i.test(text)) return { stage: "blocked", message: "V2EX 要求浏览器人机验证，普通表单暂时无法继续，请稍后重试" };
  if (await page.locator('#Top a[href^="/member/"]').count()) return { stage: "authenticated" };
  if (await otp(page).count()) return { stage: "otp", message: /验证码.*(?:错误|无效)|(?:incorrect|invalid).*(?:code|otp)/i.test(text) ? "动态验证码无效，请重新输入" : undefined };
  const form = signin(page);
  if (await form.locator('input[type="password"]').count() === 1 && await form.locator('input[type="text"]').count() === 2) {
    const image = form.locator('img[src*="/_captcha"]').first();
    if (!await image.count()) return { stage: "unsupported", message: "未找到验证码图片，V2EX 登录页面可能已变更" };
    const captcha = (await image.screenshot({ type: "png", timeout: 10_000 })).toString("base64");
    return { stage: "credentials", captcha, message: /用户名.*(?:错误|不正确)|密码.*(?:错误|不正确)|验证码.*(?:错误|不正确)|incorrect|invalid|problem/i.test(text) ? "登录未成功，请检查用户名、密码和验证码后重试" : undefined };
  }
  return { stage: "unsupported", message: "未识别到登录表单，请重新加载；已有会话未被覆盖" };
}

export async function submitLoginForm(page: Page, input: unknown): Promise<LoginFormView> {
  const credentials = z.union([loginCredentials, loginCode]).parse(input);
  const view = await readLoginForm(page);
  try {
    if ("code" in credentials) {
      if (view.stage !== "otp") return { stage: "unsupported", message: "两步验证页面已失效，请重新加载" };
      const form = otp(page);
      await form.locator('input[name="code"], input[name="otp"], input[autocomplete="one-time-code"]').first().fill(credentials.code, { timeout: 5_000 });
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }), form.locator('input[type="submit"], button[type="submit"]').first().click({ timeout: 5_000 })]);
    } else {
      if (view.stage !== "credentials") return view;
      const form = signin(page);
      await form.locator('input[type="text"]').nth(0).fill(credentials.username, { timeout: 5_000 });
      await form.locator('input[type="password"]').fill(credentials.password, { timeout: 5_000 });
      await form.locator('input[type="text"]').nth(1).fill(credentials.captcha, { timeout: 5_000 });
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }), form.locator('input[type="submit"], button[type="submit"]').first().click({ timeout: 5_000 })]);
    }
    return await readLoginForm(page);
  } catch {
    // Playwright errors may contain fill values. Never propagate them into responses or logs.
    throw new Error("登录请求未确认，请重新加载验证码后重试");
  } finally {
    await page.locator('input[type="password"], input[name="code"], input[name="otp"], input[autocomplete="one-time-code"]').evaluateAll(elements => {
      for (const element of elements) (element as HTMLInputElement).value = "";
    }).catch(() => undefined);
  }
}
