import { useEffect, useState } from "react";
import gsap from "gsap";
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

const lessonFileRoute = (fileId) => `/lesson-files/${encodeURIComponent(fileId)}`;
const getLessonFileRouteId = () => {
  const match = window.location.pathname.match(/^\/lesson-files\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};

const animatePageCopy = (page, opacity) => {
  const targets = page ? [...page.children] : [];
  if (!targets.length) return Promise.resolve();
  gsap.killTweensOf(targets);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    gsap.set(targets, { autoAlpha: opacity });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    gsap.to(targets, {
      autoAlpha: opacity,
      duration: 0.18,
      ease: "sine.inOut",
      overwrite: true,
      onComplete: resolve,
    });
  });
};

const restorePageCopy = (page) => {
  const targets = page ? [...page.children] : [];
  if (!targets.length) return;
  gsap.killTweensOf(targets);
  gsap.to(targets, {
    autoAlpha: 1,
    duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.2,
    ease: "sine.out",
    overwrite: true,
    clearProps: "opacity,visibility",
  });
};

const mergeRemoteFile = (notebooks, notebookId, fileId, remoteFile) => notebooks.map((notebook) => (
  notebook.id === notebookId
    ? {
        ...notebook,
        files: notebook.files.map((file) => (
          file.id === fileId
            ? {
                ...file,
                title: remoteFile.title,
                type: remoteFile.type,
                lessonPlan: remoteFile.document,
                documentVersion: remoteFile.documentVersion,
                pages: remoteFile.pageCount,
              }
            : file
        )),
      }
    : notebook
));

export function App() {
  const [notebooks, setNotebooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [dialogKind, setDialogKind] = useState(null);
  const [dialogNotebookId, setDialogNotebookId] = useState(null);
  const [activeFile, setActiveFile] = useState(null);
  const [routeCloseRequest, setRouteCloseRequest] = useState(0);

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
        let hydratedNotebooks = remoteNotebooks.map(materializeNotebook);
        const routedFileId = getLessonFileRouteId();
        if (routedFileId) {
          const routedNotebook = hydratedNotebooks.find((notebook) => (
            notebook.files.some((file) => file.id === routedFileId)
          ));
          if (routedNotebook) {
            const remoteFile = await agentApi.getLessonFile(routedFileId);
            if (cancelled) return;
            hydratedNotebooks = mergeRemoteFile(
              hydratedNotebooks,
              routedNotebook.id,
              routedFileId,
              remoteFile,
            );
            setSelectedId(routedNotebook.id);
            setActiveFile({
              notebookId: routedNotebook.id,
              fileId: routedFileId,
              sourceElement: null,
              originRect: null,
            });
          } else {
            window.history.replaceState({}, "", "/");
          }
        }
        setNotebooks(hydratedNotebooks);
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
      setDialogNotebookId(null);
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

  const openLessonFile = async (nextActiveFile, { historyMode = "push" } = {}) => {
    const sourceElement = nextActiveFile.sourceElement;
    if (sourceElement?.dataset.detailTransition === "pending") return false;
    if (sourceElement) {
      sourceElement.dataset.detailTransition = "pending";
      sourceElement.setAttribute("aria-busy", "true");
    }
    try {
      const remoteFile = await agentApi.getLessonFile(nextActiveFile.fileId);
      setNotebooks((current) => mergeRemoteFile(
        current,
        nextActiveFile.notebookId,
        nextActiveFile.fileId,
        remoteFile,
      ));
      if (sourceElement?.isConnected) {
        await animatePageCopy(sourceElement, 0);
      }
      setSelectedId(nextActiveFile.notebookId);
      setRouteCloseRequest(0);
      setActiveFile(nextActiveFile);
      if (historyMode) {
        window.history[`${historyMode}State`]({}, "", lessonFileRoute(nextActiveFile.fileId));
      }
      return true;
    } catch (error) {
      if (sourceElement) {
        delete sourceElement.dataset.detailTransition;
        sourceElement.removeAttribute("aria-busy");
        restorePageCopy(sourceElement);
        sourceElement.focus({ preventScroll: true });
      }
      toast.error(error.message === "lesson_file_not_found"
        ? "这份教案已不存在，请刷新备课本"
        : "暂时无法同步云端教案，助手会在版本一致后才开始工作");
      return false;
    }
  };

  const closeLessonFile = ({ historyMode = "push" } = {}) => {
    const sourceElement = activeFile?.sourceElement;
    setActiveFile(null);
    if (historyMode && !routeCloseRequest) window.history[`${historyMode}State`]({}, "", "/");
    setRouteCloseRequest(0);
    window.requestAnimationFrame(() => {
      if (!sourceElement?.isConnected) return;
      delete sourceElement.dataset.detailTransition;
      sourceElement.removeAttribute("aria-busy");
      restorePageCopy(sourceElement);
      sourceElement.focus({ preventScroll: true });
    });
  };

  useEffect(() => {
    const handlePopState = () => {
      const routedFileId = getLessonFileRouteId();
      if (!routedFileId) {
        if (activeFile?.fileId) {
          setRouteCloseRequest((request) => request + 1);
          return;
        }
        setSelectedId(null);
        return;
      }
      if (routedFileId === activeFile?.fileId) return;
      const routedNotebook = notebooks.find((notebook) => (
        notebook.files.some((file) => file.id === routedFileId)
      ));
      if (!routedNotebook) return;
      openLessonFile({
        notebookId: routedNotebook.id,
        fileId: routedFileId,
        sourceElement: null,
        originRect: null,
      }, { historyMode: null });
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [activeFile?.fileId, notebooks]);

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
      <NotebookCollection
        notebooks={notebooks}
        loading={loading}
        selectedId={selectedId}
        activeFileId={activeFile?.fileId}
        inert={Boolean(activeFile)}
        onSelect={setSelectedId}
        onOpenFile={openLessonFile}
        onCreateNotebook={() => {
          setDialogNotebookId(null);
          setDialogKind("notebook");
        }}
        onCreateFile={(notebookId) => {
          setDialogNotebookId(notebookId ?? null);
          setDialogKind("file");
        }}
        onSignOut={() => supabase?.auth.signOut()}
      />
      {activeNotebook && activeFileData && (
        <LessonFileWorkspace
          notebook={activeNotebook}
          file={activeFileData}
          sourceElement={activeFile.sourceElement}
          originRect={activeFile.originRect}
          closeSignal={routeCloseRequest}
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
          initialNotebookId={dialogNotebookId ?? selectedId}
          onClose={() => {
            setDialogKind(null);
            setDialogNotebookId(null);
          }}
          onCreate={createItem}
        />
      )}
      <Toaster position="bottom-center" />
    </main>
  );
}
