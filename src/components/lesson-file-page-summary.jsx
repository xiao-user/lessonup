import { FileText } from "lucide-react";

export function LessonFilePageSummary({ file, pageIndex, fileCount, detailHint = true, meta }) {
  return (
    <>
      <span className="book-volume-page-kind"><FileText aria-hidden="true" /> {file.type}</span>
      <span className="book-volume-page-copy">
        <strong>{file.title}</strong>
        <span>{meta ?? `${file.pages} 页教案`}</span>
        {detailHint && <small>点击进入备课详情</small>}
      </span>
      <span className="book-volume-page-number">{pageIndex + 1} / {fileCount || 1}</span>
    </>
  );
}
