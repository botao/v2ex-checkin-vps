import type { BrowserContext } from "playwright";

export interface BrowserSession {
  state: Awaited<ReturnType<BrowserContext["storageState"]>>;
  viewport: { width: number; height: number };
  savedAt: string;
}

export interface Account {
  id: string;
  username: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  browserSession?: BrowserSession;
}

export interface PublicAccount {
  id: string;
  username: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  browserSavedAt?: string;
}

export type CheckinStatus = "checked_in" | "already_checked_in" | "failed";

export interface CheckinResult {
  accountId: string;
  username: string;
  ok: boolean;
  status: CheckinStatus;
  message: string;
  checkedAt: string;
  rewardDate?: string;
  retryable?: boolean;
  attempts?: number;
}

export interface StoreData {
  accounts: Account[];
  history: CheckinResult[];
  job?: CheckinJob;
}

export interface CheckinJob {
  id: string;
  state: "running" | "completed" | "failed" | "interrupted";
  source: "manual" | "scheduled";
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentUsername: string | null;
  startedAt: string;
  finishedAt?: string;
  message?: string;
}
