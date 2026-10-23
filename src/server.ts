import express, { type NextFunction, type Request, type Response } from "express";
import cron from "node-cron";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { cookieValue, createSession, secureEqual, verifySession } from "./security.js";
import { EncryptedStore } from "./store.js";
import type { Account, PublicAccount } from "./types.js";
import { isTransientNetworkError, pageResult } from "./v2ex.js";
import { BrowserSessions, BrowserSessionError, browserAction } from "./browser-sessions.js";
import { formSubmission } from "./login-form.js";
import { CheckinRunner } from "./runner.js";
import { createShutdown } from "./shutdown.js";

const config = loadConfig();
const app = express();
const store = new EncryptedStore(config.DATA_DIR, config.MASTER_KEY);
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(root, existsSync(path.resolve(root, "../public")) ? "../public" : "../../public");
const browsers = new BrowserSessions(store);
const runner = new CheckinRunner(store, async account => {
  try { return await browsers.run(account.id, pageResult); }
  catch (error) {
    return { accountId: account.id, username: account.username, ok: false, status: "failed", checkedAt: new Date().toISOString(), retryable: isTransientNetworkError(error), message: error instanceof BrowserSessionError ? error.message : "VPS 浏览器会话访问失败，请打开浏览器检查登录状态" };
  }
});
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

app.set("trust proxy", config.TRUST_PROXY);
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "4kb" }));
app.use((_request, response, next) => {
  response.set({
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cache-Control": "no-store"
  });
  next();
});

const accountInput = z.object({
  username: z.string().trim().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/),
  enabled: z.boolean()
}).strict();

function session(request: Request) {
  return verifySession(cookieValue(request.headers.cookie, "session"), config.MASTER_KEY);
}

function authenticated(request: Request, response: Response, next: NextFunction): void {
  if (session(request)) return next();
  if (request.path.startsWith("/api/")) { response.status(401).json({ error: "登录已过期" }); return; }
  response.redirect(303, "/login");
}

function csrf(request: Request, response: Response, next: NextFunction): void {
  const current = session(request);
  if (!current || !secureEqual(request.get("X-CSRF-Token") || "", current.csrf)) {
    response.status(403).json({ error: "安全校验失败，请刷新页面" }); return;
  }
  next();
}

function publicAccount(account: Account): PublicAccount {
  const { id, username, enabled, createdAt, updatedAt } = account;
  return { id, username, enabled, createdAt, updatedAt, browserSavedAt: account.browserSession?.savedAt };
}

app.get("/health", async (_request, response) => {
  try { await store.read(); response.json({ status: "ok" }); }
  catch { response.status(503).json({ status: "degraded" }); }
});
app.get("/favicon.ico", (_request, response) => { response.sendStatus(204); });
app.get(["/styles.css", "/app.js", "/dashboard.js", "/login.js", "/browser.js"], express.static(publicDir, { index: false, maxAge: 0 }));
app.get("/login", (request, response) => session(request) ? response.redirect(303, "/") : response.sendFile(path.join(publicDir, "login.html")));
app.post("/login", (request, response) => {
  const key = request.ip || "unknown";
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (attempt && attempt.resetAt > now && attempt.count >= 8) { response.status(429).sendFile(path.join(publicDir, "login.html")); return; }
  if (!secureEqual(String(request.body.password || ""), config.ADMIN_PASSWORD)) {
    loginAttempts.set(key, { count: attempt && attempt.resetAt > now ? attempt.count + 1 : 1, resetAt: now + 15 * 60_000 });
    response.redirect(303, "/login?error=1"); return;
  }
  loginAttempts.delete(key);
  response.cookie("session", createSession(config.MASTER_KEY), { httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "strict", maxAge: 12 * 60 * 60_000, path: "/" });
  response.redirect(303, "/");
});

app.use(authenticated);
app.get("/", (_request, response) => response.sendFile(path.join(publicDir, "index.html")));
app.get("/browser/:id", (_request, response) => response.sendFile(path.join(publicDir, "browser.html")));
app.get("/api/state", async (request, response) => {
  const data = await store.read();
  response.json({ accounts: data.accounts.map(publicAccount), history: data.history, job: runner.status(), csrf: session(request)?.csrf, schedule: config.CHECKIN_CRON, timezone: config.TZ, nextRun: scheduledTask.getNextRun()?.toISOString() ?? null });
});
app.post("/api/logout", csrf, async (request, response) => {
  await browsers.closeOwner(session(request)!.csrf);
  response.clearCookie("session", { httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "strict", path: "/" });
  response.json({ ok: true });
});
app.post("/api/accounts", csrf, async (request, response) => {
  const input = accountInput.parse(request.body);
  const now = new Date().toISOString();
  const account: Account = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
  await store.update((data) => {
    if (data.accounts.some((item) => item.username.toLowerCase() === input.username.toLowerCase())) throw new Error("该用户名已存在");
    return { ...data, accounts: [...data.accounts, account] };
  });
  response.status(201).json({ account: publicAccount(account) });
});
app.put("/api/accounts/:id", csrf, async (request, response) => {
  const input = accountInput.parse(request.body);
  if (runner.status()?.state === "running") throw new Error("已有签到任务执行中");
  await browsers.invalidate(String(request.params.id));
  let updated: Account | undefined;
  await store.update((data) => {
    const index = data.accounts.findIndex((item) => item.id === request.params.id);
    if (index < 0) throw new Error("账号不存在");
    if (data.accounts.some((item, i) => i !== index && item.username.toLowerCase() === input.username.toLowerCase())) throw new Error("该用户名已存在");
    const current = data.accounts[index]!;
    updated = { ...current, username: input.username, enabled: input.enabled, updatedAt: new Date().toISOString(), ...(current.username.toLowerCase() !== input.username.toLowerCase() ? { browserSession: undefined } : {}) };
    const accounts = [...data.accounts]; accounts[index] = updated;
    return { ...data, accounts };
  });
  response.json({ account: publicAccount(updated!) });
});
app.delete("/api/accounts/:id", csrf, async (request, response) => {
  if (runner.status()?.state === "running") throw new Error("已有签到任务执行中");
  await browsers.invalidate(String(request.params.id));
  await store.update((data) => ({ ...data, accounts: data.accounts.filter((item) => item.id !== request.params.id) }));
  response.json({ ok: true });
});
app.post("/api/run", csrf, async (_request, response) => response.status(202).json({ job: await runner.start() }));
app.post("/api/run/:id", csrf, async (request, response) => response.status(202).json({ job: await runner.start(String(request.params.id)) }));

