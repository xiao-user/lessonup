import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Eye, FileText, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";

import { normalizeEditableText } from "./editable-text";
import {
  lessonFieldExtensions,
  parseLessonMarkdown,
  serializeLessonMarkdown,
} from "./lesson-markdown";

const fieldExtensions = lessonFieldExtensions;

function serializeEditor(editor) {
  return normalizeEditableText(serializeLessonMarkdown(editor.getJSON()));
}

function textOffsetAtPosition(document, position) {
  return document.textBetween(0, position, "\n").length;
}

function documentPositionAtTextOffset(document, textOffset) {
  let low = 0;
  let high = document.content.size;
  let result = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const length = document.textBetween(0, middle, "\n").length;
    if (length <= textOffset) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return Math.min(Math.max(1, result), Math.max(1, document.content.size));
}

function editorKey(field, start, end) {
  return `${field}:${start ?? 0}:${end ?? ""}`;
}

function LessonFieldEditor({
  field,
  value,
  start = 0,
  end,
  label,
  readOnly,
  revision,
  onChange,
  onFocus,
  onSelectionChange,
  onCaretChange,
  registerEditor,
}) {
  const incomingValueRef = useRef(normalizeEditableText(value));
  const publishedValueRef = useRef(normalizeEditableText(value));
  const rangeRef = useRef({ field, start, end });
  const callbacksRef = useRef({ onChange, onFocus, onSelectionChange, onCaretChange });
  const applyingRef = useRef(false);
  incomingValueRef.current = normalizeEditableText(value);
  rangeRef.current = { field, start, end };
  callbacksRef.current = { onChange, onFocus, onSelectionChange, onCaretChange };

  const editor = useEditor({
    extensions: fieldExtensions,
    content: "",
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "lesson-tiptap-field",
        "aria-label": label,
      },
    },
    onCreate({ editor: instance }) {
      applyingRef.current = true;
      try {
        instance.commands.setContent(
          parseLessonMarkdown(incomingValueRef.current),
          { emitUpdate: false },
        );
      } finally {
        applyingRef.current = false;
      }
    },
    onUpdate({ editor: instance, transaction }) {
      if (applyingRef.current || !transaction.docChanged) return;
      const previousValue = publishedValueRef.current;
      const nextValue = serializeEditor(instance);
      if (nextValue === previousValue) return;
      publishedValueRef.current = nextValue;
      callbacksRef.current.onChange({
        ...rangeRef.current,
        previousValue,
        value: nextValue,
      }, {
        field: rangeRef.current.field,
        kind: transaction.getMeta("uiEvent") === "paste" ? "paste" : "typing",
        origin: "tiptap",
      });
    },
    onFocus() {
      callbacksRef.current.onFocus();
    },
    onSelectionUpdate({ editor: instance }) {
      // setContent during editor creation also emits selection updates. Those
      // are schema initialization, not a teacher-owned caret, and must never
      // focus a later page or scroll the document during the spatial morph.
      if (!instance.isFocused) return;
      const { from, to } = instance.state.selection;
      const startOffset = textOffsetAtPosition(instance.state.doc, from);
      callbacksRef.current.onCaretChange({
        field: rangeRef.current.field,
        offset: rangeRef.current.start + startOffset,
      });
      if (from === to) return;
      const text = instance.state.doc.textBetween(from, to, "\n");
      if (!text) return;
      callbacksRef.current.onSelectionChange({
        field: rangeRef.current.field,
        start: rangeRef.current.start + startOffset,
        end: rangeRef.current.start + textOffsetAtPosition(instance.state.doc, to),
        text,
      });
    },
  }, []);

  useEffect(() => {
    if (!editor) return undefined;
    const key = editorKey(field, start, end);
    registerEditor(key, { editor, field, start, end });
    return () => registerEditor(key, null);
  }, [editor, end, field, registerEditor, start]);

  useLayoutEffect(() => {
    if (!editor) return;
    const nextValue = normalizeEditableText(value);
    if (nextValue === publishedValueRef.current) return;
    applyingRef.current = true;
    try {
      editor.commands.setContent(
        parseLessonMarkdown(nextValue),
        { emitUpdate: false },
      );
      publishedValueRef.current = nextValue;
    } finally {
      applyingRef.current = false;
    }
  }, [editor, revision, value]);

  useEffect(() => {
    editor?.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  return (
    <EditorContent
      className="lesson-field-editor"
      data-field={field}
      data-start={start}
      data-end={end}
      editor={editor}
    />
  );
}

function LessonTableColumns() {
  return (
    <colgroup>
      <col className="lesson-col-label" />
      <col className="lesson-col-content" />
      <col className="lesson-col-meta-label" />
      <col className="lesson-col-meta" />
      <col className="lesson-col-meta-label" />
      <col className="lesson-col-meta" />
    </colgroup>
  );
}

function LessonFieldCell({ colspan, ...props }) {
  return (
    <td className="lesson-tiptap-cell" colSpan={colspan}>
      <LessonFieldEditor {...props} />
    </td>
  );
}

function BasicsRow({ plan, commonProps }) {
  return (
    <tr id="lesson-section-basics" data-lesson-section="basics" className="lesson-row-basics">
      <th scope="row">单元</th>
      <LessonFieldCell {...commonProps} field="unit" value={plan.unit} label="单元" onFocus={() => commonProps.onFieldFocus("basics")} />
      <th scope="row">课时</th>
      <LessonFieldCell {...commonProps} field="period" value={plan.period} label="课时" onFocus={() => commonProps.onFieldFocus("basics")} />
      <th scope="row">总课时</th>
      <LessonFieldCell {...commonProps} field="totalPeriods" value={plan.totalPeriods} label="总课时" onFocus={() => commonProps.onFieldFocus("basics")} />
    </tr>
  );
}

function TopicRow({ plan, commonProps }) {
  return (
    <tr className="lesson-row-topic">
      <th scope="row">课题</th>
      <LessonFieldCell
        {...commonProps}
        colspan={5}
        field="topic"
        value={plan.topic}
        label="课题"
        onFocus={() => commonProps.onFieldFocus("basics")}
      />
    </tr>
  );
}

function SectionRow({ entry, commonProps }) {
  return (
    <tr
      id={entry.continued ? undefined : `lesson-section-${entry.sectionId}`}
      data-lesson-section={entry.sectionId}
      className={`lesson-row-${entry.sectionId}${entry.continued ? " is-continuation" : ""}`}
    >
      <th scope="row"><span>{entry.label}{entry.continued ? "（续）" : ""}</span></th>
      <LessonFieldCell
        colspan={5}
        field={entry.field}
        value={entry.value}
        start={entry.start}
        end={entry.end}
        label={`${entry.label}${entry.continued ? "续页" : ""}`}
        onFocus={() => commonProps.onFieldFocus(entry.sectionId)}
        {...commonProps}
      />
    </tr>
  );
}

function presentationFilename(presentation) {
  const title = String(presentation?.title ?? "课堂").replace(/\s*·\s*课堂演示\s*$/, "").trim();
  return `${title || "课堂"}演示材料.html`;
}

export function PresentationMaterialRow({
  presentation,
  state = "idle",
  error = "",
  confirmingDelete = false,
  onGenerate = () => {},
  onPreview = () => {},
  onDelete = () => {},
  measure = false,
}) {
  const busy = state === "generating" || state === "deleting";
  const hasPresentation = Boolean(presentation);
  return (
    <tr className="lesson-row-presentation" data-measure-kind={measure ? "presentation" : undefined}>
      <th scope="row"><span>演示材料</span></th>
      <td colSpan={5} className="lesson-presentation-material-cell">
        <div className="lesson-presentation-material" aria-busy={busy}>
          {hasPresentation ? (
            <>
              <span className="lesson-presentation-material-file"><FileText aria-hidden="true" />{presentationFilename(presentation)}</span>
              <div className="lesson-presentation-material-actions">
                <button type="button" className="lesson-presentation-material-action" disabled={busy} onClick={onPreview}>
                  <Eye aria-hidden="true" />预览
                </button>
                <button type="button" className="lesson-presentation-material-action" disabled={busy} onClick={onGenerate}>
                  {state === "generating" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                  {state === "generating" ? "生成中" : "重新设计"}
                </button>
                <button type="button" className="lesson-presentation-material-action is-destructive" disabled={busy} onClick={onDelete}>
                  <Trash2 aria-hidden="true" />{state === "deleting" ? "删除中" : confirmingDelete ? "确认删除" : "删除"}
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="lesson-presentation-material-action is-primary" disabled={busy} onClick={onGenerate}>
              {state === "generating" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <FileText aria-hidden="true" />}
              {state === "generating" ? "生成中" : "在对话中设计"}
            </button>
          )}
          {error ? <span className="lesson-presentation-material-error" role="alert">{error}</span> : null}
        </div>
      </td>
    </tr>
  );
}

/**
 * React owns A4 pages and the lesson table; each canonical field owns one
 * isolated Tiptap instance. Rich-text transactions therefore cannot rewrite
 * sibling modules, while pagination remains a pure projection of the plan.
 */
export function LessonPlanTiptapEditor({
  plan,
  pages,
  readOnly = false,
  externalRevision,
  layoutRevision,
  displayRevision,
  containerRef,
  onEditorReady,
  onFieldChange,
  onFieldFocus,
  onSelectionChange,
  presentationMaterial,
}) {
  const editorsRef = useRef(new Map());
  const caretRef = useRef(null);
  const revision = `${externalRevision ?? 0}:${layoutRevision ?? 0}:${displayRevision ?? "canonical"}`;
  const registerEditor = useMemo(() => (key, registration) => {
    if (registration) editorsRef.current.set(key, registration);
    else editorsRef.current.delete(key);
  }, []);
  const bridge = useMemo(() => ({ flush() {} }), []);

  useEffect(() => {
    onEditorReady(bridge);
    return () => onEditorReady(null);
  }, [bridge, onEditorReady]);

  useEffect(() => {
    const bookmark = caretRef.current;
    if (!bookmark || readOnly) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active?.classList.contains("lesson-tiptap-field")) return;
      const candidates = [...editorsRef.current.values()].filter(({ field }) => field === bookmark.field);
      const target = candidates.find(({ start, end }) => (
        bookmark.offset >= Number(start ?? 0)
        && bookmark.offset <= Number(end ?? Number.POSITIVE_INFINITY)
      )) ?? candidates.at(-1);
      if (!target) return;
      const localOffset = Math.max(0, bookmark.offset - Number(target.start ?? 0));
      target.editor.commands.focus();
      target.editor.commands.setTextSelection(
        documentPositionAtTextOffset(target.editor.state.doc, localOffset),
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layoutRevision, pages, readOnly]);

  const commonProps = {
    readOnly,
    revision,
    onChange: onFieldChange,
    onFieldFocus,
    onSelectionChange,
    onCaretChange: (bookmark) => { caretRef.current = bookmark; },
    registerEditor,
  };

  return (
    <div className="lesson-document-pages lesson-plan-tiptap" ref={containerRef}>
      {pages.map((entries, pageIndex) => (
        <div className="lesson-sheet-slot" key={`page-${pageIndex}`}>
          <div className="lesson-sheet-frame">
            <article className="lesson-sheet" data-page-index={pageIndex}>
              <div className="lesson-sheet-content">
                <table className="lesson-plan-table">
                  <LessonTableColumns />
                  <tbody>
                    {entries.map((entry) => {
                      const entryCommonProps = commonProps;
                      if (entry.kind === "basics") {
                        return <BasicsRow plan={plan} commonProps={entryCommonProps} key={entry.key} />;
                      }
                      if (entry.kind === "topic") {
                        return <TopicRow plan={plan} commonProps={entryCommonProps} key={entry.key} />;
                      }
                      if (entry.kind === "presentation") {
                        return <PresentationMaterialRow
                          key={entry.key}
                          presentation={presentationMaterial?.presentation}
                          state={presentationMaterial?.state}
                          error={presentationMaterial?.error}
                          confirmingDelete={presentationMaterial?.confirmingDelete}
                          onGenerate={presentationMaterial?.onGenerate}
                          onPreview={presentationMaterial?.onPreview}
                          onDelete={presentationMaterial?.onDelete}
                        />;
                      }
                      return <SectionRow entry={entry} commonProps={entryCommonProps} key={entry.key} />;
                    })}
                  </tbody>
                </table>
              </div>
              <span className="lesson-page-number" aria-label={`第${pageIndex + 1}页，共${pages.length}页`}>
                {pageIndex + 1} / {pages.length}
              </span>
            </article>
          </div>
        </div>
      ))}
    </div>
  );
}
