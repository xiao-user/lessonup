import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowLeft, FilePlus2, Files, FolderPlus, LoaderCircle, LogOut, Search } from "lucide-react";

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

gsap.registerPlugin(useGSAP);

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
  const headingRef = useRef(null);
  const [activeNotebookId, setActiveNotebookId] = useState(notebooks[0]?.id ?? null);
  const focusedNotebook = notebooks.find((notebook) => notebook.id === selectedId);

  useEffect(() => {
    if (notebooks.some((notebook) => notebook.id === activeNotebookId)) return;
    setActiveNotebookId(notebooks[0]?.id ?? null);
  }, [activeNotebookId, notebooks]);

  useGSAP(() => {
    const items = headingRef.current?.children;
    if (!items?.length) return;
    gsap.fromTo(items, { y: -8, autoAlpha: 0 }, {
      y: 0,
      autoAlpha: 1,
      duration: 0.32,
      ease: "power2.out",
      stagger: 0.035,
      overwrite: "auto",
    });
  }, { scope: headingRef, dependencies: [selectedId] });

  return (
    <section
      className={`notebook-collection ${focusedNotebook ? "is-focused" : ""}`}
      inert={inert}
    >
      <header className="page-heading" ref={headingRef}>
        {focusedNotebook ? (
          <Button className="collection-back-button" variant="ghost" type="button" onClick={() => carouselRef.current?.close()}>
            <ArrowLeft data-icon="inline-start" /> 返回全部备课本
          </Button>
        ) : (
          <h3 className="page-title" id="page-title">备好课</h3>
        )}
        <div className="create-actions">
          {focusedNotebook ? (
            <span className="notebook-file-count"><Files aria-hidden="true" /> {focusedNotebook.files.length} 份文件</span>
          ) : (
            <Button variant="outline" type="button" onClick={onCreateNotebook}>
              <FolderPlus data-icon="inline-start" /> 新增备课本
            </Button>
          )}
          <Button
            type="button"
            onClick={() => onCreateFile(focusedNotebook?.id ?? activeNotebookId ?? notebooks[0]?.id)}
          >
            <FilePlus2 data-icon="inline-start" /> 新增备课文件
          </Button>
          {!focusedNotebook && (
            <Button variant="ghost" size="icon" type="button" onClick={onSignOut} aria-label="退出登录">
              <LogOut />
            </Button>
          )}
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
