/**
 * Numeric, provider-safe timing for one native Pi run. It deliberately keeps
 * no prompt, response body, URL, header, credential, or provider event data.
 */
export type PiTransportTiming = {
  providerRequestCount: number;
  /** Per-request timings in provider order; optional because some test transports omit payload callbacks. */
  requestTimings?: PiTransportRequestTiming[];
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

export type PiTransportRequestTiming = {
  request: number;
  payloadBytes?: number;
  messageCount?: number;
  toolCount?: number;
  providerStatus?: number;
  requestToResponseMs?: number;
  requestToAssistantMs?: number;
  requestToTextMs?: number;
  privateReasoningBeforeTextMs?: number;
  assistantStreamMs?: number;
};

type RequestMarks = {
  request: number;
  payloadBytes?: number;
  messageCount?: number;
  toolCount?: number;
  requestAt: number;
  responseAt?: number;
  assistantAt?: number;
  textAt?: number;
  assistantEndAt?: number;
  providerStatus?: number;
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
  private requestMarks: RequestMarks[] = [];

  constructor(now: Clock = Date.now) {
    this.now = now;
  }

  onPayload(payload: unknown) {
    this.requests += 1;
    const shape = payloadShape(payload);
    this.requestMarks.push({
      request: this.requests,
      requestAt: this.now(),
      payloadBytes: serializedByteLength(payload),
      messageCount: shape.messageCount,
      toolCount: shape.toolCount,
    });
    if (this.firstRequestAt !== undefined) return;
    const current = this.requestMarks.at(-1)!;
    this.firstRequestAt = current.requestAt;
    this.firstPayloadBytes = current.payloadBytes;
    this.firstMessageCount = shape.messageCount;
    this.firstToolCount = shape.toolCount;
  }

  onResponse(response: { status?: unknown }) {
    const current = this.requestMarks.at(-1);
    if (current && current.responseAt === undefined) {
      current.responseAt = this.now();
      if (typeof response.status === "number") current.providerStatus = response.status;
    }
    if (this.firstResponseAt !== undefined) return;
    this.firstResponseAt = this.now();
    if (typeof response.status === "number") this.firstStatus = response.status;
  }

  onAssistantMessageStart() {
    const current = this.requestMarks.at(-1);
    if (current && current.assistantAt === undefined) current.assistantAt = this.now();
    if (this.firstAssistantAt === undefined) this.firstAssistantAt = this.now();
  }

  onAssistantMessageEnd() {
    const current = this.requestMarks.at(-1);
    if (current && current.assistantEndAt === undefined) current.assistantEndAt = this.now();
    if (this.firstAssistantEndAt === undefined) this.firstAssistantEndAt = this.now();
  }

  onAssistantTextDelta() {
    const current = this.requestMarks.at(-1);
    if (current && current.textAt === undefined) current.textAt = this.now();
    if (this.firstTextAt === undefined) this.firstTextAt = this.now();
  }

  snapshot(): PiTransportTiming {
    return {
      providerRequestCount: this.requests,
      ...(this.requestMarks.length === 0 ? {} : {
        requestTimings: this.requestMarks.map((request): PiTransportRequestTiming => ({
          request: request.request,
          ...(request.payloadBytes === undefined ? {} : { payloadBytes: request.payloadBytes }),
          ...(request.messageCount === undefined ? {} : { messageCount: request.messageCount }),
          ...(request.toolCount === undefined ? {} : { toolCount: request.toolCount }),
          ...(request.providerStatus === undefined ? {} : { providerStatus: request.providerStatus }),
          ...(request.responseAt === undefined ? {} : { requestToResponseMs: request.responseAt - request.requestAt }),
          ...(request.assistantAt === undefined ? {} : { requestToAssistantMs: request.assistantAt - request.requestAt }),
          ...(request.textAt === undefined ? {} : { requestToTextMs: request.textAt - request.requestAt }),
          ...(request.assistantAt === undefined || request.textAt === undefined
            ? {}
            : { privateReasoningBeforeTextMs: request.textAt - request.assistantAt }),
          ...(request.assistantAt === undefined || request.assistantEndAt === undefined
            ? {}
            : { assistantStreamMs: request.assistantEndAt - request.assistantAt }),
        })),
      }),
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
