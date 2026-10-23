const $ = selector => document.querySelector(selector);
const id = location.pathname.split("/").pop();
const form = $("#v2ex-login-form");
let csrf = "";
let revision = "";
let stage = "";
let connected = false;
let busy = false;

async function api(verb, body = {}) {
  const response = await fetch(`/api/browser/${encodeURIComponent(id)}/${verb}`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
  if (response.status === 401) { location.href = "/login"; throw new Error("后台登录已过期"); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "登录服务暂时不可用");
  return result;
}

function notice(message) {
  $("#browser-notice").textContent = message;
  $("#browser-notice").className = "notice error";
  $("#browser-notice").hidden = !message;
}

function render(view) {
  revision = view.revision;
  stage = view.stage;
  const credentials = stage === "credentials";
  const otp = stage === "otp";
  form.hidden = !(credentials || otp);
  $("#credentials-fields").hidden = !credentials;
  $("#credentials-fields").disabled = !credentials;
  $("#otp-fields").hidden = !otp;
  $("#otp-fields").disabled = !otp;
  $("#captcha-image").removeAttribute("src");
  if (view.captcha) $("#captcha-image").src = `data:image/png;base64,${view.captcha}`;
  form.elements.captcha.value = "";
  form.elements.password.value = "";
  form.elements.code.value = "";
  $("#login-submit").textContent = otp ? "验证并保存" : "登录";
  $("#login-complete").hidden = stage !== "authenticated";
  $("#login-reconnect").hidden = credentials || otp || stage === "authenticated";
  $("#browser-status").textContent = stage === "authenticated" ? "登录成功，会话已加密保存" : otp ? "等待两步验证" : credentials ? "等待登录" : "暂时无法登录";
  $("#browser-cancel").hidden = stage === "authenticated";
  notice(view.message || "");
  if (stage === "authenticated") connected = false;
}

async function operation(work) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach(button => { button.disabled = true; });
  form.querySelectorAll("input").forEach(input => { input.disabled = true; });
  notice("");
  try { await work(); }
  catch (error) {
    notice(error.message);
    $("#browser-status").textContent = "操作未完成";
    $("#login-reconnect").hidden = false;
    if (/登录窗口已关闭/.test(error.message)) { connected = false; form.hidden = true; $("#captcha-image").removeAttribute("src"); }
  } finally {
    form.elements.password.value = "";
    form.elements.code.value = "";
    busy = false;
    document.querySelectorAll("button").forEach(button => { button.disabled = false; });
    form.querySelectorAll("input").forEach(input => { input.disabled = false; });
  }
}

async function connect() {
  const response = await fetch("/api/state");
  if (response.status === 401) { location.href = "/login"; return; }
  if (!response.ok) throw new Error("无法读取账号");
  const state = await response.json();
  csrf = state.csrf;
  const account = state.accounts.find(account => account.id === id);
  if (!account) throw new Error("账号不存在");
  $("#browser-title").textContent = account.username;
  form.elements.username.value = account.username;
  await api("start", { size: "desktop" });
  connected = true;
  render(await api("form"));
}

form.addEventListener("submit", event => {
  event.preventDefault();
  if (busy) return;
  const credentials = stage === "otp" ? { code: form.elements.code.value } : { username: form.elements.username.value, password: form.elements.password.value, captcha: form.elements.captcha.value };
  form.elements.password.value = "";
  form.elements.code.value = "";
  void operation(async () => {
    $("#browser-status").textContent = "正在登录并核对账号";
    render(await api("login", { revision, credentials }));
  });
});
$("#captcha-refresh").addEventListener("click", () => { void operation(async () => render(await api("refresh"))); });
$("#login-reconnect").addEventListener("click", () => { void operation(async () => connected ? render(await api("refresh")) : connect()); });
$("#browser-cancel").addEventListener("click", () => {
  void operation(async () => { if (connected) await api("cancel"); form.reset(); location.href = "/"; });
});
void operation(connect);
