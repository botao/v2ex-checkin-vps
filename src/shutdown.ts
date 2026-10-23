interface ShutdownOptions {
  stopSchedule: () => void | Promise<void>;
  closeServer: () => Promise<void>;
  waitForJob: () => Promise<void>;
  finish: (code: number) => void;
  timeoutMs: number;
}

export function createShutdown(options: ShutdownOptions): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<number>(resolve => {
        timer = setTimeout(() => resolve(1), options.timeoutMs);
      });
      const drain = (async () => {
        await options.stopSchedule();
        await options.closeServer();
        await options.waitForJob();
        return 0;
      })().catch(() => 1);
      const code = await Promise.race([drain, timeout]);
      clearTimeout(timer);
      options.finish(code);
    })();
    return pending;
  };
}
