/**
 * Numeric, provider-safe timing for one native Pi run. It deliberately keeps
 * no prompt, response body, URL, header, credential, or provider event data.
 */
export type PiTransportTiming = {
  providerRequestCount: number;
  firstRequestPayloadBytes?: number;
  firstRequestMessageCount?: number;
  firstRequestToolCount?: number;
  firstProviderStatus?: number;
  firstRequestToResponseMs?: number;
  firstRequestToAssistantMs?: number;
  /** Time to the first browser-safe text delta; excludes private thinking. */
  firstRequestToTextMs?: number;
  /** Native assistant start → first browser-safe text delta. */
  privateReasoningBeforeTextMs?: number;
  assistantStreamMs?: number;
};

type Clock = () => number;

function payloadShape(payload: unknown) {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as { messages?: unknown; tools?: unknown };
  return {
    messageCount: Array.isArray(record.messages) ? record.messages.length : undefined,
    toolCount: Array.isArray(record.tools) ? record.tools.length : undefined,
  };
}

function serializedByteLength(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
}

export class PiTransportTimer {
  private readonly now: Clock;
  private requests = 0;
  private firstRequestAt?: number;
  private firstResponseAt?: number;
  private firstAssistantAt?: number;
  private firstTextAt?: number;
  private firstAssistantEndAt?: number;
  private firstPayloadBytes?: number;
  private firstMessageCount?: number;
  private firstToolCount?: number;
  private firstStatus?: number;

  constructor(now: Clock = Date.now) {
    this.now = now;
  }

  onPayload(payload: unknown) {
    this.requests += 1;
    if (this.firstRequestAt !== undefined) return;
    this.firstRequestAt = this.now();
    this.firstPayloadBytes = serializedByteLength(payload);
    const shape = payloadShape(payload);
    this.firstMessageCount = shape.messageCount;
    this.firstToolCount = shape.toolCount;
  }

  onResponse(response: { status?: unknown }) {
    if (this.firstResponseAt !== undefined) return;
    this.firstResponseAt = this.now();
    if (typeof response.status === "number") this.firstStatus = response.status;
  }

  onAssistantMessageStart() {
    if (this.firstAssistantAt === undefined) this.firstAssistantAt = this.now();
  }

  onAssistantMessageEnd() {
    if (this.firstAssistantEndAt === undefined) this.firstAssistantEndAt = this.now();
  }

  onAssistantTextDelta() {
    if (this.firstTextAt === undefined) this.firstTextAt = this.now();
  }

  snapshot(): PiTransportTiming {
    return {
      providerRequestCount: this.requests,
      ...(this.firstPayloadBytes === undefined ? {} : { firstRequestPayloadBytes: this.firstPayloadBytes }),
      ...(this.firstMessageCount === undefined ? {} : { firstRequestMessageCount: this.firstMessageCount }),
      ...(this.firstToolCount === undefined ? {} : { firstRequestToolCount: this.firstToolCount }),
      ...(this.firstStatus === undefined ? {} : { firstProviderStatus: this.firstStatus }),
      ...(this.firstRequestAt === undefined || this.firstResponseAt === undefined
        ? {}
        : { firstRequestToResponseMs: this.firstResponseAt - this.firstRequestAt }),
      ...(this.firstRequestAt === undefined || this.firstAssistantAt === undefined
        ? {}
        : { firstRequestToAssistantMs: this.firstAssistantAt - this.firstRequestAt }),
      ...(this.firstRequestAt === undefined || this.firstTextAt === undefined
        ? {}
        : { firstRequestToTextMs: this.firstTextAt - this.firstRequestAt }),
      ...(this.firstAssistantAt === undefined || this.firstTextAt === undefined
        ? {}
        : { privateReasoningBeforeTextMs: this.firstTextAt - this.firstAssistantAt }),
      ...(this.firstAssistantAt === undefined || this.firstAssistantEndAt === undefined
        ? {}
        : { assistantStreamMs: this.firstAssistantEndAt - this.firstAssistantAt }),
    };
  }
}
