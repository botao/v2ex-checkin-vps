import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EncryptedStore } from "../src/store.js";

test("browser endpoints require admin and CSRF; browser accounts need no pasted cookie", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v2ex-browser-api-"));
  const store = new EncryptedStore(dir, Buffer.alloc(32, 3).toString("base64"));
  await store.init();
  const browserSession = { state: { cookies: [], origins: [] }, viewport: { width: 1280, height: 900 }, savedAt: "saved-before" };
  await store.update(data => ({ ...data, accounts: [{ id: "saved", username: "saved", enabled: true, createdAt: "before", updatedAt: "before", browserSession }] }));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { ...process.env, NODE_ENV: "test", PORT: "39879", DATA_DIR: dir, ADMIN_PASSWORD: "browser-test-password", MASTER_KEY: Buffer.alloc(32, 3).toString("base64"), CHECKIN_CRON: "0 0 1 1 *" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
  const exited = once(child, "exit");
  const base = "http://127.0.0.1:39879";
  try {
    for (let i = 0; !output.includes('"server_started"'); i++) {
      if (i > 100 || child.exitCode !== null) throw new Error(output || "Startup timeout");
      await new Promise(r => setTimeout(r, 50));
    }
    for (const verb of ["start", "frame", "action", "save", "cancel", "form", "refresh", "login"]) {
      const res = await fetch(`${base}/api/browser/missing/${verb}`, { method: "POST" });
      assert.equal(res.status, 401); await res.text();
    }
    assert.equal((await fetch(`${base}/browser/missing`, { redirect: "manual" })).status, 303);
    const login = await fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=browser-test-password" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const state = await (await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).json();
    for (const verb of ["start", "frame", "action", "save", "cancel", "form", "refresh", "login"]) {
      const res = await fetch(`${base}/api/browser/missing/${verb}`, { method: "POST", headers: { Cookie: cookie } });
      assert.equal(res.status, 403); await res.text();
    }
    const headers = { Cookie: cookie, "X-CSRF-Token": state.csrf, "Content-Type": "application/json" };
    const edit = await fetch(`${base}/api/accounts/saved`, { method: "PUT", headers, body: JSON.stringify({ username: "SAVED", enabled: false }) });
    assert.equal(edit.status, 200);
    const edited = await edit.json();
    assert.equal(edited.account.browserSavedAt, browserSession.savedAt);
    assert.equal("browserSession" in edited.account, false);
    assert.deepEqual((await store.read()).accounts[0]!.browserSession, browserSession);
    const rename = await fetch(`${base}/api/accounts/saved`, { method: "PUT", headers, body: JSON.stringify({ username: "renamed", enabled: false }) });
    assert.equal(rename.status, 200); await rename.text();
    assert.equal((await store.read()).accounts[0]!.browserSession, undefined);
    const created = await fetch(`${base}/api/accounts`, { method: "POST", headers, body: JSON.stringify({ username: "alice", enabled: true }) });
    assert.equal(created.status, 201);
    const { account } = await created.json();
    assert.equal("mode" in account, false);
    assert.equal("cookie" in account, false);
    assert.equal("browserSession" in account, false);
    const page = await fetch(`${base}/browser/${account.id}`, { headers });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /v2ex-login-form/);
    assert.doesNotMatch(html, /browser-screen/);
    const frame = await fetch(`${base}/api/browser/${account.id}/frame`, { method: "POST", headers });
    assert.equal(frame.status, 409); assert.equal(frame.headers.get("cache-control"), "no-store");
    await frame.text();
    const formView = await fetch(`${base}/api/browser/${account.id}/form`, { method: "POST", headers });
    assert.equal(formView.status, 409);
    assert.equal(formView.headers.get("cache-control"), "no-store");
    await formView.text();
    for (let attempt = 0; attempt < 6; attempt++) {
      const loginAttempt = await fetch(`${base}/api/browser/${account.id}/login`, { method: "POST", headers, body: JSON.stringify({ revision: crypto.randomUUID(), credentials: { username: "alice", password: "synthetic-form-password", captcha: "ABC" } }) });
      assert.equal(loginAttempt.status, attempt < 5 ? 409 : 429);
      await loginAttempt.text();
    }
    assert.equal(output.includes("synthetic-form-password"), false);
    const bad = await fetch(`${base}/api/browser/${account.id}/action`, { method: "POST", headers, body: JSON.stringify({ type: "goto", url: "http://localhost/" }) });
    assert.equal(bad.status, 400); await bad.text();
    const cookieAccount = await fetch(`${base}/api/accounts`, { method: "POST", headers, body: JSON.stringify({ username: "bob", mode: "cookie", cookie: "A2=synthetic", enabled: true }) });
    assert.equal(cookieAccount.status, 400); await cookieAccount.text();
    const oldUpdate = await fetch(`${base}/api/accounts/${account.id}`, { method: "PUT", headers, body: JSON.stringify({ username: "alice", cookie: "A2=synthetic", enabled: true }) });
    assert.equal(oldUpdate.status, 400); await oldUpdate.text();
    const run = await fetch(`${base}/api/run/${account.id}`, { method: "POST", headers });
    assert.equal(run.status, 202); await run.text();
    let finished;
    for (let i = 0; i < 100; i++) {
      finished = await (await fetch(`${base}/api/state`, { headers })).json();
      if (finished.job?.state !== "running") break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.match(finished.history[0].message, /请先.*登录.*会话/);
  } finally {
    child.kill("SIGTERM"); await exited;
    await rm(dir, { recursive: true, force: true });
  }
});
