"use client";

import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

import ApprovalCard from "@/components/primitives/ApprovalCard.js";
import { approvalInteraction, approvalPhase } from "@/features/assistant/approval-state.js";
import ContextCards, { type ContextCardChunk } from "@/components/primitives/ContextCards.js";
import DiffTable, { type DiffRow } from "@/components/primitives/DiffTable.js";
import PromptBar from "@/components/primitives/PromptBar.js";
import StreamingText from "@/components/primitives/StreamingText.js";
import ThinkingState from "@/components/primitives/ThinkingState.js";
import ThinkingTrace from "@/components/primitives/ThinkingTrace.js";
import ToolChips, { type ToolActivity } from "@/components/primitives/ToolChips.js";
import { turnDurationMs } from "@/components/primitives/turn-duration.js";
import {
  presentActivitiesForMessage,
  presentAssistantTimeline,
  presentProcessTraceActive,
  presentThinkingVisible,
  presentTurnPhaseLabel,
  presentTurnState,
} from "@/features/assistant/agent-activity-state.js";
import {
  activeApprovalFrom,
  isAwaitingTeacherDecision,
  presentAgentError,
} from "@/features/assistant/agent-run-control.js";
import { presentPatchOperation } from "@/features/assistant/document-patch.js";
import { dashiThemeOptions } from "@/features/assistant/dashi-theme-options.js";

type HarnessProps = {
  chat: any;
  messages: any[];
  statusText: Record<string, string>;
  emptyTitle: string;
  emptyDescription: string;
  starterSuggestions?: string[];
  placeholder: string;
  sendDisabled: boolean;
  uploadDisabled?: boolean;
  showAttachment?: boolean;
  attachmentInputRef?: React.RefObject<HTMLInputElement | null>;
  onAttachment?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  resourceLabel?: string;
  resolveOperationTarget?: (operation: any, preview: any) => string | null;
  onNavigate?: (field: string, operation: any) => void;
};

function ScrollButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const onClick = useCallback(() => scrollToBottom(), [scrollToBottom]);
  if (isAtBottom) return null;
  return <button type="button" aria-label="回到最新消息" onClick={onClick} className="absolute right-3 bottom-3 z-10 flex size-8 items-center justify-center rounded-full bg-surface text-ink-2 shadow-raised transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.96]"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7" /></svg></button>;
}

function CopyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function UserTurn({ message }: { message: any }) {
  return (
    <article className="flex flex-col items-end gap-1.5 pl-10" aria-label="教师消息">
      <div className="max-w-[92%] rounded-[12px] bg-field px-3 py-2 text-[13px] leading-[1.55] text-ink shadow-hairline">{message.content}</div>
      {message.sources?.length ? (
        <div className="flex max-w-[92%] flex-wrap justify-end gap-1">
          {message.sources.map((source: any) => (
            <span key={source.id} className="rounded-chip bg-inset px-2 py-1 text-[10.5px] text-ink-3 shadow-hairline">{source.title}</span>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        aria-label="复制"
        onClick={() => navigator.clipboard.writeText(message.content)}
        className="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2"
      >
        <CopyIcon />
      </button>
    </article>
  );
}

function approvalRows(approval: any, resolveOperationTarget?: (operation: any, preview: any) => string | null, onNavigate?: (field: string, operation: any) => void): DiffRow[] {
  const operations = approval.patch?.operations ?? [];
  return operations.map((operation: any, index: number) => {
    const preview = presentPatchOperation(operation);
    return {
      key: `${operation.op ?? "document"}-${operation.unitId ?? operation.field ?? index}-${index}`,
      fieldLabel: preview.fieldLabel,
      target: resolveOperationTarget?.(operation, preview),
      before: preview.before,
      after: preview.after,
      fullBefore: preview.fullBefore,
      fullAfter: preview.fullAfter,
      isNoEffect: preview.isNoEffect,
      isTruncated: preview.isTruncated,
      onNavigate: onNavigate && preview.targetKind !== "framework" ? () => onNavigate(operation.field, operation) : null,
    };
  });
}

function presentationContextChunks(approval: any): ContextCardChunk[] {
  const goal = approval.patch?.goal;
  if (!goal?.slides?.length) return [];
  return goal.slides.map((slide: any, index: number) => {
    const copy = collectPresentationCopy(slide.props).join(" · ");
    return {
      id: `${slide.layout}-${index}`,
      title: `第 ${index + 1} 页`,
      chars: slide.layout,
      body: copy || "已完成版式与内容校验。",
      source: `${goal.themePack} · 幻灯片 ${index + 1}`,
      badge: "PPT",
      tone: "bg-green",
    };
  });
}

function collectPresentationCopy(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string" && value.trim()) output.push(value.trim());
  else if (typeof value === "number" && Number.isFinite(value)) output.push(String(value));
  else if (Array.isArray(value)) value.forEach((item) => collectPresentationCopy(item, output));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectPresentationCopy(item, output));
  }
  return [...new Set(output)];
}

function ApprovalArtifact({ approval, resourceLabel, resolveOperationTarget, onNavigate }: { approval: any; resourceLabel: string; resolveOperationTarget?: (operation: any, preview: any) => string | null; onNavigate?: (field: string, operation: any) => void }) {
  const presentation = approval.patch?.kind === "presentation_storyboard";
  if (presentation) {
    const chunks = presentationContextChunks(approval);
    return chunks.length ? <ContextCards title="课堂演示" chunks={chunks} /> : null;
  }
  const rows = approvalRows(approval, resolveOperationTarget, onNavigate);
  return rows.length ? <DiffTable title={`${resourceLabel}修改对比`} rows={rows} /> : null;
}

function ApprovalOutcome({ approval, resourceLabel }: { approval: any; resourceLabel: string }) {
  if (!approval || !["approved", "rejected"].includes(approval.state)) return null;
  const presentation = approval.patch?.kind === "presentation_storyboard";
  const label = presentation ? (approval.state === "approved" ? approval.delivery?.status === "ready" ? "课堂演示已保存" : "课堂演示方案已确认" : "已退回课堂演示") : (approval.state === "approved" ? `修改已写入${resourceLabel}` : "已保留原文");
  const hasArtifact = presentation ? presentationContextChunks(approval).length > 0 : approvalRows(approval).length > 0;
  if (hasArtifact && !(approval.patch && "baseDocumentVersion" in approval.patch)) return null;
  return <StreamingText content={label} />;
}

function AssistantTurn({ message, activities, status, sources, approvals, chat, resourceLabel, resolveOperationTarget, onNavigate }: any) {
  const streaming = message.status === "streaming" && status === "streaming" && !chat.error;
  const failure = message.status === "failed" && message.error !== "approval_resume_failed" ? presentAgentError(message.error ?? "agent_run_failed") : null;
  const statusNote = failure
    ? `${failure.message}${message.content ? " 已生成的内容仍保留；未确认的修改没有写入。" : ""}`
    : message.status === "cancelled"
      ? (message.content ? "已停止，以上是停止前生成的内容。" : "本次生成已停止。")
      : "";
  const continuationContent = message.continuationContent;
  const hasContent = Boolean(message.content);
  const canBranch = ["completed", "failed", "cancelled"].includes(message.status) && hasContent && !["streaming", "syncing", "awaiting_approval", "loading"].includes(chat.status);
  const visibleActivities = presentActivitiesForMessage(activities, message.status);
  const activeApproval = activeApprovalFrom(approvals);
  const decided = ["approved", "rejected"].includes(activeApproval?.state);
  const turnState = presentTurnState({
    messageStatus: message.status,
    chatStatus: status,
    turnStatus: message.turn?.status,
    hasActiveApproval: Boolean(activeApproval),
    awaitingTeacherDecision: isAwaitingTeacherDecision(activeApproval),
    hasError: Boolean(chat.error),
  });
  const hasRunningActivity = (visibleActivities ?? []).some((activity: ToolActivity) => activity.state === "running");
  const processActive = presentProcessTraceActive(turnState, {
    decided,
    hasRunningActivity,
  });
  const processState = processActive ? turnState : (turnState === "running" ? "completed" : turnState);
  const turnCompletedAt = processActive
    ? undefined
    : turnState === "awaiting_approval" || decided
      ? activeApproval?.createdAt
      : (message.turn?.completedAt ?? message.createdAt);
  const turnStartedAt = message.turn?.startedAt ?? message.createdAt;
  const hasProcess = (visibleActivities?.length ?? 0) > 0 || processActive;
  const showTrace = hasProcess || turnDurationMs(turnStartedAt, turnCompletedAt) > 0;
  const toolsRunning = hasRunningActivity;
  const showThinking = presentThinkingVisible({ processActive, toolsRunning });
  const timeline: Array<{ type: string; turn?: number; activities?: ToolActivity[]; content?: string }> = [
    ...presentAssistantTimeline(visibleActivities ?? [], message.turnTexts ?? {}, message.content),
    ...(statusNote ? [{ type: "text", content: statusNote }] : []),
  ];
  const lastTextIndex = timeline.findLastIndex((block) => block.type === "text");
  const interleaved = timeline.filter((block) => block.type === "tools").length > 1;
  const ownerStreaming = !continuationContent && streaming;
  const continuationStreaming = Boolean(continuationContent) && streaming;
  return <article className="flex min-w-0 flex-col gap-1.5" aria-label="备课助手回复">
    {showTrace ? (
      <ThinkingTrace startedAt={turnStartedAt} completedAt={turnCompletedAt} active={processActive} />
    ) : null}
    {timeline.map((block, index) => {
      if (block.type === "tools") {
        return <ToolChips
          key={`tools-${block.turn ?? index}`}
          state={processState}
          activities={block.activities ?? []}
          turnCount={interleaved ? undefined : message.turn?.currentTurn}
          plain={interleaved}
        />;
      }
      const lastText = index === lastTextIndex;
      return <StreamingText
        key={`text-${block.turn ?? index}`}
        content={block.content ?? ""}
        streaming={lastText && ownerStreaming}
        sources={lastText && !continuationContent ? sources : undefined}
        actions={lastText && !continuationContent}
        onCopy={lastText ? () => navigator.clipboard.writeText(message.content) : undefined}
        onRetry={lastText && message.status === "failed" ? chat.retry : undefined}
        onBranch={lastText && canBranch ? () => chat.branchFromMessage(message) : undefined}
      />;
    })}
    {showThinking
      ? <ThinkingState label={presentTurnPhaseLabel(message.turn?.phase) ?? "正在思考"} />
      : null}
    {approvals.map((approval: any) => <ApprovalArtifact key={`artifact-${approval.id}`} approval={approval} resourceLabel={resourceLabel} resolveOperationTarget={resolveOperationTarget} onNavigate={onNavigate} />)}
    {continuationContent ? <StreamingText content={continuationContent} streaming={continuationStreaming} sources={sources} onCopy={() => navigator.clipboard.writeText(continuationContent)} /> : null}
    {approvals.map((approval: any) => <ApprovalOutcome key={approval.id} approval={approval} resourceLabel={resourceLabel} />)}
  </article>;
}

function ActiveInteraction({ chat, resourceLabel }: any) {
  if (chat.pendingInteraction?.kind === "presentation_theme") {
    return <ApprovalCard title="选择一个视觉主题" description="选择后会作为下一条 Pi 输入；此时不会生成或写入任何内容。" options={dashiThemeOptions.map((theme) => ({ id: theme.id, title: `${theme.id} · ${theme.name}`, description: theme.character }))} onSelect={(theme) => chat.send(theme)} secondaryLabel="由助手选择" onSecondary={() => chat.send("由你选择合适的主题")} />;
  }
  const approval = chat.approval;
  if (!approval) return null;
  if (chat.documentApprovalInEditor && approval.patch && "baseDocumentVersion" in approval.patch) return null;
  const interaction = approvalInteraction(approval, resourceLabel);
  if (!interaction) return null;
  const { action, ...props } = interaction;
  return <ApprovalCard title={approval.patch.summary} {...props}
    onPrimary={() => action === "sync" ? chat.synchronizeConversation()
      : chat.respondApproval(action === "resume" ? approval.state === "approved" : true)}
    onSecondary={() => chat.respondApproval(false)} />;
}

/** Production Beautiful UI harness. Every state is derived from LessonUp's public Pi event projection. */
export default function IceCreamHarness({ chat, messages, statusText, emptyTitle, emptyDescription, starterSuggestions = [], placeholder, sendDisabled, uploadDisabled = false, showAttachment = true, attachmentInputRef, onAttachment, resourceLabel = "教案", resolveOperationTarget, onNavigate }: HarnessProps) {
  const latestAssistantIndex = messages.findLastIndex((message) => message.role === "assistant");
  const latestAssistant = latestAssistantIndex >= 0 ? messages[latestAssistantIndex] : null;
  const latestTurnOwnsError = latestAssistant?.status === "failed" && (latestAssistant.error ?? "agent_run_failed") === chat.error;
  const errorPresentation = chat.error ? presentAgentError(chat.error) : null;
  const suggestions = starterSuggestions.slice(0, 3);
  const promptStatus = chat.uploadError === "knowledge_source_empty"
    ? "文件内容为空，请添加正文后重新上传"
    : chat.uploadError
      ? "资料上传失败，请重试"
      : chat.status === "unconfigured" || chat.status === "error" || chat.status === "loading"
        ? statusText[chat.status] ?? chat.status
        : undefined;

  return <section className="grid flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-transparent text-ink">
    <StickToBottom className="relative overflow-hidden" role="log">
      <StickToBottom.Content className="flex min-h-full flex-col gap-5 px-4 py-4">
        {!messages.length && chat.status !== "streaming" && chat.status !== "ready" ? <div className="m-auto max-w-72 text-center"><span className="mx-auto mb-2 flex size-8 items-center justify-center rounded-card bg-inset text-ink-3 shadow-hairline"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg></span><p className="text-[13px] font-medium text-ink">{emptyTitle}</p><p className="mt-1 text-[12px] leading-relaxed text-ink-3">{emptyDescription}</p></div> : null}
        {messages.map((message, index) => {
          if (message.role !== "assistant") return <UserTurn key={message.id} message={message} />;
          const latest = index === latestAssistantIndex;
          const linked = chat.approvals.filter((approval: any) => approval.assistantMessageId === message.id || (!approval.assistantMessageId && latest));
          return <AssistantTurn key={message.id} message={message} activities={message.activities ?? (latest ? chat.activities : [])} status={latest ? chat.status : "ready"} sources={message.sources?.length ? message.sources : latest ? chat.sources : []} approvals={linked} chat={chat} resourceLabel={resourceLabel} resolveOperationTarget={resolveOperationTarget} onNavigate={onNavigate} />;
        })}
        {chat.error && !latestTurnOwnsError ? <StreamingText content={errorPresentation?.message ?? "助手暂时不可用"} onRetry={chat.status !== "awaiting_approval" && chat.error !== "document_context_stale" ? chat.retry : undefined} /> : null}
        {chat.syncError && approvalPhase(chat.approval) !== "syncing" ? <p role="status" className="text-[12px] text-ink-3">部分信息未同步，不影响已保存的结果。<button type="button" className="ml-1 underline" onClick={() => chat.synchronizeConversation()}>重新同步</button></p> : null}
        {!messages.length && chat.status === "ready" ? <div className="pb-2"><p className="px-2 pb-2 text-[12px] text-ink-3">{emptyTitle}</p>{suggestions.length ? <div className="flex flex-col gap-1" aria-label="建议操作">{suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => chat.send(suggestion)} className="rounded-control px-2 py-1.5 text-left text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink active:scale-[0.96]">{suggestion}</button>)}</div> : null}{chat.startersLoading ? <p className="px-2 text-[11.5px] text-ink-3">正在结合当前内容生成建议…</p> : null}{chat.startersError ? <p className="px-2 text-[11.5px] text-red">暂时未能生成建议 <button type="button" onClick={chat.retryStarters} className="ml-1 underline">重试</button></p> : null}</div> : null}
      </StickToBottom.Content>
      <ScrollButton />
    </StickToBottom>

    <PromptBar
      className="px-4 pt-2 pb-4"
      value={chat.draft}
      onChange={chat.setDraft}
      onSubmit={() => chat.send()}
      onStop={chat.stop}
      onAttach={onAttachment}
      attachmentInputRef={attachmentInputRef}
      uploads={showAttachment ? chat.uploads : []}
      onRemoveUpload={chat.dismissUpload}
      onRetryUpload={chat.retryUpload}
      status={chat.status}
      statusLabel={promptStatus}
      thinkingLevel={chat.thinkingLevel}
      onThinkingLevelChange={chat.setThinkingLevel}
      disabled={!chat.runtime?.agent || ["loading", "syncing", "awaiting_approval"].includes(chat.status)}
      sendDisabled={sendDisabled}
      uploadDisabled={uploadDisabled}
      showAttachment={showAttachment}
      placeholder={placeholder}
      queuedInputs={chat.queuedInputs}
      queueDelivery={chat.queueDelivery}
      onQueueDeliveryChange={chat.setQueueDelivery}
      onClearQueuedInputs={chat.clearQueuedInputs}
    >
      <ActiveInteraction chat={chat} resourceLabel={resourceLabel} />
    </PromptBar>
  </section>;
}
