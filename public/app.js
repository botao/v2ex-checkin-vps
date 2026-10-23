import { formatTime as formatInTimezone, summarizeAccounts } from "/dashboard.js";

const $ = (selector) => document.querySelector(selector);
const dialog = $("#account-dialog");
const notice = $("#notice");
let csrf = "";
let accounts = [];
let running = false;
let submitting = false;
let loadPromise = null;
let pollTimer;
let cachedState = null;
let timezone = "Asia/Hong_Kong";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const formatTime = value => formatInTimezone(value, timezone);

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (csrf) headers["X-CSRF-Token"] = csrf;
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) { location.href = "/login"; throw new Error("登录已过期"); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作失败");
  return data;
}

function flash(message, error = false) {
  const target = dialog.open ? $("#form-notice") : notice;
  target.textContent = message;
  target.className = `notice ${error ? "error" : "success"}`;
  target.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { target.hidden = true; }, 5000);
}

function statusLabel(item) {
  if (item.status === "already_checked_in") return "已领取";
  return item.ok ? "成功" : "失败";
}

function updateRunButtons() {
  document.querySelectorAll('[data-run], #run-all').forEach(button => { button.disabled = running || submitting; });
}

function renderJob(job, history) {
  running = job?.state === "running";
  $("#job-panel").hidden = !job;
  if (!job) return;
  const labels = { running: "签到执行中", completed: "签到任务已完成", failed: "签到任务失败", interrupted: "签到任务已中断" };
  $("#job-title").textContent = labels[job.state] || "签到任务";
  $("#job-count").textContent = `${job.completed} / ${job.total}`;
  $("#job-progress").max = Math.max(1, job.total);
  $("#job-progress").value = job.completed;
  const single = job.total === 1 && history[0]?.checkedAt >= job.startedAt ? history[0].message : null;
  $("#job-description").textContent = job.message || (running ? (job.currentUsername ? `正在签到：${job.currentUsername}` : "准备执行") : single || `成功 ${job.succeeded} 个，失败 ${job.failed} 个`);
}

function load() {
  if (loadPromise) return loadPromise;
  clearTimeout(pollTimer);
  loadPromise = renderState().finally(() => {
    loadPromise = null;
    pollTimer = setTimeout(() => load().catch(error => flash(error.message, true)), running ? 2000 : 15000);
  });
  return loadPromise;
}

async function renderState() {
  const data = await api("/api/state");
  csrf = data.csrf;
  accounts = data.accounts;
  timezone = data.timezone;
  const summary = summarizeAccounts(accounts, data.history, timezone);
  $("#schedule").textContent = `自动任务 ${data.timezone} · ${data.schedule}`;
  $("#next-run").textContent = data.nextRun ? formatTime(data.nextRun) : "暂无后续计划";
  if (data.nextRun) $("#next-run").dateTime = data.nextRun;
  else $("#next-run").removeAttribute("datetime");
  $("#timezone").textContent = timezone;
  $("#account-count").textContent = accounts.length;
  $("#success-count").textContent = `${summary.completed} / ${summary.enabled}`;
  $("#attention-count").textContent = summary.attention;
  $("#last-run").textContent = formatTime(data.history[0]?.checkedAt);
  cachedState = data;
  renderTables(data);
  renderJob(data.job, data.history);
  updateRunButtons();
}

