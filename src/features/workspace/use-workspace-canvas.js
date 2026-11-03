import { useCallback, useEffect, useRef, useState } from "react";

const limit = (value) => Math.min(2, Math.max(0.25, value));
const editable = (target) => target?.closest?.('input, textarea, select, [contenteditable="true"]');

// Keep high-frequency pointer work outside React and retain native scrolling,
// selection, IME and editor coordinates. Zoom never changes document content.
export function useWorkspaceCanvas(scrollRef, ready = true) {
  const [mode, setMode] = useState("select");
  const [zoom, setZoom] = useState(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  const zoomAnchorRef = useRef(null);
  const resetRef = useRef(false);

  const changeZoom = useCallback((next, point) => {
    const viewport = scrollRef.current;
    const anchor = viewport?.querySelector('[data-canvas-anchor], .lesson-sheet-slot');
    if (viewport && anchor) {
      const rect = anchor.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      const x = point?.x ?? view.left + viewport.clientWidth / 2;
      const y = point?.y ?? view.top + Math.min(viewport.clientHeight / 2, 280);
      zoomAnchorRef.current = { anchor, x, y,
        rx: (x - rect.left) / rect.width, ry: (y - rect.top) / rect.height };
    }
    setZoom(limit(typeof next === "function" ? next(scaleRef.current) : next));
  }, [scrollRef]);

  const fit = useCallback(() => {
    zoomAnchorRef.current = null;
    resetRef.current = true;
    setZoom(null);
    const viewport = scrollRef.current;
    if (viewport) { viewport.scrollTop = 0; viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2; }
  }, [scrollRef]);

  const onScaleApplied = useCallback((next) => {
    scaleRef.current = next;
    setScale(previous => Math.abs(previous - next) < 0.001 ? previous : next);
    const viewport = scrollRef.current;
    const point = zoomAnchorRef.current;
    if (viewport && point?.anchor.isConnected) {
      const rect = point.anchor.getBoundingClientRect();
      viewport.scrollLeft += rect.left + rect.width * point.rx - point.x;
      viewport.scrollTop += rect.top + rect.height * point.ry - point.y;
    } else if (viewport) {
      viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
      if (resetRef.current) viewport.scrollTop = 0;
    }
    zoomAnchorRef.current = null;
    resetRef.current = false;
  }, [scrollRef]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!ready || !viewport) return;
    let drag = null;
    let frame = null;
    let space = false;
    let wheelFrame = null;
    let wheelScale = null;
    let wheelPoint = null;
    const paint = () => {
      frame = null;
      if (!drag) return;
      viewport.scrollLeft = drag.left - drag.dx;
      viewport.scrollTop = drag.top - drag.dy;
    };
    const end = () => {
      if (frame != null) { cancelAnimationFrame(frame); paint(); }
      if (drag && viewport.hasPointerCapture(drag.id)) viewport.releasePointerCapture(drag.id);
      drag = null;
      delete viewport.dataset.panning;
    };
    const down = (event) => {
      if (event.pointerType === "touch" || ![0, 1].includes(event.button)) return;
      if (mode !== "hand" && !space && event.button !== 1) return;
      if (event.target.closest('[data-canvas-controls]')) return;
      event.preventDefault();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
        left: viewport.scrollLeft, top: viewport.scrollTop, dx: 0, dy: 0 };
      viewport.setPointerCapture(event.pointerId);
      viewport.dataset.panning = "true";
    };
    const move = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag.dx = event.clientX - drag.x; drag.dy = event.clientY - drag.y;
      if (frame == null) frame = requestAnimationFrame(paint);
    };
    const keyDown = (event) => {
      if (event.code !== "Space" || editable(event.target) || !viewport.contains(event.target)) return;
      event.preventDefault(); space = true; viewport.dataset.spacePan = "true";
    };
    const keyUp = (event) => {
      if (event.code !== "Space") return;
      space = false; delete viewport.dataset.spacePan; end();
    };
    const wheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      wheelScale = limit((wheelScale ?? scaleRef.current) * Math.exp(-event.deltaY * 0.004));
      wheelPoint = { x: event.clientX, y: event.clientY };
      if (wheelFrame == null) wheelFrame = requestAnimationFrame(() => {
        wheelFrame = null;
        changeZoom(wheelScale, wheelPoint);
        wheelScale = null;
      });
    };
    const blur = () => { space = false; delete viewport.dataset.spacePan; end(); };
    viewport.addEventListener("pointerdown", down);
    viewport.addEventListener("pointermove", move);
    viewport.addEventListener("pointerup", end);
    viewport.addEventListener("pointercancel", end);
    viewport.addEventListener("lostpointercapture", end);
    viewport.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      end(); delete viewport.dataset.spacePan;
      if (wheelFrame != null) cancelAnimationFrame(wheelFrame);
      viewport.removeEventListener("pointerdown", down);
      viewport.removeEventListener("pointermove", move);
      viewport.removeEventListener("pointerup", end);
      viewport.removeEventListener("pointercancel", end);
      viewport.removeEventListener("lostpointercapture", end);
      viewport.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  }, [changeZoom, mode, ready, scrollRef]);

  return { mode, setMode, zoom, scale, changeZoom, fit, onScaleApplied };
}
