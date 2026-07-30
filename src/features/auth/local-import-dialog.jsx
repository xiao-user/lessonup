import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function LocalImportDialog({ count, status, onConfirm, onLater }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && status !== "importing") onLater(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>导入本机备课数据</DialogTitle>
          <DialogDescription>
            检测到 {count} 个本机备课本。确认后会复制到你的 LessonUp 空间；原有浏览器数据会保留，不会静默删除。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onLater} disabled={status === "importing"}>稍后</Button>
          <Button type="button" onClick={onConfirm} disabled={status === "importing"}>{status === "importing" ? "正在导入…" : "确认导入"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
