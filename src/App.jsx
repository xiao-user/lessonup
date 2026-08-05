import { lazy, Suspense, useEffect, useState } from "react";
import gsap from "gsap";
import { toast } from "sonner";

import { Toaster } from "@/components/ui/sonner";
import { createLessonPlanDraft } from "@/features/lesson-files/data";
import {
  continuityDraft,
  lessonPeriodContext,
  lessonPeriodLabel,
} from "@/features/semester-frameworks/lesson-blueprint-context";
import { coverAssets } from "@/features/notebooks/data";
import { DeleteLessonFileDialog, DeleteNotebookDialog } from "@/features/notebooks/delete-lesson-file-dialog";
import { NotebookCollection } from "@/features/notebooks/notebook-collection";
import { agentApi } from "@/lib/agent-api";
import { createLessonPlanPreview } from "@/lib/lesson-preview";
import { supabase } from "@/lib/supabase";

const loadLessonFileWorkspace = () => import("@/features/lesson-files/lesson-file-workspace");
const loadCreateDialog = () => import("@/features/notebooks/create-dialog");
const loadProfileDialog = () => import("@/features/auth/profile-dialog");
const loadSemesterFrameworkWorkspace = () => import("@/features/semester-frameworks/semester-framework-workspace");
const loadCreateSemesterFrameworkDialog = () => import("@/features/semester-frameworks/create-semester-framework-dialog");
const LessonFileWorkspace = lazy(async () => {
  const module = await loadLessonFileWorkspace();
  return { default: module.LessonFileWorkspace };
});
const CreateDialog = lazy(async () => {
  const module = await loadCreateDialog();
  return { default: module.CreateDialog };
});
const ProfileDialog = lazy(async () => {
  const module = await loadProfileDialog();
  return { default: module.ProfileDialog };
});
const SemesterFrameworkWorkspace = lazy(async () => {
  const module = await loadSemesterFrameworkWorkspace();
  return { default: module.SemesterFrameworkWorkspace };
});
const CreateSemesterFrameworkDialog = lazy(async () => {
  const module = await loadCreateSemesterFrameworkDialog();
  return { default: module.CreateSemesterFrameworkDialog };
});

const notebookTones = ["teal", "sage", "amber", "coral"];
const blueprintGenerationPrompt = (blueprint, unitTitle, periodContext, lessonDurationMinutes) => [
  `请基于当前课时蓝图完整编写“${blueprint.title}”教案。`,
  "先读取当前整份教案、教学情境、上游备课上下文（如有）和已发布章节知识点，再一次性提交可确认的完整教案修改。",
  `本课属于“${unitTitle}”，是该章节第 ${periodContext.periodNo} / ${periodContext.periodCount} 课时，每课时 ${lessonDurationMinutes} 分钟。只完成当前课时目标，不要把整篇课文的全部内容压进一节课。`,
  periodContext.periodNo > 1
    ? `必须承接第 ${periodContext.periodNo - 1} 课时已经形成的学生产出，避免重新从整篇课文起点讲起。`
    : null,
  periodContext.periodNo < periodContext.periodCount
    ? `必须为第 ${periodContext.periodNo + 1} 课时保留明确的认知或学习产出起点，不要提前讲完后续内容。`
    : null,
  "必须继承单元目标、当前课时蓝图中的主要活动、学生可观察产出和达成证据。",
  "把本课真正处理的知识写入“重点知识”，并判断上游规划中的复习旧知或后续铺垫是否适用；采用时必须落实到具体教学活动、学生任务或评价证据，不要只写标签。",
  "内容要可直接上课、语言精简、各栏目互相对应；禁止使用可替换到任何课题的通用表述。",
].filter(Boolean).join("\n");

