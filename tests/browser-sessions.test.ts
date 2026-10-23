import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Route } from "playwright";
import { BrowserSessions, allowedBrowserRequest, browserAction } from "../src/browser-sessions.js";
import { EncryptedStore } from "../src/store.js";

test("remote browser restricts URLs and validates all input actions", () => {
  for (const url of ["https://www.v2ex.com/signin", "https://v2ex.com/mission/daily", "https://cdn.v2ex.com/avatar.png", "https://challenges.cloudflare.com/turnstile/v0/api.js"]) {
    assert.equal(allowedBrowserRequest(url, false), true);
  }
  for (const url of ["http://www.v2ex.com/", "https://v2ex.com.evil.test/", "https://127.0.0.1/", "file:///etc/passwd", "https://user:pass@www.v2ex.com/"]) {
    assert.equal(allowedBrowserRequest(url, false), false);
  }
  assert.equal(allowedBrowserRequest("https://cdn.v2ex.com/", true), false);
  assert.equal(allowedBrowserRequest("https://challenges.cloudflare.com/", true), false);
  for (const input of [{ type: "click", x: -1, y: 0 }, { type: "click", x: 5000, y: 0 }, { type: "key", key: "Control+L" }, { type: "goto", url: "http://localhost" }, { type: "text", text: "x".repeat(2049) }]) {
    assert.equal(browserAction.safeParse(input).success, false);
  }
});

test("browser login is isolated, identity checked, encrypted, reusable and exclusive", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-browser-session-"));
  const store = new EncryptedStore(dir, Buffer.alloc(32, 6).toString("base64"));
  await store.init();
  const account = { id: "a", username: "alice", enabled: true, createdAt: "now", updatedAt: "now" };
  await store.update(data => ({ ...data, accounts: [account, { ...account, id: "b", username: "bob" }] }));
  let identity = "bob";
  let closes = 0;
  const launches: unknown[] = [];
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => "https://www.v2ex.com/mission/daily",
    close: async () => {},
    locator: () => ({ first: () => ({ getAttribute: async () => `/member/${identity}` }) }),
    screenshot: async () => Buffer.from("image")
  };
  const context = {
    newPage: async () => page,
    cookies: async () => [{ name: "A2", value: "private-session" }],
    storageState: async () => ({ cookies: [{ name: "A2", value: "private-session" }], origins: [] }),
    close: async () => { closes++; }
  } as unknown as BrowserContext;
  const sessions = new BrowserSessions(store, { createContext: async state => { launches.push(state); return context; } });
  try {
    await sessions.start("a", "owner", "desktop");
    await assert.rejects(sessions.start("b", "owner", "desktop"), /浏览器/);
    await assert.rejects(sessions.frame("a", "stranger"), /浏览器/);
    await assert.rejects(sessions.run("a", async () => "unexpected"), /浏览器/);
    await assert.rejects(sessions.save("a", "owner"), /用户名/);
    assert.equal((await store.read()).accounts[0]!.browserSession, undefined);
    identity = "alice";
    await sessions.save("a", "owner");
    assert.equal((await store.read()).accounts[0]!.browserSession?.state.cookies[0]?.value, "private-session");
    assert.equal((await readFile(path.join(dir, "store.enc"), "utf8")).includes("private-session"), false);
    assert.equal(await sessions.run("a", async c => c === context), true);
    assert.equal(launches.length, 1, "same live browser context reused");
    await sessions.close();
    await sessions.run("a", async () => {});
    assert.equal(launches.length, 2);
    assert.ok(launches[1], "encrypted session restored after context closes");
    let release!: () => void;
    const pending = sessions.run("a", () => new Promise(resolve => { release = () => resolve(null); }));
    await new Promise(resolve => setTimeout(resolve, 10));
    await assert.rejects(sessions.start("b", "owner", "mobile"), /浏览器/);
    release(); await pending;
    await sessions.start("b", "owner", "mobile");
    assert.equal(launches[2], undefined, "another account never receives alice's state");
    await sessions.cancel("b", "owner");
    await assert.rejects(sessions.frame("b", "owner"), /浏览器/);
    await assert.rejects(sessions.run("b", async () => {}), /登录/);
    assert.ok(closes >= 2);
  } finally { await sessions.close(); await rm(dir, { recursive: true, force: true }); }
});

