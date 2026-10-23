import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

for (const secondStep of ["otp", "incorrect"] as const) {
  test(`ordinary form handles ${secondStep} on mobile without screenshot controls`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      let revision = "first";
      let submits = 0;
      const credentials = () => ({ stage: "credentials", revision, captcha: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6tQAAAABJRU5ErkJggg==" });
      await page.route("http://app.test/**", async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === "/api/state") { await route.fulfill({ json: { csrf: "csrf-test", accounts: [{ id: "alice", username: "alice" }] } }); return; }
        if (path.startsWith("/api/browser/")) {
          assert.equal(request.headers()["x-csrf-token"], "csrf-test");
          if (path.endsWith("/form")) { await route.fulfill({ json: credentials() }); return; }
          if (path.endsWith("/refresh")) { revision = "refreshed"; await route.fulfill({ json: credentials() }); return; }
          if (path.endsWith("/login")) {
            const data = request.postDataJSON();
            assert.equal(data.revision, revision);
            submits++;
            if (submits === 2 && secondStep === "otp") assert.equal(data.credentials.code, "123456");
            else {
              assert.equal(data.credentials.username, "alice");
              assert.equal(data.credentials.password, " synthetic password ");
              assert.equal(data.credentials.captcha, "TEST");
            }
            revision = "after-submit";
            await route.fulfill({ json: submits === 1 ? secondStep === "otp" ? { stage: "otp", revision } : { ...credentials(), message: "登录未成功" } : { stage: "authenticated", revision } }); return;
          }
          await route.fulfill({ json: { ok: true } }); return;
        }
        const asset = path.startsWith("/browser/") ? "browser.html" : path.slice(1);
        if (!["browser.html", "browser.js", "styles.css"].includes(asset)) { await route.abort(); return; }
        await route.fulfill({ contentType: asset.endsWith(".html") ? "text/html" : asset.endsWith(".js") ? "text/javascript" : "text/css", body: await readFile(new URL(`../public/${asset}`, import.meta.url), "utf8") });
      });
      await page.goto("http://app.test/browser/alice");
      await page.getByRole("button", { name: "刷新验证码" }).click();
      await page.getByLabel("V2EX 密码").fill(" synthetic password ");
      await page.getByLabel("图片验证码", { exact: true }).fill("TEST");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      if (secondStep === "otp") {
        await page.getByLabel("两步验证动态码").fill("123456");
        await page.getByRole("button", { name: "验证并保存" }).click();
      } else {
        await page.getByText("登录未成功", { exact: true }).waitFor();
        assert.equal(await page.getByLabel("V2EX 密码").inputValue(), "");
        await page.getByLabel("V2EX 密码").fill(" synthetic password ");
        await page.getByLabel("图片验证码", { exact: true }).fill("TEST");
        await page.getByRole("button", { name: "登录", exact: true }).click();
      }
      await page.getByText("登录成功，会话已加密保存", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("V2EX 密码").inputValue(), "");
      assert.equal(await page.locator("#browser-screen").count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await browser.close(); }
  });
}