function renderTables(data) {
  const query = $("#account-search").value.trim().toLowerCase();
  const filter = $("#result-filter").value;
  const selectedAccounts = summarizeAccounts(data.accounts, data.history, data.timezone).accounts.filter(account => account.username.toLowerCase().includes(query));
  const selectedHistory = data.history.filter(item => item.username.toLowerCase().includes(query) && (filter === "all" || item.status === filter));

  const labels = { complete: "已完成", attention: "需处理", pending: "待签到", disabled: "不参与" };
  const accountRows = selectedAccounts.map((account) => `<tr><td data-label="用户名"><strong title="更新时间：${escapeHtml(formatTime(account.updatedAt))}">${escapeHtml(account.username)}</strong><div class="subtle account-mode">${account.browserSavedAt ? "浏览器 · 会话已保存" : "浏览器 · 待登录"}</div></td><td data-label="自动任务"><span class="status ${account.enabled ? "ok" : "muted"}">${account.enabled ? "已启用" : "已停用"}</span></td><td data-label="今日状态"><span class="status ${account.dailyState === "attention" ? "fail" : account.dailyState === "complete" ? "ok" : "muted"}" title="${escapeHtml(account.latestResult?.message || "暂无执行记录")}">${labels[account.dailyState]}</span></td><td data-label="最近执行" class="subtle">${formatTime(account.latestResult?.checkedAt)}</td><td data-label="操作"><div class="row-actions"><button class="button compact" data-run="${account.id}">签到</button><a class="button compact" href="/browser/${encodeURIComponent(account.id)}">浏览器登录</a><button class="button compact" data-edit="${account.id}">编辑</button><button class="button compact danger" data-delete="${account.id}">删除</button></div></td></tr>`).join("");
  $("#accounts").innerHTML = selectedAccounts.length ? `<table><thead><tr><th>用户名</th><th>自动任务</th><th>今日状态</th><th>最近执行</th><th></th></tr></thead><tbody>${accountRows}</tbody></table>` : `<div class="empty">${data.accounts.length ? "没有匹配的账号" : "尚未添加账号"}</div>`;

  const historyRows = selectedHistory.map((item) => `<tr><td data-label="账号">${escapeHtml(item.username)}</td><td data-label="结果"><span class="status ${item.ok ? "ok" : "fail"}">${statusLabel(item)}</span></td><td data-label="说明" class="message">${escapeHtml(item.message)}</td><td data-label="时间" class="subtle">${formatTime(item.checkedAt)}</td></tr>`).join("");
  $("#history").innerHTML = selectedHistory.length ? `<table><thead><tr><th>账号</th><th>结果</th><th>说明</th><th>时间</th></tr></thead><tbody>${historyRows}</tbody></table>` : `<div class="empty">${data.history.length ? "没有匹配的记录" : "暂无执行记录"}</div>`;
}

for (const [selector, event] of [["#account-search", "input"], ["#result-filter", "change"]]) {
  $(selector).addEventListener(event, () => {
    if (cachedState) { renderTables(cachedState); updateRunButtons(); }
  });
}

function openForm(account) {
  const form = $("#account-form");
  form.reset();
  $("#form-notice").hidden = true;
  form.elements.id.value = account?.id || "";
  form.elements.username.value = account?.username || "";
  form.elements.enabled.checked = account?.enabled ?? true;
  $("#dialog-title").textContent = account ? "编辑账号" : "添加账号";
  dialog.showModal();
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  try {
    if (button.id === "add-account") openForm();
    if (button.matches("[data-close]")) dialog.close();
    if (button.id === "refresh") await load();
    if (button.id === "logout") { await api("/api/logout", { method: "POST" }); location.href = "/login"; }
    if (button.dataset.edit) openForm(accounts.find((item) => item.id === button.dataset.edit));
    if (button.dataset.delete && confirm("确定删除这个账号及其加密凭据？")) { await api(`/api/accounts/${button.dataset.delete}`, { method: "DELETE" }); flash("账号已删除"); await load(); }
    if (button.dataset.run || button.id === "run-all") {
      submitting = true;
      updateRunButtons();
      try {
        const data = await api(button.dataset.run ? `/api/run/${button.dataset.run}` : "/api/run", { method: "POST" });
        renderJob(data.job, []);
        flash("签到任务已开始");
        await load();
      } finally { submitting = false; updateRunButtons(); }
    }
  } catch (error) { flash(error.message, true); }
});

$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const payload = { username: form.elements.username.value, enabled: form.elements.enabled.checked };
  try {
    const result = await api(id ? `/api/accounts/${id}` : "/api/accounts", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
    if (!id) { location.href = `/browser/${encodeURIComponent(result.account.id)}`; return; }
    dialog.close(); flash(id ? "账号已更新" : "账号已添加"); await load();
  } catch (error) { flash(error.message, true); }
});

load().catch((error) => flash(error.message, true));
