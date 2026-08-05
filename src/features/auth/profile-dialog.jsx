import { useEffect, useMemo, useState } from "react";
import { FileText, LoaderCircle, Trash2, UserRound } from "lucide-react";
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
import { supabase } from "@/lib/supabase";

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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
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
      supabase?.auth.getUser() ?? Promise.resolve({ data: { user: null } }),
      agentApi.listKnowledgeUploads({ includeAttached: true }),
    ]).then(([accountResult, filesResult]) => {
      if (cancelled) return;
      if (accountResult.status === "fulfilled") setAccount(accountResult.value.data?.user ?? null);
      if (filesResult.status === "fulfilled") setFiles(filesResult.value);
      else setLoadError(true);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const accountName = account?.user_metadata?.full_name
    || account?.user_metadata?.name
    || account?.email?.split("@")[0]
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

  return <>
    <Dialog open onOpenChange={(open) => { if (!open && !deletingId) onClose(); }}>
      <DialogContent className="profile-dialog">
        <DialogHeader>
          <DialogTitle>个人信息</DialogTitle>
          <DialogDescription>查看账户概况，并管理你上传到 LessonUp 的资料。</DialogDescription>
        </DialogHeader>

        <section className="profile-account" aria-label="账户信息">
          <span className="profile-avatar" aria-hidden="true"><UserRound /></span>
          <div className="profile-account-copy">
            <strong>{accountName}</strong>
            <span>{account?.email ?? "当前本地开发账户"}</span>
          </div>
          <dl className="profile-stats">
            <div><dt>备课本</dt><dd>{notebooks.length}</dd></div>
            <div><dt>备课文件</dt><dd>{lessonFileCount}</dd></div>
            <div><dt>上传资料</dt><dd>{files.length}</dd></div>
          </dl>
          {account?.created_at && (
            <p className="profile-account-meta">加入时间　{formatDate(account.created_at)}</p>
          )}
        </section>

        <Separator />

        <section className="profile-files" aria-labelledby="profile-files-title">
          <div className="profile-files-heading">
            <div>
              <h3 id="profile-files-title">我的资料</h3>
              <p>原文件存放于私有 Storage，列表信息与检索内容保存在数据库中。</p>
            </div>
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
          ) : loadError ? (
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
          <DialogTitle>删除这个文件？</DialogTitle>
          <DialogDescription>
            “{deleteTarget?.title}”的原文件、数据库记录和检索内容都会被永久删除。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" type="button" disabled={Boolean(deletingId)} onClick={() => setDeleteTarget(null)}>
            取消
          </Button>
          <Button variant="destructive" type="button" disabled={Boolean(deletingId)} onClick={deleteFile}>
            {deletingId ? "删除中…" : "确认删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