test("abandoned browser login expires without saving credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-browser-expiry-"));
  const store = new EncryptedStore(dir, Buffer.alloc(32, 7).toString("base64"));
  await store.init();
  await store.update(data => ({ ...data, accounts: [{ id: "a", username: "alice", enabled: true, createdAt: "now", updatedAt: "now" }] }));
  let closed = false;
  const context = { newPage: async () => ({ goto: async () => {} }), close: async () => { closed = true; } } as unknown as BrowserContext;
  const sessions = new BrowserSessions(store, { idleMs: 20, createContext: async () => context });
  try {
    await sessions.start("a", "owner", "desktop");
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(closed, true);
    assert.equal((await store.read()).accounts[0]!.browserSession, undefined);
    await assert.rejects(sessions.frame("a", "owner"), /浏览器/);
  } finally { await sessions.close(); await rm(dir, { recursive: true, force: true }); }
});

test("headed browser blocks unsafe traffic and supports native inputs without saving until verified", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-browser-input-"));
  const store = new EncryptedStore(dir, Buffer.alloc(32, 4).toString("base64"));
  await store.init();
  await store.update(data => ({ ...data, accounts: [{ id: "a", username: "alice", enabled: true, createdAt: "now", updatedAt: "now" }] }));
  const events: unknown[] = [];
  let handler!: (route: Route) => Promise<void>;
  let onClose!: () => void;
  const page = {
    goto: async (url: string) => events.push(url),
    screenshot: async () => Buffer.from("screen"),
    mouse: { click: async (...args: number[]) => events.push(args), wheel: async (...args: number[]) => events.push(args) },
    keyboard: { insertText: async (text: string) => events.push(text), press: async (key: string) => events.push(key) }
  };
  const context = {
    newPage: async () => page,
    route: async (_pattern: unknown, callback: typeof handler) => { handler = callback; },
    routeWebSocket: async () => {},
    on: (name: string, callback: () => void) => { if (name === "close") onClose = callback; },
    close: async () => { onClose(); }
  } as unknown as BrowserContext;
  let launchOptions: LaunchOptions | undefined;
  let contextOptions: unknown;
  let browserClosed = false;
  t.mock.method(chromium, "launch", async (options: LaunchOptions) => {
    launchOptions = options;
    return { newContext: async (options: unknown) => { contextOptions = options; return context; }, close: async () => { browserClosed = true; } } as unknown as Browser;
  });
  const sessions = new BrowserSessions(store);
  try {
    await sessions.start("a", "owner", "mobile");
    assert.equal(launchOptions!.headless, false);
    assert.equal(launchOptions!.handleSIGTERM, false);
    assert.equal((contextOptions as { acceptDownloads: boolean }).acceptDownloads, false);
    for (const [url, topLevel, allowed] of [["https://www.v2ex.com/signin", true, true], ["https://challenges.cloudflare.com/a", false, true], ["https://challenges.cloudflare.com/a", true, false], ["http://169.254.169.254/", false, false]] as const) {
      let decision = "";
      await handler({ request: () => ({ url: () => url, isNavigationRequest: () => true, frame: () => ({ parentFrame: () => topLevel ? null : {} }) }), continue: async () => { decision = "allow"; }, abort: async () => { decision = "deny"; } } as unknown as Route);
      assert.equal(decision, allowed ? "allow" : "deny");
    }
    await sessions.action("a", "owner", { type: "click", x: 30, y: 40 });
    await sessions.action("a", "owner", { type: "text", text: "synthetic-password" });
    await sessions.action("a", "owner", { type: "key", key: "Tab" });
    await sessions.action("a", "owner", { type: "scroll", delta: 600 });
    await sessions.action("a", "owner", { type: "daily" });
    await sessions.action("a", "owner", { type: "signin" });
    await assert.rejects(sessions.action("a", "owner", { type: "click", x: 390, y: 40 }), /位置/);
    const frame = await sessions.frame("a", "owner");
    assert.equal(frame.width, 390);
    assert.equal(frame.image, Buffer.from("screen").toString("base64"));
    assert.ok(events.includes("synthetic-password"));
    assert.equal((await readFile(path.join(dir, "store.enc"), "utf8")).includes("synthetic-password"), false);
    await assert.rejects(sessions.invalidate("a"), /窗口/);
    await sessions.closeOwner("stranger");
    await sessions.closeOwner("owner");
    assert.equal(browserClosed, true);
    await assert.rejects(sessions.frame("a", "owner"), /窗口/);
  } finally { await sessions.close(); await rm(dir, { recursive: true, force: true }); }
});
