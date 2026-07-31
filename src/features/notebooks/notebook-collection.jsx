import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowLeft, FilePlus2, Files, FolderPlus, LoaderCircle, LogOut, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FolderCard } from "@/features/notebooks/folder-card";

gsap.registerPlugin(useGSAP);

const readDesignToken = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function NotebookCollection({
  notebooks,
  loading,
  selectedId,
  activeFileId,
  onSelect,
  onOpenFile,
  onCreateNotebook,
  onCreateFile,
  onSignOut,
}) {
  const collectionRef = useRef(null);
  const trackRef = useRef(null);
  const transitionRef = useRef(null);
  const closeAnimationRef = useRef(null);
  const dismissFocusedRef = useRef(null);
  const isAnimatingRef = useRef(false);
  const focusedIdRef = useRef(selectedId);
  focusedIdRef.current = selectedId;
  const focusedNotebook = notebooks.find((notebook) => notebook.id === selectedId);

  const { contextSafe } = useGSAP(() => {
    const media = gsap.matchMedia();
    const track = trackRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const moveTrackTo = track
      ? gsap.quickTo(track, "x", { duration: reduceMotion ? 0 : 0.46, ease: "power3.out" })
      : null;
    let scrollTarget = track ? Math.max(0, -(Number(gsap.getProperty(track, "x")) || 0)) : 0;
    let touchY = null;

    const getMaxTravel = () => {
      const workspace = track?.closest(".workspace");
      return track && workspace ? Math.max(0, track.scrollWidth - workspace.clientWidth) : 0;
    };

    const moveTrack = (delta, event) => {
      if (!track || focusedIdRef.current || document.querySelector('[data-slot="dialog-content"]')) return;

      const maxTravel = getMaxTravel();
      if (!delta || !maxTravel) return;

      if (event?.cancelable) event.preventDefault();

      const nextTarget = gsap.utils.clamp(0, maxTravel, scrollTarget + delta * 1.15);
      const canMove = nextTarget !== scrollTarget;
      scrollTarget = nextTarget;

      if (!canMove) return;
      moveTrackTo?.(-scrollTarget);
    };

    const scrollHorizontally = (event) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      moveTrack(delta, event);
    };

    const startTouch = (event) => {
      touchY = event.touches[0]?.clientY ?? null;
    };

    const moveTouch = (event) => {
      const currentY = event.touches[0]?.clientY;
      if (touchY == null || currentY == null) return;
      const delta = touchY - currentY;
      touchY = currentY;
      moveTrack(delta, event);
    };

    const resetTouch = () => { touchY = null; };
    const clampTrack = () => {
      scrollTarget = gsap.utils.clamp(0, getMaxTravel(), scrollTarget);
      moveTrackTo?.tween.pause();
      gsap.set(track, { x: -scrollTarget });
    };

    const dismissFocused = (event) => dismissFocusedRef.current?.(event);

    window.addEventListener("wheel", scrollHorizontally, { passive: false });
    window.addEventListener("touchstart", startTouch, { passive: true });
    window.addEventListener("touchmove", moveTouch, { passive: false });
    window.addEventListener("touchend", resetTouch, { passive: true });
    window.addEventListener("resize", clampTrack);
    document.addEventListener("pointerdown", dismissFocused, true);
    media.add(
      {
        reduceMotion: "(prefers-reduced-motion: reduce)",
        isMobile: "(max-width: 799px)",
      },
      (context) => {
        if (context.conditions.reduceMotion) return;
        gsap.timeline({ defaults: { ease: "power3.out" } })
          .from(".page-heading", { y: 18, autoAlpha: 0, duration: 0.46 })
          .from(".folder-card", {
            y: context.conditions.isMobile ? 22 : 34,
            scale: 0.97,
            autoAlpha: 0,
            duration: 0.62,
            stagger: { each: 0.07, from: "start" },
          }, 0.08);
      },
    );
    return () => {
      window.removeEventListener("wheel", scrollHorizontally);
      window.removeEventListener("touchstart", startTouch);
      window.removeEventListener("touchmove", moveTouch);
      window.removeEventListener("touchend", resetTouch);
      window.removeEventListener("resize", clampTrack);
      document.removeEventListener("pointerdown", dismissFocused, true);
      moveTrackTo?.tween.kill();
      gsap.killTweensOf(track);
      media.revert();
    };
  }, { scope: collectionRef });

  const hoverFolder = contextSafe((event, entering) => {
    if (focusedIdRef.current || isAnimatingRef.current) return;
    const card = event.currentTarget;
    const front = card.querySelector(".folder-front");
    const papers = [...card.querySelectorAll(".folder-paper")].slice(0, 2);
    const duration = entering ? 0.44 : 0.4;

    gsap.to(front, {
      x: entering ? -5 : 0,
      rotationY: entering ? -27 : -15,
      boxShadow: readDesignToken(entering ? "--shadow-folder-hover" : "--shadow-folder-rest"),
      duration,
      ease: "power3.out",
      overwrite: "auto",
    });

    gsap.to(papers, {
      x: (index) => entering ? (index === 0 ? 41 : 43) : (index === 0 ? 31 : 23),
      y: (index) => entering ? (index === 0 ? 27 : 3) : (index === 0 ? 27 : 13),
      rotation: (index) => entering ? (index === 0 ? 12 : 5) : (index === 0 ? 7 : 6),
      duration,
      ease: "power3.out",
      overwrite: "auto",
    });
  });

  const openNotebook = contextSafe((id, event) => {
    if (isAnimatingRef.current || focusedIdRef.current) return;
    isAnimatingRef.current = true;
    focusedIdRef.current = id;
    const selectedCard = event.currentTarget.closest(".folder-card");
    const track = trackRef.current;
    const initialCardRects = new Map(
      [...collectionRef.current.querySelectorAll(".folder-card")]
        .map((card) => [card, card.getBoundingClientRect()]),
    );
    onSelect(id);

    gsap.delayedCall(0, () => {
      const root = collectionRef.current;
      const focusUi = root.querySelector(".focus-mode-ui");
      const cards = [...root.querySelectorAll(".folder-card")];
      const otherCards = cards.filter((card) => card !== selectedCard);
      const pageHeading = root.querySelector(".page-heading");
      const front = selectedCard.querySelector(".folder-front");
      const paperLayer = selectedCard.querySelector(".folder-papers");
      const papers = [...selectedCard.querySelectorAll(".folder-paper")].slice(0, 2);
      const hiddenPapers = [...selectedCard.querySelectorAll(".folder-paper")].slice(2);
      const hit = selectedCard.querySelector(".folder-hit");
      const menu = selectedCard.querySelector(".folder-menu");
      gsap.set(track, { overflow: "visible" });
      const baseCardRects = new Map(cards.map((card) => [card, card.getBoundingClientRect()]));
      gsap.set(cards, {
        x: (index, card) => initialCardRects.get(card).left - baseCardRects.get(card).left,
        y: (index, card) => initialCardRects.get(card).top - baseCardRects.get(card).top,
      });

      const selectedRect = initialCardRects.get(selectedCard);
      const selectedBaseRect = baseCardRects.get(selectedCard);
      const rootRect = root.getBoundingClientRect();
      const isMobile = window.matchMedia("(max-width: 799px)").matches;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const travel = Math.max(window.innerWidth, window.innerHeight) * 0.72;
      const scrollState = { y: window.scrollY };
      const html = document.documentElement;
      const previousScrollBehavior = html.style.scrollBehavior;
      const paperWidth = papers[0]?.offsetWidth ?? selectedRect.width * 0.85;
      const paperHeight = papers[0]?.offsetHeight ?? selectedRect.height * 0.85;
      const focusedPaperGap = isMobile ? 12 : 24;
      const focusedPaperShift = 80;
      const visiblePaperCount = papers.length;
      const focusedCompositionWidth = selectedRect.width
        + visiblePaperCount * paperWidth
        + Math.max(0, visiblePaperCount - 1) * focusedPaperGap
        - (visiblePaperCount ? focusedPaperShift : 0);
      const focusedLeft = Math.max(0, (rootRect.width - focusedCompositionWidth) / 2);
      const duration = reduceMotion ? 0 : 0.74;
      html.style.scrollBehavior = "auto";

      gsap.set(focusUi, { autoAlpha: 0 });
      if (hiddenPapers.length) gsap.set(hiddenPapers, { autoAlpha: 0 });
      gsap.set(paperLayer, { zIndex: 3 });

      const finishClose = () => {
        gsap.set(track, { clearProps: "overflow" });
        gsap.set(
          [selectedCard, ...otherCards, pageHeading, focusUi, front, paperLayer, ...papers, ...hiddenPapers, hit, menu],
          { clearProps: "transform,opacity,visibility,zIndex,pointerEvents,boxShadow" },
        );
        transitionRef.current = null;
        closeAnimationRef.current = null;
        focusedIdRef.current = null;
        isAnimatingRef.current = false;
        html.style.scrollBehavior = previousScrollBehavior;
        onSelect(null);
      };

      const timeline = gsap.timeline({
        paused: true,
        defaults: { ease: "power3.inOut" },
        onComplete: () => {
          isAnimatingRef.current = false;
          window.scrollTo({ top: 0, behavior: "instant" });
          html.style.scrollBehavior = previousScrollBehavior;
        },
        onReverseComplete: finishClose,
      });

      timeline
        .addLabel("focus", 0)
        .to(scrollState, {
          y: 0,
          duration: reduceMotion ? 0 : 0.62,
          onUpdate: () => window.scrollTo(0, scrollState.y),
        }, "focus")
        .to(pageHeading, { y: -24, autoAlpha: 0, duration: reduceMotion ? 0 : 0.42 }, "focus")
        .to(otherCards, {
          x: (index, card) => {
            const rect = initialCardRects.get(card);
            const baseRect = baseCardRects.get(card);
            const dx = rect.left + rect.width / 2 - window.innerWidth / 2;
            const dy = rect.top + rect.height / 2 - window.innerHeight / 2;
            const length = Math.hypot(dx, dy) || 1;
            return rect.left - baseRect.left + (dx / length) * travel;
          },
          y: (index, card) => {
            const rect = initialCardRects.get(card);
            const baseRect = baseCardRects.get(card);
            const dx = rect.left + rect.width / 2 - window.innerWidth / 2;
            const dy = rect.top + rect.height / 2 - window.innerHeight / 2;
            const length = Math.hypot(dx, dy) || 1;
            return rect.top - baseRect.top + (dy / length) * travel;
          },
          rotation: (index) => (index % 2 ? 12 : -12),
          scale: 0.88,
          autoAlpha: 0,
          pointerEvents: "none",
          duration,
          stagger: reduceMotion ? 0 : { amount: 0.14, from: "center" },
        }, "focus")
        .to(focusUi, { autoAlpha: 1, duration: reduceMotion ? 0 : 0.35 }, "focus+=0.16")
        .to(selectedCard, {
          x: rootRect.left + focusedLeft - selectedBaseRect.left,
          y: 0,
          transformOrigin: "top left",
          zIndex: 30,
          duration,
        }, "focus")
        .to(menu, { autoAlpha: 0, duration: reduceMotion ? 0 : 0.2 }, "focus")
        .to(front, {
          x: isMobile ? -12 : -18,
          rotationY: isMobile ? -66 : -64,
          boxShadow: readDesignToken("--shadow-folder-focus"),
          duration: reduceMotion ? 0 : 0.78,
        }, "focus+=0.13")
        .to(papers, {
          x: (index) => selectedRect.width + index * paperWidth
            + index * focusedPaperGap - focusedPaperShift,
          y: (selectedRect.height - paperHeight) / 2,
          rotation: 0,
          autoAlpha: 1,
          duration: reduceMotion ? 0 : 0.72,
          stagger: reduceMotion ? 0 : { each: 0.08, from: "start" },
        }, "focus+=0.22");

      closeAnimationRef.current = () => {
        if (timeline.reversed()) return;
        isAnimatingRef.current = true;
        const reverseDuration = reduceMotion ? 0 : timeline.time() / 1.18;
        const innerDuration = Math.min(0.52, reverseDuration * 0.9);

        timeline.getTweensOf([front, ...papers]).forEach((tween) => tween.kill());
        gsap.killTweensOf([front, ...papers]);
        gsap.timeline({ defaults: { duration: innerDuration, ease: "power3.inOut" } })
          .to(front, {
            x: 0,
            rotationY: -15,
            boxShadow: readDesignToken("--shadow-folder-rest"),
          }, 0)
          .to(papers, {
            x: (index) => index === 0 ? 31 : 23,
            y: (index) => index === 0 ? 27 : 13,
            rotation: (index) => index === 0 ? 7 : 6,
            autoAlpha: 1,
          }, 0);
        timeline.timeScale(1.18).reverse();
      };

      transitionRef.current = timeline;
      timeline.play();
    });
  });

  const closeNotebook = contextSafe(() => {
    closeAnimationRef.current?.();
  });

  dismissFocusedRef.current = (event) => {
    if (!focusedIdRef.current) return;
    if (activeFileId || event.target.closest(".lesson-file-workspace")) return;
    if (event.target.closest(".folder-paper")) return;
    if (event.target.closest('.focus-actions button, [data-slot^="dialog-"]')) return;
    closeNotebook();
  };

  return (
    <div className={`collection-view ${focusedNotebook ? "is-focused" : ""}`} ref={collectionRef}>
      <div className="page-heading">
        <h3 className="page-title" id="page-title">备好课</h3>
        <div className="create-actions">
          <Button variant="outline" type="button" onClick={onCreateNotebook}>
            <FolderPlus data-icon="inline-start" /> 新增备课本
          </Button>
          <Button type="button" onClick={onCreateFile}>
            <FilePlus2 data-icon="inline-start" /> 新增备课文件
          </Button>
          <Button variant="ghost" size="icon" type="button" onClick={onSignOut} aria-label="退出登录">
            <LogOut />
          </Button>
        </div>
      </div>

      {focusedNotebook && (
        <section className="focus-mode-ui" aria-label={`${focusedNotebook.title}中的备课文件`}>
          <div className="focus-toolbar">
            <Button variant="ghost" type="button" onClick={closeNotebook}>
              <ArrowLeft data-icon="inline-start" /> 返回全部备课本
            </Button>
            <div className="focus-actions">
              <span><Files aria-hidden="true" /> {focusedNotebook.files.length} 份文件</span>
              <Button type="button" onClick={onCreateFile}>
                <FilePlus2 data-icon="inline-start" /> 新增备课文件
              </Button>
            </div>
          </div>
        </section>
      )}

      {notebooks.length ? (
        <div className="folder-grid" ref={trackRef} aria-label="备课本列表">
          {notebooks.map((notebook) => (
            <FolderCard
              notebook={notebook}
              isFocused={notebook.id === selectedId}
              activeFileId={activeFileId}
              onOpen={openNotebook}
              onOpenFile={onOpenFile}
              onHover={hoverFolder}
              key={notebook.id}
            />
          ))}
        </div>
      ) : (
        <Empty className="collection-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">{loading ? <LoaderCircle className="animate-spin" /> : <Search />}</EmptyMedia>
            <EmptyTitle>{loading ? "正在加载备课数据" : "还没有备课本"}</EmptyTitle>
            <EmptyDescription>{loading ? "正在从服务器读取你的工作区。" : "创建第一个备课本开始准备课程。"}</EmptyDescription>
          </EmptyHeader>
          {!loading && <EmptyContent>
            <Button type="button" onClick={onCreateNotebook}>
              <FolderPlus data-icon="inline-start" /> 新增备课本
            </Button>
          </EmptyContent>}
        </Empty>
      )}
    </div>
  );
}
