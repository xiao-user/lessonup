import { describe, expect, it } from "vitest";
import { PiTransportTimer } from "./transport-timing.js";

describe("PiTransportTimer", () => {
  it("records only safe shape and latency metrics for the first provider turn", () => {
    let time = 1_000;
    const timer = new PiTransportTimer(() => time);

    timer.onPayload({ messages: [{ role: "user", content: "private" }], tools: [{ name: "read_document" }] });
    time += 120;
    timer.onResponse({ status: 200 });
    time += 380;
    timer.onAssistantMessageStart();
    time += 245;
    timer.onAssistantTextDelta();
    time += 75;
    timer.onAssistantMessageEnd();
    timer.onPayload({ messages: [], tools: [] });

    expect(timer.snapshot()).toMatchObject({
      providerRequestCount: 2,
      firstRequestMessageCount: 1,
      firstRequestToolCount: 1,
      firstProviderStatus: 200,
      firstRequestToResponseMs: 120,
      firstRequestToAssistantMs: 500,
      firstRequestToTextMs: 745,
      privateReasoningBeforeTextMs: 245,
      assistantStreamMs: 320,
    });
  });
});
