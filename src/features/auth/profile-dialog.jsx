import { useEffect, useMemo, useState } from "react";
import { Eye, FileText, LoaderCircle, Presentation, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { agentApi } from "@/lib/agent-api";
import { getCurrentAccount } from "@/lib/session";

const statusLabels = {
  queued: "等待处理",
  processing: "解析中",
  ready: "可用",
  failed: "处理失败",
};

const formatDate = (value) => value
  ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  : "—";

const formatBytes = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export function ProfileDialog({ notebooks, onClose }) {
  const [account, setAccount] = useState(null);
  const [files, setFiles] = useState([]);
  const [presentations, setPresentations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filesLoadError, setFilesLoadError] = useState(false);
  const [presentationsLoadError, setPresentationsLoadError] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const lessonFileCount = useMemo(
    () => notebooks.reduce((total, notebook) => total + notebook.files.length, 0),
    [notebooks],
  );
  const scopeNames = useMemo(() => {
    const names = new Map();
    for (const notebook of notebooks) {
      names.set(`notebook:${notebook.id}`, notebook.title);
      for (const file of notebook.files) names.set(`file:${file.id}`, file.title);
    }
    return names;
  }, [notebooks]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      getCurrentAccount(),
      agentApi.listKnowledgeUploads({ includeAttached: true }),
      agentApi.listMyClassroomPresentations(),
    ]).then(([accountResult, filesResult, presentationsResult]) => {
      if (cancelled) return;
      if (accountResult.status === "fulfilled") setAccount(accountResult.value);
      if (filesResult.status === "fulfilled") setFiles(filesResult.value);
      else setFilesLoadError(true);
      if (presentationsResult.status === "fulfilled") setPresentations(presentationsResult.value);
      else setPresentationsLoadError(true);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const accountName = account?.loginName
    || "LessonUp 用户";

  const scopeLabel = (file) => {
    if (file.lesson_file_id) return scopeNames.get(`file:${file.lesson_file_id}`) ?? "已删除的备课文件";
    if (file.notebook_id) return scopeNames.get(`notebook:${file.notebook_id}`) ?? "已删除的备课本";
    return "个人资料";
  };

  const deleteFile = async () => {
    if (!deleteTarget || deletingId) return;
    setDeletingId(deleteTarget.id);
    try {
      await agentApi.deleteKnowledgeUpload(deleteTarget.id);
      setFiles((current) => current.filter((file) => file.id !== deleteTarget.id));
      toast.success(`“${deleteTarget.title}”已删除`);
      setDeleteTarget(null);
    } catch {
      toast.error("文件删除失败，请稍后重试");
    } finally {
      setDeletingId(null);
    }
  };

  const deletePresentation = async () => {
    if (!deleteTarget || deletingId) return;
    setDeletingId(deleteTarget.id);
    try {
      await agentApi.deleteClassroomPresentation(deleteTarget.id);
      setPresentations((current) => current.filter((presentation) => presentation.id !== deleteTarget.id));
      toast.success(`“${deleteTarget.title}”已删除`);
      setDeleteTarget(null);
    } catch {
      toast.error("演示材料删除失败，请稍后重试");
    } finally {
      setDeletingId(null);
    }
  };

  return <>
    <Dialog open onOpenChange={(open) => { if (!open && !deletingId) onClose(); }}>
      <DialogContent className="profile-dialog">
        <DialogHeader className="profile-dialog-header">
          <DialogTitle>个人信息</DialogTitle>
        </DialogHeader>

        <section className="profile-account" aria-label="账户信息">
          <span className="profile-avatar" aria-hidden="true"><UserRound /></span>
          <div className="profile-account-copy">
            <strong>{accountName}</strong>
            <span>{account?.createdAt ? `加入时间 ${formatDate(account.createdAt)}` : "加入时间 —"}</span>
          </div>
          <dl className="profile-stats">
            <div><dt>备课本</dt><dd>{notebooks.length}</dd></div>
            <div><dt>备课文件</dt><dd>{lessonFileCount}</dd></div>
            <div><dt>上传资料</dt><dd>{files.length}</dd></div>
            <div><dt>演示材料</dt><dd>{presentations.length}</dd></div>
          </dl>
        </section>

        <section className="profile-files" aria-labelledby="profile-presentations-title">
          <div className="profile-files-heading">
            <h3 id="profile-presentations-title">我的演示材料</h3>
            {!loading && <Badge variant="secondary">{presentations.length} 份演示</Badge>}
          </div>
          {presentationsLoadError && !loading ? (
            <Empty className="profile-files-state"><EmptyHeader><EmptyMedia variant="icon"><Presentation /></EmptyMedia><EmptyTitle>暂时无法读取演示材料</EmptyTitle><EmptyDescription>请关闭后重新打开个人信息再试。</EmptyDescription></EmptyHeader></Empty>
          ) : presentations.length ? (
            <ul className="profile-file-list">
              {presentations.map((presentation) => (
                <li className="profile-file-row profile-presentation-row" key={presentation.id}>
                  <span className="profile-file-icon" aria-hidden="true"><Presentation /></span>
                  <div className="profile-file-copy">
                    <strong title={presentation.title}>{presentation.title}</strong>
                    <span>{formatBytes(presentation.byteSize)} · {formatDate(presentation.updatedAt)}</span>
                  </div>
                  <Badge variant="secondary">Dashi</Badge>
                  <Button variant="ghost" size="icon-sm" type="button" aria-label={`打开演示材料${presentation.title}`} onClick={async () => {
                    const access = await agentApi.createPresentationAccess(presentation.id);
                    window.open(access.url, "_blank", "noopener");
                  }}>
                    <Eye />
                  </Button>
                  <Button variant="ghost" size="icon-sm" type="button" aria-label={`删除演示材料${presentation.title}`} onClick={() => setDeleteTarget({ ...presentation, kind: "presentation" })}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          ) : !loading ? (
            <Empty className="profile-files-state"><EmptyHeader><EmptyMedia variant="icon"><Presentation /></EmptyMedia><EmptyTitle>还没有课堂演示</EmptyTitle><EmptyDescription>在备课助手中确认生成的课堂演示会显示在这里。</EmptyDescription></EmptyHeader></Empty>
          ) : null}
        </section>

        <Separator />

        <section className="profile-files" aria-labelledby="profile-files-title">
          <div className="profile-files-heading">
            <h3 id="profile-files-title">我的资料</h3>
            {!loading && <Badge variant="secondary">{files.length} 个文件</Badge>}
          </div>

          {loading ? (
            <Empty className="profile-files-state">
              <EmptyHeader>
                <EmptyMedia variant="icon"><LoaderCircle className="animate-spin" /></EmptyMedia>
                <EmptyTitle>正在读取文件</EmptyTitle>
                <EmptyDescription>正在同步你的个人资料列表。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : filesLoadError ? (
            <Empty className="profile-files-state">
              <EmptyHeader>
                <EmptyMedia variant="icon"><FileText /></EmptyMedia>
                <EmptyTitle>暂时无法读取文件</EmptyTitle>
                <EmptyDescription>请关闭后重新打开个人信息再试。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : files.length ? (
            <ul className="profile-file-list">
              {files.map((file) => (
                <li className="profile-file-row" key={file.id}>
                  <span className="profile-file-icon" aria-hidden="true"><FileText /></span>
                  <div className="profile-file-copy">
                    <strong title={file.title}>{file.title}</strong>
                    <span>
                      {scopeLabel(file)} · {formatBytes(file.metadata?.bytes)} · {formatDate(file.updated_at)}
                    </span>
                  </div>
                  <Badge variant={file.status === "failed" ? "destructive" : "secondary"}>
                    {statusLabels[file.status] ?? file.status}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label={`删除文件${file.title}`}
                    onClick={() => setDeleteTarget(file)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty className="profile-files-state">
              <EmptyHeader>
                <EmptyMedia variant="icon"><FileText /></EmptyMedia>
                <EmptyTitle>还没有上传资料</EmptyTitle>
                <EmptyDescription>在备课助手中上传的 PDF、Word、PPT、Markdown 或文本会显示在这里。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </section>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deletingId) setDeleteTarget(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除这个{deleteTarget?.kind === "presentation" ? "演示材料" : "文件"}？</DialogTitle>
          <DialogDescription>
            {deleteTarget?.kind === "presentation"
              ? `“${deleteTarget?.title}”的 HTML 演示和数据库记录都会被永久删除。`
              : `“${deleteTarget?.title}”的原文件、数据库记录和检索内容都会被永久删除。`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" type="button" disabled={Boolean(deletingId)} onClick={() => setDeleteTarget(null)}>
            取消
          </Button>
          <Button variant="destructive" type="button" disabled={Boolean(deletingId)} onClick={deleteTarget?.kind === "presentation" ? deletePresentation : deleteFile}>
            {deletingId ? "删除中…" : deleteTarget?.kind === "presentation" ? "删除演示材料" : "删除文件"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
