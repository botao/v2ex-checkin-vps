import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { readLoginForm, submitLoginForm, loginCredentials } from "../src/login-form.js";
import { BrowserSessions } from "../src/browser-sessions.js";
import { EncryptedStore } from "../src/store.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("login form validates credentials without accepting arbitrary fields", () => {
  assert.equal(loginCredentials.safeParse({ username: "alice", password: " secret ", captcha: "ABC123" }).success, true);
  for (const input of [{ username: "alice", password: "", captcha: "ABC" }, { username: "alice", password: "x", captcha: "x".repeat(33) }, { username: "alice", password: "x", captcha: "ABC", url: "http://localhost" }]) {
    assert.equal(loginCredentials.safeParse(input).success, false);
  }
});

test("unknown URLs, changed layouts and failed navigation do not leak credentials", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    assert.equal((await readLoginForm(page)).stage, "unsupported");
    let body = '<form action="/signin"><input type="text"><input type="password"><input type="text"></form>';
    let abortPost = false;
    await page.route("https://www.v2ex.com/**", async route => {
      if (abortPost && route.request().method() === "POST") { await route.abort(); return; }
      await route.fulfill({ contentType: "text/html", body });
    });
    await page.goto("https://www.v2ex.com/signin");
    assert.equal((await readLoginForm(page)).stage, "unsupported");
    body = '<form action="/signin" method="post"><input type="text" name="user"><input type="password" name="pass"><img src="/_captcha" width="40" height="40"><input type="text" name="captcha"><input type="submit"></form>';
    await page.unroute("https://www.v2ex.com/**");
    await page.route("https://www.v2ex.com/**", async route => {
      if (route.request().url().endsWith("/_captcha")) { await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>' }); return; }
      if (abortPost && route.request().method() === "POST") { await route.abort(); return; }
      await route.fulfill({ contentType: "text/html", body });
    });
    await page.reload();
    assert.equal((await submitLoginForm(page, { code: "123456" })).stage, "unsupported");
    abortPost = true;
    await assert.rejects(submitLoginForm(page, { username: "alice", password: "synthetic secret", captcha: "ABC" }), error => {
      assert.match(String(error), /登录请求未确认/);
      assert.equal(String(error).includes("synthetic secret"), false);
      return true;
    });
  } finally { await browser.close(); }
});

for (const scenario of ["success", "incorrect", "otp", "blocked", "unknown"] as const) {
  test(`native login form handles ${scenario} and clears passwords`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      let submissions = 0;
      let refreshes = 0;
      const form = '<form action="/signin" method="post"><input type="text" name="randomUser"><input type="password" name="randomPassword"><img src="/_captcha" width="240" height="80"><input type="text" name="randomCaptcha"><input type="hidden" name="once" value="fresh"><input type="submit" value="登录"></form>';
      await context.route("https://www.v2ex.com/**", async route => {
        const request = route.request();
        if (new URL(request.url()).pathname === "/_captcha") {
          await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="white"/><text x="10" y="40">TEST CAPTCHA</text></svg>' }); return;
        }
        let html = form;
        if (request.method() === "POST") {
          submissions++;
          const values = new URLSearchParams(request.postData()!);
          if (submissions === 1) {
            assert.equal(values.get("randomUser"), "alice");
            assert.equal(values.get("randomPassword"), " synthetic secret ");
            assert.equal(values.get("randomCaptcha"), "ABC123");
            assert.equal(values.get("once"), "fresh");
          }
          if (scenario === "incorrect") html = '<div class="problem">用户名或密码错误</div>' + form;
          else if (scenario === "blocked") html = "Just a moment... Verify you are human";
          else if (scenario === "unknown") html = "New unknown page";
          else if (scenario === "otp" && submissions === 1) html = '<form action="/2fa" method="post"><input name="code" autocomplete="one-time-code"><input type="submit" value="验证"></form>';
          else html = '<div id="Top"><a href="/member/alice">alice</a></div>';
        } else refreshes++;
        await route.fulfill({ contentType: "text/html", body: html });
      });
      const page = await context.newPage();
      await page.goto("https://www.v2ex.com/signin");
      const view = await readLoginForm(page);
      assert.equal(view.stage, "credentials");
      assert.ok(view.captcha?.startsWith("iVBOR"));
      assert.equal(JSON.stringify(view).includes("fresh"), false, "hidden once token stays inside browser");
      const result = await submitLoginForm(page, { username: "alice", password: " synthetic secret ", captcha: "ABC123" });
      assert.equal(result.stage, scenario === "success" ? "authenticated" : scenario === "incorrect" ? "credentials" : scenario === "unknown" ? "unsupported" : scenario);
      assert.equal(JSON.stringify(result).includes("synthetic secret"), false);
      assert.equal(await page.locator('input[type="password"]').evaluateAll(es => es.some(e => (e as HTMLInputElement).value !== "")), false);
      if (scenario === "otp") {
        const finished = await submitLoginForm(page, { code: "123456" });
        assert.equal(finished.stage, "authenticated");
      }
      assert.ok(refreshes >= 1);
    } finally { await browser.close(); }
  });
}

