/**
 * Conversation presentation adapted from Craft Agents' TurnCard and
 * InlineExecution components (Apache-2.0).
 *
 * This local adapter deliberately consumes only LessonUp's normalized events.
 * It does not depend on Craft's Electron session model or expose model reasoning.
 * See THIRD_PARTY_NOTICES.md.
 */
import { memo, useCallback, useState } from "react";
import {
  ArrowDown,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  CornerDownLeft,
  FileText,
  GitBranch,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  agentActivitySummary,
  agentTurnPhases,
  deriveAgentTurnPhase,
  presentAgentActivities,
  shouldShowAgentThinking,
} from "@/features/assistant/agent-turn-presentation";
import { presentAgentError } from "@/features/assistant/agent-run-control";
import { presentPatchOperation } from "@/features/assistant/document-patch";
import { dedupeAgentSources } from "@/features/assistant/source-state";
import { cn } from "@/lib/utils";

export function CraftConversation({ className, ...props }) {
  return <StickToBottom className={cn("craft-conversation", className)} role="log" {...props} />;
}

export function CraftConversationContent({ className, ...props }) {
  return <StickToBottom.Content className={cn("craft-conversation-content", className)} {...props} />;
}

export function CraftConversationEmpty({ title, description }) {
  return (
    <div className="craft-conversation-empty">
      <p>{title}</p>
      <span>{description}</span>
    </div>
  );
}

export function CraftConversationScrollButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const handleClick = useCallback(() => scrollToBottom(), [scrollToBottom]);
  if (isAtBottom) return null;
  return (
    <Button className="craft-scroll-button" variant="outline" size="icon-sm" onClick={handleClick} aria-label="回到最新消息">
      <ArrowDown />
    </Button>
  );
}

