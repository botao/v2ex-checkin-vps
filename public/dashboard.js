export function formatTime(value, timezone = "Asia/Hong_Kong") {
  if (!value || !Number.isFinite(Date.parse(value))) return "暂无";
  return new Intl.DateTimeFormat("zh-HK", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value));
}

export function formatRewardDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "未记录";
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : "未记录";
}

export function summarizeAccounts(accounts, history, timezone, now = new Date()) {
  const date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timezone });
  const today = date.format(now);
  const completed = new Set();
  const latest = new Map();
  for (const result of history) {
    const time = Date.parse(result.checkedAt);
    if (!Number.isFinite(time)) continue;
    if (result.ok && formatRewardDate(result.rewardDate) === today) completed.add(result.accountId);
    if (!latest.has(result.accountId) || time > Date.parse(latest.get(result.accountId).checkedAt)) latest.set(result.accountId, result);
  }
  const rows = accounts.map(account => {
    const latestResult = latest.get(account.id) || null;
    const todayComplete = completed.has(account.id);
    const dailyState = !account.enabled ? "disabled" : latestResult && !latestResult.ok ? "attention" : todayComplete ? "complete" : "pending";
    return { ...account, todayComplete, latestResult, dailyState };
  });
  return {
    accounts: rows,
    enabled: rows.filter(account => account.enabled).length,
    completed: rows.filter(account => account.enabled && account.todayComplete).length,
    attention: rows.filter(account => account.dailyState === "attention").length
  };
}
