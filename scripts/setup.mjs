import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function initializeEnv(directory) {
  let file;
  try {
    file = await open(path.join(directory, ".env"), "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    await file.writeFile([
      `ADMIN_PASSWORD=${randomBytes(24).toString("base64url")}`,
      `MASTER_KEY=${randomBytes(32).toString("base64")}`,
      "PORT=3000", "TZ=Asia/Hong_Kong", "CHECKIN_CRON=10 8 * * *", "TRUST_PROXY=1", ""
    ].join("\n"));
  } finally { await file.close(); }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(await initializeEnv(process.cwd())
      ? "Created .env (mode 0600). Read ADMIN_PASSWORD locally to sign in. Back up .env with your encrypted data."
      : "Existing .env preserved. No credentials were changed.");
  } catch {
    console.error("Cannot create .env. Check directory permissions; existing files were not overwritten.");
    process.exitCode = 1;
  }
}
