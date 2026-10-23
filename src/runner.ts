import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Account, CheckinJob, CheckinResult } from "./types.js";
import type { EncryptedStore } from "./store.js";

export class CheckinRunner {
  private busy = false;
  private job: CheckinJob | null = null;
  private completion: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: EncryptedStore,
    private readonly checkIn: (account: Account) => Promise<CheckinResult>,
    private readonly retryDelay: () => Promise<void> = () => delay(15_000)
  ) {}

  async init(): Promise<void> {
    this.job = (await this.store.read()).job ?? null;
    if (this.job?.state === "running") {
      this.job = { ...this.job, state: "interrupted", currentUsername: null, finishedAt: new Date().toISOString(), message: "服务重启，未完成的账号可重新执行签到" };
      const job = this.job;
      await this.store.update(data => ({ ...data, job }));
    }
  }

  status(): CheckinJob | null { return this.job ? { ...this.job } : null; }
  wait(): Promise<void> { return this.completion; }

  async start(accountId?: string, source: CheckinJob["source"] = "manual"): Promise<CheckinJob> {
    if (this.busy) throw new Error("已有签到任务执行中");
    this.busy = true;
    // Include asynchronous startup in the promise used by graceful shutdown.
    let complete!: () => void;
    this.completion = new Promise<void>(resolve => { complete = resolve; });
    try {
      const accounts = (await this.store.read()).accounts.filter(account => accountId ? account.id === accountId : account.enabled);
      if (!accounts.length) throw new Error(accountId ? "账号不存在" : "没有已启用的账号");
      const job: CheckinJob = {
        id: randomUUID(), state: "running", source, total: accounts.length, completed: 0,
        succeeded: 0, failed: 0, currentUsername: null, startedAt: new Date().toISOString()
      };
      await this.store.update(data => ({ ...data, job }));
      this.job = job;
      const accepted = { ...job };
      void this.execute(accounts, job).finally(() => { this.busy = false; complete(); });
      return accepted;
    } catch (error) { this.busy = false; complete(); throw error; }
  }

  private async execute(accounts: Account[], initial: CheckinJob): Promise<void> {
    let job = initial;
    try {
      for (const account of accounts) {
        job = { ...job, currentUsername: account.username };
        this.job = job;
        await this.store.update(data => ({ ...data, job }));
        let result = { ...await this.attempt(account), attempts: 1 };
        if (job.source === "scheduled" && !result.ok && result.retryable === true) {
          job = { ...job, message: "网络或服务暂时异常，15 秒后重试一次" };
          this.job = job;
          await this.store.update(data => ({ ...data, job, history: [result, ...data.history].slice(0, 100) }));
          await this.retryDelay();
          job = { ...job, message: `正在重试：${account.username}` };
          this.job = job;
          await this.store.update(data => ({ ...data, job }));
          result = { ...await this.attempt(account), attempts: 2 };
          result.message = `${result.ok ? "重试成功" : "重试后仍失败"}：${result.message}`;
        }
        job = { ...job, message: undefined, completed: job.completed + 1, succeeded: job.succeeded + Number(result.ok), failed: job.failed + Number(!result.ok) };
        await this.store.update(data => ({ ...data, job, history: [result, ...data.history].slice(0, 100) }));
        this.job = job;
      }
      job = { ...job, state: "completed", currentUsername: null, finishedAt: new Date().toISOString() };
      await this.store.update(data => ({ ...data, job }));
      this.job = job;
    } catch {
      job = { ...job, state: "failed", currentUsername: null, finishedAt: new Date().toISOString(), message: "任务保存失败，请检查数据卷权限和磁盘空间" };
      this.job = job;
      try { await this.store.update(data => ({ ...data, job })); }
      catch { console.error(JSON.stringify({ event: "job_save_failed", jobId: job.id })); }
    }
  }

  private async attempt(account: Account): Promise<CheckinResult> {
    try { return await this.checkIn(account); }
    catch {
      return { accountId: account.id, username: account.username, ok: false, status: "failed", message: "账号签到异常，请检查浏览器运行环境", checkedAt: new Date().toISOString() };
    }
  }
}
