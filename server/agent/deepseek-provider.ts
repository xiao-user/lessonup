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
  private readonly provider: OpenAIProvider;

  constructor(apiKey = config.DEEPSEEK_API_KEY, baseURL = config.DEEPSEEK_BASE_URL) {
    if (!apiKey) throw new Error("deepseek_not_configured");
    this.provider = new OpenAIProvider({
      apiKey,
      baseURL,
      useResponses: false,
      strictFeatureValidation: true,
    });
  }

  async getModel(modelName: string = deepSeekModels.pro): Promise<Model> {
    if (modelName !== deepSeekModels.pro && modelName !== deepSeekModels.flash) {
      throw new Error(`unsupported_deepseek_model:${modelName}`);
    }
    return new DeepSeekToolArgumentRepairModel(await this.provider.getModel(modelName));
  }

  async close() {
    await this.provider.close();
  }
}

export function createDeepSeekClient() {
  if (!config.DEEPSEEK_API_KEY) throw new Error("deepseek_not_configured");
  return new OpenAI({ apiKey: config.DEEPSEEK_API_KEY, baseURL: config.DEEPSEEK_BASE_URL });
}
