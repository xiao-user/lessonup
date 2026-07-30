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
  Square,
  X,
} from "lucide-react";
import { Streamdown } from "streamdown";
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
    <Streamdown
      className="craft-markdown"
      isAnimating={isAnimating}
    >
      {children}
    </Streamdown>
  );
});

function ActivityStatusIcon({ state }) {
  if (state === "completed") return <Check aria-hidden="true" />;
  if (state === "failed") return <X aria-hidden="true" />;
  if (state === "running") return <LoaderCircle className="animate-spin" aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

function ThinkingState({ preparing = false }) {
  return (
    <div className="craft-thinking-state" role="status">
      <LoaderCircle className="animate-spin" aria-hidden="true" />
      <span>{preparing ? "正在组织回复…" : "思考中…"}</span>
    </div>
  );
}

function CraftActivityGroup({ activities, phase }) {
  const [expanded, setExpanded] = useState(true);
  const visibleActivities = presentAgentActivities(activities);
  const summary = agentActivitySummary(visibleActivities, phase);

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
        {shouldShowAgentThinking(phase) ? <ThinkingState preparing /> : null}
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
  if (!sources.length) return null;
  return (
    <details className="craft-sources">
      <summary>
        <BookOpen aria-hidden="true" />
        {sources.length} 个来源
        <ChevronDown aria-hidden="true" />
      </summary>
      <div>
        {sources.map((source) => source.url ? (
          <a href={source.url} target="_blank" rel="noreferrer" key={source.id}>{source.title}</a>
        ) : (
          <span key={source.id}>{source.title}{source.page ? ` · 第 ${source.page} 页` : ""}</span>
        ))}
      </div>
    </details>
  );
}

export function CraftUserTurn({ message, onCopy, onBranch }) {
  return (
    <article className="craft-turn craft-turn-user" data-from="user">
      <div className="craft-user-bubble">{message.content}</div>
      {message.status !== "streaming" ? <CraftTurnActions onCopy={onCopy} onBranch={onBranch} /> : null}
    </article>
  );
}

export function CraftAssistantTurn({
  message,
  activities = [],
  status,
  sources = [],
  onCopy,
}) {
  const hasResponse = Boolean(message.content);
  return (
    <article className="craft-turn craft-turn-assistant" data-from="assistant">
      <CraftTurnProcess activities={activities} status={status} responseText={message.content} />
      {hasResponse ? (
        <div className="craft-response-card">
          <div className="craft-response-content">
            <CraftMarkdown isAnimating={message.status === "streaming"}>{message.content}</CraftMarkdown>
          </div>
          {message.status !== "streaming" ? <CraftTurnActions onCopy={onCopy} /> : null}
        </div>
      ) : null}
      <CraftSources sources={sources} />
    </article>
  );
}

export function CraftAttachments({ uploads, onRemove }) {
  if (!uploads.length) return null;
  return (
    <div className="craft-attachments">
      {uploads.map((upload) => {
        const state = upload.status === "ready" ? "可用"
          : upload.status === "failed" ? "失败"
            : upload.status === "processing" ? "解析中"
              : "排队中";
        const label = `${upload.title} · ${state}`;
        return (
          <span className="craft-attachment" key={upload.id}>
            <FileText aria-hidden="true" />
            <span>{label}</span>
            <Button variant="ghost" size="icon-xs" type="button" onClick={() => onRemove(upload.id)} aria-label={`移除${label}`}><X /></Button>
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
}) {
  if (!approval) return null;
  const pending = approval.state === "pending" || approval.state === "responding";
  return (
    <section className="craft-approval" aria-label="教案修改确认">
      <h3>{approval.patch.summary}</h3>
      <div className="craft-approval-diff">
        {approval.patch.operations.map((operation, index) => (
          <div key={`${operation.field}-${operation.start}-${index}`}>
            <span>{operation.field} · {operation.start}—{operation.end}</span>
            <del>{operation.expectedText || "（空）"}</del>
            <ins>{operation.replacement || "（删除）"}</ins>
          </div>
        ))}
      </div>
      {approval.patch.citations?.length ? (
        <p>附有 {approval.patch.citations.length} 个可追溯来源</p>
      ) : null}
      {pending ? (
        <div className="craft-approval-actions">
          <Button type="button" variant="ghost" size="sm" onClick={onReject} disabled={approval.state === "responding"}><X data-icon="inline-start" />拒绝</Button>
          <Button type="button" size="sm" onClick={onApprove} disabled={approval.state === "responding"}><Check data-icon="inline-start" />接受修改</Button>
        </div>
      ) : (
        <p className="craft-approval-result"><Check aria-hidden="true" />{approval.state === "approved" ? "修改已写入，可通过教案撤销恢复" : "已保留原文"}</p>
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
  status,
  statusLabel,
  disabled,
  sendDisabled,
  uploadDisabled,
  placeholder,
}) {
  const running = status === "streaming";
  return (
    <form className="craft-composer" onSubmit={onSubmit}>
      <CraftAttachments uploads={uploads} onRemove={onRemoveUpload} />
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
