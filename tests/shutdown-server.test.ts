import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`server handles ${signal} with a clean exit and keeps encrypted data`, { timeout: 15_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "v2ex-shutdown-server-"));
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      env: {
        ...process.env, NODE_ENV: "test", PORT: String(port), DATA_DIR: dir,
        ADMIN_PASSWORD: "shutdown-test-password", MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
        CHECKIN_CRON: "0 0 1 1 *", TZ: "Asia/Hong_Kong"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const exited = once(child, "exit");
    try {
      for (let attempt = 0; !output.includes('"event":"server_started"'); attempt++) {
        if (attempt >= 100 || child.exitCode !== null) throw new Error(`Server failed to start: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      await health.text();
      const login = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "shutdown-test-password" })
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Cookie: cookie } })).json();
      assert.equal(typeof state.nextRun, "string");
      assert.ok(Date.parse(state.nextRun) > Date.now());
      assert.equal(state.timezone, "Asia/Hong_Kong");
      child.kill(signal);
      const [code, exitSignal] = await exited;
      assert.equal(code, 0, output);
      assert.equal(exitSignal, null);
      assert.ok(output.includes('"event":"shutdown_completed"'));
      const { EncryptedStore } = await import("../src/store.js");
      const data = await new EncryptedStore(dir, Buffer.alloc(32, 9).toString("base64")).read();
      assert.deepEqual(data.accounts, []);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      await rm(dir, { recursive: true, force: true });
    }
  });
}
