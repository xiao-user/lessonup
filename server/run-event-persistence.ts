import type { NormalizedAgentEvent } from "./domain.js";

export function shouldPersistRunEvent(event: NormalizedAgentEvent) {
  return event.type !== "message.delta";
}
