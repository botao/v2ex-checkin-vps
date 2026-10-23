import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

for (const width of [1440, 390, 320]) {
  test(`browser-only account configuration works at ${width}px`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      let payload: unknown;
      const accounts = [{ id: "saved", username: "alice", enabled: true, browserSavedAt: "2026-10-23T15:00:00Z" }, { id: "pending", username: "bob", enabled: false }];
      await page.route("http://dashboard.test/**", async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/state") { await route.fulfill({ json: { accounts, history: [], csrf: "test", timezone: "Asia/Hong_Kong", schedule: "17 9 * * *", nextRun: null } }); return; }
        if (pathname === "/api/accounts/saved") { payload = request.postDataJSON(); await route.fulfill({ json: { account: accounts[0] } }); return; }
        if (pathname === "/api/accounts") { payload = request.postDataJSON(); await route.fulfill({ status: 201, json: { account: { id: "new" } } }); return; }
        if (pathname === "/browser/new") { await route.fulfill({ contentType: "text/html", body: "<h1>Login</h1>" }); return; }
        const asset = pathname === "/" ? "index.html" : pathname.slice(1);
        if (!["index.html", "app.js", "dashboard.js", "styles.css"].includes(asset)) { await route.abort(); return; }
        await route.fulfill({ contentType: asset.endsWith("html") ? "text/html" : asset.endsWith("js") ? "text/javascript" : "text/css", body: await readFile(`public/${asset}`, "utf8") });
      });
      await page.goto("http://dashboard.test/");
      await page.getByText("浏览器 · 会话已保存", { exact: true }).waitFor();
      await page.getByText("浏览器 · 待登录", { exact: true }).waitFor();
      await page.locator('[data-edit="saved"]').click();
      await page.getByRole("button", { name: "保存账号", exact: true }).click();
      await page.locator("#account-dialog").waitFor({ state: "hidden" });
      assert.deepEqual(payload, { username: "alice", enabled: true });
      await page.getByRole("button", { name: "添加账号", exact: true }).click();
      await page.getByLabel("V2EX 用户名").fill("charlie");
      assert.equal(await page.locator('[name="cookie"], [name="mode"]').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mkdir("output/playwright", { recursive: true });
      await page.screenshot({ path: `output/playwright/browser-only-${width}.png` });
      await page.getByRole("button", { name: "保存账号", exact: true }).click();
      await page.waitForURL("http://dashboard.test/browser/new");
      assert.deepEqual(payload, { username: "charlie", enabled: true });
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
