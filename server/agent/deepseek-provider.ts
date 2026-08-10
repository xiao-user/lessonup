import {
  OpenAIProvider,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import OpenAI from "openai";
import { config } from "../config.js";

export const deepSeekModels = {
  pro: "deepseek-v4-pro",
  flash: "deepseek-v4-flash",
} as const;

export type DeepSeekModel = typeof deepSeekModels[keyof typeof deepSeekModels];
export type DeepSeekApiProtocol = "chat-completions" | "responses";

export function deepSeekApiProtocolForModel(modelName: string): DeepSeekApiProtocol {
  if (modelName === deepSeekModels.pro) return "chat-completions";
  if (modelName === deepSeekModels.flash) return "responses";
  throw new Error(`unsupported_deepseek_model:${modelName}`);
}

export function repairToolArgumentsJson(value: string) {
  try {
    JSON.parse(value);
    return value;
  } catch {
    let repaired = "";
    let insideString = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (!insideString) {
        repaired += character;
        if (character === "\"") insideString = true;
        continue;
      }
      if (escaped) {
        repaired += character;
        escaped = false;
        continue;
      }
      if (character === "\\") {
        repaired += character;
        escaped = true;
        continue;
      }
      if (character !== "\"") {
        repaired += character;
        continue;
      }
      const next = value.slice(index + 1).match(/\S/)?.[0];
      if (next === ":" || next === "," || next === "}" || next === "]" || next === undefined) {
        repaired += character;
        insideString = false;
      } else {
        repaired += "\\\"";
      }
    }
    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      return value;
    }
  }
}

function repairToolCalls<T extends { output: unknown[] }>(response: T): T {
  let changed = false;
  const output = response.output.map((item) => {
    const candidate = item as { type?: string; arguments?: string };
    if (candidate.type !== "function_call" || typeof candidate.arguments !== "string") return item;
    const repaired = repairToolArgumentsJson(candidate.arguments);
    if (repaired === candidate.arguments) return item;
    changed = true;
    return { ...candidate, arguments: repaired };
  });
  return changed ? { ...response, output } : response;
}

class DeepSeekToolArgumentRepairModel implements Model {
  constructor(private readonly model: Model) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    return repairToolCalls(await this.model.getResponse(request));
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    for await (const event of this.model.getStreamedResponse(request)) {
      if (event.type !== "response_done") {
        yield event;
        continue;
      }
      yield {
        ...event,
        response: repairToolCalls(event.response),
      };
    }
  }

  getRetryAdvice(args: Parameters<NonNullable<Model["getRetryAdvice"]>>[0]) {
    return this.model.getRetryAdvice?.(args);
  }
}

export class DeepSeekModelProvider implements ModelProvider {
  private readonly chatCompletionsProvider: OpenAIProvider;
  private readonly responsesProvider: OpenAIProvider;

  constructor(apiKey = config.DEEPSEEK_API_KEY, baseURL = config.DEEPSEEK_BASE_URL) {
    if (!apiKey) throw new Error("deepseek_not_configured");
    this.chatCompletionsProvider = new OpenAIProvider({
      apiKey,
      baseURL,
      useResponses: false,
      strictFeatureValidation: true,
    });
    this.responsesProvider = new OpenAIProvider({
      apiKey,
      baseURL,
      useResponses: true,
    });
  }

  async getModel(modelName: string = deepSeekModels.flash): Promise<Model> {
    const protocol = deepSeekApiProtocolForModel(modelName);
    const provider = protocol === "responses"
      ? this.responsesProvider
      : this.chatCompletionsProvider;
    return new DeepSeekToolArgumentRepairModel(await provider.getModel(modelName));
  }

  async close() {
    await Promise.all([
      this.chatCompletionsProvider.close(),
      this.responsesProvider.close(),
    ]);
  }
}

export function createDeepSeekClient() {
  if (!config.DEEPSEEK_API_KEY) throw new Error("deepseek_not_configured");
  return new OpenAI({ apiKey: config.DEEPSEEK_API_KEY, baseURL: config.DEEPSEEK_BASE_URL });
}

export async function requestDeepSeekFlashText(args: {
  instructions: string;
  input: string;
  maxOutputTokens: number;
  temperature?: number;
  json?: boolean;
  signal?: AbortSignal;
}) {
  const response = await createDeepSeekClient().responses.create({
    model: deepSeekModels.flash,
    instructions: args.instructions,
    input: args.input,
    max_output_tokens: args.maxOutputTokens,
    temperature: args.temperature,
    reasoning: { effort: "low" },
    store: false,
    text: args.json ? { format: { type: "json_object" } } : undefined,
  }, { signal: args.signal });
  if (response.status !== "completed") {
    throw new Error(`deepseek_flash_response_${response.status}`);
  }
  const content = response.output_text.trim();
  if (!content) throw new Error("deepseek_flash_response_empty");
  return content;
}
