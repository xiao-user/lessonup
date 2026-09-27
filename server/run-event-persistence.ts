import type { NormalizedAgentEvent } from "./domain.js";

const transientEventTypes = new Set<NormalizedAgentEvent["type"]>([
  "run.started",
  "agent.started",
  "turn.started",
  "assistant.message.started",
  "message.delta",
]);

export function shouldPersistRunEvent(event: NormalizedAgentEvent) {
  // These are live transport phases derived from an already durable run row.
  // Journaling each one forced four serial D1 writes before the first visible
  // token while adding no recoverable business fact. The browser still sees
  // the real Pi events; refresh derives the phase from the run/message rows.
  return !transientEventTypes.has(event.type);
}
