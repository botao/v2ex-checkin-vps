import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptJson, encryptJson } from "./security.js";
import type { CheckinResult, StoreData } from "./types.js";

const EMPTY: StoreData = { accounts: [], history: [] };

export class EncryptedStore {
  private readonly file: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(dataDir: string, private readonly key: string) {
    this.file = path.join(dataDir, "store.enc");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try { await readFile(this.file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.write(EMPTY);
    }
    const data = await this.read();
    // Remove legacy manually entered credentials, never the browser storageState.
    if (data.accounts.some(account => "cookie" in account || "mode" in account)) {
      await this.update(current => ({ ...current, accounts: current.accounts.map(account => {
        const { cookie: _cookie, mode: _mode, ...rest } = account as typeof account & { cookie?: unknown; mode?: unknown };
        return rest;
      }) }));
    }
  }

  async read(): Promise<StoreData> {
    return decryptJson<StoreData>(await readFile(this.file, "utf8"), this.key);
  }

  async update(change: (data: StoreData) => StoreData | Promise<StoreData>): Promise<StoreData> {
    let output = EMPTY;
    const operation = this.queue.then(async () => {
      output = await change(await this.read());
      await this.write(output);
    });
    // Preserve the caller's error without poisoning the queue for later writes.
    this.queue = operation.catch(() => undefined);
    await operation;
    return output;
  }

  async addHistory(results: CheckinResult[]): Promise<void> {
    if (!results.length) return;
    await this.update((data) => ({ ...data, history: [...results, ...data.history].slice(0, 100) }));
  }

  private async write(data: StoreData): Promise<void> {
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, encryptJson(data, this.key), { mode: 0o600 });
    await rename(temp, this.file);
  }
}
