import { access, mkdir, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { totalmem } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { loadConfig } from "../dist/src/config.js";
import { EncryptedStore } from "../dist/src/store.js";

const results = [];
let config;
try { config = loadConfig(); results.push({ check: "configuration", status: "ok" }); }
catch {
  results.push({ check: "configuration", status: "failed", message: "Check ADMIN_PASSWORD, MASTER_KEY, TZ and CHECKIN_CRON. Use Node --env-file=.env for local checks." });
}

if (config) {
  const probe = path.join(config.DATA_DIR, `.doctor-${randomUUID()}`);
  try {
    await mkdir(config.DATA_DIR, { recursive: true });
    const file = await open(probe, "wx", 0o600);
    await file.close();
    await unlink(probe);
    results.push({ check: "data_directory", status: "ok" });
  } catch { results.push({ check: "data_directory", status: "failed", message: "Data directory is not writable. Check volume permissions and disk space." }); }
  try {
    let existing = true;
    try { await access(path.join(config.DATA_DIR, "store.enc")); }
    catch (error) { if (error.code === "ENOENT") existing = false; else throw error; }
    if (existing) await new EncryptedStore(config.DATA_DIR, config.MASTER_KEY).read();
    results.push({ check: "encrypted_store", status: existing ? "ok" : "not_initialized" });
  } catch { results.push({ check: "encrypted_store", status: "failed", message: "Cannot decrypt data. Restore the original MASTER_KEY; do not replace or delete store.enc." }); }
}

let browser;
try {
  browser = await chromium.launch({ headless: true, timeout: 20_000 });
  const page = await browser.newPage();
  await page.setContent("<title>Browser health check</title>");
  if (await page.title() !== "Browser health check") throw new Error("Browser is not responding");
  results.push({ check: "chromium", status: "ok" });
} catch { results.push({ check: "chromium", status: "failed", message: "Chromium cannot start. For local runs: npx playwright install --with-deps chromium. For Docker: rebuild the Playwright image and check available memory." }); }
finally { await browser?.close().catch(() => undefined); }

console.log(JSON.stringify({ checks: results, memoryMiB: Math.floor(totalmem() / 1024 / 1024), note: "Local browser check only; V2EX connectivity and login are not tested." }, null, 2));
if (results.some(result => result.status === "failed")) process.exitCode = 1;