const browserRequests = new Map<string, { count: number; until: number }>();
const credentialAttempts = new Map<string, { count: number; until: number }>();
app.use("/api/browser", csrf, (request, response, next) => {
  const now = Date.now();
  for (const [key, value] of browserRequests) if (value.until < now) browserRequests.delete(key);
  const key = session(request)!.csrf;
  const bucket = browserRequests.get(key) ?? { count: 0, until: now + 60_000 };
  browserRequests.set(key, bucket);
  if (++bucket.count > 240) { response.status(429).json({ error: "浏览器操作过于频繁，请稍后重试" }); return; }
  next();
});
app.post("/api/browser/:id/start", async (request, response) => {
  if (runner.status()?.state === "running") throw new Error("已有签到任务执行中");
  const { size } = z.object({ size: z.enum(["desktop", "mobile"]) }).parse(request.body);
  await browsers.start(String(request.params.id), session(request)!.csrf, size);
  response.json({ ok: true });
});
app.post("/api/browser/:id/frame", async (request, response) => response.json(await browsers.frame(String(request.params.id), session(request)!.csrf)));
app.post("/api/browser/:id/action", async (request, response) => {
  const action = browserAction.parse(request.body);
  await browsers.action(String(request.params.id), session(request)!.csrf, action);
  response.json({ ok: true });
});
app.post("/api/browser/:id/save", async (request, response) => {
  await browsers.save(String(request.params.id), session(request)!.csrf);
  response.json({ ok: true });
});
app.post("/api/browser/:id/cancel", async (request, response) => {
  await browsers.cancel(String(request.params.id), session(request)!.csrf);
  response.json({ ok: true });
});
app.post("/api/browser/:id/form", async (request, response) => response.json(await browsers.form(String(request.params.id), session(request)!.csrf)));
app.post("/api/browser/:id/refresh", async (request, response) => response.json(await browsers.form(String(request.params.id), session(request)!.csrf, true)));
app.post("/api/browser/:id/login", async (request, response) => {
  const input = formSubmission.parse(request.body);
  const now = Date.now();
  for (const [key, value] of credentialAttempts) if (value.until < now) credentialAttempts.delete(key);
  const key = session(request)!.csrf;
  const bucket = credentialAttempts.get(key) ?? { count: 0, until: now + 60_000 };
  credentialAttempts.set(key, bucket);
  if (++bucket.count > 5) { response.status(429).json({ error: "登录尝试过于频繁，请一分钟后重试" }); return; }
  response.json(await browsers.submitForm(String(request.params.id), key, input));
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const known = error instanceof BrowserSessionError ? error.message : error instanceof z.ZodError ? "输入内容格式无效" : error instanceof Error && ["该用户名已存在", "账号不存在", "没有已启用的账号", "已有签到任务执行中"].includes(error.message) ? error.message : null;
  if (!known) console.error(JSON.stringify({ event: "request_failed", kind: error instanceof Error ? error.name : "unknown" }));
  response.status(error instanceof BrowserSessionError || known === "已有签到任务执行中" ? 409 : known ? 400 : 500).json({ error: known || "服务暂时不可用，请稍后重试" });
});

await store.init();
await runner.init();
const scheduledTask = cron.schedule(config.CHECKIN_CRON, async () => {
  try { await runner.start(undefined, "scheduled"); await runner.wait(); }
  catch { console.error(JSON.stringify({ event: "scheduled_run_failed" })); }
}, { timezone: config.TZ, noOverlap: true });
const server = app.listen(config.PORT, "0.0.0.0", () => console.log(JSON.stringify({ event: "server_started", port: config.PORT, schedule: config.CHECKIN_CRON, timezone: config.TZ })));
const shutdown = createShutdown({
  stopSchedule: () => scheduledTask.stop(),
  closeServer: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  waitForJob: async () => { await runner.wait(); await browsers.close(); },
  timeoutMs: 75_000,
  finish: code => {
    console.log(JSON.stringify({ event: code === 0 ? "shutdown_completed" : "shutdown_failed", code }));
    process.exit(code);
  }
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(JSON.stringify({ event: "shutdown_requested", signal }));
    void shutdown();
  });
}
