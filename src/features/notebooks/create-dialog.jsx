import { useState } from "react";

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

export function CreateDialog({ kind, notebooks, onClose, onCreate }) {
  const isNotebook = kind === "notebook";
  const [title, setTitle] = useState("");
  const [className, setClassName] = useState("七年级（1）班");
  const [subject, setSubject] = useState("语文");
  const [notebookId, setNotebookId] = useState(notebooks[0]?.id ?? "");

  const submit = (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    onCreate({ title: title.trim(), className, subject, notebookId });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{isNotebook ? "新增备课本" : "新增备课文件"}</DialogTitle>
            <DialogDescription>
              {isNotebook ? "为一个班级建立新的课程档案。" : "把新教案归入已有的备课本。"}
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
                onChange={(event) => setTitle(event.target.value)}
                placeholder={isNotebook ? "例如：地理备课本" : "例如：季风与我们的生活"}
              />
            </Field>

            {isNotebook ? (
              <FieldGroup className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="class-name">班级</FieldLabel>
                  <Input
                    id="class-name"
                    value={className}
                    onChange={(event) => setClassName(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="subject">科目</FieldLabel>
                  <Input
                    id="subject"
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                  />
                </Field>
              </FieldGroup>
            ) : (
              <Field>
                <FieldLabel htmlFor="notebook-select">所属备课本</FieldLabel>
                <Select value={notebookId} onValueChange={setNotebookId}>
                  <SelectTrigger id="notebook-select" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {notebooks.map((notebook) => (
                        <SelectItem value={notebook.id} key={notebook.id}>
                          {notebook.title} · {notebook.className}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </FieldGroup>

          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={!title.trim()}>创建</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
