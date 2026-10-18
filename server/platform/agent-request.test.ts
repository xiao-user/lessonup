import { describe, expect, it } from "vitest";
import { AgentRequestBodyError, MAX_AGENT_REQUEST_BYTES, ownAgentRequest } from "../../cloudflare/agent-request.js";
describe("ownAgentRequest", () => {
  it("consumes the original body before forwarding and preserves bytes and headers", async () => {
    const source = new Request("https://lesson.test/api/agent/runs/one/cancel", { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: "{}" });
    const owned = await ownAgentRequest(source);
    expect(source.bodyUsed).toBe(true);
    expect(owned.json).toEqual({});
    expect(owned.request.headers.get("authorization")).toBe("Bearer test");
    expect(await owned.request.text()).toBe("{}");
  });
  it("does not consume GET and HEAD or mistake a response SSE stream for a request body", async () => {
    const source = new Request("https://lesson.test/api/agent/threads/one/activity");
    expect((await ownAgentRequest(source)).request).toBe(source);
  });
  it("accepts the schema's worst-case escaped selection and message size", async () => {
    const json = { selection: { fieldSnapshot: "\u0000".repeat(200_000), text: "\u0000".repeat(200_000) }, message: "\u0000".repeat(20_000) };
    const body = JSON.stringify(json);
    expect(new TextEncoder().encode(body).length).toBeLessThan(MAX_AGENT_REQUEST_BYTES);
    const owned = await ownAgentRequest(new Request("https://lesson.test/api/agent/threads/one/runs", { method: "POST", body }));
    expect(owned.json).toEqual(json);
  });
  it("bounds actual streamed bytes, independent of content-length", async () => {
    const source = new Request("https://lesson.test/api/agent/threads/one/runs", { method: "POST", body: "x".repeat(MAX_AGENT_REQUEST_BYTES + 1) });
    await expect(ownAgentRequest(source)).rejects.toMatchObject({ status: 413, code: "agent_request_too_large" });
  });
  it("returns a bounded input error for interrupted streams", async () => {
    const stream = new ReadableStream({ pull(controller) { controller.error(new Error("connection lost")); } });
    const source = new Request("https://lesson.test/api/agent/threads/one/runs", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(ownAgentRequest(source)).rejects.toBeInstanceOf(AgentRequestBodyError);
  });
});
