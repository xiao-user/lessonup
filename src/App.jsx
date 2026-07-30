import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Toaster } from "@/components/ui/sonner";
import { LessonFileWorkspace } from "@/features/lesson-files/lesson-file-workspace";
import { createLessonPlanDraft } from "@/features/lesson-files/data";
import { LocalImportDialog } from "@/features/auth/local-import-dialog";
import { CreateDialog } from "@/features/notebooks/create-dialog";
import { coverAssets, initialNotebooks } from "@/features/notebooks/data";
import { NotebookCollection } from "@/features/notebooks/notebook-collection";
import { agentApi } from "@/lib/agent-api";

const notebookTones = ["teal", "sage", "amber", "coral"];
const storageKey = "lessonup:notebooks:v1";
const importedStorageKey = "lessonup:server-imported:v1";

const loadNotebooks = () => {
  try {
    const saved = window.localStorage.getItem(storageKey);
    return saved ? JSON.parse(saved) : initialNotebooks;
  } catch {
    return initialNotebooks;
  }
};

export function App() {
  const [notebooks, setNotebooks] = useState(loadNotebooks);
  const [selectedId, setSelectedId] = useState(null);
  const [dialogKind, setDialogKind] = useState(null);
  const [activeFile, setActiveFile] = useState(null);
  const [importOffer, setImportOffer] = useState(false);
  const [importStatus, setImportStatus] = useState("idle");

  const selectedNotebook = notebooks.find((notebook) => notebook.id === selectedId);
  const activeNotebook = notebooks.find((notebook) => notebook.id === activeFile?.notebookId);
  const activeFileData = activeNotebook?.files.find((file) => file.id === activeFile?.fileId);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(notebooks));
  }, [notebooks]);

  const materializeNotebooks = () => notebooks.map((notebook) => ({
    id: notebook.id,
    title: notebook.title,
    className: notebook.className,
    year: notebook.year,
    subject: notebook.subject,
    files: notebook.files.map((file) => ({
      id: file.id,
      title: file.title,
      type: file.type,
      image: file.image,
      pages: file.pages,
      documentVersion: file.documentVersion ?? 0,
      lessonPlan: file.lessonPlan ?? createLessonPlanDraft(notebook, file),
    })),
  }));

  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;
    let attempts = 0;
    const connectStorage = async () => {
      try {
        const runtime = await agentApi.runtime();
        if (cancelled) return;
        const hasConfirmedImport = window.localStorage.getItem(importedStorageKey);
        if (!hasConfirmedImport && notebooks.length) {
          setImportOffer(true);
          return;
        }

        // The in-memory repository is intentionally ephemeral. Once the user has
        // confirmed import, rehydrate it after an API restart without asking them
        // to repeat the same consent step.
        if (runtime.persistence === "memory" && hasConfirmedImport) {
          await agentApi.importNotebooks(materializeNotebooks());
          window.dispatchEvent(new CustomEvent("lessonup:agent-storage-ready"));
        }
      } catch {
        if (!cancelled && attempts < 8) {
          attempts += 1;
          retryTimer = window.setTimeout(connectStorage, Math.min(2000, attempts * 250));
        }
      }
    };
    connectStorage();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, []);

  const importLocalData = async () => {
    setImportStatus("importing");
    try {
      await agentApi.importNotebooks(materializeNotebooks());
      window.localStorage.setItem(importedStorageKey, new Date().toISOString());
      setNotebooks((current) => current.map((notebook) => ({
        ...notebook,
        files: notebook.files.map((file) => ({
          ...file,
          lessonPlan: file.lessonPlan ?? createLessonPlanDraft(notebook, file),
          documentVersion: file.documentVersion ?? 0,
        })),
      })));
      setImportOffer(false);
      setImportStatus("done");
      window.dispatchEvent(new CustomEvent("lessonup:agent-storage-ready"));
      toast.success("本机备课数据已导入");
    } catch (error) {
      setImportStatus("error");
      toast.error(`导入失败：${error.message}`);
    }
  };

  const createItem = (values) => {
    if (dialogKind === "notebook") {
      const newNotebook = {
        id: `notebook-${Date.now()}`,
        title: values.title,
        className: values.className,
        year: "2025—2026 学年",
        subject: values.subject,
        tone: notebookTones[notebooks.length % notebookTones.length],
        updatedAt: Date.now(),
        files: [],
      };
      setNotebooks((current) => [newNotebook, ...current]);
      toast.success(`“${values.title}”已创建`);
    } else {
      const targetId = selectedId ?? values.notebookId;
      setNotebooks((current) => current.map((notebook) => notebook.id === targetId ? {
        ...notebook,
        updatedAt: Date.now(),
        files: [{
          id: `file-${Date.now()}`,
          title: values.title,
          type: "新教案",
          pages: 1,
          updated: "刚刚",
          image: coverAssets[notebook.files.length % coverAssets.length],
        }, ...notebook.files],
      } : notebook));
      toast.success(`“${values.title}”已加入备课本`);
    }
    setDialogKind(null);
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
      if (error.message === "lesson_file_not_found") return;
      toast.error(error.message === "stale_document"
        ? "云端教案已更新，请刷新后再继续编辑"
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
        aria-hidden={activeFile ? true : undefined}
        inert={Boolean(activeFile)}
      >
        <NotebookCollection
          notebooks={notebooks}
          selectedId={selectedId}
          activeFileId={activeFile?.fileId}
          onSelect={setSelectedId}
          onOpenFile={setActiveFile}
          onCreateNotebook={() => setDialogKind("notebook")}
          onCreateFile={() => setDialogKind("file")}
        />
      </section>
      {activeNotebook && activeFileData && (
        <LessonFileWorkspace
          notebook={activeNotebook}
          file={activeFileData}
          originRect={activeFile.originRect}
          onSave={updateLessonPlan}
          onAgentVersionCommitted={(lessonPlan, documentVersion) => (
            updateLocalLessonPlan(lessonPlan, activeFileData.pages, documentVersion)
          )}
          onClose={() => setActiveFile(null)}
          key={`${activeNotebook.id}-${activeFileData.id}`}
        />
      )}
      {dialogKind && (
        <CreateDialog
          kind={dialogKind}
          notebooks={notebooks}
          onClose={() => setDialogKind(null)}
          onCreate={createItem}
        />
      )}
      {importOffer && (
        <LocalImportDialog
          count={notebooks.length}
          status={importStatus}
          onConfirm={importLocalData}
          onLater={() => setImportOffer(false)}
        />
      )}
      <Toaster position="bottom-center" />
    </main>
  );
}
