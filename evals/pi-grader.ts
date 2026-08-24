import { Agent } from "@earendil-works/pi-agent-core";
import { createPiModelRuntime } from "../server/agent-runtime/pi/model-provider.js";
import type { BusinessGraderClient } from "./grading.js";

export function createPiGraderClient(args: { apiKey: string; baseURL: string }): BusinessGraderClient {
  return {
    chat: {
      completions: {
        create: async (request) => {
          const definition = createPiModelRuntime({
            apiKey: args.apiKey,
            baseUrl: args.baseURL,
            modelId: request.model,
          });
          const system = request.messages.find((message) => message.role === "system")?.content ?? "";
          const input = request.messages.filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n");
          const agent = new Agent({
            initialState: {
              systemPrompt: system,
              model: definition.primary,
              thinkingLevel: "low",
              tools: [],
            },
            streamFn: definition.streamFn,
            toolExecution: "sequential",
          });
          await agent.prompt(input);
          if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
          const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
          const content = assistant?.role === "assistant"
            ? assistant.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("")
            : "";
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}
