import { z } from "zod";
import cron from "node-cron";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  ADMIN_PASSWORD: z.string().min(12),
  MASTER_KEY: z.string().refine((value) => {
    try { return /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").length === 32; } catch { return false; }
  }, "MASTER_KEY must be a base64-encoded 32-byte key"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TZ: z.string().default("Asia/Hong_Kong").refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "TZ must be a valid IANA timezone"),
  CHECKIN_CRON: z.string().default("17 9 * * *").refine(value => value.trim().split(/\s+/).length === 5 && cron.validate(value), "CHECKIN_CRON must be a valid five-field cron expression"),
  TRUST_PROXY: z.coerce.number().int().min(0).max(2).default(1),
  DATA_DIR: z.string().default("./data")
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
