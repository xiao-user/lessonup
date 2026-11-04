import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LessonFilePageBackSummary, LessonFilePageSummary, NotebookTitlePageSummary } from "@/components/lesson-file-page-summary";

export function BookVolume({
  notebook,
  isOpen,
  activeFileId,
  pageIndex,
  onToggle,
  onOpenFile,
  onPrepareFile,
  onDeleteFile,
  onPageChange,
  pageAnimating,
  turningPages,
  bookAnimating,
  closing,
  renderPages,
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
  // pageIndex is the leaf index in [title, ...files]. Title is leaf 0.
  const activePageIndex = isOpen ? pageIndex : 0;
  const activePage = pages[activePageIndex];
  const activeFile = activePage?.kind === "file" ? activePage : null;
  const leafCount = pages.length;

  const openFile = (event, file) => {
    event.stopPropagation();
    if (!isOpen || !file || pageAnimating || bookAnimating) return;
    const sourceElement = event.currentTarget;
    sourceElement.blur();
    onOpenFile({
      notebookId: notebook.id,
      fileId: file.id,
      sourceElement,
    });
  };

  return (
    <article
      className={`book-volume tone-${notebook.tone} ${isOpen ? "is-open" : ""} ${bookAnimating ? "is-animating" : ""}`}
      data-notebook-id={notebook.id}
      onClick={(event) => {
        if (isOpen && event.target.closest(".book-volume-leaf-back")) onToggle();
      }}
      ref={registerBook}
    >
      <div className="book-volume-unit">
        <div className="book-volume-spread">
          <div className="book-volume-pages" aria-hidden={!isOpen}>
            {renderPages && pages.map((page, index) => (
              <div
                className={`book-volume-leaf ${index < activePageIndex ? "is-turned" : ""} ${index === activePageIndex ? "is-current" : ""} ${turningPages.includes(index) ? "is-turning" : ""}`}
                data-page-index={index}
                data-page-kind={page.kind}
                style={{ "--leaf-layer": pages.length - index + 1 }}
                aria-hidden={index !== activePageIndex}
                key={page.id}
              >
                {(index === 0 || Math.abs(index - activePageIndex) <= 2 || turningPages.includes(index) || (closing && index < activePageIndex)) && (page.kind === "file" ? (
                  <button
                    className={`folder-paper book-volume-file book-volume-leaf-front ${activeFileId === page.id ? "is-file-source" : ""}`}
                    data-file-id={page.id}
                    type="button"
                    tabIndex={isOpen && index === activePageIndex && !pageAnimating && !bookAnimating ? 0 : -1}
                    aria-label={`打开备课文件${page.title}`}
                    onClick={(event) => openFile(event, page)}
                    onPointerEnter={() => { if (isOpen && !bookAnimating && !pageAnimating) onPrepareFile?.(); }}
                    onFocus={() => { if (isOpen && !bookAnimating && !pageAnimating) onPrepareFile?.(); }}
                  >
                    <LessonFilePageSummary
                      file={page}
                      pageIndex={index - 1}
                      fileCount={fileCount}
                    />
                  </button>
                ) : (
                  <div className="folder-paper book-volume-leaf-front" aria-label={`${notebook.title}扉页`}>
                    <NotebookTitlePageSummary notebook={notebook} />
                  </div>
                ))}
                <div className="book-volume-leaf-back" aria-hidden="true">
                  {(index === 0 || Math.abs(index - activePageIndex) <= 2 || turningPages.includes(index) || (closing && index < activePageIndex)) && (page.kind === "title" ? (
                    <NotebookTitlePageSummary notebook={notebook} />
                  ) : (
                    <LessonFilePageBackSummary file={page} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <button
            className="book-volume-cover"
            type="button"
            aria-label={isOpen ? `合上${notebook.title}` : `打开${notebook.title}`}
            style={{ "--cover-layer": pages.length + 2 }}
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

      {isOpen && (
        <div className="book-volume-controls" aria-label="翻阅备课本">
          {leafCount > 1 && (
            <button
              className="book-volume-control-button"
              type="button"
              aria-label="上一页"
              disabled={bookAnimating || pageIndex <= 0}
              onClick={(event) => { event.stopPropagation(); onPageChange(pageIndex - 1); }}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
          )}
          <span className="book-volume-page-label">{pageIndex === 0 ? "扉页" : pageIndex} / {fileCount}</span>
          {leafCount > 1 && (
            <button
              className="book-volume-control-button"
              type="button"
              aria-label="下一页"
              disabled={bookAnimating || pageIndex >= leafCount - 1}
              onClick={(event) => { event.stopPropagation(); onPageChange(pageIndex + 1); }}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          )}
          {fileCount > 0 && (
            <Button
              className="book-volume-delete-button"
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label={activeFile ? `删除备课文件${activeFile.title}` : "扉页不可删除"}
              disabled={bookAnimating || pageAnimating || !activeFile}
              onClick={(event) => {
                event.stopPropagation();
                if (!activeFile) return;
                onDeleteFile(activeFile);
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
