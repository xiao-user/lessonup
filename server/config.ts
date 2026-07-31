import "dotenv/config";
import { z } from "zod";

const emptyAsUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(
  (value) => value === "" ? undefined : value,
  schema.optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  APP_ORIGIN: z.string().default("http://127.0.0.1:5173"),
  DEEPSEEK_API_KEY: emptyAsUndefined(z.string().min(1)),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  DEEPSEEK_PRO_MODEL: z.literal("deepseek-v4-pro").default("deepseek-v4-pro"),
  DEEPSEEK_FLASH_MODEL: z.literal("deepseek-v4-flash").default("deepseek-v4-flash"),
  SUPABASE_URL: emptyAsUndefined(z.url()),
  SUPABASE_ANON_KEY: emptyAsUndefined(z.string().min(1)),
  SUPABASE_SERVICE_ROLE_KEY: emptyAsUndefined(z.string().min(1)),
  AGENT_STATE_ENCRYPTION_KEY: emptyAsUndefined(z.string().min(32)),
  TAVILY_API_KEY: emptyAsUndefined(z.string().min(1)),
  BGE_M3_BASE_URL: emptyAsUndefined(z.url()),
  BGE_M3_API_KEY: emptyAsUndefined(z.string().min(1)),
  BGE_M3_MODEL: z.string().default("BAAI/bge-m3"),
  KNOWLEDGE_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).default(2_000),
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  MCP_TOKEN_SECRET: emptyAsUndefined(z.string().min(32)),
  LESSONUP_DEV_AUTH: z.enum(["0", "1"]).default("0"),
}).superRefine((env, context) => {
  if (env.LESSONUP_DEV_AUTH === "1" && env.NODE_ENV !== "test") {
    context.addIssue({ code: "custom", path: ["LESSONUP_DEV_AUTH"], message: "dev_auth_is_test_only" });
  }
  if (env.NODE_ENV !== "production") return;
  if (env.LESSONUP_DEV_AUTH !== "0") {
    context.addIssue({ code: "custom", path: ["LESSONUP_DEV_AUTH"], message: "production_requires_dev_auth_disabled" });
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    context.addIssue({ code: "custom", path: ["SUPABASE_URL"], message: "production_requires_supabase" });
  }
  if (env.DEEPSEEK_API_KEY && (!env.AGENT_STATE_ENCRYPTION_KEY || !env.MCP_TOKEN_SECRET)) {
    context.addIssue({ code: "custom", path: ["AGENT_STATE_ENCRYPTION_KEY"], message: "production_agent_requires_runtime_secrets" });
  }
});

export const config = envSchema.parse(process.env);

export const hasSupabase = Boolean(
  config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY && config.SUPABASE_ANON_KEY,
);

export const hasDeepSeek = Boolean(config.DEEPSEEK_API_KEY);

export const runtimeCapabilities = {
  agent: hasDeepSeek,
  auth: hasSupabase,
  knowledge: hasSupabase && Boolean(config.BGE_M3_BASE_URL),
  persistence: hasSupabase ? "supabase" : "memory",
  webSearch: Boolean(config.TAVILY_API_KEY),
} as const;