for (const outcome of ["success", "incorrect", "wrong_account"] as const) {
  test(`form session ${outcome} checks revisions and preserves prior credentials`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "v2ex-form-session-"));
    const store = new EncryptedStore(dir, Buffer.alloc(32, 8).toString("base64"));
    await store.init();
    const browser = await chromium.launch({ headless: true });
    const oldState = { cookies: [{ name: "A2", value: "previous-session", domain: ".v2ex.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const }], origins: [] };
    await store.update(data => ({ ...data, accounts: [{ id: "a", username: "alice", enabled: true, createdAt: "now", updatedAt: "now", browserSession: { state: oldState, viewport: { width: 1280, height: 800 }, savedAt: "prior" } }] }));
    let submitted = 0;
    const sessions = new BrowserSessions(store, { createContext: async saved => {
      const context = await browser.newContext({ storageState: saved?.state });
      await context.route("https://www.v2ex.com/**", async route => {
        const request = route.request();
        if (new URL(request.url()).pathname === "/_captcha") { await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><text y="30">TEST</text></svg>' }); return; }
        const isPost = request.method() === "POST";
        if (isPost) submitted++;
        const authenticated = (isPost && outcome !== "incorrect") || new URL(request.url()).pathname === "/mission/daily";
        const identity = outcome === "wrong_account" ? "bob" : "alice";
        await route.fulfill({ contentType: "text/html", headers: isPost && outcome !== "incorrect" ? { "set-cookie": "A2=new-session; Domain=.v2ex.com; Path=/; Secure; HttpOnly; SameSite=Lax" } : {}, body: authenticated ? `<div id="Top"><a href="/member/${identity}">${identity}</a></div>` : '<form action="/signin" method="post"><input type="text" name="user"><input type="password" name="pass"><img src="/_captcha"><input type="text" name="captcha"><input type="submit"></form>' });
      });
      return context;
    } });
    try {
      await sessions.start("a", "owner", "desktop");
      const initial = await sessions.form("a", "owner");
      await assert.rejects(sessions.form("a", "stranger"), /浏览器/);
      const fresh = await sessions.form("a", "owner", true);
      const credentials = { username: "alice", password: " synthetic secret ", captcha: "ABC" };
      await assert.rejects(sessions.submitForm("a", "owner", { revision: initial.revision, credentials }), /验证码已更新/);
      await assert.rejects(sessions.submitForm("a", "owner", { revision: fresh.revision, credentials: { ...credentials, username: "bob" } }), /用户名/);
      assert.equal(submitted, 0);
      if (outcome === "wrong_account") {
        await assert.rejects(sessions.submitForm("a", "owner", { revision: fresh.revision, credentials }), /用户名/);
      } else {
        const result = await sessions.submitForm("a", "owner", { revision: fresh.revision, credentials });
        assert.equal(result.stage, outcome === "success" ? "authenticated" : "credentials");
        assert.notEqual(result.revision, fresh.revision);
      }
      const account = (await store.read()).accounts[0]!;
      assert.equal(account.browserSession!.state.cookies[0]!.value, outcome === "success" ? "new-session" : "previous-session");
      assert.equal((await readFile(path.join(dir, "store.enc"), "utf8")).includes("synthetic secret"), false);
    } finally { await sessions.close(); await browser.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
