import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildCurriculumNodeOptions,
  buildContextProfileFromTextbook,
  formatCurriculumNodeTitle,
  formatTextbookOptionLabel,
  formatTextbookVolumeLabel,
} from "@/features/curriculum/labels";
import { agentApi } from "@/lib/agent-api";

const NONE = "__none__";
const formatNotebookLabel = (notebook) => {
  if (!notebook) return "";
  return [
    notebook.title,
    notebook.title.includes(notebook.subject) ? null : notebook.subject,
    notebook.className,
  ].filter(Boolean).join(" · ");
};

export function CreateDialog({ kind, notebooks, initialNotebookId, onClose, onCreate }) {
  const isNotebook = kind === "notebook";
  const [title, setTitle] = useState("");
  const [className, setClassName] = useState("七年级（1）班");
  const [stage, setStage] = useState("初中");
  const [grade, setGrade] = useState("七年级");
  const [subject, setSubject] = useState("语文");
  const [notebookId, setNotebookId] = useState(
    initialNotebookId ?? notebooks[0]?.id ?? "",
  );
  const [edition, setEdition] = useState(NONE);
  const [textbookId, setTextbookId] = useState(NONE);
  const [unitNodeId, setUnitNodeId] = useState(NONE);
  const [lessonNodeId, setLessonNodeId] = useState(NONE);
  const [titleWasEdited, setTitleWasEdited] = useState(false);
  const [facets, setFacets] = useState({
    stages: [], grades: [], subjects: [], editions: [], gradesByStage: {},
  });
  const [textbooks, setTextbooks] = useState([]);
  const [units, setUnits] = useState([]);
  const [lessonNodes, setLessonNodes] = useState([]);
  const [loadingCurriculum, setLoadingCurriculum] = useState(true);
  const [loadingUnits, setLoadingUnits] = useState(false);
  const [loadingLessonNodes, setLoadingLessonNodes] = useState(false);

  const selectedNotebook = notebooks.find((notebook) => notebook.id === notebookId);
  const subjectForLesson = selectedNotebook?.subject ?? subject;
  const inferredNotebookGrade = selectedNotebook?.className?.match(
    /([一二三四五六七八九十]+年级)/,
  )?.[1] ?? "";
  const stageForCatalog = isNotebook ? stage : (selectedNotebook?.stage ?? "");
  const gradeForCatalog = isNotebook
    ? grade
    : (selectedNotebook?.grade || inferredNotebookGrade);
  const selectedTextbook = textbooks.find((book) => book.id === textbookId);
  const selectedUnit = units.find((node) => node.nodeId === unitNodeId);
  const lessonNodeOptions = useMemo(
    () => buildCurriculumNodeOptions(lessonNodes, unitNodeId),
    [lessonNodes, unitNodeId],
  );
  const selectedLessonNode = lessonNodeOptions.find((node) => node.nodeId === lessonNodeId);

  const editions = useMemo(() => {
    const values = new Set(
      textbooks
        .filter((book) => !subjectForLesson || book.subject === subjectForLesson)
        .map((book) => book.edition)
        .filter(Boolean),
    );
    return [...values].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [textbooks, subjectForLesson]);

  const textbooksForEdition = useMemo(() => (
    textbooks.filter((book) => (
      (!subjectForLesson || book.subject === subjectForLesson)
      && (edition === NONE || book.edition === edition)
    ))
  ), [textbooks, subjectForLesson, edition]);
  const gradesForStage = facets.gradesByStage?.[stage] ?? facets.grades ?? [];

  useEffect(() => {
    if (!isNotebook || titleWasEdited) return;
    setTitle([grade, subject, "备课本"].filter(Boolean).join(""));
  }, [grade, isNotebook, subject, titleWasEdited]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCurriculum(true);
      try {
        const nextFacets = await agentApi.listCurriculumFacets();
        if (!cancelled) {
          setFacets(nextFacets);
          if (isNotebook && nextFacets.subjects?.length && !nextFacets.subjects.includes(subject)) {
            setSubject(nextFacets.subjects[0]);
          }
          if (isNotebook) {
            const validGrades = nextFacets.gradesByStage?.[stage] ?? nextFacets.grades ?? [];
            if (validGrades.length && !validGrades.includes(grade)) setGrade(validGrades[0]);
          }
        }
      } catch {
        if (!cancelled) setFacets({
          stages: ["小学", "初中", "高中"],
          grades: [],
          subjects: ["语文", "数学", "英语"],
          editions: [],
          gradesByStage: {},
        });
      } finally {
        if (!cancelled) setLoadingCurriculum(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isNotebook]);

  useEffect(() => {
    if (!subjectForLesson) {
      setTextbooks([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await agentApi.listCurriculumTextbooks({
          subject: subjectForLesson,
          stage: stageForCatalog || undefined,
          grade: gradeForCatalog || undefined,
          limit: 200,
        });
        if (cancelled) return;
        const nextTextbooks = result.textbooks ?? [];
        const preferredEdition = isNotebook ? NONE : (selectedNotebook?.edition || NONE);
        const preferredBooks = preferredEdition === NONE
          ? nextTextbooks
          : nextTextbooks.filter((book) => book.edition === preferredEdition);
        const nextTextbookId = !isNotebook && preferredBooks.length === 1
          ? preferredBooks[0].id
          : NONE;
        setTextbooks(nextTextbooks);
        setEdition(preferredEdition);
        setTextbookId(nextTextbookId);
        setUnitNodeId(NONE);
        setLessonNodeId(NONE);
        setUnits([]);
        setLessonNodes([]);
      } catch {
        if (!cancelled) setTextbooks([]);
      }
    })();
    return () => { cancelled = true; };
  }, [
    isNotebook,
    subjectForLesson,
    stageForCatalog,
    gradeForCatalog,
    notebookId,
    selectedNotebook?.edition,
  ]);

  useEffect(() => {
    if (isNotebook || textbookId === NONE) {
      setUnits([]);
      setUnitNodeId(NONE);
      setLessonNodes([]);
      setLessonNodeId(NONE);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      setLoadingUnits(true);
      try {
        const result = await agentApi.listCurriculumNodes(textbookId, { rootsOnly: true });
        if (cancelled) return;
        const nextUnits = result.nodes ?? [];
        setUnits(nextUnits);
        setUnitNodeId(nextUnits.length === 1 ? nextUnits[0].nodeId : NONE);
      } catch {
        if (!cancelled) setUnits([]);
      } finally {
        if (!cancelled) setLoadingUnits(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isNotebook, textbookId]);

  useEffect(() => {
    if (isNotebook || textbookId === NONE || unitNodeId === NONE) {
      setLessonNodes([]);
      setLessonNodeId(NONE);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      setLoadingLessonNodes(true);
      try {
        const result = await agentApi.listCurriculumNodes(textbookId, {
          parentId: unitNodeId,
          maxLevel: 5,
        });
        if (cancelled) return;
        setLessonNodes(result.nodes ?? []);
        setLessonNodeId(NONE);
      } catch {
        if (!cancelled) setLessonNodes([]);
      } finally {
        if (!cancelled) setLoadingLessonNodes(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isNotebook, textbookId, unitNodeId]);

  const submit = (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    if (isNotebook) {
      onCreate({
        title: title.trim(),
        className,
        subject,
        stage: stage === NONE ? "" : stage,
        grade: grade === NONE ? "" : grade,
        edition: edition === NONE ? "" : edition,
        notebookId,
      });
      return;
    }
    onCreate({
      title: title.trim(),
      className,
      subject: subjectForLesson,
      notebookId,
      unitTitle: selectedUnit?.title,
      lessonTitle: selectedLessonNode
        ? formatCurriculumNodeTitle(selectedLessonNode.title)
        : undefined,
      contextProfile: buildContextProfileFromTextbook(
        selectedTextbook,
        unitNodeId === NONE ? undefined : unitNodeId,
        lessonNodeId === NONE ? undefined : lessonNodeId,
      ),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{isNotebook ? "新增备课本" : "新增备课文件"}</DialogTitle>
            <DialogDescription>
              {isNotebook
                ? "为一个班级建立新的课程档案，科目来自国家教材目录。"
                : "选择教材中的具体课文或章节，自动建立文件并填写教案基本信息。"}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="item-title">
                {isNotebook ? "备课本名称" : "文件名称"}
              </FieldLabel>
              <Input
                id="item-title"
                autoFocus
                value={title}
                onChange={(event) => {
                  setTitleWasEdited(true);
                  setTitle(event.target.value);
                }}
                placeholder={isNotebook ? "例如：地理备课本" : "例如：季风与我们的生活"}
              />
            </Field>

            {isNotebook ? (
              <>
                <Field>
                  <FieldLabel htmlFor="class-name">班级</FieldLabel>
                  <Input
                    id="class-name"
                    value={className}
                    onChange={(event) => setClassName(event.target.value)}
                  />
                </Field>
                <FieldGroup className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="stage">学段</FieldLabel>
                    <Select
                      value={stage}
                      onValueChange={(value) => {
                        setStage(value);
                        const validGrades = facets.gradesByStage?.[value] ?? [];
                        if (validGrades.length && !validGrades.includes(grade)) {
                          setGrade(validGrades[0]);
                        }
                      }}
                      disabled={loadingCurriculum}
                    >
                      <SelectTrigger id="stage" className="w-full">
                        <SelectValue placeholder="选择学段" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {(facets.stages?.length ? facets.stages : [stage]).map((item) => (
                            <SelectItem value={item} key={item}>{item}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="grade">年级</FieldLabel>
                    <Select value={grade} onValueChange={setGrade} disabled={loadingCurriculum}>
                      <SelectTrigger id="grade" className="w-full">
                        <SelectValue placeholder="选择年级" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {(gradesForStage.length ? gradesForStage : [grade]).map((item) => (
                            <SelectItem value={item} key={item}>{item}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
                <FieldGroup className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="subject">科目</FieldLabel>
                    <Select value={subject} onValueChange={setSubject} disabled={loadingCurriculum}>
                      <SelectTrigger id="subject" className="w-full">
                        <SelectValue placeholder={loadingCurriculum ? "加载科目…" : "选择科目"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {(facets.subjects?.length ? facets.subjects : [subject]).map((item) => (
                            <SelectItem value={item} key={item}>{item}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="notebook-edition">教材版本</FieldLabel>
                    <Select value={edition} onValueChange={setEdition} disabled={!editions.length}>
                      <SelectTrigger id="notebook-edition" className="w-full">
                        <SelectValue placeholder="选择版本">
                          {(value) => value === NONE ? "暂不指定" : value}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={NONE}>暂不指定</SelectItem>
                          {editions.map((item) => (
                            <SelectItem value={item} key={item}>{item}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
              </>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor="notebook-select">所属备课本</FieldLabel>
                  <Select value={notebookId} onValueChange={setNotebookId}>
                    <SelectTrigger id="notebook-select" className="w-full">
                      <SelectValue>
                        {(value) => {
                          const notebook = notebooks.find((item) => item.id === value);
                          return formatNotebookLabel(notebook) || "选择备课本";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {notebooks.map((notebook) => (
                          <SelectItem value={notebook.id} key={notebook.id}>
                            {formatNotebookLabel(notebook)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>

                <FieldGroup className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="edition-select">教材版本</FieldLabel>
                    <Select
                      value={edition}
                      onValueChange={(value) => {
                        setEdition(value);
                        const matchingBooks = value === NONE
                          ? textbooks
                          : textbooks.filter((book) => book.edition === value);
                        setTextbookId(matchingBooks.length === 1 ? matchingBooks[0].id : NONE);
                        setUnitNodeId(NONE);
                        setLessonNodeId(NONE);
                        setLessonNodes([]);
                      }}
                      disabled={!textbooks.length}
                    >
                      <SelectTrigger id="edition-select" className="w-full">
                        <SelectValue placeholder={textbooks.length ? "可选版本" : "暂无匹配教材"}>
                          {(value) => value === NONE ? "暂不指定" : value}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={NONE}>暂不指定</SelectItem>
                          {editions.map((item) => (
                            <SelectItem value={item} key={item}>{item}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="textbook-select">教材册次</FieldLabel>
                    <Select
                      value={textbookId}
                      onValueChange={(value) => {
                        setTextbookId(value);
                        setUnitNodeId(NONE);
                        setLessonNodeId(NONE);
                        setLessonNodes([]);
                      }}
                      disabled={!textbooksForEdition.length}
                    >
                      <SelectTrigger id="textbook-select" className="w-full">
                        <SelectValue placeholder="可选册次">
                          {(value) => {
                            if (value === NONE) return "暂不指定";
                            return formatTextbookVolumeLabel(
                              textbooks.find((book) => book.id === value),
                            ) || "选择教材册次";
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={NONE}>暂不指定</SelectItem>
                          {textbooksForEdition.map((book) => (
                            <SelectItem value={book.id} key={book.id}>
                              {formatTextbookOptionLabel(book)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>

                <Field>
                  <FieldLabel htmlFor="unit-select">教材单元</FieldLabel>
                  <Select
                    value={unitNodeId}
                    onValueChange={(value) => {
                      setUnitNodeId(value);
                      setLessonNodeId(NONE);
                    }}
                    disabled={textbookId === NONE || loadingUnits}
                  >
                    <SelectTrigger id="unit-select" className="w-full">
                      <SelectValue placeholder={
                          textbookId === NONE
                            ? "先选择教材册次"
                            : loadingUnits
                              ? "加载单元…"
                              : "可选单元"
                        }
                      >
                        {(value) => {
                          if (value === NONE) return "暂不指定";
                          return units.find((node) => node.nodeId === value)?.title ?? "选择教材单元";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={NONE}>暂不指定</SelectItem>
                        {units.map((node) => (
                          <SelectItem value={node.nodeId} key={node.nodeId}>
                            {node.title}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>

                <Field>
                  <FieldLabel htmlFor="lesson-node-select">具体课文或章节</FieldLabel>
                  <Select
                    value={lessonNodeId}
                    onValueChange={(value) => {
                      setLessonNodeId(value);
                      const node = lessonNodeOptions.find((item) => item.nodeId === value);
                      if (node && !titleWasEdited) {
                        setTitle(formatCurriculumNodeTitle(node.title));
                      }
                    }}
                    disabled={unitNodeId === NONE || loadingLessonNodes}
                  >
                    <SelectTrigger id="lesson-node-select" className="w-full">
                      <SelectValue placeholder={
                          unitNodeId === NONE
                            ? "先选择教材单元"
                            : loadingLessonNodes
                              ? "加载课文与章节…"
                              : lessonNodeOptions.length
                                ? "选择具体内容"
                                : "该单元暂无下级目录"
                        }
                      >
                        {(value) => {
                          if (value === NONE) return "暂不指定";
                          return lessonNodeOptions.find((node) => node.nodeId === value)?.label
                            ?? "选择具体内容";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={NONE}>暂不指定</SelectItem>
                        {lessonNodeOptions.map((node) => (
                          <SelectItem value={node.nodeId} key={node.nodeId}>
                            {node.label}
                            {node.pageNumber ? ` · 第 ${node.pageNumber} 页` : ""}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </>
            )}
          </FieldGroup>

          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={!title.trim() || (!isNotebook && !notebookId)}>创建</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
