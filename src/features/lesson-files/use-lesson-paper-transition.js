import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

const SHEET_POSE = "position,top,left,width,height,zIndex,transform,transformOrigin,willChange,backgroundColor,borderRadius";

// The slot retains document geometry; only the first paper's compositor layer
// travels. No cloned editor, per-frame measurement or shadow interpolation.
export function useLessonPaperTransition({ rootRef, scrollRef, sourceElement }) {
  const transitionRef = useRef(null);
  const { contextSafe } = useGSAP(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const desktop = window.matchMedia("(min-width: 681px)");
    const pane = root.querySelector(".lesson-document-pane");
    const backdrop = root.querySelector(".lesson-workspace-backdrop");
    let timeline = null;
    let disposed = false;
    const targets = () => ({
      sheet: root.querySelector(".lesson-sheet-frame"),
      content: [...root.querySelectorAll(".lesson-sheet-content")],
      secondary: [...root.querySelectorAll(".lesson-sheet-frame")].slice(1),
      rails: desktop.matches ? [...root.querySelectorAll(".lesson-side-rail")] : [],
    });
    const sourceRect = () => sourceElement?.isConnected ? sourceElement.getBoundingClientRect() : null;
    const usable = (rect) => rect?.width > 0 && rect?.height > 0;
    const pin = (sheet, rect) => gsap.set(sheet, {
      position: "fixed", left: rect.left, top: rect.top, width: rect.width,
      height: rect.height, zIndex: 6, transformOrigin: "top left", willChange: "transform",
    });
    const pose = (from, to) => ({
      x: to.left - from.left, y: to.top - from.top,
      scaleX: to.width / from.width, scaleY: to.height / from.height,
    });
    const settled = ({ sheet, content, secondary, rails }) => {
      gsap.set(sheet, { clearProps: SHEET_POSE });
      gsap.set([...content, ...secondary, ...rails], { clearProps: "opacity,visibility,transform" });
      gsap.set(backdrop, { clearProps: "opacity" });
      if (pane) pane.inert = false;
      root.dataset.motion = "idle";
    };
    const finish = () => timeline?.progress(1);
    const enter = () => {
      const elements = targets();
      const { sheet, content, secondary, rails } = elements;
      const from = sourceRect();
      const to = sheet?.getBoundingClientRect();
      if (!usable(from) || !usable(to) || reduced.matches) {
        root.dataset.motion = "idle";
        return;
      }
      root.dataset.motion = "entering";
      if (pane) pane.inert = true;
      const paperStyle = getComputedStyle(sheet);
      const finalPaper = paperStyle.backgroundColor;
      const finalRadius = paperStyle.borderRadius;
      const sourcePaper = getComputedStyle(sourceElement).backgroundColor;
      pin(sheet, to);
      gsap.set(sheet, { ...pose(to, from), backgroundColor: sourcePaper, borderRadius: 3 });
      gsap.set(backdrop, { opacity: 0 });
      gsap.set([...content, ...rails], { autoAlpha: 0 });
      gsap.set(secondary, { autoAlpha: 0, y: 24 });
      timeline = gsap.timeline({ onComplete: () => settled(elements) })
        .to(backdrop, { opacity: 1, duration: 0.58, ease: "power2.inOut" }, 0)
        .to(sheet, { x: 0, y: 0, scaleX: 1, scaleY: 1, backgroundColor: finalPaper, borderRadius: finalRadius, duration: 0.82, ease: "power2.inOut" }, 0)
        .to(content, { autoAlpha: 1, duration: 0.32, ease: "sine.inOut" }, 0.82 * 0.58);
      if (secondary.length) timeline.to(secondary, {
        y: 0, autoAlpha: 1, duration: 0.34, stagger: { amount: Math.min(secondary.length - 1, 4) * 0.05 },
      }, 0.82 * 0.66);
      if (rails.length) timeline.fromTo(rails, { x: (i) => i === 0 ? -16 : 16 }, {
        x: 0, autoAlpha: 1, duration: 0.34, stagger: 0.05,
      }, 0.82 * 0.7);
    };
    transitionRef.current = () => new Promise((resolve) => {
      if (disposed) { resolve(false); return; }
      finish();
      if (reduced.matches) { resolve(true); return; }
      root.dataset.motion = "exiting";
      if (pane) pane.inert = true;
      const exit = () => {
        const { sheet, content, secondary, rails } = targets();
        const from = sheet?.getBoundingClientRect();
        const to = sourceRect();
        timeline = gsap.timeline({
          defaults: { ease: "power2.inOut" },
          onComplete: () => resolve(true), onInterrupt: () => resolve(false),
        });
        if (!usable(from) || !usable(to)) {
          timeline.to(root, { opacity: 0, duration: 0.24 });
          return;
        }
        pin(sheet, from);
        if (rails.length) timeline.to(rails, { autoAlpha: 0, x: (i) => i === 0 ? -12 : 12, duration: 0.22 }, 0);
        if (secondary.length) timeline.to(secondary, { autoAlpha: 0, y: 20, duration: 0.22 }, 0);
        timeline.to(content, { autoAlpha: 0, duration: 0.24, ease: "sine.inOut" }, 0)
          .to(sheet, { ...pose(from, to), backgroundColor: getComputedStyle(sourceElement).backgroundColor, borderRadius: 3, duration: 0.72 }, 0.06)
          .to(backdrop, { opacity: 0, duration: 0.42 }, 0.36);
      };
      if (scrollRef.current?.scrollTop) {
        timeline = gsap.timeline({ onComplete: exit, onInterrupt: () => resolve(false) })
          .to(scrollRef.current, { scrollTop: 0, duration: 0.34, ease: "power3.inOut" });
      } else exit();
    });
    enter();
    window.addEventListener("resize", finish);
    reduced.addEventListener("change", finish);
    return () => {
      disposed = true;
      if (pane) pane.inert = false;
      timeline?.kill();
      transitionRef.current = null;
      window.removeEventListener("resize", finish);
      reduced.removeEventListener("change", finish);
    };
  }, { scope: rootRef });
  return contextSafe(() => transitionRef.current?.() ?? Promise.resolve(false));
}
