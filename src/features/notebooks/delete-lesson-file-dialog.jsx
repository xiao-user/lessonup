import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DeleteLessonFileDialog({ file, deleting, onClose, onConfirm }) {
  return (
    <Dialog open={Boolean(file)} onOpenChange={(open) => { if (!open && !deleting) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除这份备课文件？</DialogTitle>
          <DialogDescription>
            “{file?.title}”的教案、历史版本、助手会话和关联上传资料都会被永久删除。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" type="button" disabled={deleting} onClick={onClose}>取消</Button>
          <Button variant="destructive" type="button" disabled={deleting} onClick={onConfirm}>
            {deleting ? "删除中…" : "确认删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteNotebookDialog({ notebook, deleting, onClose, onConfirm }) {
  return (
    <Dialog open={Boolean(notebook)} onOpenChange={(open) => { if (!open && !deleting) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除整个备课本？</DialogTitle>
          <DialogDescription>
            “{notebook?.title}”及其中全部备课文件、历史版本、助手会话和关联上传资料都会被永久删除。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" type="button" disabled={deleting} onClick={onClose}>取消</Button>
          <Button variant="destructive" type="button" disabled={deleting} onClick={onConfirm}>
            {deleting ? "删除中…" : "确认删除备课本"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
