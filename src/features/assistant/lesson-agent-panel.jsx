import { Fragment, useEffect, useRef, useState } from "react";
import { Archive, Check, GitBranch, History, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { branchDisplayLabel, presentAgentError } from "@/features/assistant/agent-run-control";
import { canSendAgentMessage } from "@/features/assistant/attachment-state";
import { useAgentChat } from "@/features/assistant/use-agent-chat";

const statusText = {
  loading: "正在连接",
  ready: "可结合当前教案继续备课",
  streaming: "正在思考与调用备课能力",
  awaiting_approval: "有一项修改等待确认",
  unconfigured: "AI 服务尚未配置",
  error: "需要恢复",
};

export function LessonAgentPanel({
  notebook,
  file,
  activeSection,
  activeSectionData,
  selection,
  onClearSelection,
  onPatchApplied,
  onBeforeRun,
}) {
  const chat = useAgentChat({
    notebookId: notebook.id,
    lessonFileId: file.id,
    documentVersion: file.documentVersion,
    activeSectionId: activeSection,
    selection,
    onPatchApplied,
    onBeforeRun,
  });
  const activeThread = chat.threads.find((thread) => thread.id === chat.activeThreadId);
  const starterSuggestions = activeThread?.starterSuggestions ?? [];
  const hasPendingThreads = chat.threads.some((thread) => thread.status === "awaiting_approval");
  const errorPresentation = chat.error ? presentAgentError(chat.error) : null;
  const latestAssistantIndex = chat.messages.findLastIndex((message) => message.role === "assistant");
  const [renaming, setRenaming] = useState(false);
  const [threadTitle, setThreadTitle] = useState("");
  const attachmentInputRef = useRef(null);

  useEffect(() => {
    if (!renaming) setThreadTitle(activeThread?.title ?? "");
  }, [activeThread?.title, renaming]);

  const commitThreadTitle = async () => {
    const title = threadTitle.trim();
    if (!title) return;
    await chat.updateActiveThread({ title });
    setRenaming(false);
  };

  const submit = (event) => {
    event.preventDefault();
    chat.send();
  };

  const handleAttachment = async (event) => {
    const sourceFile = event.target.files?.[0];
    event.target.value = "";
    if (sourceFile) await chat.uploadKnowledge(sourceFile).catch(() => null);
  };

  const createThread = async () => {
    const result = await chat.createThread();
    if (result?.reason === "current_thread_empty") toast.info("当前已是新会话");
  };

  return (
    <>
      <header className="lesson-assistant-header">
        <div className="lesson-agent-heading">
          <div className="lesson-agent-heading-main">
            {renaming ? (
              <form className="lesson-thread-rename" onSubmit={(event) => { event.preventDefault(); commitThreadTitle(); }}>
                <Input value={threadTitle} onChange={(event) => setThreadTitle(event.target.value)} aria-label="会话名称" autoFocus maxLength={60} />
                <Button size="icon-sm" type="submit" aria-label="保存会话名称" disabled={!threadTitle.trim()}><Check /></Button>
                <Button size="icon-sm" variant="ghost" type="button" aria-label="取消重命名" onClick={() => setRenaming(false)}><X /></Button>
              </form>
            ) : (
              <>
                <span className="lesson-agent-title" title={activeThread?.title ?? "新会话"}>
                  {activeThread?.title ?? "新会话"}
                </span>
                {activeThread?.status === "awaiting_approval" ? (
                  <span className="lesson-thread-status-dot" aria-label="有修改等待确认" />
                ) : null}
              </>
            )}
          </div>
          <div className="lesson-agent-heading-actions">
            {chat.threads.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={(
                    <Button className="lesson-history-trigger" size="icon-sm" variant="ghost" type="button" aria-label="切换备课会话">
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
            )}
            <Button size="icon-sm" variant="ghost" type="button" aria-label="新建会话" onClick={createThread}>
              <Plus />
            </Button>
            {activeThread && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" type="button" aria-label="会话操作"><MoreHorizontal /></Button>} />
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => { setThreadTitle(activeThread.title); setRenaming(true); }}><Pencil />重命名</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => chat.removeActiveThread("archive")}><Archive />归档</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => chat.removeActiveThread("delete")}><Trash2 />删除</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {selection?.text && (
          <div className="lesson-selection-chip">
            <span>已选：{selection.text}</span>
            <Button variant="ghost" size="icon-xs" type="button" onClick={onClearSelection} aria-label="移除选区上下文"><X /></Button>
          </div>
        )}

        {chat.branches.length > 1 && (
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
        )}
      </header>

      <CraftConversation className="lesson-agent-conversation">
        <CraftConversationContent>
          {!chat.messages.length && chat.status !== "streaming" && chat.status !== "ready" && (
            <CraftConversationEmpty
              title={statusText[chat.status] ?? "备课助手"}
              description={chat.status === "unconfigured"
                ? "请在服务端配置 DEEPSEEK_API_KEY。模型密钥不会进入浏览器。"
                : chat.error === "lesson_file_not_found"
                  ? "请先确认导入本地备课数据，再开始新会话。"
                  : errorPresentation?.message ?? "暂时无法开始会话。"}
            />
          )}

          {chat.messages.map((message, index) => {
            const isLatestAssistant = message.role === "assistant" && index === latestAssistantIndex;
            const sources = message.sources?.length
              ? message.sources
              : isLatestAssistant
                ? chat.sources
                : [];
            const linkedApprovals = chat.approvals.filter((approval) => (
              approval.assistantMessageId === message.id
              || (!approval.assistantMessageId && isLatestAssistant)
            ));
            return message.role === "assistant" ? (
              <Fragment key={message.id}>
                <CraftAssistantTurn
                  message={message}
                  activities={isLatestAssistant ? chat.activities : []}
                  status={isLatestAssistant ? chat.status : "ready"}
                  sources={sources}
                  onCopy={() => navigator.clipboard.writeText(message.content)}
                  onBranch={message.status === "completed"
                    && chat.status !== "streaming"
                    && chat.status !== "awaiting_approval"
                    && chat.status !== "loading"
                    ? () => chat.branchFromMessage(message)
                    : undefined}
                />
                {linkedApprovals.map((approval) => (
                  <CraftApproval
                    approval={approval}
                    onApprove={() => chat.respondApproval(true)}
                    onReject={() => chat.respondApproval(false)}
                    onContinue={() => chat.respondApproval(approval.decision === "approved")}
                    key={approval.id}
                  />
                ))}
              </Fragment>
            ) : (
              <CraftUserTurn
                key={message.id}
                message={message}
                onCopy={() => navigator.clipboard.writeText(message.content)}
              />
            );
          })}

          {chat.error && chat.error !== "lesson_file_not_found" && (
            <>
              <p className="lesson-agent-error" role="alert">{errorPresentation.message}</p>
              {chat.status !== "awaiting_approval" && chat.error !== "document_context_stale" && (
                <Button size="sm" variant="outline" type="button" onClick={chat.retry}>{errorPresentation.retryLabel}</Button>
              )}
            </>
          )}
        </CraftConversationContent>
        <CraftConversationScrollButton />
      </CraftConversation>

      {chat.status === "ready" && !chat.messages.length && starterSuggestions.length > 0 && (
        <div className="lesson-assistant-suggestions" aria-label="建议操作">
          {starterSuggestions.slice(0, 3).map((suggestion, index) => (
            <Button className="lesson-assistant-suggestion" variant="ghost" size="sm" type="button" onClick={() => chat.send(suggestion)} key={suggestion}>
              <span data-tone={index % 2 ? "olive" : "teal"} aria-hidden="true" />{suggestion}
            </Button>
          ))}
        </div>
      )}
      {chat.status === "ready" && !chat.messages.length && chat.startersLoading ? (
        <p className="lesson-assistant-suggestions-status" role="status">正在结合当前教案生成建议…</p>
      ) : null}
      {chat.status === "ready" && !chat.messages.length && chat.startersError ? (
        <div className="lesson-assistant-suggestions-status" role="status">
          <span>暂时未能生成建议</span>
          <Button size="sm" variant="ghost" type="button" onClick={chat.retryStarters}>重新生成</Button>
        </div>
      ) : null}

      <CraftComposer
        value={chat.draft}
        onChange={(event) => chat.setDraft(event.target.value)}
        onSubmit={submit}
        onStop={chat.stop}
        onAttach={handleAttachment}
        attachmentInputRef={attachmentInputRef}
        uploads={chat.uploads}
        onRemoveUpload={chat.dismissUpload}
        onRetryUpload={chat.retryUpload}
        status={chat.status}
        statusLabel={chat.uploadError === "knowledge_source_empty"
          ? "文件内容为空，请添加正文后重新上传"
          : chat.uploadError
            ? "资料上传失败，请重试"
            : statusText[chat.status] ?? chat.status}
        disabled={!chat.runtime?.agent || chat.status === "loading" || chat.status === "awaiting_approval"}
        sendDisabled={!canSendAgentMessage({
          draft: chat.draft,
          uploads: chat.uploads,
          agentAvailable: chat.runtime?.agent,
          status: chat.status,
        })}
        uploadDisabled={!chat.runtime?.knowledge}
        placeholder={`询问整份教案（当前定位：${activeSectionData.label}）…`}
      />
    </>
  );
}
