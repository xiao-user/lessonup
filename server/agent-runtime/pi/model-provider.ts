import {
  createModels,
  createProvider,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import * as openAICompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openAIResponses from "@earendil-works/pi-ai/api/openai-responses";

export type CompatibleModelApi = "openai-completions" | "openai-responses";

const commonModel = {
  provider: "openai-compatible",
  reasoning: true,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function createPiModelProvider(args: {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  api: CompatibleModelApi;
  contextWindow: number;
  maxTokens: number;
}) {
  if (!args.apiKey || !args.baseUrl || !args.modelId) throw new Error("model_provider_not_configured");
  const primary = {
    ...commonModel,
    id: args.modelId,
    name: args.modelId,
    api: args.api,
    baseUrl: args.baseUrl,
    contextWindow: args.contextWindow,
    maxTokens: args.maxTokens,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    compat: {
      supportsDeveloperRole: false,
      supportsStrictMode: true,
      ...(args.api === "openai-responses"
        ? { supportsLongCacheRetention: false }
        : {
            supportsStore: false,
            maxTokensField: "max_tokens" as const,
            sendSessionAffinityHeaders: true,
            sessionAffinityFormat: "openai" as const,
            // pi-ai detects Zhipu hosts but still sets supportsReasoningEffort
            // false. GLM-5.3 then omits reasoning_effort and defaults to max
            // thinking, which is 1–2 minutes of hidden tokens before any tool
            // call. Honor the Agent thinkingLevel instead.
            //
            // GLM's prefix cache is implicit and keyed on identical messages
            // and tools. Do not stamp Anthropic cache_control or OpenAI
            // prompt_cache_key: Zhipu rejects those fields. Session affinity
            // headers keep successive turns on the same cache replica.
            supportsReasoningEffort: true,
          }),
    },
    ...(args.api === "openai-responses" ? { samplingParams: { store: false } } : {}),
  } as Model<CompatibleModelApi>;
  const provider = createProvider<CompatibleModelApi>({
    id: "openai-compatible",
    name: "OpenAI-compatible model service",
    baseUrl: args.baseUrl,
    auth: {
      apiKey: {
        name: "LessonUp server model key",
        check: async () => ({ type: "api_key", source: "LessonUp model configuration" }),
        resolve: async () => ({
          auth: { apiKey: args.apiKey, baseUrl: args.baseUrl },
          source: "LessonUp model configuration",
        }),
      },
    },
    models: [primary],
    api: {
      "openai-completions": openAICompletions,
      "openai-responses": openAIResponses,
    },
  });
  return { provider, primary };
}

export function createPiModelRuntime(args: {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  api: CompatibleModelApi;
  contextWindow: number;
  maxTokens: number;
}) {
  const definition = createPiModelProvider(args);
  const models = createModels();
  models.setProvider(definition.provider);
  const baseStreamFn = models.streamSimple.bind(models);
  return {
    models,
    primary: definition.primary as Model<Api>,
    // Agent owns its request lifecycle. Do not add a second retry/streaming
    // harness here: retries must be explicit, durable run decisions.
    streamFn: baseStreamFn,
  };
}
