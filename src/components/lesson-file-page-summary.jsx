export function NotebookTitlePageSummary({ notebook }) {
  return (
    <span className="book-volume-title-page-copy">
      <i aria-hidden="true" />
      <span className="book-volume-title-page-center">
        <strong>{notebook.title}</strong>
        <span>{[notebook.subject, notebook.className].filter(Boolean).join(" · ")}</span>
        <small>{notebook.year}</small>
      </span>
      <i aria-hidden="true" />
    </span>
  );
}

export function LessonFilePageSummary({ file, pageIndex, fileCount }) {
  const paragraphs = file.preview?.length
    ? file.preview
    : ["这份教案尚未填写正文，进入详情后即可开始备课。"];

  return (
    <span className="book-volume-file-page-copy">
      <strong>{file.title}</strong>
      <span className="book-volume-file-page-body">
        {paragraphs.map((paragraph, index) => (
          <span key={`${file.id}:preview:${index}`}>{paragraph}</span>
        ))}
      </span>
      <small>{file.type} · {file.pages} 页教案</small>
      <span className="book-volume-page-number">{pageIndex + 1} / {fileCount || 1}</span>
    </span>
  );
}

export function LessonFilePageBackSummary({ file }) {
  const meta = [file.type, file.pages ? `${file.pages} 页` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <span className="book-volume-title-page-copy book-volume-file-page-back">
      <i aria-hidden="true" />
      <span className="book-volume-title-page-center">
        <strong>{file.title}</strong>
        {meta ? <span>{meta}</span> : null}
        {file.updated ? <small>{file.updated}</small> : null}
      </span>
      <i aria-hidden="true" />
    </span>
  );
}
