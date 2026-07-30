import type { TracingProcessor } from "@openai/agents";

export class LessonTracingProcessor implements TracingProcessor {
  private readonly started = new Map<string, number>();
  readonly metrics: Array<{ type: "trace" | "span"; id: string; durationMs: number }> = [];

  async onTraceStart(trace: { traceId: string }) { this.started.set(trace.traceId, performance.now()); }
  async onTraceEnd(trace: { traceId: string }) {
    const started = this.started.get(trace.traceId) ?? performance.now();
    this.metrics.push({ type: "trace", id: trace.traceId, durationMs: performance.now() - started });
    this.started.delete(trace.traceId);
    if (this.metrics.length > 1_000) this.metrics.splice(0, this.metrics.length - 1_000);
  }
  async onSpanStart(span: { spanId: string }) { this.started.set(span.spanId, performance.now()); }
  async onSpanEnd(span: { spanId: string }) {
    const started = this.started.get(span.spanId) ?? performance.now();
    this.metrics.push({ type: "span", id: span.spanId, durationMs: performance.now() - started });
    this.started.delete(span.spanId);
    if (this.metrics.length > 1_000) this.metrics.splice(0, this.metrics.length - 1_000);
  }
  async shutdown() {}
  async forceFlush() {}
}
