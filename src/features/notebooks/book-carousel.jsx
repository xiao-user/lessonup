import { Fragment, forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

import {
  addCarouselWheelImpulse,
  advanceCarouselMotion,
  applyCarouselEdgeResistance,
  BOOK_CAROUSEL_MOTION,
  carouselBookPose,
  carouselNamePose,
  clampCarouselPosition,
  createCarouselMotion,
  normalizeWheelDelta,
  resolveCarouselReleaseVelocity,
} from "@/features/notebooks/book-carousel-motion";
import {
  addPageTurn,
  applyOpenBookPose,
  baseRotation,
  CLOSE_DURATION,
  EASE,
  OPEN_DURATION,
  OPEN_FIRST_PAGE_DELAY,
  pageTurnDuration,
  placeCarousel,
  readPageAngle,
} from "@/features/notebooks/book-carousel-animation";
import { BookVolume } from "@/features/notebooks/book-volume";

gsap.registerPlugin(useGSAP);

const POINTER_DRAG_THRESHOLD = 3;

export const BookCarousel = forwardRef(function BookCarousel({
  notebooks,
  selectedId,
  activeFileId,
  dismissible = true,
  onSelect,
  onActiveChange,
  onOpenFile,
  onPrepareFile,
  onDeleteFile,
}, ref) {
  const rootRef = useRef(null);
  const bookRefs = useRef([]);
  const nameRefs = useRef([]);
  const metaRefs = useRef([]);
  const scrollbarRef = useRef(null);
  const isAnimatingRef = useRef(false);
  const pageAnimatingRef = useRef(false);
  const pageTimelinesRef = useRef(new Map());
  const activeIndexRef = useRef(0);
  const preparedIndexRef = useRef(0);
  const positionRef = useRef(0);
  const motionRef = useRef(createCarouselMotion(0));
  const motionTickerRef = useRef(null);
  const selectedIdRef = useRef(selectedId);
  const dismissibleRef = useRef(dismissible);
  const pageIndexesRef = useRef({});
  const pointerIdRef = useRef(null);
  const pointerStartYRef = useRef(null);
  const pointerYRef = useRef(null);
  const pointerTimeRef = useRef(0);
  const pointerLastMoveTimeRef = useRef(0);
  const pointerDraggingRef = useRef(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [preparedIndex, setPreparedIndex] = useState(0);
  const [pageIndexes, setPageIndexes] = useState({});
  const [pageAnimating, setPageAnimating] = useState(false);
  const [bookAnimating, setBookAnimating] = useState(false);
  const [closingId, setClosingId] = useState(null);
  const activeNotebook = notebooks[activeIndex];
  const preparedNotebook = notebooks[preparedIndex];
  const selectedFileSignature = selectedId
    ? `${selectedId}:${notebooks.find((notebook) => notebook.id === selectedId)?.files.map((file) => file.id).join(",") ?? ""}`
    : "";
  const openNotebookId = selectedId ?? closingId;

  activeIndexRef.current = activeIndex;
  selectedIdRef.current = selectedId;
  dismissibleRef.current = dismissible;
  pageIndexesRef.current = pageIndexes;

  const commitPageIndex = (notebookId, pageIndex, synchronous = false) => {
    const next = { ...pageIndexesRef.current, [notebookId]: pageIndex };
    pageIndexesRef.current = next;
    if (synchronous) flushSync(() => setPageIndexes(next));
    else setPageIndexes(next);
  };

  const { contextSafe } = useGSAP(() => {}, { scope: rootRef });
  const maxPosition = () => Math.max(0, notebooks.length - 1);
  const clampPosition = (value) => clampCarouselPosition(value, maxPosition());

  const updateNearestIndex = (position) => {
    const nearest = clampPosition(Math.round(position));
    if (nearest !== activeIndexRef.current) {
      activeIndexRef.current = nearest;
      setActiveIndex(nearest);
    }
  };

  const setMotionState = (state) => {
    if (rootRef.current) rootRef.current.dataset.motionState = state;
  };

  const prepareRestingBook = (position) => {
    const index = clampPosition(Math.round(position));
    if (index === preparedIndexRef.current) return;
    preparedIndexRef.current = index;
    setPreparedIndex(index);
  };

  const commitPosition = (position, { allowOverscroll = false } = {}) => {
    const resolved = allowOverscroll
      ? gsap.utils.clamp(
        -BOOK_CAROUSEL_MOTION.overscrollLimit,
        maxPosition() + BOOK_CAROUSEL_MOTION.overscrollLimit,
        position,
      )
      : clampPosition(position);
    positionRef.current = resolved;
    motionRef.current.position = resolved;
    if (rootRef.current) rootRef.current.dataset.carouselPosition = resolved.toFixed(4);
    updateNearestIndex(resolved);
    placeCarousel({ position: resolved, bookRefs, nameRefs, metaRefs, scrollbarRef });
  };

  const removeMotionTicker = () => {
    if (!motionTickerRef.current) return;
    gsap.ticker.remove(motionTickerRef.current);
    motionTickerRef.current = null;
  };

  const stopPositionMotion = (position = positionRef.current) => {
    removeMotionTicker();
    const clamped = clampPosition(position);
    motionRef.current = createCarouselMotion(clamped);
    commitPosition(clamped);
    prepareRestingBook(clamped);
    setMotionState("idle");
  };

  const startPositionMotion = contextSafe(() => {
    if (motionTickerRef.current) return;
    setMotionState("moving");
    const tick = () => {
      const next = advanceCarouselMotion(
        motionRef.current,
        gsap.ticker.deltaRatio(60) / 60,
        maxPosition(),
      );
      motionRef.current = next;
      commitPosition(next.position, { allowOverscroll: true });
      if (!next.settled) return;
      removeMotionTicker();
      commitPosition(next.position);
      prepareRestingBook(next.position);
      setMotionState("idle");
    };
    motionTickerRef.current = tick;
    gsap.ticker.add(tick);
  });

  const goTo = contextSafe((nextIndex) => {
    if (!notebooks.length || selectedIdRef.current || closingId || isAnimatingRef.current) return;
    const clamped = clampPosition(nextIndex);
    if (motionRef.current.settled && Math.abs(clamped - positionRef.current) < 0.001) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      stopPositionMotion(clamped);
      return;
    }
    motionRef.current = {
      ...motionRef.current,
      target: clamped,
      landingTarget: null,
      settled: false,
    };
    startPositionMotion();
  });

  useGSAP(() => {
    const clamped = clampPosition(positionRef.current);
    stopPositionMotion(clamped);
  }, { scope: rootRef, dependencies: [notebooks.length], revertOnUpdate: false });

  useGSAP(() => {
    const root = rootRef.current;
    const meta = root.querySelectorAll(".book-carousel-meta");
    const names = root.querySelectorAll(".book-carousel-index button");
    const scrollbar = root.querySelector(".book-carousel-scrollbar");
    if (!selectedId) {
      // While a close timeline owns the book, leave chrome/pose to that timeline.
      if (isAnimatingRef.current || closingId) return;
      gsap.set(bookRefs.current.filter(Boolean), { autoAlpha: 1 });
      gsap.set(meta, { x: 0, autoAlpha: 1 });
      gsap.set(names, { clearProps: "transform", "--name-x": "0px" });
      gsap.set(scrollbar, { x: 0, autoAlpha: 0.85 });
      placeCarousel({ position: positionRef.current, bookRefs, nameRefs, metaRefs, scrollbarRef });
      return;
    }
    if (isAnimatingRef.current || pageAnimatingRef.current) return;
    const selectedIndex = notebooks.findIndex((notebook) => notebook.id === selectedId);
    if (selectedIndex < 0) return;
    activeIndexRef.current = selectedIndex;
    stopPositionMotion(selectedIndex);
    setActiveIndex(selectedIndex);
    const fileIndex = notebooks[selectedIndex].files.findIndex((file) => file.id === activeFileId);
    if (fileIndex >= 0) {
      // Leaf 0 is the title page; lesson files start at leaf 1.
      commitPageIndex(selectedId, fileIndex + 1);
    }
    gsap.set(bookRefs.current.filter(Boolean), {
      autoAlpha: (index) => index === selectedIndex ? 1 : 0,
    });
    placeCarousel({ position: selectedIndex, bookRefs, nameRefs, metaRefs, scrollbarRef });
    applyOpenBookPose(bookRefs.current[selectedIndex], rootRef.current);
    gsap.set(meta, { x: (index) => index === 0 ? -72 : 72, autoAlpha: 0 });
    gsap.set(names, { clearProps: "transform", "--name-x": "64px", autoAlpha: 0 });
    gsap.set(scrollbar, { x: 10, autoAlpha: 0 });
    setMotionState("idle");
  }, { scope: rootRef, dependencies: [selectedId, activeFileId, selectedFileSignature, closingId] });

  useEffect(() => {
    onActiveChange?.(activeNotebook?.id ?? null);
  }, [activeNotebook?.id, onActiveChange]);

  useEffect(() => {
    const nextIndexes = {};
    let changed = false;
    for (const notebook of notebooks) {
      const currentIndex = pageIndexesRef.current[notebook.id] ?? 0;
      // Leaf indices: 0 = title … files.length = last lesson file.
      const nextIndex = Math.min(currentIndex, notebook.files.length);
      nextIndexes[notebook.id] = nextIndex;
      if (nextIndex !== currentIndex) changed = true;
    }
    if (Object.keys(pageIndexesRef.current).length !== notebooks.length) changed = true;
    if (!changed) return;
    pageIndexesRef.current = nextIndexes;
    setPageIndexes(nextIndexes);
  }, [notebooks]);

  useEffect(() => () => {
    pageTimelinesRef.current.forEach((timeline) => timeline.kill());
    pageTimelinesRef.current.clear();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const collection = root.closest(".notebook-collection") ?? root;

    let dragFrame = null;
    const flushDrag = () => {
      if (dragFrame == null) return;
      cancelAnimationFrame(dragFrame);
      dragFrame = null;
      commitPosition(motionRef.current.position, { allowOverscroll: true });
    };
    const wheel = (event) => {
      if (selectedIdRef.current || isAnimatingRef.current || !notebooks.length) return;
      if (event.target.closest?.('[data-slot^="dialog-"]')) return;
      event.preventDefault();
      const delta = normalizeWheelDelta(event, collection.clientHeight || window.innerHeight);
      if (!delta) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        goTo(activeIndexRef.current + Math.sign(delta));
        return;
      }
      motionRef.current = addCarouselWheelImpulse(motionRef.current, delta, maxPosition());
      startPositionMotion();
    };
    const clearPointer = () => {
      flushDrag();
      pointerIdRef.current = null;
      pointerStartYRef.current = null;
      pointerYRef.current = null;
      pointerDraggingRef.current = false;
    };
    const pointerDown = (event) => {
      if (selectedIdRef.current || isAnimatingRef.current || !notebooks.length) return;
      if (!event.isPrimary || event.pointerType === "mouse") return;
      pointerIdRef.current = event.pointerId;
      pointerStartYRef.current = event.clientY;
      pointerYRef.current = event.clientY;
      pointerTimeRef.current = performance.now();
      pointerLastMoveTimeRef.current = pointerTimeRef.current;
      pointerDraggingRef.current = false;
      try {
        root.setPointerCapture?.(event.pointerId);
      } catch {
        // Synthetic pointer events used by tests may not own a browser pointer.
      }
    };
    const pointerMove = (event) => {
      if (pointerIdRef.current !== event.pointerId || pointerYRef.current == null) return;
      const currentY = event.clientY;
      if (!pointerDraggingRef.current) {
        if (Math.abs(currentY - pointerStartYRef.current) < POINTER_DRAG_THRESHOLD) return;
        pointerDraggingRef.current = true;
        removeMotionTicker();
        motionRef.current = {
          ...motionRef.current,
          velocity: 0,
          target: null,
          landingTarget: null,
          settled: false,
        };
        setMotionState("dragging");
      }
      const delta = pointerYRef.current - currentY;
      if (Math.abs(delta) < 1) return;
      event.preventDefault();
      pointerYRef.current = currentY;
      const now = performance.now();
      const elapsedSeconds = gsap.utils.clamp(1 / 120, 1 / 20, (now - pointerTimeRef.current) / 1000);
      const deltaPosition = delta / BOOK_CAROUSEL_MOTION.dragPixelsPerBook;
      const position = applyCarouselEdgeResistance(
        motionRef.current.position + deltaPosition,
        maxPosition(),
      );
      motionRef.current = {
        position,
        velocity: gsap.utils.interpolate(
          motionRef.current.velocity,
          deltaPosition / elapsedSeconds,
          0.45,
        ),
        target: null,
        landingTarget: null,
        settled: false,
      };
      pointerTimeRef.current = now;
      pointerLastMoveTimeRef.current = now;
      // Pointer hardware can emit faster than the display refreshes. Retain
      // every velocity sample, but commit the latest visual pose once per frame.
      if (dragFrame == null) dragFrame = requestAnimationFrame(flushDrag);
    };
    const pointerEnd = (event) => {
      if (pointerIdRef.current !== event.pointerId) return;
      if (root.hasPointerCapture?.(event.pointerId)) root.releasePointerCapture(event.pointerId);
      const wasDragging = pointerDraggingRef.current;
      clearPointer();
      if (!wasDragging) return;
      const idleMilliseconds = performance.now() - pointerLastMoveTimeRef.current;
      motionRef.current = {
        ...motionRef.current,
        velocity: resolveCarouselReleaseVelocity(motionRef.current.velocity, idleMilliseconds),
      };
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        stopPositionMotion(Math.round(positionRef.current));
        return;
      }
      startPositionMotion();
    };
    const pointerCancel = (event) => {
      if (pointerIdRef.current !== event.pointerId) return;
      const wasDragging = pointerDraggingRef.current;
      clearPointer();
      if (wasDragging) stopPositionMotion(Math.round(positionRef.current));
    };
    const visibilityChange = () => {
      if (document.visibilityState !== "hidden" || motionRef.current.settled) return;
      clearPointer();
      stopPositionMotion(Math.round(positionRef.current));
    };

    collection.addEventListener("wheel", wheel, { passive: false });
    root.addEventListener("pointerdown", pointerDown, { passive: true });
    root.addEventListener("pointermove", pointerMove, { passive: false });
    root.addEventListener("pointerup", pointerEnd, { passive: true });
    root.addEventListener("pointercancel", pointerCancel, { passive: true });
    document.addEventListener("visibilitychange", visibilityChange);
    return () => {
      if (dragFrame != null) cancelAnimationFrame(dragFrame);
      collection.removeEventListener("wheel", wheel);
      root.removeEventListener("pointerdown", pointerDown);
      root.removeEventListener("pointermove", pointerMove);
      root.removeEventListener("pointerup", pointerEnd);
      root.removeEventListener("pointercancel", pointerCancel);
      document.removeEventListener("visibilitychange", visibilityChange);
      removeMotionTicker();
    };
  }, [notebooks.length]);

  const handleIndexKeyDown = (event, index) => {
    let nextIndex = null;
    if (["ArrowDown", "ArrowRight"].includes(event.key)) nextIndex = index + 1;
    else if (["ArrowUp", "ArrowLeft"].includes(event.key)) nextIndex = index - 1;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = maxPosition();
    if (nextIndex == null) return;
    event.preventDefault();
    const clamped = clampPosition(nextIndex);
    nameRefs.current[clamped]?.focus({ preventScroll: true });
    goTo(clamped);
  };

  const pageRadii = () => {
    const height = rootRef.current?.clientHeight ?? 0;
    return { outer: height * 0.0055, inner: height * 0.0045 };
  };

  const animateChrome = (timeline, open, position = 0) => {
    const root = rootRef.current;
    const metaLeft = root.querySelector(".book-carousel-meta-left");
    const metaRight = root.querySelector(".book-carousel-meta-right");
    const names = gsap.utils.toArray(".book-carousel-index button", root);
    const scrollbar = root.querySelector(".book-carousel-scrollbar");
    const otherBooks = bookRefs.current.filter((book, index) => book && index !== activeIndexRef.current);
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.38;
    if (metaLeft) timeline.to(metaLeft, {
      x: open ? -72 : 0,
      autoAlpha: open ? 0 : 1,
      duration,
      ease: EASE.fade,
    }, position);
    if (metaRight) timeline.to(metaRight, {
      x: open ? 72 : 0,
      autoAlpha: open ? 0 : 1,
      duration,
      ease: EASE.fade,
    }, position);
    if (names.length) timeline.to(names, {
        "--name-x": open ? "64px" : "0px",
        autoAlpha: open
          ? 0
          : (index) => carouselNamePose(index - positionRef.current).visibility,
        duration,
        ease: EASE.fade,
        stagger: { amount: duration ? Math.min(names.length - 1, 5) * 0.018 : 0, from: open ? "start" : "end" },
      }, position);
    if (scrollbar) timeline.to(scrollbar, {
      x: open ? 10 : 0,
      autoAlpha: open ? 0 : 0.85,
      duration,
      ease: EASE.fade,
    }, position);
    if (otherBooks.length) timeline.to(otherBooks, {
        autoAlpha: open ? 0 : 1,
        duration: duration * 0.9,
        ease: EASE.fade,
        stagger: { amount: duration ? Math.min(otherBooks.length - 1, 5) * 0.025 : 0, from: open ? "start" : "end" },
      }, position);
  };

  const changePage = contextSafe((notebookId, nextIndex, options = {}) => {
    const { bypassBookLock = false } = options;
    const notebook = notebooks.find((item) => item.id === notebookId);
    const currentIndex = pageIndexesRef.current[notebookId] ?? 0;
    const maxLeaf = notebook?.files.length ?? 0;
    if (
      !notebook
      || (isAnimatingRef.current && !bypassBookLock)
      || nextIndex === currentIndex
      || nextIndex < 0
      || nextIndex > maxLeaf
    ) {
      return Promise.resolve(false);
    }
    const book = bookRefs.current[notebooks.findIndex((item) => item.id === notebookId)];
    // Turning forward flips the current leaf left; turning back unflips the target leaf.
    const movingIndex = nextIndex > currentIndex ? currentIndex : nextIndex;
    const leaf = book?.querySelector(`.book-volume-leaf[data-page-index="${movingIndex}"]`);
    if (!leaf) return Promise.resolve(false);

    const currentRotation = readPageAngle(leaf);
    const nextPageIndexes = { ...pageIndexesRef.current, [notebookId]: nextIndex };
    pageIndexesRef.current = nextPageIndexes;
    flushSync(() => {
      setPageAnimating(true);
      setPageIndexes(nextPageIndexes);
    });
    pageAnimatingRef.current = true;
    pageTimelinesRef.current.get(leaf)?.kill();
    gsap.set(leaf, {
      "--leaf-angle": `${currentRotation}deg`,
    });
    const targetRotation = nextIndex > currentIndex ? -180 : 0;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = pageTurnDuration(currentRotation, targetRotation, reduceMotion);
    return new Promise((resolve) => {
      const timeline = gsap.timeline({
        onInterrupt: () => resolve(false),
        onComplete: () => {
          if (pageTimelinesRef.current.get(leaf) !== timeline) {
            resolve(false);
            return;
          }
          pageTimelinesRef.current.delete(leaf);
          gsap.set(leaf, { clearProps: "--leaf-angle" });
          pageAnimatingRef.current = pageTimelinesRef.current.size > 0;
          setPageAnimating(pageAnimatingRef.current);
          resolve(true);
        },
      });
      pageTimelinesRef.current.set(leaf, timeline);
      addPageTurn(timeline, leaf, { rotationY: targetRotation, duration });
    });
  });

  const openNotebook = contextSafe((notebookId) => {
    const index = notebooks.findIndex((notebook) => notebook.id === notebookId);
    if (index < 0 || isAnimatingRef.current) return;
    if (index !== activeIndexRef.current || !motionRef.current.settled) {
      goTo(index);
      return;
    }
    if (selectedIdRef.current) return;
    const book = bookRefs.current[index];
    if (!book) return;
    stopPositionMotion(index);
    isAnimatingRef.current = true;
    setBookAnimating(true);
    const pages = book.querySelector(".book-volume-pages");
    const page = book.querySelector(".book-volume-leaf.is-current");
    const coverBack = book.querySelector(".book-volume-cover-back");
    const { outer, inner } = pageRadii();
    const openScale = Number.parseFloat(getComputedStyle(book).getPropertyValue("--book-open-scale")) || 1;
    const fileCount = notebooks[index].files.length;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const openDuration = reduceMotion ? 0 : OPEN_DURATION;
    const firstPageDelay = reduceMotion ? 0 : OPEN_FIRST_PAGE_DELAY;
    gsap.set(book, { zIndex: 40 });
    commitPageIndex(notebookId, 0, true);
    const timeline = gsap.timeline({
      onComplete: () => {
        isAnimatingRef.current = false;
        setBookAnimating(false);
      },
    });
    animateChrome(timeline, true, 0);
    // Same page-turn path as lesson leaves: land on title, then turn to first file.
    if (fileCount > 0) {
      timeline.call(() => {
        void changePage(notebookId, 1, { bypassBookLock: true });
      }, [], firstPageDelay);
    }
    timeline
      .call(() => onSelect(notebookId), [], reduceMotion ? 0 : 0.23)
      .to(book.querySelector(".book-volume-cover"), { "--cover-angle": "-180deg", duration: openDuration, ease: EASE.swing }, 0)
      .to(book.querySelector(".book-volume-unit"), { "--book-spread-x": "50%", duration: openDuration * 0.88, ease: EASE.drift }, 0)
      .to(book, { "--book-scale": openScale, duration: openDuration * 0.86, ease: EASE.settle }, 0)
      .to(book, { "--book-rotation": "0deg", duration: openDuration * 0.82, ease: EASE.tilt }, 0)
      .fromTo(pages, { borderRadius: outer }, {
        borderRadius: `0px ${outer}px ${outer}px 0px`, duration: openDuration * 0.78, ease: EASE.soft,
      }, 0)
      .fromTo(page, { borderRadius: inner }, {
        borderRadius: `0px ${inner}px ${inner}px 0px`, duration: openDuration * 0.78, ease: EASE.soft,
      }, 0)
      .fromTo(coverBack, { borderRadius: outer }, {
        borderRadius: `${outer}px 0px 0px ${outer}px`, duration: openDuration * 0.78, ease: EASE.soft,
      }, 0);
  });

  const closeNotebook = contextSafe(() => {
    if (!selectedIdRef.current || isAnimatingRef.current) return;
    const selectedNotebookId = selectedIdRef.current;
    const index = bookRefs.current.findIndex((candidate) => candidate?.dataset.notebookId === selectedNotebookId);
    const book = bookRefs.current[index];
    if (!book) {
      onSelect(null);
      return;
    }
    isAnimatingRef.current = true;
    setBookAnimating(true);
    // Keep the open-book pose via closingId while clearing selectedId immediately so
    // collection chrome (title, actions, page controls) syncs with the close motion.
    setClosingId(selectedNotebookId);
    onSelect(null);
    pageTimelinesRef.current.forEach((timeline) => timeline.kill());
    pageTimelinesRef.current.clear();
    pageAnimatingRef.current = false;
    setPageAnimating(false);
    const pages = book.querySelector(".book-volume-pages");
    const page = book.querySelector(".book-volume-leaf.is-current");
    const coverBack = book.querySelector(".book-volume-cover-back");
    const controls = book.querySelector(".book-volume-controls");
    const slot = carouselBookPose(index - activeIndexRef.current);
    const restingRotation = baseRotation(index) + slot.rotationOffset;
    const { outer, inner } = pageRadii();
    const leaves = gsap.utils.toArray(".book-volume-leaf", book);
    const turnedLeaves = leaves
      .map((leaf) => ({
        leaf,
        index: Number(leaf.dataset.pageIndex),
        rotation: readPageAngle(leaf),
      }))
      .filter(({ rotation }) => rotation < -0.5)
      .sort((left, right) => right.index - left.index);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const timeline = gsap.timeline({
      onComplete: () => {
        gsap.set(leaves, { "--leaf-angle": "0deg" });
        commitPageIndex(selectedNotebookId, 0, true);
        gsap.set([pages, page, coverBack], { clearProps: "borderRadius" });
        gsap.set(book, {
          zIndex: slot.zIndex,
        });
        gsap.set(book.querySelector(".book-volume-cover"), { "--cover-angle": "0deg" });
        gsap.set(book.querySelector(".book-volume-unit"), { "--book-spread-x": "0%" });
        // Leave controls at autoAlpha 0. Clearing opacity/visibility here would
        // flash the pager for one frame while closingId still keeps isOpen true.
        isAnimatingRef.current = false;
        setBookAnimating(false);
        setClosingId(null);
        window.requestAnimationFrame(() => {
          if (!book.isConnected) return;
          gsap.set(leaves, { clearProps: "--leaf-angle" });
        });
      },
    });

    turnedLeaves.forEach(({ leaf }, order) => {
      const start = reduceMotion ? 0 : Math.min(order * 0.075, 0.45);
      addPageTurn(timeline, leaf, {
        rotationY: 0,
        duration: reduceMotion ? 0 : 0.54,
        position: start,
        ease: "power3.inOut",
      });
    });

    animateChrome(timeline, false, 0);
    if (controls) {
      timeline.to(controls, {
        autoAlpha: 0,
        duration: reduceMotion ? 0 : 0.28,
        ease: EASE.fade,
      }, 0);
    }
    timeline
      .to(book.querySelector(".book-volume-cover"), { "--cover-angle": "0deg", duration: reduceMotion ? 0 : CLOSE_DURATION, ease: "power3.inOut" }, 0)
      .to(book.querySelector(".book-volume-unit"), { "--book-spread-x": "0%", duration: reduceMotion ? 0 : CLOSE_DURATION, ease: "power3.inOut" }, 0)
      .to(book, { "--book-scale": slot.scale, duration: reduceMotion ? 0 : CLOSE_DURATION, ease: "power3.inOut" }, 0)
      .to(book, { "--book-rotation": `${restingRotation}deg`, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.66, ease: "power2.inOut" }, (reduceMotion ? 0 : CLOSE_DURATION * 0.34))
      .to(pages, { borderRadius: outer, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.74, ease: EASE.soft }, 0)
      .to(page, { borderRadius: inner, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.74, ease: EASE.soft }, 0)
      .to(coverBack, { borderRadius: outer, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.74, ease: EASE.soft }, 0);
  });

  useEffect(() => {
    const dismiss = (event) => {
      // Framework / lesson overlays keep the notebook open underneath. Do not
      // treat their pointer events as "click outside" and close the book.
      if (!dismissibleRef.current || !selectedIdRef.current || activeFileId) return;
      if (event.target.closest(".book-volume, .page-heading, .lesson-open-progress, [data-slot^=dialog-]")) return;
      closeNotebook();
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (!dismissibleRef.current || !selectedIdRef.current || activeFileId) return;
      if (event.target.closest?.("[data-slot^=dialog-]")) return;
      event.preventDefault();
      closeNotebook();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [activeFileId, notebooks.length]);

  const prepareRemoveFile = (notebookId, fileId) => {
    const notebook = notebooks.find((item) => item.id === notebookId);
    if (!notebook) return Promise.resolve(false);
    const fileIndex = notebook.files.findIndex((file) => file.id === fileId);
    if (fileIndex < 0) return Promise.resolve(false);
    const leafIndex = fileIndex + 1;
    const currentIndex = pageIndexesRef.current[notebookId] ?? 0;
    if (currentIndex !== leafIndex) {
      // Viewing a later leaf: shift index after delete via notebooks sync.
      // Viewing an earlier leaf: no turn needed before removal.
      if (currentIndex > leafIndex) {
        commitPageIndex(notebookId, currentIndex - 1, true);
      }
      return Promise.resolve(true);
    }
    // Flip the previous leaf (title or prior file) back to the right first.
    return changePage(notebookId, leafIndex - 1);
  };

  useImperativeHandle(ref, () => ({
    close: closeNotebook,
    prepareRemoveFile,
  }));

  return (
    <div
      className={`book-carousel ${openNotebookId ? "is-open" : ""}`}
      data-carousel-position="0.0000"
      data-motion-state="idle"
      role="region"
      aria-label="备课本选择器"
      aria-roledescription="备课本轮播"
      ref={rootRef}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {preparedNotebook
          ? `已选择${preparedNotebook.title}，第 ${preparedIndex + 1} 本，共 ${notebooks.length} 本`
          : ""}
      </span>
      <div className="book-carousel-scrollbar" aria-hidden="true" ref={scrollbarRef} />
      {notebooks.length > 1 ? (
        <span className="book-carousel-position-cue" aria-hidden="true">
          {preparedIndex + 1} / {notebooks.length}
        </span>
      ) : null}
      {activeNotebook && <>
        <span
          className="book-carousel-meta book-carousel-meta-left"
          ref={(element) => { metaRefs.current[0] = element; }}
        >
          {activeNotebook.subject || "备课"}
        </span>
        <span
          className="book-carousel-meta book-carousel-meta-right"
          ref={(element) => { metaRefs.current[1] = element; }}
        >
          {activeNotebook.files.length} 份文件
        </span>
      </>}

      <div className="book-carousel-stage" aria-label="备课本列表">
        {notebooks.map((notebook, index) => (
          <BookVolume
            notebook={notebook}
            isOpen={notebook.id === openNotebookId}
            activeFileId={activeFileId}
            pageIndex={Math.min(pageIndexes[notebook.id] ?? 0, notebook.files.length)}
            pageAnimating={pageAnimating && notebook.id === openNotebookId}
            bookAnimating={bookAnimating && notebook.id === openNotebookId}
            closing={notebook.id === closingId}
            renderPages={notebook.id === openNotebookId || index === preparedIndex}
            onToggle={() => notebook.id === openNotebookId ? closeNotebook() : openNotebook(notebook.id)}
            onOpenFile={onOpenFile}
            onPrepareFile={onPrepareFile}
            onDeleteFile={(file) => onDeleteFile({ ...file, notebookId: notebook.id })}
            onPageChange={(nextIndex) => changePage(notebook.id, nextIndex)}
            registerBook={(element) => { bookRefs.current[index] = element; }}
            key={notebook.id}
          />
        ))}
      </div>

      <nav
        className="book-carousel-index"
        aria-label="切换备课本"
        inert={openNotebookId ? true : undefined}
      >
        {notebooks.map((notebook, index) => (
          <Fragment key={notebook.id}>
            <button
              className={index === activeIndex ? "is-active" : ""}
              type="button"
              aria-current={index === activeIndex ? "true" : undefined}
              aria-describedby={`book-carousel-index-description-${notebook.id}`}
              tabIndex={openNotebookId ? -1 : (index === activeIndex ? 0 : -1)}
              onClick={() => goTo(index)}
              onKeyDown={(event) => handleIndexKeyDown(event, index)}
              ref={(element) => { nameRefs.current[index] = element; }}
            >
              {notebook.title}
            </button>
            <span className="sr-only" id={`book-carousel-index-description-${notebook.id}`}>
              {[notebook.subject, notebook.className, `${notebook.files.length} 份文件`].filter(Boolean).join("，")}
            </span>
          </Fragment>
        ))}
      </nav>
    </div>
  );
});
