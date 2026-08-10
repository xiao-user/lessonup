import { useEffect, useMemo, useRef, useState } from "react";

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
import { formatTextbookOptionLabel } from "@/features/curriculum/labels";
import { agentApi } from "@/lib/agent-api";

const DEFAULT_TERM = "2026—2027 学年上学期";

export function CreateSemesterFrameworkDialog({ notebook, onClose, onCreate }) {
  const [textbooks, setTextbooks] = useState([]);
  const [textbookId, setTextbookId] = useState("");
  const [term, setTerm] = useState(DEFAULT_TERM);
  const [totalWeeks, setTotalWeeks] = useState(18);
  const [weeklyPeriods, setWeeklyPeriods] = useState(5);
  const [lessonDurationMinutes, setLessonDurationMinutes] = useState(40);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const submissionRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await agentApi.listCurriculumTextbooks({
          subject: notebook.subject,
          stage: notebook.stage || undefined,
          grade: notebook.grade || undefined,
          limit: 200,
        });
        if (cancelled) return;
        const matching = (result.textbooks ?? []).filter((book) => (
          !notebook.edition || book.edition === notebook.edition
        ));
        const choices = matching.length ? matching : (result.textbooks ?? []);
        setTextbooks(choices);
        if (choices.length === 1) setTextbookId(choices[0].id);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [notebook.edition, notebook.grade, notebook.stage, notebook.subject]);

  const selectedTextbook = useMemo(
    () => textbooks.find((book) => book.id === textbookId),
    [textbookId, textbooks],
  );

  const submit = async (event) => {
    event.preventDefault();
    if (!selectedTextbook || submitting) return;
    const values = {
      textbookId,
      title: `${notebook.grade || ""}${notebook.subject}${selectedTextbook.volume || ""}教学框架`,
      term: term.trim(),
      startDate: null,
      totalWeeks: Number(totalWeeks),
      weeklyPeriods: Number(weeklyPeriods),
      lessonDurationMinutes: Number(lessonDurationMinutes),
      capacityRatio: 0.9,
      planningHorizonWeeks: Math.min(2, Number(totalWeeks)),
      contextProfile: {
        className: notebook.className,
        gradeLevel: selectedTextbook.grade || notebook.grade,
        textbookEdition: [selectedTextbook.edition, selectedTextbook.volume].filter(Boolean).join(" · "),
      },
    };
    const signature = JSON.stringify(values);
    if (submissionRef.current?.signature !== signature) {
      submissionRef.current = { signature, idempotencyKey: crypto.randomUUID() };
    }
    setSubmitting(true);
    try {
      await onCreate(values, submissionRef.current.idempotencyKey);
      submissionRef.current = null;
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>建立学期教学框架</DialogTitle>
            <DialogDescription>
              先固定教材和时间范围，系统会按真实教材目录建立全部单元骨架。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="framework-textbook">教材</FieldLabel>
              <Select value={textbookId} onValueChange={setTextbookId} disabled={loading || !textbooks.length}>
                <SelectTrigger id="framework-textbook">
                  <SelectValue placeholder={loading ? "正在匹配教材…" : "选择教材册次"}>
                    {(value) => formatTextbookOptionLabel(
                      textbooks.find((book) => book.id === value),
                    ) || "选择教材册次"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {textbooks.map((book) => (
                      <SelectItem value={book.id} key={book.id}>
                        {formatTextbookOptionLabel(book)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="framework-term">学期</FieldLabel>
              <Input id="framework-term" value={term} onChange={(event) => setTerm(event.target.value)} />
            </Field>
            <FieldGroup className="grid grid-cols-3 gap-3">
              <Field>
                <FieldLabel htmlFor="framework-weeks">教学周</FieldLabel>
                <Input id="framework-weeks" type="number" min="1" max="30" value={totalWeeks} onChange={(event) => setTotalWeeks(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="framework-periods">每周课时</FieldLabel>
                <Input id="framework-periods" type="number" min="1" max="30" value={weeklyPeriods} onChange={(event) => setWeeklyPeriods(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="framework-duration">每课时分钟</FieldLabel>
                <Select value={String(lessonDurationMinutes)} onValueChange={(value) => setLessonDurationMinutes(Number(value))}>
                  <SelectTrigger id="framework-duration">
                    <SelectValue>
                      {(value) => (value ? `${value} 分钟` : "选择课时分钟")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="40">40 分钟</SelectItem>
                      <SelectItem value="45">45 分钟</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" type="button" disabled={submitting} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={!selectedTextbook || !term.trim() || submitting}>
              {submitting ? "正在建立…" : "建立框架"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
