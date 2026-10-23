import { chromium, type BrowserContext, type Page } from "playwright";
import { z } from "zod";
import type { EncryptedStore } from "./store.js";
import type { Account, BrowserSession } from "./types.js";
import { randomUUID } from "node:crypto";
import { readLoginForm, submitLoginForm, formSubmission, type LoginFormView } from "./login-form.js";

export class BrowserSessionError extends Error {}
const fail = (message: string): never => { throw new BrowserSessionError(message); };
const viewports = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 740 } };

export const browserAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().int().min(0).max(1279), y: z.number().int().min(0).max(799) }).strict(),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(2048) }).strict(),
  z.object({ type: z.literal("key"), key: z.enum(["Tab", "Shift+Tab", "Enter", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "ControlOrMeta+A", "Escape"]) }).strict(),
  z.object({ type: z.literal("scroll"), delta: z.number().int().min(-740).max(740) }).strict(),
  z.object({ type: z.enum(["signin", "daily"]) }).strict()
]);

export function allowedBrowserRequest(value: string, navigation: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    if (navigation) return url.hostname === "www.v2ex.com" || url.hostname === "v2ex.com";
    return url.hostname === "v2ex.com" || url.hostname.endsWith(".v2ex.com") || url.hostname === "challenges.cloudflare.com";
  } catch { return false; }
}

async function launchContext(saved: BrowserSession | undefined, viewport: BrowserSession["viewport"]): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: false, timeout: 30_000, handleSIGINT: false, handleSIGTERM: false });
  try {
    const context = await browser.newContext({ storageState: saved?.state, viewport, locale: "zh-CN", timezoneId: "Asia/Hong_Kong", acceptDownloads: false, serviceWorkers: "block" });
    await context.route("**/*", route => {
      const request = route.request();
      // Only top-level documents may visit V2EX. Challenge subframes are confined to their provider.
      const topLevel = request.isNavigationRequest() && request.frame().parentFrame() === null;
      return allowedBrowserRequest(request.url(), topLevel) ? route.continue() : route.abort();
    });
    await context.routeWebSocket(/.*/, socket => socket.close());
    context.on("page", page => { page.on("dialog", dialog => { void dialog.dismiss(); }); });
    context.on("close", () => { void browser.close().catch(() => undefined); });
    return context;
  } catch (error) { await browser.close(); throw error; }
}

interface Slot {
  accountId: string;
  context: BrowserContext;
  viewport: BrowserSession["viewport"];
  page?: Page;
  owner?: string;
  openedAt: number;
  formRevision?: string;
}

// One live context bounds memory and keeps interactive login mutually exclusive with check-in.
export class BrowserSessions {
  private slot?: Slot;
  private busy = false;
  private timer?: NodeJS.Timeout;
  private readonly idleMs: number;
  private readonly createContext: typeof launchContext;

