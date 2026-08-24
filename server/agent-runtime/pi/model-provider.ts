import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Api,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import * as openAICompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openAIResponses from "@earendil-works/pi-ai/api/openai-responses";

export type CompatibleModelApi = "openai-completions" | "openai-responses";

const transientProviderError = (message: string | undefined) => Boolean(message && (
  /\b(?:502|503|504)\b/.test(message)
  || /connection error|fetch failed|ECONNRESET|ETIMEDOUT|timed out|timeout|upstream_error/i.test(message)
));

const commitsProviderOutput = (event: AssistantMessageEvent) => {
  if (event.type === "text_delta") return event.delta.length > 0;
  if (event.type === "thinking_delta") return event.delta.length > 0;
  if (event.type === "toolcall_end" || event.type === "done") return true;
  return false;
};

const waitForRetry = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const timeout = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timeout);
    resolve();
  }, { once: true });
});

/**
 * Retries only transport failures that occur before the provider has produced
 * semantic output. A partial answer or complete tool call commits the request,
 * so it is never replayed and tools cannot execute twice.
 */
export const createResilientStreamFn = (
  stream: StreamFn,
  options: { maxRetries?: number; retryDelaysMs?: number[] } = {},
): StreamFn => (model, context, streamOptions) => {
  const outer = createAssistantMessageEventStream();
  const maxRetries = options.maxRetries ?? 2;
  const retryDelays = options.retryDelaysMs ?? [300, 900];

  queueMicrotask(async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const buffered: AssistantMessageEvent[] = [];
      let committed = false;
      let retry = false;
      const current = await stream(model, context, streamOptions);

      for await (const event of current) {
        if (!committed && event.type === "error" && transientProviderError(event.error.errorMessage)) {
          if (attempt < maxRetries && !streamOptions?.signal?.aborted) {
            retry = true;
            break;
          }
        }

        if (!committed) {
          buffered.push(event);
          if (commitsProviderOutput(event) || event.type === "error") {
            committed = true;
            for (const pending of buffered.splice(0)) outer.push(pending);
          }
        } else {
          outer.push(event);
        }
      }

      if (!retry) return;
      await waitForRetry(retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 0, streamOptions?.signal);
    }
  });

  return outer;
};

const commonModel = {
  provider: "openai-compatible",
  reasoning: true,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 384_000,
};

export function createPiModelProvider(args: {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  api?: CompatibleModelApi;
}) {
  if (!args.apiKey || !args.baseUrl || !args.modelId) throw new Error("model_provider_not_configured");
  const api = args.api ?? "openai-responses";
  const primary = {
    ...commonModel,
    id: args.modelId,
    name: args.modelId,
    api,
    baseUrl: args.baseUrl,
    thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
    compat: {
      supportsDeveloperRole: false,
      supportsStrictMode: true,
      ...(api === "openai-responses"
        ? { supportsLongCacheRetention: false }
        : { supportsStore: false, maxTokensField: "max_tokens" as const }),
    },
    ...(api === "openai-responses" ? { samplingParams: { store: false } } : {}),
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
  api?: CompatibleModelApi;
}) {
  const definition = createPiModelProvider(args);
  const models = createModels();
  models.setProvider(definition.provider);
  const baseStreamFn = models.streamSimple.bind(models);
  return {
    models,
    primary: definition.primary as Model<Api>,
    streamFn: createResilientStreamFn(baseStreamFn),
  };
}
