import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { buildCurriculumNodeOptions, formatCurriculumNodeTitle } from "@/features/curriculum/labels";
import { lessonPeriodContext, nextLessonPeriodContext } from "@/features/semester-frameworks/lesson-blueprint-context";

export function BlueprintDialog({ unit, unitTitle, nodes, blueprint, lessonDuration, unitBlueprints = [], knowledgeByNodeId = {}, onClose, onSave, onDelete }) {
  const editing = Boolean(blueprint);
  const options = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
    const scopedNodes = nodes.filter((node) => {
      let current = node;
      const visited = new Set();
      while (current && !visited.has(current.nodeId)) {
        if (current.nodeId === unit.curriculumNodeId) return true;
        visited.add(current.nodeId);
        current = current.parentId ? nodeById.get(current.parentId) : null;
      }
      return false;
    });
    return buildCurriculumNodeOptions(scopedNodes, unit.curriculumNodeId)
      .filter((node) => node.nodeId !== unit.curriculumNodeId);
  }, [nodes, unit.curriculumNodeId]);
  const [curriculumNodeId, setCurriculumNodeId] = useState(blueprint?.curriculumNodeId ?? "");
  const [title, setTitle] = useState(blueprint?.title ?? "");
  const [mainActivity, setMainActivity] = useState(blueprint?.mainActivity ?? "");
  const [observableProduct, setObservableProduct] = useState(blueprint?.observableProduct ?? "");
  const [assessmentEvidence, setAssessmentEvidence] = useState(blueprint?.assessmentEvidence ?? "");
  const [plannedMinutes, setPlannedMinutes] = useState(blueprint?.plannedMinutes ?? lessonDuration ?? 40);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const submissionRef = useRef(null);

  const periodContext = useMemo(() => {
    if (!curriculumNodeId) return null;
    const knowledgeRecord = knowledgeByNodeId[curriculumNodeId];
    return editing
      ? lessonPeriodContext(blueprint, unitBlueprints, knowledgeRecord)
      : nextLessonPeriodContext(curriculumNodeId, unitBlueprints, knowledgeRecord);
  }, [blueprint, curriculumNodeId, editing, knowledgeByNodeId, unitBlueprints]);

  useEffect(() => {
    if (editing || !curriculumNodeId) return;
    const node = options.find((candidate) => candidate.nodeId === curriculumNodeId);
    if (!node) return;
    const baseTitle = formatCurriculumNodeTitle(node.title);
    setTitle(periodContext?.periodCount > 1
      ? `${baseTitle} · 第 ${periodContext.periodNo} 课时`
      : baseTitle);
  }, [curriculumNodeId, editing, options, periodContext?.periodCount, periodContext?.periodNo]);

  const submit = async (event) => {
    event.preventDefault();
    const duration = Number(plannedMinutes);
    if (!title.trim() || submitting || (!editing && !curriculumNodeId) || !Number.isInteger(duration) || duration < 20 || duration > 60) return;
    const values = editing ? {
      expectedVersion: blueprint.version,
      title: title.trim(),
      mainActivity: mainActivity.trim(),
      observableProduct: observableProduct.trim(),
      assessmentEvidence: assessmentEvidence.trim(),
      plannedMinutes: duration,
    } : {
      semesterUnitId: unit.id,
      curriculumNodeId,
      chapterPeriodNo: periodContext?.periodNo ?? 1,
      title: title.trim(),
      mainActivity: mainActivity.trim(),
      observableProduct: observableProduct.trim(),
      assessmentEvidence: assessmentEvidence.trim(),
      anticipatedDifficulties: [],
      plannedMinutes: duration,
      teacherNotes: "",
    };
    const signature = JSON.stringify(values);
    if (submissionRef.current?.signature !== signature) {
      submissionRef.current = { signature, idempotencyKey: crypto.randomUUID() };
    }
    setSubmitting(true);
    try {
      await onSave(values, submissionRef.current.idempotencyKey);
      submissionRef.current = null;
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (!editing || submitting) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSubmitting(true);
    try {
      await onDelete({ expectedVersion: blueprint.version }, crypto.randomUUID());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent className="framework-blueprint-dialog">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{editing ? "编辑课时蓝图" : "新增课时蓝图"}</DialogTitle>
            <DialogDescription>{confirmingDelete
              ? "删除后，这条蓝图及其已关联的知识点选择会一并移除；历史框架版本仍保留记录。"
              : `${unitTitle}：只确定这节课最重要的活动与可观察结果。`}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {!editing && <Field>
              <FieldLabel htmlFor="blueprint-node">教材章节</FieldLabel>
              <Select value={curriculumNodeId} onValueChange={setCurriculumNodeId}>
                <SelectTrigger id="blueprint-node" className="w-full"><SelectValue placeholder="选择具体章节">
                  {(value) => options.find((node) => node.nodeId === value)?.label || "选择具体章节"}
                </SelectValue></SelectTrigger>
                <SelectContent><SelectGroup>{options.map((node) => (
                  <SelectItem value={node.nodeId} key={node.nodeId}>{node.label}</SelectItem>
                ))}</SelectGroup></SelectContent>
              </Select>
            </Field>}
            <Field><FieldLabel htmlFor="blueprint-title">课时名称</FieldLabel><Input id="blueprint-title" value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="blueprint-minutes">课时时长（分钟）</FieldLabel><Input id="blueprint-minutes" type="number" min="20" max="60" value={plannedMinutes} onChange={(event) => setPlannedMinutes(event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="blueprint-activity">主要教学活动</FieldLabel><Textarea id="blueprint-activity" value={mainActivity} onChange={(event) => setMainActivity(event.target.value)} placeholder="例如：学生先独立提出问题，再用问题清单比较提问角度" /></Field>
            <FieldGroup className="grid grid-cols-2 gap-3">
              <Field><FieldLabel htmlFor="blueprint-product">学生可观察产出</FieldLabel><Textarea id="blueprint-product" value={observableProduct} onChange={(event) => setObservableProduct(event.target.value)} placeholder="学生最终能做出什么" /></Field>
              <Field><FieldLabel htmlFor="blueprint-evidence">达成证据</FieldLabel><Textarea id="blueprint-evidence" value={assessmentEvidence} onChange={(event) => setAssessmentEvidence(event.target.value)} placeholder="如何判断目标是否达成" /></Field>
            </FieldGroup>
            <div className="framework-blueprint-period-summary">
              <span>本课时</span>
              <strong>{plannedMinutes || lessonDuration || 40} 分钟</strong>
              {periodContext ? <small>当前为本篇第 {periodContext.periodNo} / {periodContext.periodCount} 课时{periodContext.recommendation?.title ? ` · ${periodContext.recommendation.title}` : ""}</small> : <small>选择章节后自动匹配教材课时建议</small>}
            </div>
          </FieldGroup>
          <DialogFooter>
            {editing ? <Button variant="ghost" type="button" disabled={submitting} onClick={remove}><Trash2 />{confirmingDelete ? "确认删除蓝图" : "删除"}</Button> : null}
            <Button variant="outline" type="button" disabled={submitting} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={!title.trim() || (!editing && !curriculumNodeId) || !Number.isInteger(Number(plannedMinutes)) || Number(plannedMinutes) < 20 || Number(plannedMinutes) > 60 || submitting}>{submitting ? "正在处理…" : "保存蓝图"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
