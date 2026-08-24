import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  GitBranch,
  History,
  Link2,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

import IceCreamHarness from "@/components/site/IceCreamHarness";
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
import { presentConversationMessages } from "@/features/assistant/conversation-messages";
import { useAgentChat } from "@/features/assistant/use-agent-chat";

const statusText = {
  loading: "正在连接学期框架",
  ready: "可结合当前框架继续规划",
  streaming: "正在处理当前请求",
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
  railMode = "assistant",
  onRailModeChange,
  continuitySlot = null,
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
  const errorPresentation = chat.error ? presentAgentError(chat.error) : null;
  const activeUnitTitle = unitTitleById.get(activeUnitId) ?? "整学期";
  const continuityOpen = railMode === "continuity";
  const hasPendingThreads = chat.threads.some((thread) => thread.status === "awaiting_approval");
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
  const createThread = async () => {
    try {
      const result = await chat.createThread();
      if (result?.reason === "current_thread_empty") toast.info("当前已是新会话");
    } catch {
      toast.error("暂时无法新建会话");
    }
  };

  const toggleContinuity = () => {
    onRailModeChange?.(continuityOpen ? "assistant" : "continuity");
  };

  return (
    <>
      <header className="lesson-assistant-header">
        <div className="lesson-agent-heading">
          <div className="lesson-agent-heading-main">
            <span
              className="lesson-agent-title"
              title={continuityOpen ? "教学衔接" : (activeThread?.title ?? "新会话")}
            >
              {continuityOpen ? "教学衔接" : (activeThread?.title ?? "新会话")}
            </span>
            {!continuityOpen && activeThread?.status === "awaiting_approval" ? (
              <span className="lesson-thread-status-dot" aria-label="有修改等待确认" />
            ) : null}
          </div>
          <div className="lesson-agent-heading-actions">
            <Button
              size="icon-sm"
              variant="ghost"
              type="button"
              aria-label={continuityOpen ? "返回助手" : "教学衔接"}
              aria-pressed={continuityOpen}
              onClick={toggleContinuity}
            >
              <Link2 aria-hidden="true" fill={continuityOpen ? "currentColor" : "none"} />
            </Button>
            {!continuityOpen && chat.threads.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={(
                    <Button className="lesson-history-trigger" size="icon-sm" variant="ghost" type="button" aria-label="切换规划会话">
                      <History />
                      {hasPendingThreads ? <span className="lesson-thread-status-dot" aria-label="有会话等待确认" /> : null}
                    </Button>
                  )}
                />
                <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
                  {chat.threads.map((thread) => (
                    <DropdownMenuItem key={thread.id} onClick={() => chat.selectThread(thread.id)}>
                      <span className="lesson-thread-menu-check" aria-hidden="true">
                        {thread.id === chat.activeThreadId ? <Check /> : null}
                      </span>
                      <span className="lesson-thread-menu-title">{thread.title}</span>
                      {thread.status === "awaiting_approval" ? (
                        <span className="lesson-thread-status-dot" aria-label="有修改等待确认" />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {!continuityOpen ? (
              <Button size="icon-sm" variant="ghost" type="button" aria-label="新建规划会话" onClick={createThread}>
                <Plus />
              </Button>
            ) : null}
            {!continuityOpen && activeThread ? (
              <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
                <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" type="button" aria-label="会话操作"><MoreHorizontal /></Button>} />
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => chat.removeActiveThread("archive")}>
                    <Archive />
                    归档
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>

        {!continuityOpen && chat.branches.length > 1 ? (
          <Select value={chat.activeBranchId ?? undefined} onValueChange={chat.switchBranch}>
            <SelectTrigger className="lesson-branch-select" size="sm" aria-label="切换消息分支">
              <GitBranch />
              <SelectValue>{(value) => {
                const index = chat.branches.findIndex((branch) => branch.id === value);
                return branchDisplayLabel(chat.branches[index], index);
              }}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              <SelectGroup>
                {chat.branches.map((branch, index) => (
                  <SelectItem value={branch.id} key={branch.id}>{branchDisplayLabel(branch, index)}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
      </header>

      {continuityOpen ? (
        <div className="framework-continuity-slot">
          {continuitySlot}
        </div>
      ) : (
        <IceCreamHarness
          chat={chat}
          messages={presentedMessages}
          statusText={statusText}
          emptyTitle={statusText[chat.status] ?? "学期规划助手"}
          emptyDescription={chat.status === "unconfigured"
            ? "请在服务端配置 OpenAI-compatible 模型服务。"
            : errorPresentation?.message ?? "暂时无法开始会话。"}
          starterSuggestions={starterSuggestions}
          placeholder={`询问学期框架（当前查看：${activeUnitTitle}）…`}
          sendDisabled={!canSendAgentMessage({ draft: chat.draft, uploads: [], agentAvailable: chat.runtime?.agent, status: chat.status })}
          showAttachment={false}
          resourceLabel="学期框架"
          resolveOperationTarget={(operation, preview) => {
            if (preview.targetKind === "unit") return unitTitleById.get(operation.unitId) ?? "单元";
            if (preview.targetKind === "blueprint") return operation.op === "create_lesson_blueprint"
              ? unitTitleById.get(operation.semesterUnitId) ?? "课时蓝图"
              : blueprintById.get(operation.blueprintId)?.title ?? operation.expectedTitle ?? "课时蓝图";
            return "整学期";
          }}
          onNavigate={(_field, operation) => {
            const unitId = operation.unitId ?? operation.semesterUnitId ?? operation.expectedSemesterUnitId ?? blueprintById.get(operation.blueprintId)?.semesterUnitId;
            if (unitId) onNavigateToUnit(unitId);
          }}
        />
      )}
    </>
  );
}
