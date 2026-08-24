import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Check, GitBranch, History, MoreHorizontal, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import IceCreamHarness from "@/components/site/IceCreamHarness";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { branchDisplayLabel, presentAgentError } from "@/features/assistant/agent-run-control";
import { presentConversationMessages } from "@/features/assistant/conversation-messages";
import { canSendAgentMessage } from "@/features/assistant/attachment-state";
import { useAgentChat } from "@/features/assistant/use-agent-chat";
import {
  buildCurriculumNodeOptions,
  buildContextProfileFromTextbook,
  formatTextbookOptionLabel,
  formatTextbookSelectionLabel,
} from "@/features/curriculum/labels";
import { agentApi } from "@/lib/agent-api";

const CONTEXT_NONE = "__none__";

const statusText = {
  loading: "正在连接",
  ready: "可结合当前教案继续备课",
  streaming: "正在处理当前请求",
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
  onCanonicalDocument,
  onBeforeRun,
  onNavigateToSection,
  initialPrompt = null,
  onInitialPromptConsumed,
}) {
  const chat = useAgentChat({
    notebookId: notebook.id,
    lessonFileId: file.id,
    documentVersion: file.documentVersion,
    activeSectionId: activeSection,
    selection,
    onCanonicalDocument,
    onBeforeRun,
    starterSuggestionsEnabled: !initialPrompt,
  });
  const activeThread = chat.threads.find((thread) => thread.id === chat.activeThreadId);
  const starterSuggestions = activeThread?.starterSuggestions ?? [];
  const hasPendingThreads = chat.threads.some((thread) => thread.status === "awaiting_approval");
  const errorPresentation = chat.error ? presentAgentError(chat.error) : null;
  const presentedMessages = useMemo(() => (
    presentConversationMessages(chat.messages, chat.approvals)
  ), [chat.approvals, chat.messages]);
  const [renaming, setRenaming] = useState(false);
  const [threadTitle, setThreadTitle] = useState("");
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [contextDialogOpen, setContextDialogOpen] = useState(false);
  const [contextProfile, setContextProfile] = useState(file.contextProfile ?? {});
  const [savingContext, setSavingContext] = useState(false);
  const [contextTextbooks, setContextTextbooks] = useState([]);
  const [contextUnits, setContextUnits] = useState([]);
  const [contextLessonNodes, setContextLessonNodes] = useState([]);
  const [loadingContextCatalog, setLoadingContextCatalog] = useState(false);
  const attachmentInputRef = useRef(null);
  const initialPromptSentRef = useRef(false);

  useEffect(() => {
    const requestDashiPresentation = (event) => {
      const prompt = event.detail?.prompt;
      if (typeof prompt !== "string" || !prompt.trim()) return;
      if (chat.status !== "ready") {
        toast.info("备课助手完成当前请求后，再发起课堂演示设计。");
        return;
      }
      document.getElementById("lesson-assistant-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      void chat.send(prompt);
    };
    window.addEventListener("lessonup:request-dashi-presentation", requestDashiPresentation);
    return () => window.removeEventListener("lessonup:request-dashi-presentation", requestDashiPresentation);
  }, [chat.send, chat.status]);

  useEffect(() => {
    if (
      !initialPrompt
      || initialPromptSentRef.current
      || chat.status !== "ready"
      || chat.messages.length > 0
      || !chat.activeThreadId
      || !chat.activeBranchId
    ) return;
    initialPromptSentRef.current = true;
    onInitialPromptConsumed?.();
    void chat.send(initialPrompt);
  }, [
    chat.activeBranchId,
    chat.activeThreadId,
    chat.messages.length,
    chat.send,
    chat.status,
    initialPrompt,
    onInitialPromptConsumed,
  ]);

  useEffect(() => {
    if (!renaming) setThreadTitle(activeThread?.title ?? "");
  }, [activeThread?.title, renaming]);

  useEffect(() => {
    if (!contextDialogOpen) {
      setContextProfile(file.contextProfile ?? {});
      return undefined;
    }
    let cancelled = false;
    (async () => {
      setLoadingContextCatalog(true);
      try {
        const result = await agentApi.listCurriculumTextbooks({
          subject: notebook.subject,
          limit: 200,
        });
        if (cancelled) return;
        setContextTextbooks(result.textbooks ?? []);
        const textbookId = file.contextProfile?.textbookId;
        if (textbookId) {
          const [units, lessons] = await Promise.all([
            agentApi.listCurriculumNodes(textbookId, { rootsOnly: true }),
            file.contextProfile?.unitNodeId
              ? agentApi.listCurriculumNodes(textbookId, {
                parentId: file.contextProfile.unitNodeId,
                maxLevel: 5,
              })
              : Promise.resolve({ nodes: [] }),
          ]);
          if (!cancelled) {
            setContextUnits(units.nodes ?? []);
            setContextLessonNodes(lessons.nodes ?? []);
          }
        } else {
          setContextUnits([]);
          setContextLessonNodes([]);
        }
      } catch {
        if (!cancelled) {
          setContextTextbooks([]);
          setContextUnits([]);
          setContextLessonNodes([]);
        }
      } finally {
        if (!cancelled) setLoadingContextCatalog(false);
      }
    })();
    return () => { cancelled = true; };
  }, [contextDialogOpen, file.contextProfile, notebook.subject]);

  const commitThreadTitle = async () => {
    const title = threadTitle.trim();
    if (!title) return;
    await chat.updateActiveThread({ title });
    setRenaming(false);
  };

  const handleAttachment = async (event) => {
    const sourceFile = event.target.files?.[0];
    event.target.value = "";
    if (sourceFile) await chat.uploadKnowledge(sourceFile).catch(() => null);
  };

  const createThread = async () => {
    try {
      const result = await chat.createThread();
      if (result?.reason === "current_thread_empty") toast.info("当前已是新会话");
    } catch {
      toast.error("暂时无法新建会话");
    }
  };

  const saveContextProfile = async () => {
    setSavingContext(true);
    try {
      const durationText = String(contextProfile.lessonDurationMinutes ?? "").trim();
      const saved = await agentApi.updateLessonFile(file.id, {
        contextProfile: {
          gradeLevel: contextProfile.gradeLevel?.trim() || undefined,
          textbookEdition: contextProfile.textbookEdition?.trim() || undefined,
          textbookId: contextProfile.textbookId || undefined,
          unitNodeId: contextProfile.unitNodeId || undefined,
          lessonNodeId: contextProfile.lessonNodeId || undefined,
          lessonDurationMinutes: durationText ? Number(durationText) : undefined,
          learnerProfile: contextProfile.learnerProfile?.trim() || undefined,
          equipmentConditions: contextProfile.equipmentConditions?.trim() || undefined,
        },
      });
      onCanonicalDocument(saved);
      setContextDialogOpen(false);
      toast.success("教学情境已更新");
    } catch {
      toast.error("教学情境保存失败");
    } finally {
      setSavingContext(false);
    }
  };

  const selectedContextTextbookId = contextProfile.textbookId || CONTEXT_NONE;
  const selectedContextUnitId = contextProfile.unitNodeId || CONTEXT_NONE;
  const selectedContextLessonId = contextProfile.lessonNodeId || CONTEXT_NONE;
  const contextLessonOptions = useMemo(
    () => buildCurriculumNodeOptions(contextLessonNodes, selectedContextUnitId),
    [contextLessonNodes, selectedContextUnitId],
  );

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
                  <DropdownMenuItem onClick={() => setContextDialogOpen(true)}><Settings2 />教学情境</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => { setThreadTitle(activeThread.title); setRenaming(true); }}><Pencil />重命名</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => chat.removeActiveThread("archive")}><Archive />归档</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleteConfirmationOpen(true)}><Trash2 />删除</DropdownMenuItem>
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

      <IceCreamHarness
        chat={chat}
        messages={presentedMessages}
        statusText={statusText}
        emptyTitle={statusText[chat.status] ?? "备课助手"}
        emptyDescription={chat.status === "unconfigured"
          ? "请在服务端配置 MODEL_BASE_URL、MODEL_ID 和 MODEL_API_KEY。模型密钥不会进入浏览器。"
          : chat.error === "lesson_file_not_found"
            ? "请先确认导入本地备课数据，再开始新会话。"
            : errorPresentation?.message ?? "暂时无法开始会话。"}
        starterSuggestions={starterSuggestions}
        placeholder={`询问整份教案（当前定位：${activeSectionData.label}）…`}
        sendDisabled={!canSendAgentMessage({
          draft: chat.draft,
          uploads: chat.uploads,
          agentAvailable: chat.runtime?.agent,
          status: chat.status,
        })}
        uploadDisabled={!chat.runtime?.knowledge}
        attachmentInputRef={attachmentInputRef}
        onAttachment={handleAttachment}
        onNavigate={onNavigateToSection}
      />

      <Dialog open={deleteConfirmationOpen} onOpenChange={setDeleteConfirmationOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除这个备课会话？</DialogTitle>
            <DialogDescription>
              会话中的消息、分支和已解决审批将不再显示。若只想暂时收起，请使用“归档”。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => setDeleteConfirmationOpen(false)}>取消</Button>
            <Button
              variant="destructive"
              type="button"
              onClick={async () => {
                await chat.removeActiveThread("delete");
                setDeleteConfirmationOpen(false);
              }}
            >
              删除会话
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={contextDialogOpen} onOpenChange={setContextDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>教学情境</DialogTitle>
            <DialogDescription>
              这些条件帮助助手判断时间安排和课堂可执行性；不知道的项目可以留空，助手会明确说明不确定性。
            </DialogDescription>
          </DialogHeader>
          <div className="lesson-context-fields">
            <div>
              <Label htmlFor="lesson-textbook">教材册次</Label>
              <Select
                value={selectedContextTextbookId}
                disabled={loadingContextCatalog}
                onValueChange={async (value) => {
                  if (value === CONTEXT_NONE) {
                    setContextUnits([]);
                    setContextLessonNodes([]);
                    setContextProfile((current) => ({
                      ...current,
                      ...buildContextProfileFromTextbook(null),
                    }));
                    return;
                  }
                  const book = contextTextbooks.find((item) => item.id === value);
                  setContextProfile((current) => ({
                    ...current,
                    ...buildContextProfileFromTextbook(book),
                  }));
                  try {
                    const nodes = await agentApi.listCurriculumNodes(value, { rootsOnly: true });
                    setContextUnits(nodes.nodes ?? []);
                    setContextLessonNodes([]);
                  } catch {
                    setContextUnits([]);
                  }
                }}
              >
                <SelectTrigger id="lesson-textbook">
                  <SelectValue placeholder={loadingContextCatalog ? "加载教材…" : "选择教材"}>
                    {(value) => {
                      if (value === CONTEXT_NONE) return "暂不指定";
                      return formatTextbookSelectionLabel(
                        contextTextbooks.find((book) => book.id === value),
                      ) || "选择教材";
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={CONTEXT_NONE}>暂不指定</SelectItem>
                    {contextTextbooks.map((book) => (
                      <SelectItem value={book.id} key={book.id}>
                        {formatTextbookOptionLabel(book)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="lesson-unit">教材单元</Label>
              <Select
                value={selectedContextUnitId}
                disabled={selectedContextTextbookId === CONTEXT_NONE}
                onValueChange={async (value) => {
                  setContextLessonNodes([]);
                  setContextProfile((current) => ({
                    ...current,
                    unitNodeId: value === CONTEXT_NONE ? undefined : value,
                    lessonNodeId: undefined,
                  }));
                  if (value !== CONTEXT_NONE) {
                    try {
                      const result = await agentApi.listCurriculumNodes(
                        selectedContextTextbookId,
                        { parentId: value, maxLevel: 5 },
                      );
                      setContextLessonNodes(result.nodes ?? []);
                    } catch {
                      setContextLessonNodes([]);
                    }
                  }
                }}
              >
                <SelectTrigger id="lesson-unit">
                  <SelectValue placeholder={
                      selectedContextTextbookId === CONTEXT_NONE ? "先选择教材" : "可选单元"
                    }
                  >
                    {(value) => {
                      if (value === CONTEXT_NONE) return "暂不指定";
                      return contextUnits.find((node) => node.nodeId === value)?.title ?? "选择单元";
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={CONTEXT_NONE}>暂不指定</SelectItem>
                    {contextUnits.map((node) => (
                      <SelectItem value={node.nodeId} key={node.nodeId}>
                        {node.title}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="lesson-curriculum-node">具体课文或章节</Label>
              <Select
                value={selectedContextLessonId}
                disabled={selectedContextUnitId === CONTEXT_NONE}
                onValueChange={(value) => {
                  setContextProfile((current) => ({
                    ...current,
                    lessonNodeId: value === CONTEXT_NONE ? undefined : value,
                  }));
                }}
              >
                <SelectTrigger id="lesson-curriculum-node">
                  <SelectValue placeholder={
                      selectedContextUnitId === CONTEXT_NONE
                        ? "先选择单元"
                        : contextLessonOptions.length
                          ? "选择具体内容"
                          : "该单元暂无下级目录"
                    }
                  >
                    {(value) => {
                      if (value === CONTEXT_NONE) return "暂不指定";
                      return contextLessonOptions.find((node) => node.nodeId === value)?.label
                        ?? "选择具体内容";
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={CONTEXT_NONE}>暂不指定</SelectItem>
                    {contextLessonOptions.map((node) => (
                      <SelectItem value={node.nodeId} key={node.nodeId}>
                        {node.label}
                        {node.pageNumber ? ` · 第 ${node.pageNumber} 页` : ""}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="lesson-duration">本课时分钟</Label>
              <Input
                id="lesson-duration"
                type="number"
                min="10"
                max="180"
                value={contextProfile.lessonDurationMinutes ?? ""}
                onChange={(event) => setContextProfile((current) => ({
                  ...current,
                  lessonDurationMinutes: event.target.value,
                }))}
                placeholder="例如：40"
              />
            </div>
            <div>
              <Label htmlFor="lesson-learners">学情特征</Label>
              <Textarea
                id="lesson-learners"
                value={contextProfile.learnerProfile ?? ""}
                onChange={(event) => setContextProfile((current) => ({ ...current, learnerProfile: event.target.value }))}
                placeholder="例如：已完成预习，朗读基础较好，但概括能力较弱"
              />
            </div>
            <div>
              <Label htmlFor="lesson-equipment">设备与课堂条件</Label>
              <Textarea
                id="lesson-equipment"
                value={contextProfile.equipmentConditions ?? ""}
                onChange={(event) => setContextProfile((current) => ({ ...current, equipmentConditions: event.target.value }))}
                placeholder="例如：有投影，无学生平板"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => setContextDialogOpen(false)}>取消</Button>
            <Button
              type="button"
              disabled={savingContext}
              onClick={saveContextProfile}
            >
              {savingContext ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