  constructor(private readonly store: EncryptedStore, options: { idleMs?: number; createContext?: typeof launchContext } = {}) {
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.createContext = options.createContext ?? launchContext;
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) fail("浏览器正在操作，请稍后重试");
    this.busy = true;
    clearTimeout(this.timer);
    try { return await work(); }
    finally { this.busy = false; this.arm(); }
  }

  private arm(): void {
    clearTimeout(this.timer);
    if (!this.slot) return;
    const remaining = this.slot.owner ? Math.min(this.idleMs, 20 * 60_000 - (Date.now() - this.slot.openedAt)) : this.idleMs;
    this.timer = setTimeout(() => { void this.close().catch(() => undefined); }, Math.max(1, remaining));
    this.timer.unref();
  }

  private async account(id: string): Promise<Account> {
    return (await this.store.read()).accounts.find(a => a.id === id) ?? fail("账号不存在");
  }

  private async ensure(account: Account, viewport: BrowserSession["viewport"]): Promise<Slot> {
    if (this.slot?.accountId === account.id) return this.slot;
    await this.dispose();
    const context = await this.createContext(account.browserSession, viewport);
    return this.slot = { accountId: account.id, context, viewport, openedAt: Date.now() };
  }

  private interactive(id: string, owner: string): Slot & { page: Page } {
    if (!this.slot || this.slot.accountId !== id || this.slot.owner !== owner || !this.slot.page) fail("浏览器登录窗口已关闭或由其他会话占用");
    return this.slot as Slot & { page: Page };
  }

  async start(id: string, owner: string, size: keyof typeof viewports): Promise<void> {
    return this.exclusive(async () => {
      if (this.slot?.owner) {
        this.interactive(id, owner);
        return;
      }
      const account = await this.account(id);
      const slot = await this.ensure(account, account.browserSession?.viewport ?? viewports[size]);
      slot.owner = owner;
      slot.openedAt = Date.now();
      try {
        slot.page = await slot.context.newPage();
        await slot.page.goto("https://www.v2ex.com/signin", { waitUntil: "domcontentloaded", timeout: 45_000 });
      } catch (error) { await this.dispose(); throw error; }
    });
  }

  async frame(id: string, owner: string): Promise<{ image: string; width: number; height: number }> {
    // Polling must not keep an abandoned login alive.
    if (this.busy) fail("浏览器正在操作，请稍后重试");
    const slot = this.interactive(id, owner);
    const image = await slot.page.screenshot({ type: "jpeg", quality: 75, timeout: 10_000 });
    return { image: image.toString("base64"), ...slot.viewport };
  }

  async action(id: string, owner: string, input: unknown): Promise<void> {
    const action = browserAction.parse(input);
    return this.exclusive(async () => {
      const { page, viewport } = this.interactive(id, owner);
      if (action.type === "click") {
        if (action.x >= viewport.width || action.y >= viewport.height) fail("点击位置无效");
        await page.mouse.click(action.x, action.y);
      } else if (action.type === "text") await page.keyboard.insertText(action.text);
      else if (action.type === "key") await page.keyboard.press(action.key);
      else if (action.type === "scroll") await page.mouse.wheel(0, action.delta);
      else await page.goto(`https://www.v2ex.com/${action.type === "signin" ? "signin" : "mission/daily"}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    });
  }

  private async verify(slot: Slot, account: Account): Promise<void> {
    const page = await slot.context.newPage();
    try {
      const response = await page.goto("https://www.v2ex.com/mission/daily", { waitUntil: "domcontentloaded", timeout: 45_000 });
      const member = await page.locator('#Top a[href^="/member/"]').first().getAttribute("href", { timeout: 5_000 }).catch(() => null);
      const cookies = await slot.context.cookies("https://www.v2ex.com");
      if (response?.status() !== 200 || member?.toLowerCase() !== `/member/${account.username.toLowerCase()}` || !cookies.some(c => c.name === "A2")) {
        fail("登录未确认或用户名不匹配，请确认已登录指定 V2EX 账号");
      }
    } finally { await page.close(); }
  }

  private async persist(slot: Slot): Promise<void> {
    const browserSession: BrowserSession = { state: await slot.context.storageState({ indexedDB: true }), viewport: slot.viewport, savedAt: new Date().toISOString() };
    await this.store.update(data => ({ ...data, accounts: data.accounts.map(a => a.id === slot.accountId ? { ...a, browserSession } : a) }));
  }

  async save(id: string, owner: string): Promise<void> {
    return this.exclusive(async () => {
      const slot: Slot = this.interactive(id, owner);
      await this.verify(slot, await this.account(id));
      await this.persist(slot);
      await slot.page!.close();
      slot.page = undefined;
      slot.owner = undefined;
    });
  }

  private async finishForm(slot: Slot, view: LoginFormView): Promise<LoginFormView & { revision: string }> {
    if (view.stage === "authenticated") {
      await this.verify(slot, await this.account(slot.accountId));
      await this.persist(slot);
      await slot.page!.close();
      slot.page = undefined;
      slot.owner = undefined;
    }
    slot.formRevision = randomUUID();
    return { ...view, revision: slot.formRevision };
  }

  async form(id: string, owner: string, refresh = false): Promise<LoginFormView & { revision: string }> {
    return this.exclusive(async () => {
      const slot = this.interactive(id, owner);
      if (refresh) await slot.page.goto("https://www.v2ex.com/signin", { waitUntil: "domcontentloaded", timeout: 45_000 });
      return this.finishForm(slot, await readLoginForm(slot.page));
    });
  }

  async submitForm(id: string, owner: string, input: unknown): Promise<LoginFormView & { revision: string }> {
    const submission = formSubmission.parse(input);
    return this.exclusive(async () => {
      const slot = this.interactive(id, owner);
      if (submission.revision !== slot.formRevision) fail("验证码已更新，请重新加载后提交");
      const account = await this.account(id);
      if ("username" in submission.credentials && submission.credentials.username.toLowerCase() !== account.username.toLowerCase()) fail("用户名必须与当前账号一致");
      slot.formRevision = randomUUID();
      try { return await this.finishForm(slot, await submitLoginForm(slot.page, submission.credentials)); }
      catch (error) {
        if (error instanceof BrowserSessionError) throw error;
        return fail("登录请求未确认，请重新加载后重试；已有会话未被覆盖");
      }
    });
  }

  async cancel(id: string, owner: string): Promise<void> {
    return this.exclusive(async () => { this.interactive(id, owner); await this.dispose(); });
  }

  async run<T>(id: string, work: (context: BrowserContext, account: Account) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      if (this.slot?.owner) fail("浏览器登录窗口使用中，请完成登录后再签到");
      const account = await this.account(id);
      if (!account.browserSession) fail("请先打开浏览器登录并保存会话");
      const slot = await this.ensure(account, account.browserSession!.viewport);
      try {
        await this.verify(slot, account);
        const output = await work(slot.context, account);
        await this.persist(slot);
        return output;
      } catch (error) { await this.dispose(); throw error; }
    });
  }

  async closeOwner(owner: string): Promise<void> {
    if (this.slot?.owner === owner) await this.cancel(this.slot.accountId, owner);
  }

  async invalidate(id: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.slot?.accountId !== id) return;
      if (this.slot.owner) fail("浏览器登录窗口使用中，请先保存或关闭");
      await this.dispose();
    });
  }

  private async dispose(): Promise<void> {
    clearTimeout(this.timer);
    const slot = this.slot;
    this.slot = undefined;
    await slot?.context.close();
  }

  async close(): Promise<void> { return this.exclusive(() => this.dispose()); }
}
