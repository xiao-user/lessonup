import { useEffect, useMemo, useRef, useState } from "react";
import { Check, GitBranch, History, MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";

import {
  CraftApproval,
  CraftAssistantTurn,
  CraftComposer,
  CraftConversation,
  CraftConversationContent,
  CraftConversationEmpty,
  CraftConversationScrollButton,
  CraftUserTurn,
} from "@/components/craft-agent/agent-chat";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  branchDisplayLabel,
  presentAgentError,
} from "@/features/assistant/agent-run-control";
import { canSendAgentMessage } from "@/features/assistant/attachment-state";
import { presentConversationMessages } from "@/features/assistant/agent-turn-presentation";
import { useAgentChat } from "@/features/assistant/use-agent-chat";

const statusText = {
  loading: "正在连接学期框架",
  ready: "可结合当前框架继续规划",
  streaming: "正在读取框架并分析",
  awaiting_approval: "有一项框架修改等待确认",
  unconfigured: "AI 服务尚未配置",
  error: "需要恢复",
};

export function SemesterFrameworkAgentPanel({
  notebook,
  aggregate,
  activeUnitId,
  unitTitleById,
  onCanonicalFramework,
  onNavigateToUnit,
  initialPrompt = null,
  onInitialPromptConsumed,
}) {
  const chat = useAgentChat({
    notebookId: notebook.id,
    semesterFrameworkId: aggregate.framework.id,
    frameworkVersion: aggregate.framework.version,
    activeSectionId: "semester-framework",
    activeUnitId,
    onCanonicalFramework,
  });
  const [actionsOpen, setActionsOpen] = useState(false);
  const initialPromptSentRef = useRef(null);
  const activeThread = chat.threads.find((thread) => thread.id === chat.activeThreadId);
  const starterSuggestions = activeThread?.starterSuggestions ?? [];
  const presentedMessages = useMemo(() => (
    presentConversationMessages(chat.messages, chat.approvals)
  ), [chat.approvals, chat.messages]);
  const latestAssistantIndex = presentedMessages.findLastIndex((message) => message.role === "assistant");
  const latestAssistant = latestAssistantIndex >= 0 ? presentedMessages[latestAssistantIndex] : null;
  const errorPresentation = chat.error ? presentAgentError(chat.error) : null;
  const latestTurnOwnsError = latestAssistant?.status === "failed"
    && (latestAssistant.error ?? "agent_run_failed") === chat.error;
  const hasContinuationFailureTurn = chat.messages.some((message) => (
    message.role === "assistant"
    && message.status === "failed"
    && message.error === "approval_resume_failed"
  ));
  const activeUnitTitle = unitTitleById.get(activeUnitId) ?? "整学期";
  const blueprintById = useMemo(() => new Map(aggregate.blueprints.map((blueprint) => [
    blueprint.id,
    blueprint,
  ])), [aggregate.blueprints]);

  useEffect(() => {
    if (!initialPrompt) return;
    if (initialPromptSentRef.current === initialPrompt) return;
    if (!chat.runtime?.agent || !chat.activeThreadId || !chat.activeBranchId) return;
    if (chat.status === "loading" || chat.status === "streaming" || chat.status === "awaiting_approval") {
      return;
    }
    initialPromptSentRef.current = initialPrompt;
    onInitialPromptConsumed?.();
    void chat.send(initialPrompt);
  }, [
    chat.activeBranchId,
    chat.activeThreadId,
    chat.runtime?.agent,
    chat.send,
    chat.status,
    initialPrompt,
    onInitialPromptConsumed,
  ]);
  const suggestions = useMemo(() => starterSuggestions.slice(0, 3), [starterSuggestions]);

  const createThread = async () => {
    try {
      const result = await chat.createThread();
      if (result?.reason === "current_thread_empty") toast.info("当前已是新会话");
    } catch {
      toast.error("暂时无法新建会话");
    }
  };

  return (
    <section className="framework-agent-panel" aria-label="学期规划助手">
      <header className="framework-agent-header">
        <div>
          <span>学期规划助手</span>
          <strong title={activeThread?.title ?? "新会话"}>{activeThread?.title ?? "新会话"}</strong>
        </div>
        <div className="framework-agent-header-actions">
          {chat.threads.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" type="button" aria-label="切换规划会话"><History /></Button>} />
              <DropdownMenuContent align="end">
                {chat.threads.map((thread) => (
                  <DropdownMenuItem key={thread.id} onClick={() => chat.selectThread(thread.id)}>
                    <span className="lesson-thread-menu-check" aria-hidden="true">{thread.id === chat.activeThreadId ? <Check /> : null}</span>
                    <span className="lesson-thread-menu-title">{thread.title}</span>
                    {thread.status === "awaiting_approval" ? <span className="lesson-thread-status-dot" aria-label="有修改等待确认" /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button size="icon-sm" variant="ghost" type="button" aria-label="新建规划会话" onClick={createThread}><Plus /></Button>
          {activeThread ? (
            <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
              <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" type="button" aria-label="会话操作"><MoreHorizontal /></Button>} />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => chat.removeActiveThread("archive")}>归档当前会话</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </header>

      <div className="framework-agent-context" title={`当前查看：${activeUnitTitle}`}>
        当前查看：{activeUnitTitle}
      </div>

      {chat.branches.length > 1 ? (
        <Select value={chat.activeBranchId ?? undefined} onValueChange={chat.switchBranch}>
          <SelectTrigger className="framework-agent-branch w-auto" size="sm" aria-label="切换消息分支">
            <GitBranch />
            <SelectValue>{(value) => {
              const index = chat.branches.findIndex((branch) => branch.id === value);
              return branchDisplayLabel(chat.branches[index], index);
            }}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            <SelectGroup>{chat.branches.map((branch, index) => (
              <SelectItem value={branch.id} key={branch.id}>{branchDisplayLabel(branch, index)}</SelectItem>
            ))}</SelectGroup>
          </SelectContent>
        </Select>
      ) : null}

      <CraftConversation className="framework-agent-conversation">
        <CraftConversationContent>
          {!chat.messages.length && chat.status !== "streaming" && chat.status !== "ready" ? (
            <CraftConversationEmpty
              title={statusText[chat.status] ?? "学期规划助手"}
              description={chat.status === "unconfigured"
                ? "请在服务端配置 DeepSeek 模型服务。"
                : errorPresentation?.message ?? "暂时无法开始会话。"}
            />
          ) : null}

          {presentedMessages.map((message, index) => {
            const isLatestAssistant = message.role === "assistant" && index === latestAssistantIndex;
            const linkedApprovals = chat.approvals.filter((approval) => (
              approval.assistantMessageId === message.id
              || (!approval.assistantMessageId && isLatestAssistant)
            ));
            if (message.role !== "assistant") {
              return <CraftUserTurn key={message.id} message={message} onCopy={() => navigator.clipboard.writeText(message.content)} />;
            }
            return (
                <CraftAssistantTurn
                  key={message.id}
                  message={message}
                  activities={message.activities ?? (isLatestAssistant ? chat.activities : [])}
                  status={isLatestAssistant ? chat.status : "ready"}
                  sources={message.sources?.length ? message.sources : isLatestAssistant ? chat.sources : []}
                  onCopy={() => navigator.clipboard.writeText(message.content)}
                  onRetry={message.status === "failed" ? chat.retry : undefined}
                  onBranch={["completed", "failed", "cancelled"].includes(message.status)
                    && Boolean(message.content)
                    && !["streaming", "awaiting_approval", "loading"].includes(chat.status)
                    ? () => chat.branchFromMessage(message)
                    : undefined}
                >
                {linkedApprovals.map((approval) => (
                  <CraftApproval
                    key={approval.id}
                    approval={approval}
                    resourceLabel="学期框架"
                    resolveOperationTarget={(operation, preview) => {
                      if (preview.targetKind === "unit") {
                        return unitTitleById.get(operation.unitId) ?? "单元";
                      }
                      if (preview.targetKind === "blueprint") {
                        if (operation.op === "create_lesson_blueprint") {
                          return unitTitleById.get(operation.semesterUnitId) ?? "课时蓝图";
                        }
                        return blueprintById.get(operation.blueprintId)?.title
                          ?? operation.expectedTitle
                          ?? "课时蓝图";
                      }
                      return "整学期";
                    }}
                    onApprove={() => chat.respondApproval(true)}
                    onReject={() => chat.respondApproval(false)}
                    onContinue={() => chat.respondApproval(approval.decision === "approved")}
                    onNavigate={(_field, operation) => {
                      const unitId = operation.unitId
                        ?? operation.semesterUnitId
                        ?? operation.expectedSemesterUnitId
                        ?? blueprintById.get(operation.blueprintId)?.semesterUnitId;
                      if (unitId) onNavigateToUnit(unitId);
                    }}
                    showContinuationNotice={approval.state === "continuation" && !hasContinuationFailureTurn}
                  />
                ))}
                </CraftAssistantTurn>
            );
          })}

          {chat.error ? (
            <>
              {!latestTurnOwnsError ? <p className="lesson-agent-error" role="alert">{errorPresentation.message}</p> : null}
              {!latestTurnOwnsError && chat.status !== "awaiting_approval" ? <Button size="sm" variant="outline" type="button" onClick={chat.retry}>{errorPresentation.retryLabel}</Button> : null}
            </>
          ) : null}
        </CraftConversationContent>
        <CraftConversationScrollButton />
      </CraftConversation>

      {chat.status === "ready" && !chat.messages.length && suggestions.length ? (
        <div className="framework-agent-suggestions" aria-label="建议操作">
          {suggestions.map((suggestion) => (
            <Button variant="ghost" size="sm" type="button" onClick={() => chat.send(suggestion)} key={suggestion}>{suggestion}</Button>
          ))}
        </div>
      ) : null}
      {chat.status === "ready" && !chat.messages.length && chat.startersLoading ? <p className="framework-agent-starter-status">正在结合当前框架生成建议…</p> : null}
      {chat.status === "ready" && !chat.messages.length && chat.startersError ? (
        <div className="framework-agent-starter-status"><span>暂时未能生成建议</span><Button size="sm" variant="ghost" type="button" onClick={chat.retryStarters}>重试</Button></div>
      ) : null}

      {chat.approval ? (
        <div className="framework-agent-approval-dock" role="status">
          <div><strong>{chat.approval.state === "continuation" ? "修改已确认" : "框架修改等待确认"}</strong><span>{chat.approval.patch.summary}</span></div>
          {chat.approval.state === "continuation" ? (
            <Button size="sm" onClick={() => chat.respondApproval(chat.approval.decision === "approved")}>继续生成</Button>
          ) : chat.approval.state === "pending" ? (
            <Button size="sm" variant="outline" onClick={() => document.getElementById(`approval-${chat.approval.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>查看并确认</Button>
          ) : null}
        </div>
      ) : null}

      <CraftComposer
        value={chat.draft}
        onChange={(event) => chat.setDraft(event.target.value)}
        onSubmit={(event) => { event.preventDefault(); chat.send(); }}
        onStop={chat.stop}
        uploads={[]}
        status={chat.status}
        statusLabel={statusText[chat.status] ?? chat.status}
        disabled={!chat.runtime?.agent || chat.status === "loading" || chat.status === "awaiting_approval"}
        sendDisabled={!canSendAgentMessage({ draft: chat.draft, uploads: [], agentAvailable: chat.runtime?.agent, status: chat.status })}
        showAttachment={false}
        placeholder={`询问学期框架（当前查看：${activeUnitTitle}）…`}
      />
    </section>
  );
}
