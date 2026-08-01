import { ChevronLeft, ChevronRight, FileText } from "lucide-react";

import { LessonFilePageSummary } from "@/components/lesson-file-page-summary";

export function BookVolume({
  notebook,
  isOpen,
  activeFileId,
  pageIndex,
  onToggle,
  onOpenFile,
  onPageChange,
  pageAnimating,
  bookAnimating,
  registerBook,
}) {
  const fileCount = notebook.files.length;
  const pages = [
    {
      id: `${notebook.id}:title-page`,
      kind: "title",
      type: notebook.subject || "备课本",
      title: notebook.title,
      pages: fileCount,
      meta: `${fileCount} 份备课文件`,
    },
    ...notebook.files.map((file) => ({ ...file, kind: "file" })),
  ];
  const activePageIndex = isOpen && fileCount ? pageIndex + 1 : 0;

  const openFile = (event, file) => {
    event.stopPropagation();
    if (!isOpen || !file || pageAnimating || bookAnimating) return;
    const sourceElement = event.currentTarget;
    const rect = sourceElement.getBoundingClientRect();
    const originRect = {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
    sourceElement.blur();
    onOpenFile({
      notebookId: notebook.id,
      fileId: file.id,
      sourceElement,
      originRect,
    });
  };

  return (
    <article
      className={`book-volume tone-${notebook.tone} ${isOpen ? "is-open" : ""}`}
      data-notebook-id={notebook.id}
      onClick={(event) => {
        if (isOpen && event.target.closest(".book-volume-leaf-back")) onToggle();
      }}
      ref={registerBook}
    >
      <div className="book-volume-unit">
        <div className="book-volume-spread">
          <div className="book-volume-pages" aria-hidden={!isOpen}>
            {pages.map((page, index) => (
              <div
                className={`book-volume-leaf ${index < activePageIndex ? "is-turned" : ""} ${index === activePageIndex ? "is-current" : ""}`}
                data-page-index={index}
                data-page-kind={page.kind}
                style={{ zIndex: index < activePageIndex ? 40 + index : 10 + pages.length - index }}
                aria-hidden={index !== activePageIndex}
                key={page.id}
              >
                {page.kind === "file" ? (
                  <button
                    className={`folder-paper book-volume-file book-volume-leaf-front ${activeFileId === page.id ? "is-file-source" : ""}`}
                    data-file-id={page.id}
                    type="button"
                    tabIndex={isOpen && index === activePageIndex && !pageAnimating && !bookAnimating ? 0 : -1}
                    aria-label={`打开备课文件${page.title}`}
                    onClick={(event) => openFile(event, page)}
                  >
                    <LessonFilePageSummary
                      file={page}
                      pageIndex={index - 1}
                      fileCount={fileCount}
                    />
                  </button>
                ) : (
                  <div className="folder-paper book-volume-leaf-front" aria-label={`${notebook.title}扉页`}>
                    <LessonFilePageSummary
                      file={page}
                      pageIndex={0}
                      fileCount={pages.length}
                      detailHint={false}
                      meta={page.meta}
                    />
                  </div>
                )}
                <div className="book-volume-leaf-back" aria-hidden="true">
                  <span>{String(Math.max(1, index)).padStart(2, "0")}</span>
                  <strong>{page.title}</strong>
                  <small>{page.kind === "title" ? page.meta : "已翻阅"}</small>
                </div>
              </div>
            ))}
            {!fileCount && <div className="book-volume-empty-page" aria-hidden="true"><FileText /></div>}
          </div>

          <button
            className="book-volume-cover"
            type="button"
            aria-label={isOpen ? `合上${notebook.title}` : `打开${notebook.title}`}
            onClick={onToggle}
            onPointerUp={(event) => event.currentTarget.blur()}
          >
            <span className="book-volume-cover-back" aria-hidden="true" />
            <span className="book-volume-cover-front">
              <span className="book-volume-spine" aria-hidden="true" />
              <span className="book-volume-cover-copy">
                <span>{String(fileCount).padStart(2, "0")} 份备课文件</span>
                <strong>{notebook.title}</strong>
              </span>
            </span>
          </button>
        </div>
      </div>

      {isOpen && fileCount > 1 && (
        <div className="book-volume-controls" aria-label="翻阅备课文件">
          <button
            className="book-volume-control-button"
            type="button"
            aria-label="上一份备课文件"
            disabled={bookAnimating || pageIndex <= 0}
            onClick={(event) => { event.stopPropagation(); onPageChange(pageIndex - 1); }}
          >
            <ChevronLeft />
          </button>
          <span>{pageIndex + 1} / {fileCount}</span>
          <button
            className="book-volume-control-button"
            type="button"
            aria-label="下一份备课文件"
            disabled={bookAnimating || pageIndex >= fileCount - 1}
            onClick={(event) => { event.stopPropagation(); onPageChange(pageIndex + 1); }}
          >
            <ChevronRight />
          </button>
        </div>
      )}
    </article>
  );
}
