import { useEffect, useRef, useState } from "react";
import { ArrowLeft, FilePlus2, FolderPlus, LoaderCircle, LogOut, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { BookCarousel } from "@/features/notebooks/book-carousel";

export function NotebookCollection({
  notebooks,
  loading,
  selectedId,
  activeFileId,
  inert,
  onSelect,
  onOpenFile,
  onCreateNotebook,
  onCreateFile,
  onSignOut,
}) {
  const carouselRef = useRef(null);
  const [activeNotebookId, setActiveNotebookId] = useState(notebooks[0]?.id ?? null);
  const focusedNotebook = notebooks.find((notebook) => notebook.id === selectedId);

  useEffect(() => {
    if (notebooks.some((notebook) => notebook.id === activeNotebookId)) return;
    setActiveNotebookId(notebooks[0]?.id ?? null);
  }, [activeNotebookId, notebooks]);

  return (
    <section
      className={`notebook-collection ${focusedNotebook ? "is-focused" : ""}`}
      inert={inert}
    >
      <header className="page-heading">
        <div className="collection-heading-switch">
          <h3
            className={`page-title ${focusedNotebook ? "" : "is-visible"}`}
            id="page-title"
            aria-hidden={focusedNotebook ? "true" : undefined}
          >
            备好课
          </h3>
          <Button
            className={`collection-back-button ${focusedNotebook ? "is-visible" : ""}`}
            variant="ghost"
            type="button"
            tabIndex={focusedNotebook ? 0 : -1}
            aria-hidden={focusedNotebook ? undefined : "true"}
            onClick={() => carouselRef.current?.close()}
          >
            <ArrowLeft data-icon="inline-start" /> 返回全部备课本
          </Button>
        </div>
        <div className="create-actions">
          <Button
            className="collection-context-action collection-signout-action"
            variant="ghost"
            size="icon"
            type="button"
            tabIndex={focusedNotebook ? -1 : 0}
            aria-hidden={focusedNotebook ? "true" : undefined}
            onClick={onSignOut}
            aria-label="退出登录"
          >
            <LogOut />
          </Button>
          <Button
            className="collection-context-action"
            variant="outline"
            type="button"
            tabIndex={focusedNotebook ? -1 : 0}
            aria-hidden={focusedNotebook ? "true" : undefined}
            onClick={onCreateNotebook}
          >
            <FolderPlus data-icon="inline-start" /> 新增备课本
          </Button>
          <Button
            type="button"
            onClick={() => onCreateFile(focusedNotebook?.id ?? activeNotebookId ?? notebooks[0]?.id)}
          >
            <FilePlus2 data-icon="inline-start" /> 新增备课文件
          </Button>
        </div>
      </header>

      {notebooks.length ? (
        <BookCarousel
          notebooks={notebooks}
          selectedId={selectedId}
          activeFileId={activeFileId}
          onSelect={onSelect}
          onActiveChange={setActiveNotebookId}
          onOpenFile={onOpenFile}
          ref={carouselRef}
        />
      ) : (
        <Empty className="collection-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">{loading ? <LoaderCircle className="animate-spin" /> : <Search />}</EmptyMedia>
            <EmptyTitle>{loading ? "正在加载备课数据" : "还没有备课本"}</EmptyTitle>
            <EmptyDescription>{loading ? "正在从服务器读取你的工作区。" : "创建第一个备课本开始准备课程。"}</EmptyDescription>
          </EmptyHeader>
          {!loading && <EmptyContent>
            <Button type="button" onClick={onCreateNotebook}>
              <FolderPlus data-icon="inline-start" /> 新增备课本
            </Button>
          </EmptyContent>}
        </Empty>
      )}
    </section>
  );
}
