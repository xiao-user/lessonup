import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { parseStreamingJson } from "@earendil-works/pi-ai";
import type { Emit } from "./contracts.js";
import {
  safeToolCompletionDetail,
  safeToolDetail,
  safeToolPresentation,
} from "../../agent/tool-presentation.js";
import { PublicTextGuard } from "./session-state.js";
import { documentDraftFields } from "./document-draft.js";

function publicToolProgress(partialResult: unknown) {
  if (!partialResult || typeof partialResult !== "object") return undefined;
  const details = (partialResult as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const candidate = (details as { publicProgress?: unknown }).publicProgress;
  if (!candidate || typeof candidate !== "object") return undefined;
  const progress = candidate as { label?: unknown; current?: unknown; total?: unknown };
  if (typeof progress.label !== "string" || !progress.label.trim()) return undefined;
  return {
    label: progress.label.slice(0, 80),
    ...(typeof progress.current === "number" ? { current: progress.current } : {}),
    ...(typeof progress.total === "number" ? { total: progress.total } : {}),
  };
}

/**
 * The only browser-facing view of native Pi lifecycle events. This deliberately
 * contains no Agent control, queue, persistence, or business decisions.
 */
export function projectPublicPiEvents(args: {
  agent: Agent;
  runId: string;
  signal?: AbortSignal;
  emit: Emit;
  onTextDelta?: (delta: string, turn: number) => void | boolean | Promise<void | boolean>;
  documentDraftScope?: { fileId: string; baseDocumentVersion: number };
}) {
  let currentTurn = 0;
  const publicText = new PublicTextGuard();
  const toolPresentations = new Map<string, ReturnType<typeof safeToolPresentation> & { detail: string }>();
  let publishedTurnText = "";
  const draftCalls = new Set<string>();
  const draftArguments = new Map<string, string>();
  let lastDraftCheckpoint = 0;
  const publishDelta = async (delta: string) => {
    const published = await args.onTextDelta?.(delta, currentTurn);
    if (published !== false) publishedTurnText += delta;
  };
  const unsubscribe = args.agent.subscribe(async (event: AgentEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta" && args.documentDraftScope && !args.signal?.aborted) {
      const update = event.assistantMessageEvent;
      const call = update.partial.content[update.contentIndex];
      if (call?.type === "toolCall") {
        const json = (draftArguments.get(call.id) ?? "") + update.delta;
        draftArguments.set(call.id, json);
        const fields = documentDraftFields(call.name, parseStreamingJson(json));
        if (fields) {
          draftCalls.add(call.id);
          const persist = Date.now() - lastDraftCheckpoint >= 250;
          if (persist) lastDraftCheckpoint = Date.now();
          await args.emit({ type: "document.draft", runId: args.runId, toolCallId: call.id, ...args.documentDraftScope, fields }, { persist });
        }
      }
      return;
    }
    if (event.type === "agent_start") {
      await args.emit({ type: "agent.started", runId: args.runId });
      return;
    }
    if (event.type === "turn_start") {
      currentTurn += 1;
      await args.emit({ type: "turn.started", runId: args.runId, turn: currentTurn });
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      await args.emit({ type: "assistant.message.started", runId: args.runId, turn: currentTurn });
      return;
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = publicText.push(event.assistantMessageEvent.delta);
      if (publicText.hasViolation) {
        args.agent.abort();
        return;
      }
      if (delta) await publishDelta(delta);
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const delta = publicText.flush();
      if (delta) await publishDelta(delta);
      if (publishedTurnText) {
        await args.emit({
          type: "message.turn_text",
          runId: args.runId,
          turn: currentTurn,
          text: publishedTurnText,
        });
      }
      publishedTurnText = "";
      const outcome = event.message.stopReason === "error"
        ? "failed"
        : event.message.stopReason === "aborted"
          ? "cancelled"
          : "completed";
      await args.emit({ type: "assistant.message.ended", runId: args.runId, turn: currentTurn, outcome });
      return;
    }
    if (event.type === "tool_execution_start") {
      const presentation = {
        ...safeToolPresentation(event.toolName, event.args),
        detail: safeToolDetail(event.toolName, event.args),
      };
      toolPresentations.set(event.toolCallId, presentation);
      await args.emit({
        type: "tool.started",
        runId: args.runId,
        toolCallId: event.toolCallId,
        name: event.toolName,
        turn: currentTurn,
        ...presentation,
      });
      return;
    }
    if (event.type === "tool_execution_update") {
      const presentation = toolPresentations.get(event.toolCallId) ?? {
        ...safeToolPresentation(event.toolName, event.args),
        detail: safeToolDetail(event.toolName, event.args),
      };
      await args.emit({
        type: "tool.updated",
        runId: args.runId,
        toolCallId: event.toolCallId,
        name: event.toolName,
        turn: currentTurn,
        progress: publicToolProgress(event.partialResult),
        ...presentation,
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      draftArguments.delete(event.toolCallId);
      if (event.isError && draftCalls.has(event.toolCallId)) {
        await args.emit({ type: "document.draft.discarded", runId: args.runId, toolCallId: event.toolCallId });
      }
      const startedPresentation = toolPresentations.get(event.toolCallId) ?? {
        ...safeToolPresentation(event.toolName),
        detail: safeToolDetail(event.toolName),
      };
      const presentation = {
        ...startedPresentation,
        detail: safeToolCompletionDetail(
          event.toolName,
          startedPresentation.label,
          event.isError,
          startedPresentation.detail,
        ),
      };
      await args.emit({
        type: "tool.completed",
        runId: args.runId,
        toolCallId: event.toolCallId,
        name: event.toolName,
        ok: !event.isError,
        outcome: event.isError ? "needs_revision" : "completed",
        turn: currentTurn,
        ...presentation,
      });
      toolPresentations.delete(event.toolCallId);
      return;
    }
    if (event.type === "turn_end") {
      const outcome = event.message.role === "assistant" && event.message.stopReason === "error"
        ? "failed"
        : event.message.role === "assistant" && event.message.stopReason === "aborted"
          ? "cancelled"
          : "completed";
      await args.emit({ type: "turn.ended", runId: args.runId, turn: currentTurn, toolCount: event.toolResults.length, outcome });
      return;
    }
    if (event.type === "agent_end") {
      const outcome = args.agent.state.errorMessage
        ? "failed"
        : args.signal?.aborted
          ? "cancelled"
          : "completed";
      await args.emit({ type: "agent.ended", runId: args.runId, turnCount: currentTurn, outcome });
    }
  });
  return { unsubscribe, hasProtocolViolation: () => publicText.hasViolation };
}
