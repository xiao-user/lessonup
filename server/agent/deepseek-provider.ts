import { OpenAIProvider, type Model, type ModelProvider } from "@openai/agents";
import OpenAI from "openai";
import { config } from "../config.js";

export const deepSeekModels = {
  pro: "deepseek-v4-pro",
  flash: "deepseek-v4-flash",
} as const;

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
    return this.provider.getModel(modelName);
  }

  async close() {
    await this.provider.close();
  }
}

export function createDeepSeekClient() {
  if (!config.DEEPSEEK_API_KEY) throw new Error("deepseek_not_configured");
  return new OpenAI({ apiKey: config.DEEPSEEK_API_KEY, baseURL: config.DEEPSEEK_BASE_URL });
}
