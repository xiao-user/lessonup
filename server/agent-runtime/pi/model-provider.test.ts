import { describe, expect, it } from "vitest";
import { createPiModelProvider, createPiModelRuntime } from "./model-provider.js";

describe("Pi model provider", () => {
  it("registers any explicitly configured model on the Responses API", () => {
    const { primary } = createPiModelProvider({
      apiKey: "test-key",
      baseUrl: "https://gateway.example/v1",
      modelId: "model-a",
      api: "openai-responses",
      contextWindow: 100_000,
      maxTokens: 8_000,
    });
    expect(primary.id).toBe("model-a");
    expect(primary.api).toBe("openai-responses");
    expect(primary.provider).toBe("openai-compatible");
    expect(primary.samplingParams).toMatchObject({ store: false });
  });

  it("declares every Pi thinking level so missing keys cannot fall back to the provider default", () => {
    const { primary } = createPiModelProvider({
      apiKey: "test-key",
      baseUrl: "https://gateway.example/v1",
      modelId: "model-a",
      api: "openai-completions",
      contextWindow: 100_000,
      maxTokens: 8_000,
    });
    expect(primary.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
  });

  it("can use Chat Completions without changing provider code", () => {
    const runtime = createPiModelRuntime({
      apiKey: "test-key",
      baseUrl: "https://another-gateway.example/v1",
      modelId: "model-b",
      api: "openai-completions",
      contextWindow: 100_000,
      maxTokens: 8_000,
    });
    expect(runtime.primary.id).toBe("model-b");
    expect(runtime.primary.api).toBe("openai-completions");
    expect(runtime.models.getModels("openai-compatible").map((model) => model.id)).toEqual(["model-b"]);
  });

  it("forwards thinkingLevel as reasoning_effort on Zhipu hosts instead of letting GLM default to max", async () => {
    const runtime = createPiModelRuntime({
      apiKey: "test-key",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      modelId: "glm-5.3-flash",
      api: "openai-completions",
      contextWindow: 200_000,
      maxTokens: 8_000,
    });
    expect(runtime.primary.compat).toMatchObject({ supportsReasoningEffort: true });

    let payload: { thinking?: unknown; reasoning_effort?: unknown } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      payload = JSON.parse(String(init?.body ?? "{}"));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const stream = runtime.streamFn(runtime.primary, {
        systemPrompt: "x",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
      }, { reasoning: "low", apiKey: "test-key" });
      for await (const _event of stream) {
        // Drain the mocked SSE. The assertion is the outbound payload.
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(payload?.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(payload?.reasoning_effort).toBe("low");
  });

  it("sends Completions session affinity headers for a custom gateway", async () => {
    const runtime = createPiModelRuntime({
      apiKey: "test-key",
      baseUrl: "https://another-gateway.example/v1",
      modelId: "model-b",
      api: "openai-completions",
      contextWindow: 100_000,
      maxTokens: 8_000,
    });
    expect(runtime.primary.compat).toMatchObject({
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openai",
    });

    let headers: Headers | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      headers = new Headers(init?.headers);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const stream = runtime.streamFn(runtime.primary, {
        systemPrompt: "x",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
      }, { apiKey: "test-key", sessionId: "branch-session-1" });
      for await (const _event of stream) {
        // Drain the mocked SSE. The assertion is the outbound headers.
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(headers?.get("session_id") ?? headers?.get("session-id")).toBe("branch-session-1");
    expect(headers?.get("x-client-request-id")).toBe("branch-session-1");
    expect(headers?.get("x-session-affinity")).toBe("branch-session-1");
  });

  it("does not stamp Anthropic cache_control or OpenAI prompt_cache_key on a Zhipu host", async () => {
    const runtime = createPiModelRuntime({
      apiKey: "test-key",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      modelId: "glm-5.3-flash",
      api: "openai-completions",
      contextWindow: 200_000,
      maxTokens: 8_000,
    });

    let payload: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      payload = JSON.parse(String(init?.body ?? "{}"));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const stream = runtime.streamFn(runtime.primary, {
        systemPrompt: "x",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
      }, { apiKey: "test-key", sessionId: "branch-session-1", cacheRetention: "short", reasoning: "low" });
      for await (const _event of stream) {
        // Drain the mocked SSE. The assertion is the outbound payload.
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
    expect(JSON.stringify(payload)).not.toContain("cache_control");
  });
});
