import { describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createPiModelProvider, createPiModelRuntime, createResilientStreamFn } from "./model-provider.js";

describe("Pi model provider", () => {
  it("registers any configured model on the stateless Responses API by default", () => {
    const { primary } = createPiModelProvider({
      apiKey: "test-key",
      baseUrl: "https://gateway.example/v1",
      modelId: "model-a",
    });
    expect(primary.id).toBe("model-a");
    expect(primary.api).toBe("openai-responses");
    expect(primary.provider).toBe("openai-compatible");
    expect(primary.samplingParams).toMatchObject({ store: false });
  });

  it("can use Chat Completions without changing provider code", () => {
    const runtime = createPiModelRuntime({
      apiKey: "test-key",
      baseUrl: "https://another-gateway.example/v1",
      modelId: "model-b",
      api: "openai-completions",
    });
    expect(runtime.primary.id).toBe("model-b");
    expect(runtime.primary.api).toBe("openai-completions");
    expect(runtime.models.getModels("openai-compatible").map((model) => model.id)).toEqual(["model-b"]);
  });

  it("retries a transient empty provider failure before exposing it to Pi", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "Connection error." }),
      fauxAssistantMessage("完成"),
    ]);
    const stream = createResilientStreamFn(models.streamSimple.bind(models), {
      maxRetries: 1,
      retryDelaysMs: [0],
    });

    const result = await (await stream(faux.getModel(), {
      systemPrompt: "test",
      messages: [],
      tools: [],
    })).result();

    expect(result.stopReason).toBe("stop");
    expect(faux.state.callCount).toBe(2);
  });

  it("does not retry after partial semantic output", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "Connection error." }),
      fauxAssistantMessage("must not run"),
    ]);
    const stream = createResilientStreamFn(models.streamSimple.bind(models), {
      maxRetries: 1,
      retryDelaysMs: [0],
    });

    const result = await (await stream(faux.getModel(), {
      systemPrompt: "test",
      messages: [],
      tools: [],
    })).result();

    expect(result.stopReason).toBe("error");
    expect(faux.state.callCount).toBe(1);
  });
});
