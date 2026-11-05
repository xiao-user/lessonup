import { describe, expect, it } from "vitest";
import { PiTransportTimer } from "./transport-timing.js";

describe("PiTransportTimer", () => {
  it("records only safe shape and latency metrics for every provider turn", () => {
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
    time += 10;
    timer.onPayload({ messages: [{ role: "user" }, { role: "assistant" }], tools: [] });
    time += 90;
    timer.onResponse({ status: 200 });
    time += 210;
    timer.onAssistantMessageStart();
    time += 300;
    timer.onAssistantMessageEnd();

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
      requestTimings: [
        {
          request: 1,
          messageCount: 1,
          toolCount: 1,
          providerStatus: 200,
          requestToResponseMs: 120,
          requestToAssistantMs: 500,
          requestToTextMs: 745,
          privateReasoningBeforeTextMs: 245,
          assistantStreamMs: 320,
        },
        {
          request: 2,
          messageCount: 2,
          toolCount: 0,
          providerStatus: 200,
          requestToResponseMs: 90,
          requestToAssistantMs: 300,
          assistantStreamMs: 300,
        },
      ],
    });
  });
});
