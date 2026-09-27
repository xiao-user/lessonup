import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowLeft, FilePlus2, FolderPlus, LoaderCircle, LogOut, Milestone, Search, Trash2, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { BookCarousel } from "@/features/notebooks/book-carousel";

export const NotebookCollection = forwardRef(function NotebookCollection({
  notebooks,
  loading,
  selectedId,
  activeFileId,
  inert,
  onSelect,
  onOpenFile,
  onDeleteFile,
  onDeleteNotebook,
  onCreateNotebook,
  onCreateFile,
  onOpenFramework,
  onOpenProfile,
  onSignOut,
}, ref) {
  const carouselRef = useRef(null);
  const [activeNotebookId, setActiveNotebookId] = useState(notebooks[0]?.id ?? null);
  const focusedNotebook = notebooks.find((notebook) => notebook.id === selectedId);

  useImperativeHandle(ref, () => ({
    close: () => carouselRef.current?.close(),
    prepareRemoveFile: (notebookId, fileId) => (
      carouselRef.current?.prepareRemoveFile?.(notebookId, fileId) ?? Promise.resolve(false)
    ),
  }));

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
            <ArrowLeft data-icon="inline-start" />
            <span className="collection-back-label-full">返回全部备课本</span>
            <span className="collection-back-label-short">返回</span>
          </Button>
        </div>
        <div className="create-actions">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  className="collection-context-action collection-account-action"
                  variant="ghost"
                  size="icon"
                  type="button"
                  tabIndex={focusedNotebook ? -1 : 0}
                  aria-hidden={focusedNotebook ? "true" : undefined}
                  aria-label="个人信息"
                />
              }
            >
              <UserRound />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" sideOffset={8}>
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={onOpenProfile}><UserRound />个人信息</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" onClick={onSignOut}><LogOut />退出</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            className="collection-context-action collection-create-notebook-action"
            variant="outline"
            type="button"
            tabIndex={focusedNotebook ? -1 : 0}
            aria-hidden={focusedNotebook ? "true" : undefined}
            aria-label="新增备课本"
            onClick={onCreateNotebook}
          >
            <FolderPlus data-icon="inline-start" />
            <span className="collection-action-label">新增备课本</span>
          </Button>
          {focusedNotebook && (
            <Button
              className="collection-focused-action"
              variant="outline"
              type="button"
              aria-label="打开学期框架"
              onClick={() => onOpenFramework(focusedNotebook.id)}
            >
              <Milestone data-icon="inline-start" />
              <span className="collection-action-label">学期框架</span>
            </Button>
          )}
          {focusedNotebook && (
            <Button
              className="collection-focused-action"
              variant="outline"
              type="button"
              aria-label={`删除备课本${focusedNotebook.title}`}
              onClick={() => onDeleteNotebook(focusedNotebook)}
            >
              <Trash2 data-icon="inline-start" />
              <span className="collection-action-label">删除备课本</span>
            </Button>
          )}
          <Button
            className="collection-create-file-action"
            type="button"
            aria-label="新增备课文件"
            onClick={() => onCreateFile(focusedNotebook?.id ?? activeNotebookId ?? notebooks[0]?.id)}
          >
            <FilePlus2 data-icon="inline-start" />
            <span className="collection-action-label-full">新增备课文件</span>
            <span className="collection-action-label-short">新增文件</span>
          </Button>
        </div>
      </header>

      {notebooks.length ? (
        <BookCarousel
          notebooks={notebooks}
          selectedId={selectedId}
          activeFileId={activeFileId}
          dismissible={!inert}
          onSelect={onSelect}
          onActiveChange={setActiveNotebookId}
          onOpenFile={onOpenFile}
          onDeleteFile={onDeleteFile}
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
});