const CraftMarkdown = memo(function CraftMarkdown({ children, isAnimating = false }) {
  return (
    <div className="craft-markdown" data-streaming={isAnimating || undefined}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: linkChildren, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">{linkChildren}</a>
          ),
          table: ({ children: tableChildren }) => (
            <div className="craft-markdown-table-scroll">
              <table>{tableChildren}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

function ActivityStatusIcon({ state }) {
  if (state === "completed") return <Check aria-hidden="true" />;
  if (state === "failed") return <X aria-hidden="true" />;
  if (state === "running") return <LoaderCircle className="animate-spin" aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

function ThinkingState({ preparing = false, revising = false }) {
  return (
    <div className="craft-thinking-state" role="status">
      <LoaderCircle className="animate-spin" aria-hidden="true" />
      <span>{revising ? "正在修正修改建议…" : preparing ? "正在生成下一步…" : "思考中…"}</span>
    </div>
  );
}

function CraftActivityGroup({ activities, phase }) {
  const [expanded, setExpanded] = useState(true);
  const visibleActivities = presentAgentActivities(activities);
  const summary = agentActivitySummary(visibleActivities, phase);
  const revising = visibleActivities.some((activity) => (
    activity.name?.startsWith("propose_")
    && (activity.state === "failed" || activity.attempts > 1)
  ));

  return (
    <details
      className="craft-activity-group"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary aria-label={`任务组：${summary}`}>
        <ChevronRight className="craft-activity-chevron" aria-hidden="true" />
        <span className="craft-activity-count">{visibleActivities.length}</span>
        <span>{summary}</span>
      </summary>
      <div className="craft-activity-list">
        {visibleActivities.map((activity) => (
          <div className="craft-activity-row" data-state={activity.state} key={activity.id}>
            <ActivityStatusIcon state={activity.state} />
            <span>{activity.label}</span>
            <small>{activity.state === "completed" ? "完成" : activity.state === "failed" ? "失败" : "进行中"}</small>
          </div>
        ))}
        {shouldShowAgentThinking(phase) ? <ThinkingState preparing revising={revising} /> : null}
      </div>
    </details>
  );
}

function CraftTurnProcess({ activities, status, responseText }) {
  const phase = deriveAgentTurnPhase({ activities, status, responseText });
  const showStandaloneThinking = !activities.length && shouldShowAgentThinking(phase);
  const showStreaming = phase === agentTurnPhases.streaming;
  if (!activities.length && !showStandaloneThinking && !showStreaming) return null;

  return (
    <div className="craft-turn-process" data-phase={phase}>
      {activities.length ? <CraftActivityGroup activities={activities} phase={phase} /> : null}
      {showStandaloneThinking ? <ThinkingState /> : null}
      {showStreaming ? (
        <div className="craft-response-streaming" role="status">
          <LoaderCircle className="animate-spin" aria-hidden="true" />
          <span>正在回复…</span>
        </div>
      ) : null}
    </div>
  );
}

function CraftTurnActions({ onCopy, onBranch }) {
  return (
    <div className="craft-turn-actions">
      <Button type="button" variant="ghost" size="sm" onClick={onCopy}>
        <Copy data-icon="inline-start" />复制
      </Button>
      {onBranch ? (
        <Button type="button" variant="ghost" size="sm" aria-label="从此消息创建分支" onClick={onBranch}>
          <GitBranch data-icon="inline-start" />从此创建分支
        </Button>
      ) : null}
    </div>
  );
}

function CraftSources({ sources }) {
  const visibleSources = dedupeAgentSources(sources);
  if (!visibleSources.length) return null;
  return (
    <details className="craft-sources">
      <summary>
        <BookOpen aria-hidden="true" />
        {visibleSources.length} 个来源
        <ChevronDown aria-hidden="true" />
      </summary>
      <div>
        {visibleSources.map((source) => source.url ? (
          <a href={source.url} target="_blank" rel="noreferrer" key={source.id}>{source.title}</a>
        ) : (
          <span key={source.id}>{source.title}{source.page ? ` · 第 ${source.page} 页` : ""}</span>
        ))}
      </div>
    </details>
  );
}

export function CraftUserTurn({ message, onCopy }) {
  return (
    <article className="craft-turn craft-turn-user" data-from="user" aria-label="教师消息">
      <div className="craft-user-bubble">{message.content}</div>
      {message.sources?.length ? (
        <div className="craft-message-attachments" aria-label="随消息发送的资料">
          {message.sources.map((source) => (
            <span className="craft-message-attachment" key={source.id} title={source.title}>
              <FileText aria-hidden="true" />
              <span>{source.title}</span>
            </span>
          ))}
        </div>
      ) : null}
      {message.status !== "streaming" ? <CraftTurnActions onCopy={onCopy} /> : null}
    </article>
  );
}

export function CraftAssistantTurn({
  message,
  activities = [],
  status,
  sources = [],
  children,
  onCopy,
  onBranch,
  onRetry,
}) {
  const hasResponse = Boolean(message.content);
  const failure = message.status === "failed"
    ? presentAgentError(message.error ?? "agent_run_failed")
    : null;
  return (
    <article className="craft-turn craft-turn-assistant" data-from="assistant" aria-label="备课助手回复">
      <CraftTurnProcess activities={activities} status={status} responseText={message.content} />
      {hasResponse || failure ? (
        <div className="craft-response-card">
          {hasResponse ? <div className="craft-response-content">
            <CraftMarkdown isAnimating={message.status === "streaming"}>{message.content}</CraftMarkdown>
          </div> : null}
          {failure ? (
            <div className="craft-turn-failed" role="status">
              <p>{hasResponse
                ? `${failure.message} 已生成的内容和执行记录仍保留在本轮中；未确认的修改没有写入。`
                : failure.message}</p>
              {onRetry ? <Button size="sm" variant="outline" type="button" onClick={onRetry}><RotateCcw />{failure.retryLabel}</Button> : null}
            </div>
          ) : null}
          {message.status !== "streaming" && hasResponse ? <CraftTurnActions onCopy={onCopy} onBranch={onBranch} /> : null}
        </div>
      ) : null}
      {message.status === "cancelled" ? (
        <p className="craft-turn-cancelled" role="status">
          {hasResponse ? "已停止，以上是停止前生成的内容。" : "本次生成已停止。"}
        </p>
      ) : null}
      {children}
      <CraftSources sources={sources} />
    </article>
  );
}

export function CraftAttachments({ uploads, onRemove, onRetry }) {
  if (!uploads.length) return null;
  return (
    <div className="craft-attachments">
      {uploads.map((upload) => {
        const state = upload.status === "ready" ? "可用"
          : upload.status === "failed" && upload.last_error === "knowledge_source_empty" ? "文件内容为空"
            : upload.status === "failed" ? "处理失败"
            : upload.status === "processing" ? "解析中"
              : "排队中";
        const label = `${upload.title}，${state}`;
        const retryable = upload.status === "failed" && upload.last_error !== "knowledge_source_empty";
        return (
          <span className="craft-attachment" key={upload.id}>
            <FileText aria-hidden="true" />
            <span className="craft-attachment-name" title={upload.title}>{upload.title}</span>
            <span className="craft-attachment-status">{state}</span>
            {retryable && (
              <Button variant="ghost" size="icon-xs" type="button" onClick={() => onRetry(upload.id)} aria-label={`重试${label}`}>
                <RotateCcw />
              </Button>
            )}
            <Button variant="ghost" size="icon-xs" type="button" onClick={() => onRemove(upload.id)} aria-label={`删除${label}`}><X /></Button>
          </span>
        );
      })}
    </div>
  );
}

export function CraftApproval({
  approval,
  onApprove,
  onReject,
  onContinue,
  onNavigate,
  resolveOperationTarget,
  resourceLabel = "教案",
  showContinuationNotice = false,
}) {
  if (!approval) return null;
  const pending = approval.state === "pending" || approval.state === "responding";
  const projection = approval.patch.projection;
  const completeLessonChange = Boolean(approval.patch.designBasisPatch);
  const quality = approval.patch.qualityPrediction;
  const qualityIssueLabels = {
    missing_core_content: "核心栏目仍有空缺",
    generic_reusable_content: "存在通用模板表述",
    process_too_thin: "教学过程偏简略",
    learner_action_missing: "缺少明确学生任务",
    assessment_evidence_missing: "评价证据不够可观察",
    duration_exceeds_context: "时间安排超过当前课时",
  };
  return (
    <section className="craft-approval" id={`approval-${approval.id}`} aria-label={`${resourceLabel}修改确认`}>
      <h3>{approval.patch.summary}</h3>
      {quality ? (
        <p className={`craft-approval-quality ${quality.passed ? "is-passed" : "needs-attention"}`}>
          {quality.passed
            ? "语义质量检查通过"
            : `语义质量建议关注：${quality.issues.map((issue) => qualityIssueLabels[issue] ?? issue).join("；")}`}
        </p>
      ) : null}
      {projection ? (
        <div className="craft-approval-projection-context">
          <p>
            {completeLessonChange
              ? `Agent 将保存本轮形成的教学判断，并同步调整下方 ${approval.patch.operations.length} 个教案栏目。你只需确认一次；任一部分发生冲突都不会写入。`
              : `本次将根据 ${projection.entryRefs.length} 条已确认教学决定${projection.expectedLearnerContext ? "及当前学情" : ""}调整下方教案栏目，不建立自动同步。`}
          </p>
          {projection.entryRefs.length ? (
            <details>
              <summary>查看调整理由</summary>
              <ul>
                {projection.entryRefs.map((entry) => (
                  <li key={entry.entryId}>{entry.expectedStatement}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
      <div className="craft-approval-diff">
        {approval.patch.operations.map((operation, index) => {
          const preview = presentPatchOperation(operation);
          const targetLabel = resolveOperationTarget?.(operation, preview);
          return (
            <div key={`${operation.op ?? "document"}-${operation.unitId ?? operation.field}-${operation.start ?? index}-${index}`}>
              <div className="craft-approval-diff-heading">
                <span>{targetLabel ? `${targetLabel} · ${preview.fieldLabel}` : preview.fieldLabel}</span>
                {onNavigate && preview.targetKind !== "framework" ? (
                  <Button type="button" variant="ghost" size="xs" onClick={() => onNavigate(operation.field, operation)}>
                    在{resourceLabel}中定位
                  </Button>
                ) : null}
              </div>
              {preview.isNoEffect ? (
                <p className="craft-approval-no-effect">这项历史建议没有产生实际内容变化。</p>
              ) : (
                <>
                  <del>{preview.before || "（新增内容）"}</del>
                  <ins>{preview.after || "（删除这段内容）"}</ins>
                </>
              )}
              {preview.isTruncated && !preview.isNoEffect ? (
                <details>
                  <summary>展开完整对比</summary>
                  <del>{preview.fullBefore || "（新增内容）"}</del>
                  <ins>{preview.fullAfter || "（删除这段内容）"}</ins>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
      {approval.patch.citations?.length ? (
        <p>附有 {approval.patch.citations.length} 个可追溯来源</p>
      ) : null}
      {approval.state === "continuation" ? (
        <>
          {showContinuationNotice ? (
            <p className="craft-approval-result">
              修改决定已经保存，但后续回复未能恢复。{resourceLabel}状态不会被重复写入。
            </p>
          ) : null}
          <div className="craft-approval-actions">
            <Button type="button" size="sm" onClick={onContinue}>
              继续生成
            </Button>
          </div>
        </>
      ) : approval.state === "responding" ? (
        <div className="craft-approval-progress" role="status">
          <LoaderCircle className="animate-spin" aria-hidden="true" />
          <span>{approval.decision === "approved" ? "正在应用修改并继续生成…" : "正在保留原文并继续生成…"}</span>
        </div>
      ) : pending ? (
        <div className="craft-approval-actions">
          <Button type="button" variant="ghost" size="sm" onClick={onReject} disabled={approval.state === "responding"}><X data-icon="inline-start" />拒绝</Button>
          <Button type="button" size="sm" onClick={onApprove} disabled={approval.state === "responding"}><Check data-icon="inline-start" />接受修改</Button>
        </div>
      ) : (
        <p className="craft-approval-result"><Check aria-hidden="true" />{
          approval.state === "approved"
            ? completeLessonChange
              ? "备课调整已完成；教案正文可通过撤销恢复"
              : projection
              ? "已写入 A4，可通过教案撤销；原设计依据保持不变"
              : resourceLabel === "教案" ? "修改已写入，可通过教案撤销恢复" : `修改已写入${resourceLabel}`
            : completeLessonChange
              ? "已取消本次备课调整"
              : resourceLabel === "教案" ? "已保留原文" : `已保留原${resourceLabel}`
        }</p>
      )}
    </section>
  );
}

export function CraftComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  onAttach,
  attachmentInputRef,
  uploads,
  onRemoveUpload,
  onRetryUpload,
  status,
  statusLabel,
  disabled,
  sendDisabled,
  uploadDisabled,
  showAttachment = true,
  placeholder,
}) {
  const running = status === "streaming";
  return (
    <form className="craft-composer" onSubmit={onSubmit}>
      <CraftAttachments uploads={uploads} onRemove={onRemoveUpload} onRetry={onRetryUpload} />
      <Textarea
        className="craft-composer-textarea"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-label="向备课助手提问"
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="craft-composer-footer">
        <div>
          {showAttachment ? (
            <>
              <input
                ref={attachmentInputRef}
                className="sr-only"
                type="file"
                accept=".pdf,.docx,.pptx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown"
                onChange={onAttach}
                aria-label="选择备课资料"
              />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="上传备课资料"
                title={uploadDisabled ? "资料库服务尚未配置" : "上传备课资料"}
                disabled={uploadDisabled}
                onClick={() => attachmentInputRef.current?.click()}
              >
                <Paperclip />
              </Button>
            </>
          ) : null}
          <span>{statusLabel}</span>
        </div>
        <Button
          size="icon-sm"
          type={running ? "button" : "submit"}
          aria-label={running ? "停止生成" : "发送"}
          disabled={!running && sendDisabled}
          onClick={running ? onStop : undefined}
        >
          {running ? <Square /> : <CornerDownLeft />}
        </Button>
      </div>
    </form>
  );
}
