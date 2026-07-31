import { Ellipsis } from "lucide-react";

import { Button } from "@/components/ui/button";

export function FolderCard({ notebook, isFocused, activeFileId, onOpen, onOpenFile, onHover }) {
  return (
    <article
      className={`folder-card tone-${notebook.tone} ${isFocused ? "is-focused" : ""}`}
      data-notebook-id={notebook.id}
      onMouseEnter={(event) => onHover(event, true)}
      onMouseLeave={(event) => onHover(event, false)}
    >
      <div className="folder-visual">
        <div className="folder-back" aria-hidden="true" />
        <div className="folder-papers" aria-hidden={!isFocused}>
          {notebook.files.map((file, index) => (
            <button
              className={`folder-paper ${activeFileId === file.id ? "is-file-source" : ""}`}
              data-paper-index={index}
              data-file-id={file.id}
              type="button"
              aria-label={`打开备课文件${file.title}`}
              onClick={(event) => {
                event.stopPropagation();
                if (!isFocused || !onOpenFile) return;
                const sourceElement = event.currentTarget;
                const rect = sourceElement.getBoundingClientRect();
                sourceElement.blur();
                onOpenFile({
                  notebookId: notebook.id,
                  fileId: file.id,
                  sourceElement,
                  originRect: {
                    top: rect.top,
                    left: rect.left,
                    width: rect.width,
                    height: rect.height,
                  },
                });
              }}
              key={file.id}
            >
              <div className="folder-paper-image">
                <img src={file.image} alt="" />
                <span>{file.type}</span>
              </div>
              <div className="folder-paper-copy">
                <h3>{file.title}</h3>
                <p>{file.pages} 页 · 更新于 {file.updated}</p>
              </div>
            </button>
          ))}
        </div>
        <div className="folder-front">
          <div className="folder-copy">
            <span className="folder-kicker">
              {String(notebook.files.length).padStart(2, "0")} 份备课文件
            </span>
            <h2>{notebook.title}</h2>
            <dl>
              <div><dt>班级</dt><dd>{notebook.className}</dd></div>
              <div><dt>年度</dt><dd>{notebook.year}</dd></div>
              <div><dt>科目</dt><dd>{notebook.subject}</dd></div>
            </dl>
          </div>
          <button
            className="folder-hit"
            type="button"
            onClick={(event) => {
              if (!isFocused) event.stopPropagation();
              onOpen(notebook.id, event);
            }}
            aria-label={`打开${notebook.title}`}
          />
          <Button
            className="folder-menu"
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label={`${notebook.title}更多操作`}
          >
            <Ellipsis />
          </Button>
        </div>
      </div>
    </article>
  );
}
