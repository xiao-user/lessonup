import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Toaster } from "@/components/ui/sonner";
import { LessonFileWorkspace } from "@/features/lesson-files/lesson-file-workspace";
import { createLessonPlanDraft } from "@/features/lesson-files/data";
import { CreateDialog } from "@/features/notebooks/create-dialog";
import { coverAssets } from "@/features/notebooks/data";
import { NotebookCollection } from "@/features/notebooks/notebook-collection";
import { agentApi } from "@/lib/agent-api";
import { supabase } from "@/lib/supabase";

const notebookTones = ["teal", "sage", "amber", "coral"];
const formatUpdatedAt = (updatedAt) => new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
}).format(new Date(updatedAt));

const materializeNotebook = (notebook) => ({
  ...notebook,
  updatedAt: new Date(notebook.updatedAt).getTime(),
  files: (notebook.files ?? []).map((file) => ({
    ...file,
    pages: file.pageCount,
    updated: formatUpdatedAt(file.updatedAt),
  })),
});

export function App() {
  const [notebooks, setNotebooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [dialogKind, setDialogKind] = useState(null);
  const [activeFile, setActiveFile] = useState(null);

  const selectedNotebook = notebooks.find((notebook) => notebook.id === selectedId);
  const activeNotebook = notebooks.find((notebook) => notebook.id === activeFile?.notebookId);
  const activeFileData = activeNotebook?.files.find((file) => file.id === activeFile?.fileId);

  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;
    let attempts = 0;
    const loadWorkspace = async () => {
      try {
        const remoteNotebooks = await agentApi.listNotebooks();
        if (cancelled) return;
        setNotebooks(remoteNotebooks.map(materializeNotebook));
        setLoading(false);
        window.dispatchEvent(new CustomEvent("lessonup:agent-storage-ready"));
      } catch {
        if (!cancelled && attempts < 8) {
          attempts += 1;
          retryTimer = window.setTimeout(loadWorkspace, Math.min(2000, attempts * 250));
        } else if (!cancelled) {
          setLoading(false);
          toast.error("无法加载备课数据，请稍后重试");
        }
      }
    };
    loadWorkspace();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, []);

  const createItem = async (values) => {
    try {
      if (dialogKind === "notebook") {
        const notebook = await agentApi.createNotebook({
          title: values.title,
          className: values.className,
          year: "2025—2026 学年",
          subject: values.subject,
          stage: values.stage,
          grade: values.grade,
          edition: values.edition,
          tone: notebookTones[notebooks.length % notebookTones.length],
        });
        setNotebooks((current) => [materializeNotebook({ ...notebook, files: [] }), ...current]);
        toast.success(`“${values.title}”已创建`);
      } else {
        const targetId = values.notebookId || selectedId;
        const targetNotebook = notebooks.find((notebook) => notebook.id === targetId);
        if (!targetNotebook) throw new Error("notebook_not_found");
        const image = coverAssets[targetNotebook.files.length % coverAssets.length];
        const draftFile = { title: values.title, type: "新教案", image };
        const file = await agentApi.createLessonFile({
          notebookId: targetId,
          title: values.title,
          type: draftFile.type,
          image,
          document: createLessonPlanDraft(targetNotebook, draftFile, {
            unitTitle: values.unitTitle,
            lessonTitle: values.lessonTitle,
          }),
          contextProfile: values.contextProfile,
          pageCount: 1,
        });
        setNotebooks((current) => current.map((notebook) => notebook.id === targetId ? {
          ...notebook,
          updatedAt: Date.now(),
          files: [{
            ...file,
            lessonPlan: file.document,
            pages: file.pageCount,
            updated: "刚刚",
          }, ...notebook.files],
        } : notebook));
        toast.success(`“${values.title}”已加入备课本`);
      }
      setDialogKind(null);
    } catch (error) {
      toast.error(`创建失败：${error.message}`);
    }
  };

  const updateLocalLessonPlan = (lessonPlan, pageCount, documentVersion) => {
    setNotebooks((current) => current.map((notebook) => (
      notebook.id === activeFile.notebookId
        ? {
            ...notebook,
            updatedAt: Date.now(),
            files: notebook.files.map((file) => (
              file.id === activeFile.fileId
                ? {
                    ...file,
                    lessonPlan,
                    pages: pageCount,
                    updated: "刚刚",
                    ...(documentVersion === undefined ? {} : { documentVersion }),
                  }
                : file
            )),
          }
        : notebook
    )));
  };

  const openLessonFile = async (nextActiveFile) => {
    try {
      const remoteFile = await agentApi.getLessonFile(nextActiveFile.fileId);
      setNotebooks((current) => current.map((notebook) => (
        notebook.id === nextActiveFile.notebookId
          ? {
              ...notebook,
              files: notebook.files.map((file) => (
                file.id === nextActiveFile.fileId
                  ? {
                      ...file,
                      title: remoteFile.title,
                      type: remoteFile.type,
                      image: remoteFile.image ?? file.image,
                      lessonPlan: remoteFile.document,
                      documentVersion: remoteFile.documentVersion,
                      pages: remoteFile.pageCount,
                    }
                  : file
              )),
            }
          : notebook
      )));
      setActiveFile(nextActiveFile);
    } catch (error) {
      nextActiveFile.sourceElement?.focus({ preventScroll: true });
      toast.error(error.message === "lesson_file_not_found"
        ? "这份教案已不存在，请刷新备课本"
        : "暂时无法同步云端教案，助手会在版本一致后才开始工作");
    }
  };

  const closeLessonFile = () => {
    const sourceElement = activeFile?.sourceElement;
    setActiveFile(null);
    window.requestAnimationFrame(() => {
      if (sourceElement?.isConnected) sourceElement.focus({ preventScroll: true });
    });
  };

  const updateLessonPlan = async (
    lessonPlan,
    pageCount,
    source = "manual",
    baseDocumentVersion = activeFileData?.documentVersion ?? 0,
  ) => {
    updateLocalLessonPlan(lessonPlan, pageCount);
    if (source === "agent-local") return null;
    try {
      const saved = await agentApi.saveLessonDocument(activeFile.fileId, {
        baseVersion: baseDocumentVersion,
        document: lessonPlan,
        pageCount,
        source: source === "undo" ? "undo" : "manual",
      });
      updateLocalLessonPlan(saved.document, saved.pageCount, saved.documentVersion);
      return saved;
    } catch (error) {
      toast.error(error.message === "stale_document"
        ? "云端教案已更新，请刷新后再继续编辑"
        : error.message === "lesson_file_not_found"
          ? "这份教案已被删除，无法继续保存"
        : `云端保存失败：${error.message}`);
      throw error;
    }
  };

  return (
    <main id="top">
      <video className="background-video" autoPlay loop muted playsInline preload="auto" aria-hidden="true">
        <source src="/assets/contra-labs-background.mp4" type="video/mp4" />
      </video>
      <section
        className={`workspace ${selectedNotebook ? "is-focused" : ""} ${activeFile ? "has-file-open" : ""}`}
        inert={Boolean(activeFile)}
      >
        <NotebookCollection
          notebooks={notebooks}
          loading={loading}
          selectedId={selectedId}
          activeFileId={activeFile?.fileId}
          onSelect={setSelectedId}
          onOpenFile={openLessonFile}
          onCreateNotebook={() => setDialogKind("notebook")}
          onCreateFile={() => setDialogKind("file")}
          onSignOut={() => supabase?.auth.signOut()}
        />
      </section>
      {activeNotebook && activeFileData && (
        <LessonFileWorkspace
          notebook={activeNotebook}
          file={activeFileData}
          originRect={activeFile.originRect}
          onSave={updateLessonPlan}
          onAgentVersionCommitted={async (lessonPlan, documentVersion, pageCount) => {
            updateLocalLessonPlan(lessonPlan, pageCount, documentVersion);
            const saved = await agentApi.updateLessonPageCount(activeFileData.id, {
              documentVersion,
              pageCount,
            });
            updateLocalLessonPlan(saved.document, saved.pageCount, saved.documentVersion);
          }}
          onClose={closeLessonFile}
          key={`${activeNotebook.id}-${activeFileData.id}`}
        />
      )}
      {dialogKind && (
        <CreateDialog
          kind={dialogKind}
          notebooks={notebooks}
          initialNotebookId={selectedId}
          onClose={() => setDialogKind(null)}
          onCreate={createItem}
        />
      )}
      <Toaster position="bottom-center" />
    </main>
  );
}