const directLessonGenerationPrompt = (title) => [
  `请基于当前已绑定的科目、教材、单元、章节、课时长度和班级信息，完整编写“${title}”教案。`,
  "先读取当前整份教案、教学情境、上游备课上下文（如有）和已发布章节知识点，再一次性提交可确认的完整教案修改。",
  "把本课真正处理的知识写入“重点知识”；如果上游学期框架存在对应课时蓝图或复习/铺垫信息，必须继承并落实到具体教学活动、学生任务或评价证据。",
  "信息不足时基于现有可靠信息完成可用版本，并明确保留需要教师补充的真实学情条件；不要填入通用占位文案。",
].join("\n");
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
const semesterFrameworkRoute = (frameworkId) => `/semester-frameworks/${encodeURIComponent(frameworkId)}`;
const getLessonFileRouteId = () => {
  const match = window.location.pathname.match(/^\/lesson-files\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};
const getSemesterFrameworkRouteId = () => {
  const match = window.location.pathname.match(/^\/semester-frameworks\/([^/]+)\/?$/);
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
                preview: createLessonPlanPreview(remoteFile.document),
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
  const [profileOpen, setProfileOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingFile, setDeletingFile] = useState(false);
  const [deleteNotebookTarget, setDeleteNotebookTarget] = useState(null);
  const [deletingNotebook, setDeletingNotebook] = useState(false);
  const [activeFramework, setActiveFramework] = useState(null);
  const [frameworkDialogNotebookId, setFrameworkDialogNotebookId] = useState(null);
  const [pendingLessonGeneration, setPendingLessonGeneration] = useState(null);

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
        const routedFrameworkId = getSemesterFrameworkRouteId();
        if (routedFrameworkId) {
          const [framework] = await Promise.all([
            agentApi.getSemesterFramework(routedFrameworkId),
            loadSemesterFrameworkWorkspace(),
          ]);
          if (cancelled) return;
          const routedNotebook = hydratedNotebooks.find((notebook) => (
            notebook.id === framework.framework.notebookId
          ));
          if (routedNotebook) {
            setSelectedId(routedNotebook.id);
            setActiveFramework({
              id: routedFrameworkId,
              notebookId: routedNotebook.id,
            });
          } else {
            window.history.replaceState({}, "", "/");
          }
        } else if (routedFileId) {
          const routedNotebook = hydratedNotebooks.find((notebook) => (
            notebook.files.some((file) => file.id === routedFileId)
          ));
          if (routedNotebook) {
            const [remoteFile] = await Promise.all([
              agentApi.getLessonFile(routedFileId),
              loadLessonFileWorkspace(),
            ]);
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
        let lessonBlueprintId;
        if (values.contextProfile?.textbookId && values.contextProfile?.lessonNodeId) {
          try {
            const frameworks = await agentApi.listSemesterFrameworks(targetId);
            const matching = (frameworks.frameworks ?? []).filter((framework) => (
              framework.textbookId === values.contextProfile.textbookId
            ));
            const aggregates = await Promise.all(matching.map((framework) => (
              agentApi.getSemesterFramework(framework.id)
            )));
            const blueprintMatches = aggregates.flatMap((aggregate) => (
              aggregate.blueprints.filter((blueprint) => (
                blueprint.curriculumNodeId === values.contextProfile.lessonNodeId
              ))
            ));
            if (blueprintMatches.length === 1) lessonBlueprintId = blueprintMatches[0].id;
          } catch {
            // 教案仍可按已验证教材章节创建；只有唯一匹配时才自动绑定蓝图。
          }
        }
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
          lessonBlueprintId,
          pageCount: 1,
        }, values.idempotencyKey);
        setNotebooks((current) => current.map((notebook) => notebook.id === targetId ? {
          ...notebook,
          updatedAt: Date.now(),
          files: [{
            ...file,
            lessonPlan: file.document,
            preview: createLessonPlanPreview(file.document),
            pages: file.pageCount,
            updated: "刚刚",
          }, ...notebook.files],
        } : notebook));
        setPendingLessonGeneration({
          fileId: file.id,
          prompt: directLessonGenerationPrompt(values.title),
        });
        setDialogKind(null);
        setDialogNotebookId(null);
        toast.success(`已建立“${values.title}”，助手正在生成教案`);
        await openLessonFile({
          notebookId: targetId,
          fileId: file.id,
          sourceElement: null,
          originRect: null,
        });
        return;
      }
      setDialogKind(null);
      setDialogNotebookId(null);
    } catch (error) {
      toast.error(`创建失败：${error.message}`);
      throw error;
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
                    preview: createLessonPlanPreview(lessonPlan),
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
      const [remoteFile] = await Promise.all([
        agentApi.getLessonFile(nextActiveFile.fileId),
        loadLessonFileWorkspace(),
      ]);
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

  const openSemesterFramework = async (notebookId, frameworkId = null, { historyMode = "push" } = {}) => {
    try {
      const targetFrameworkId = frameworkId ?? (
        await agentApi.listSemesterFrameworks(notebookId)
      ).frameworks?.[0]?.id;
      if (!targetFrameworkId) {
        await loadCreateSemesterFrameworkDialog();
        setFrameworkDialogNotebookId(notebookId);
        return false;
      }
      await Promise.all([
        agentApi.getSemesterFramework(targetFrameworkId),
        loadSemesterFrameworkWorkspace(),
      ]);
      setSelectedId(notebookId);
      setActiveFramework({ id: targetFrameworkId, notebookId });
      if (historyMode) {
        window.history[`${historyMode}State`]({}, "", semesterFrameworkRoute(targetFrameworkId));
      }
      return true;
    } catch (error) {
      toast.error(error.message === "semester_framework_not_found"
        ? "这份学期框架已经不存在"
        : `暂时无法打开学期框架：${error.message}`);
      return false;
    }
  };

  const closeSemesterFramework = ({ historyMode = "push" } = {}) => {
    setActiveFramework(null);
    if (historyMode) window.history[`${historyMode}State`]({}, "", "/");
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
      const routedFrameworkId = getSemesterFrameworkRouteId();
      if (routedFrameworkId) {
        if (activeFramework?.id === routedFrameworkId) return;
        agentApi.getSemesterFramework(routedFrameworkId).then((framework) => {
          void openSemesterFramework(
            framework.framework.notebookId,
            routedFrameworkId,
            { historyMode: null },
          );
        }).catch(() => window.history.replaceState({}, "", "/"));
        return;
      }
      if (activeFramework) {
        setActiveFramework(null);
        return;
      }
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
  }, [activeFile?.fileId, activeFramework?.id, notebooks]);

  const createSemesterFramework = async (values, idempotencyKey) => {
    const notebookId = frameworkDialogNotebookId;
    if (!notebookId) throw new Error("notebook_not_found");
    try {
      const aggregate = await agentApi.createSemesterFramework(
        notebookId,
        values,
        idempotencyKey,
      );
      setFrameworkDialogNotebookId(null);
      toast.success("学期框架已按教材目录建立");
      await loadSemesterFrameworkWorkspace();
      setSelectedId(notebookId);
      setActiveFramework({ id: aggregate.framework.id, notebookId });
      window.history.pushState({}, "", semesterFrameworkRoute(aggregate.framework.id));
    } catch (error) {
      toast.error(`建立失败：${error.message}`);
      throw error;
    }
  };

  const createLessonFromBlueprint = async ({
    blueprint,
    unit,
    unitTitle,
    textbook,
    framework,
    knowledgeRecord,
    continuityCandidates,
    unitBlueprints,
    action = "create",
  }) => {
    const notebook = notebooks.find((candidate) => candidate.id === framework.notebookId);
    if (!notebook) throw new Error("notebook_not_found");
    const existingFile = notebook.files.find((file) => (
      file.lessonBlueprintId === blueprint.id
    ));
    if (existingFile) {
      if (action === "regenerate") {
        const periodContext = lessonPeriodContext(blueprint, unitBlueprints, knowledgeRecord);
        setPendingLessonGeneration({
          fileId: existingFile.id,
          prompt: blueprintGenerationPrompt(
            blueprint,
            unitTitle,
            periodContext,
            blueprint.plannedMinutes ?? framework.lessonDurationMinutes,
          ),
        });
        toast.success(`助手将按最新蓝图重新生成“${blueprint.title}”`);
      }
      setActiveFramework(null);
      await openLessonFile({
        notebookId: notebook.id,
        fileId: existingFile.id,
        sourceElement: null,
        originRect: null,
      });
      return;
    }
    const image = coverAssets[notebook.files.length % coverAssets.length];
    const draftFile = { title: blueprint.title, type: "课时蓝图教案", image };
    const periodContext = lessonPeriodContext(blueprint, unitBlueprints, knowledgeRecord);
    const knowledgePoints = periodContext.points
      .map((item) => item.point?.canonicalName)
      .filter(Boolean)
      .join("；");
    const file = await agentApi.createLessonFile({
      notebookId: notebook.id,
      title: blueprint.title,
      type: draftFile.type,
      image,
      document: createLessonPlanDraft(notebook, draftFile, {
        unitTitle,
        lessonTitle: blueprint.title,
        period: lessonPeriodLabel(periodContext.periodNo, periodContext.periodCount),
        totalPeriods: `共 ${periodContext.periodCount} 课时`,
        objectives: unit.learningGoals,
        knowledgePoints,
        continuity: continuityDraft(continuityCandidates, periodContext),
        focus: blueprint.anticipatedDifficulties?.length
          ? `预期难点：${blueprint.anticipatedDifficulties.join("；")}`
          : "",
        mainActivity: blueprint.mainActivity,
        assessmentEvidence: blueprint.assessmentEvidence,
      }),
      contextProfile: {
        gradeLevel: textbook?.grade || notebook.grade,
        textbookEdition: [textbook?.edition, textbook?.volume].filter(Boolean).join(" · "),
        textbookId: framework.textbookId,
        unitNodeId: unit.curriculumNodeId,
        lessonNodeId: blueprint.curriculumNodeId,
        lessonDurationMinutes: blueprint.plannedMinutes ?? framework.lessonDurationMinutes,
      },
      lessonBlueprintId: blueprint.id,
      pageCount: 1,
    }, crypto.randomUUID());
    setNotebooks((current) => current.map((candidate) => candidate.id === notebook.id ? {
      ...candidate,
      updatedAt: Date.now(),
      files: [{
        ...file,
        lessonPlan: file.document,
        preview: createLessonPlanPreview(file.document),
        pages: file.pageCount,
        updated: "刚刚",
      }, ...candidate.files],
    } : candidate));
    setPendingLessonGeneration({
      fileId: file.id,
      prompt: blueprintGenerationPrompt(
        blueprint,
        unitTitle,
        periodContext,
        blueprint.plannedMinutes ?? framework.lessonDurationMinutes,
      ),
    });
    setActiveFramework(null);
    toast.success(`已建立“${blueprint.title}”，助手正在生成教案`);
    await openLessonFile({
      notebookId: notebook.id,
      fileId: file.id,
      sourceElement: null,
      originRect: null,
    });
  };

  const deleteBlueprintLesson = ({ blueprint, framework }) => {
    const notebook = notebooks.find((candidate) => candidate.id === framework.notebookId);
    const file = notebook?.files.find((candidate) => (
      candidate.lessonBlueprintId === blueprint.id
    ));
    if (!file) return;
    setDeleteTarget({ ...file, notebookId: notebook.id });
  };

  const updateLessonPlan = async (
    lessonPlan,
    pageCount,
    source = "manual",
    baseDocumentVersion = activeFileData?.documentVersion ?? 0,
    idempotencyKey = crypto.randomUUID(),
  ) => {
    updateLocalLessonPlan(lessonPlan, pageCount);
    if (source === "agent-local") return null;
    try {
      const saved = await agentApi.saveLessonDocument(activeFile.fileId, {
        baseVersion: baseDocumentVersion,
        document: lessonPlan,
        pageCount,
        source: source === "undo" ? "undo" : "manual",
      }, idempotencyKey);
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

  const deleteLessonFile = async () => {
    if (!deleteTarget || deletingFile) return;
    setDeletingFile(true);
    try {
      await agentApi.deleteLessonFile(deleteTarget.id);
      setNotebooks((current) => current.map((notebook) => (
        notebook.id === deleteTarget.notebookId
          ? {
              ...notebook,
              updatedAt: Date.now(),
              files: notebook.files.filter((file) => file.id !== deleteTarget.id),
            }
          : notebook
      )));
      toast.success(`“${deleteTarget.title}”已删除`);
      setDeleteTarget(null);
    } catch (error) {
      toast.error(error.message === "lesson_file_not_found"
        ? "这份备课文件已经不存在"
        : "删除失败，请稍后重试");
    } finally {
      setDeletingFile(false);
    }
  };

  const deleteNotebook = async () => {
    if (!deleteNotebookTarget || deletingNotebook) return;
    setDeletingNotebook(true);
    try {
      await agentApi.deleteNotebook(deleteNotebookTarget.id);
      setNotebooks((current) => current.filter((notebook) => notebook.id !== deleteNotebookTarget.id));
      setSelectedId((current) => current === deleteNotebookTarget.id ? null : current);
      toast.success(`“${deleteNotebookTarget.title}”已删除`);
      setDeleteNotebookTarget(null);
    } catch (error) {
      toast.error(error.message === "notebook_not_found"
        ? "这个备课本已经不存在"
        : "删除失败，请稍后重试");
    } finally {
      setDeletingNotebook(false);
    }
  };

  return (
    <main id="top">
      <NotebookCollection
        notebooks={notebooks}
        loading={loading}
        selectedId={selectedId}
        activeFileId={activeFile?.fileId}
        inert={Boolean(activeFile || activeFramework)}
        onSelect={setSelectedId}
        onOpenFile={openLessonFile}
        onDeleteFile={setDeleteTarget}
        onDeleteNotebook={setDeleteNotebookTarget}
        onCreateNotebook={() => {
          void loadCreateDialog();
          setDialogNotebookId(null);
          setDialogKind("notebook");
        }}
        onCreateFile={(notebookId) => {
          void loadCreateDialog();
          setDialogNotebookId(notebookId ?? null);
          setDialogKind("file");
        }}
        onOpenFramework={(notebookId) => {
          void openSemesterFramework(notebookId);
        }}
        onOpenProfile={() => {
          void loadProfileDialog();
          window.requestAnimationFrame(() => setProfileOpen(true));
        }}
        onSignOut={() => supabase?.auth.signOut()}
      />
      {activeNotebook && activeFileData && (
        <Suspense fallback={null}>
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
            initialAgentPrompt={pendingLessonGeneration?.fileId === activeFileData.id
              ? pendingLessonGeneration.prompt
              : null}
            onInitialAgentPromptConsumed={() => setPendingLessonGeneration((current) => (
              current?.fileId === activeFileData.id ? null : current
            ))}
            key={`${activeNotebook.id}-${activeFileData.id}`}
          />
        </Suspense>
      )}
      {activeFramework && (
        <Suspense fallback={null}>
          <SemesterFrameworkWorkspace
            notebook={notebooks.find((notebook) => notebook.id === activeFramework.notebookId)}
            frameworkId={activeFramework.id}
            onClose={closeSemesterFramework}
            onCreateLesson={createLessonFromBlueprint}
            onDeleteLesson={deleteBlueprintLesson}
            key={activeFramework.id}
          />
        </Suspense>
      )}
      {dialogKind && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}
      {profileOpen && (
        <Suspense fallback={null}>
          <ProfileDialog notebooks={notebooks} onClose={() => setProfileOpen(false)} />
        </Suspense>
      )}
      {frameworkDialogNotebookId && (
        <Suspense fallback={null}>
          <CreateSemesterFrameworkDialog
            notebook={notebooks.find((notebook) => notebook.id === frameworkDialogNotebookId)}
            onClose={() => setFrameworkDialogNotebookId(null)}
            onCreate={createSemesterFramework}
          />
        </Suspense>
      )}
      {deleteTarget && (
        <DeleteLessonFileDialog
          file={deleteTarget}
          deleting={deletingFile}
          onClose={() => setDeleteTarget(null)}
          onConfirm={deleteLessonFile}
        />
      )}
      {deleteNotebookTarget && (
        <DeleteNotebookDialog
          notebook={deleteNotebookTarget}
          deleting={deletingNotebook}
          onClose={() => setDeleteNotebookTarget(null)}
          onConfirm={deleteNotebook}
        />
      )}
      <Toaster position="bottom-center" />
    </main>
  );
}
