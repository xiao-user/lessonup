import { Hand, List, Maximize, Minus, MousePointer2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CanvasTools({ canvas, outlineOpen, onToggleOutline, outlineLabel, children }) {
  return <div className="workspace-toolrail" role="toolbar" aria-label="画布工具" data-canvas-controls>
    <Button variant="ghost" size="icon" aria-label="选择与编辑" title="选择与编辑" aria-pressed={canvas.mode === "select"} onClick={() => canvas.setMode("select")}><MousePointer2 /></Button>
    <Button variant="ghost" size="icon" aria-label="拖动画布" title="拖动画布 · 也可按住空格" aria-pressed={canvas.mode === "hand"} onClick={() => canvas.setMode("hand")}><Hand /></Button>
    <span className="workspace-tool-divider" />
    <Button variant="ghost" size="icon" aria-label={outlineLabel} title={outlineLabel} aria-pressed={outlineOpen} onClick={onToggleOutline}><List /></Button>
    {children}
  </div>;
}

export function CanvasZoom({ canvas }) {
  return <div className="workspace-zoom" role="group" aria-label="画布缩放" data-canvas-controls>
    <Button variant="ghost" size="icon-sm" aria-label="缩小画布" title="缩小" disabled={canvas.scale <= 0.251} onClick={() => canvas.changeZoom(scale => scale - 0.1)}><Minus /></Button>
    <select aria-label="画布缩放比例" value={canvas.zoom == null ? 'fit' : String(canvas.zoom)} onChange={(event) => event.target.value === 'fit' ? canvas.fit() : canvas.changeZoom(Number(event.target.value))}>
      <option value="fit">适应宽度</option>
      {![0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].includes(canvas.zoom) && canvas.zoom != null ? <option value={String(canvas.zoom)}>{Math.round(canvas.scale * 100)}%</option> : null}
      {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(scale => <option key={scale} value={String(scale)}>{Math.round(scale * 100)}%</option>)}
    </select>
    <Button variant="ghost" size="icon-sm" aria-label="放大画布" title="放大" disabled={canvas.scale >= 1.999} onClick={() => canvas.changeZoom(scale => scale + 0.1)}><Plus /></Button>
    <span className="workspace-tool-divider" />
    <Button variant="ghost" size="icon-sm" aria-label="适应画布" title="适应宽度并回到页首" onClick={canvas.fit}><Maximize /></Button>
  </div>;
}
