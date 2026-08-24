import { Agent } from "@earendil-works/pi-agent-core";
import { config } from "../../config.js";
import { createPiModelRuntime } from "./model-provider.js";

export async function requestPiText(args: {
  instructions: string;
  input: string;
  signal?: AbortSignal;
}) {
  const definition = createPiModelRuntime({
    apiKey: config.MODEL_API_KEY ?? "",
    baseUrl: config.MODEL_BASE_URL ?? "",
    modelId: config.MODEL_ID ?? "",
    api: config.MODEL_API,
  });
  const agent = new Agent({
    initialState: {
      systemPrompt: args.instructions,
      model: definition.primary,
      thinkingLevel: "low",
      tools: [],
    },
    streamFn: definition.streamFn,
    toolExecution: "sequential",
  });
  const abort = () => agent.abort();
  args.signal?.addEventListener("abort", abort, { once: true });
  try {
    await agent.prompt(args.input);
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
    const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
    if (!assistant || assistant.role !== "assistant") throw new Error("pi_text_response_missing");
    return assistant.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  } finally {
    args.signal?.removeEventListener("abort", abort);
  }
}
