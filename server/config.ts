import "dotenv/config";
import { z } from "zod";

const emptyAsUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(
  (value) => value === "" ? undefined : value,
  schema.optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),
  APP_ORIGIN: z.string().default("http://127.0.0.1:5173"),
  LESSONUP_PERSISTENCE: z.enum(["memory", "d1"]).default("memory"),
  MODEL_API_KEY: emptyAsUndefined(z.string().min(1)),
  MODEL_BASE_URL: emptyAsUndefined(z.url()),
  MODEL_ID: emptyAsUndefined(z.string().trim().min(1)),
  MODEL_API: emptyAsUndefined(z.enum(["openai-responses", "openai-completions"])),
  MODEL_CONTEXT_WINDOW: emptyAsUndefined(z.coerce.number().int().min(1)),
  MODEL_MAX_TOKENS: emptyAsUndefined(z.coerce.number().int().min(1)),
  AGENT_STATE_ENCRYPTION_KEY: emptyAsUndefined(z.string().min(32)),
  TAVILY_API_KEY: emptyAsUndefined(z.string().min(1)),
  EMBEDDING_BASE_URL: emptyAsUndefined(z.url()),
  EMBEDDING_API_KEY: emptyAsUndefined(z.string().min(1)),
  EMBEDDING_MODEL: emptyAsUndefined(z.string().trim().min(1)),
  EMBEDDING_DIMENSIONS: emptyAsUndefined(z.coerce.number().int().positive()),
  KNOWLEDGE_WORKER_INTERVAL_MS: z.coerce.number().int().min(500).default(2_000),
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  MCP_TOKEN_SECRET: emptyAsUndefined(z.string().min(32)),
  LESSONUP_DEV_AUTH: z.enum(["0", "1"]).default("0"),
}).superRefine((env, context) => {
  if (env.LESSONUP_DEV_AUTH === "1" && env.NODE_ENV !== "test") {
    context.addIssue({ code: "custom", path: ["LESSONUP_DEV_AUTH"], message: "dev_auth_is_test_only" });
  }
  const modelFields = [
    env.MODEL_API_KEY,
    env.MODEL_BASE_URL,
    env.MODEL_ID,
    env.MODEL_API,
    env.MODEL_CONTEXT_WINDOW,
    env.MODEL_MAX_TOKENS,
  ];
  if (modelFields.some(Boolean) && !modelFields.every(Boolean)) {
    context.addIssue({ code: "custom", path: ["MODEL_API_KEY"], message: "model_configuration_incomplete" });
  }
  const embeddingFields = [
    env.EMBEDDING_BASE_URL,
    env.EMBEDDING_API_KEY,
    env.EMBEDDING_MODEL,
    env.EMBEDDING_DIMENSIONS,
  ];
  if (embeddingFields.some(Boolean) && !embeddingFields.every(Boolean)) {
    context.addIssue({ code: "custom", path: ["EMBEDDING_BASE_URL"], message: "embedding_configuration_incomplete" });
  }
  if (env.NODE_ENV !== "production") return;
  if (env.LESSONUP_DEV_AUTH !== "0") {
    context.addIssue({ code: "custom", path: ["LESSONUP_DEV_AUTH"], message: "production_requires_dev_auth_disabled" });
  }
  if (env.LESSONUP_PERSISTENCE !== "d1") {
    context.addIssue({ code: "custom", path: ["LESSONUP_PERSISTENCE"], message: "production_requires_d1" });
  }
  if (!env.MCP_TOKEN_SECRET) {
    context.addIssue({ code: "custom", path: ["MCP_TOKEN_SECRET"], message: "production_requires_mcp_token_secret" });
  }
  if (env.MODEL_API_KEY && !env.AGENT_STATE_ENCRYPTION_KEY) {
    context.addIssue({ code: "custom", path: ["AGENT_STATE_ENCRYPTION_KEY"], message: "production_agent_requires_runtime_secrets" });
  }
});

export const parseConfig = (env: NodeJS.ProcessEnv) => envSchema.parse(env);

export const config = parseConfig(process.env);

export const hasD1 = config.LESSONUP_PERSISTENCE === "d1";

export const hasModelProvider = Boolean(
  config.MODEL_API_KEY
  && config.MODEL_BASE_URL
  && config.MODEL_ID
  && config.MODEL_API
  && config.MODEL_CONTEXT_WINDOW
  && config.MODEL_MAX_TOKENS,
);

export const hasEmbeddingProvider = Boolean(
  config.EMBEDDING_BASE_URL
  && config.EMBEDDING_API_KEY
  && config.EMBEDDING_MODEL
  && config.EMBEDDING_DIMENSIONS,
);

export const runtimeCapabilities = {
  agent: hasModelProvider,
  auth: hasD1,
  knowledge: hasD1 && hasEmbeddingProvider,
  persistence: config.LESSONUP_PERSISTENCE,
  webSearch: Boolean(config.TAVILY_API_KEY),
  presentation: { html: hasModelProvider },
  agentRuntime: hasModelProvider ? "pi" : "unconfigured",
} as const;
