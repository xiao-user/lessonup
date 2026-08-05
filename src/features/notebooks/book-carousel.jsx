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
import { BookVolume } from "@/features/notebooks/book-volume";

gsap.registerPlugin(useGSAP);

const EASE = {
  drift: "expo.out",
  swing: "power3.inOut",
  tilt: "power2.out",
  settle: "back.out(1.35)",
  soft: "sine.inOut",
  fade: "sine.out",
};

const OPEN_DURATION = 0.9;
const OPEN_TITLE_DELAY = 0.28;
const OPEN_TITLE_DURATION = OPEN_DURATION - OPEN_TITLE_DELAY;
const CLOSE_DURATION = 1.02;
const BASE_ROTATIONS = [-3, -2.8, 3.1, -7.5, 2, -4];
const POINTER_DRAG_THRESHOLD = 3;

const bookPoseWriters = new WeakMap();
const namePoseWriters = new WeakMap();
const opacityWriters = new WeakMap();
const scrollbarWriters = new WeakMap();

const baseRotation = (index) => BASE_ROTATIONS[index % BASE_ROTATIONS.length];

function getBookPoseWriters(book) {
  let writers = bookPoseWriters.get(book);
  if (!writers) {
    writers = {
      y: gsap.quickSetter(book, "--book-y", "cqh"),
      scale: gsap.quickSetter(book, "--book-scale"),
      rotation: gsap.quickSetter(book, "--book-rotation", "deg"),
    };
    bookPoseWriters.set(book, writers);
  }
  return writers;
}

function getNamePoseWriters(name) {
  let writers = namePoseWriters.get(name);
  if (!writers) {
    writers = {
      y: gsap.quickSetter(name, "--name-y", "cqh"),
      proximity: gsap.quickSetter(name, "--name-proximity"),
      opacity: gsap.quickSetter(name, "opacity"),
    };
    namePoseWriters.set(name, writers);
  }
  return writers;
}

function setOpacity(element, opacity) {
  if (!element) return;
  let writer = opacityWriters.get(element);
  if (!writer) {
    writer = gsap.quickSetter(element, "opacity");
    opacityWriters.set(element, writer);
  }
  writer(opacity);
  element.style.visibility = opacity > 0 ? "visible" : "hidden";
}

function setScrollbarPosition(scrollbar, position) {
  if (!scrollbar) return;
  let writer = scrollbarWriters.get(scrollbar);
  if (!writer) {
    writer = gsap.quickSetter(scrollbar, "y", "cqh");
    scrollbarWriters.set(scrollbar, writer);
  }
  writer(position);
}

function readPageAngle(leaf) {
  if (!leaf) return 0;
  return Number.parseFloat(getComputedStyle(leaf).getPropertyValue("--leaf-angle")) || 0;
}

function addPageTurn(timeline, leaf, {
  rotationY,
  duration,
  position = 0,
  ease = EASE.swing,
}) {
  if (!leaf) return timeline;
  timeline.to(leaf, {
    "--leaf-angle": `${rotationY}deg`,
    duration,
    ease,
    overwrite: "auto",
  }, position);
  return timeline;
}

function applyOpenBookPose(book, root) {
  const height = root?.clientHeight ?? 0;
  const outer = height * 0.0055;
  const inner = height * 0.0045;
  const openScale = Number.parseFloat(getComputedStyle(book).getPropertyValue("--book-open-scale")) || 1.32;
  const cover = book.querySelector(".book-volume-cover");
  const titleLeaf = book.querySelector('.book-volume-leaf[data-page-kind="title"]');
  const unit = book.querySelector(".book-volume-unit");
  const pages = book.querySelector(".book-volume-pages");
  const page = book.querySelector(".book-volume-leaf.is-current, .book-volume-empty-page");
  const coverBack = book.querySelector(".book-volume-cover-back");

  gsap.set(book, {
    zIndex: 40,
    "--book-scale": openScale,
    "--book-rotation": "0deg",
    "--book-shadow-alpha": 0,
  });
  gsap.set(cover, { "--cover-angle": "-180deg" });
  if (titleLeaf && book.querySelector('.book-volume-leaf[data-page-kind="file"]')) {
    gsap.set(titleLeaf, { "--leaf-angle": "-180deg" });
  }
  gsap.set(unit, { xPercent: 50 });
  gsap.set(pages, { borderRadius: `0px ${outer}px ${outer}px 0px` });
  gsap.set(page, { borderRadius: `0px ${inner}px ${inner}px 0px` });
  gsap.set(coverBack, { borderRadius: `${outer}px 0px 0px ${outer}px` });
}

function placeCarousel({ position, bookRefs, nameRefs, metaRefs, scrollbarRef }) {
  bookRefs.current.forEach((book, index) => {
    if (!book) return;
    const offset = index - position;
    const pose = carouselBookPose(offset);
    const writers = getBookPoseWriters(book);
    const slot = String(Math.round(offset));
    const layer = String(pose.zIndex);
    if (book.dataset.slot !== slot) book.dataset.slot = slot;
    if (book.style.zIndex !== layer) book.style.zIndex = layer;
    writers.y(pose.y);
    writers.scale(pose.scale);
    writers.rotation(baseRotation(index) + pose.rotationOffset);
  });

  nameRefs.current.forEach((name, index) => {
    if (!name) return;
    const offset = index - position;
    const pose = carouselNamePose(offset);
    const writers = getNamePoseWriters(name);
    writers.y(pose.y);
    writers.proximity(pose.proximity);
    writers.opacity(pose.visibility);
    if (name.style.visibility !== "visible") name.style.visibility = "visible";
  });

  const focusDistance = Math.abs(position - Math.round(position));
  const rawMetaVisibility = Math.max(0, 1 - focusDistance * 2);
  const metaVisibility = rawMetaVisibility * rawMetaVisibility * (3 - 2 * rawMetaVisibility);
  metaRefs.current.forEach((meta) => setOpacity(meta, metaVisibility));

  const maxPosition = Math.max(1, bookRefs.current.filter(Boolean).length - 1);
  setScrollbarPosition(
    scrollbarRef.current,
    gsap.utils.clamp(0, 1, position / maxPosition) * 59,
  );
}

export const BookCarousel = forwardRef(function BookCarousel({
  notebooks,
  selectedId,
  activeFileId,
  onSelect,
  onActiveChange,
  onOpenFile,
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
  const activeNotebook = notebooks[activeIndex];
  const preparedNotebook = notebooks[preparedIndex];

  activeIndexRef.current = activeIndex;
  selectedIdRef.current = selectedId;
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
    if (!notebooks.length || selectedIdRef.current || isAnimatingRef.current) return;
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
      gsap.set(bookRefs.current.filter(Boolean), { autoAlpha: 1 });
      gsap.set(meta, { x: 0, autoAlpha: 1 });
      gsap.set(names, { clearProps: "transform", "--name-x": "0px" });
      gsap.set(scrollbar, { x: 0, autoAlpha: 0.85 });
      placeCarousel({ position: positionRef.current, bookRefs, nameRefs, metaRefs, scrollbarRef });
      return;
    }
    if (isAnimatingRef.current) return;
    const selectedIndex = notebooks.findIndex((notebook) => notebook.id === selectedId);
    if (selectedIndex < 0) return;
    activeIndexRef.current = selectedIndex;
    stopPositionMotion(selectedIndex);
    setActiveIndex(selectedIndex);
    const fileIndex = notebooks[selectedIndex].files.findIndex((file) => file.id === activeFileId);
    if (fileIndex >= 0) {
      commitPageIndex(selectedId, fileIndex);
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
  }, { scope: rootRef, dependencies: [selectedId, activeFileId] });

  useEffect(() => {
    onActiveChange?.(activeNotebook?.id ?? null);
  }, [activeNotebook?.id, onActiveChange]);

  useEffect(() => {
    const nextIndexes = {};
    let changed = false;
    for (const notebook of notebooks) {
      const currentIndex = pageIndexesRef.current[notebook.id] ?? 0;
      const nextIndex = Math.min(currentIndex, Math.max(0, notebook.files.length - 1));
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
        positionRef.current + deltaPosition,
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
      commitPosition(position, { allowOverscroll: true });
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
    timeline.to(metaLeft, { x: open ? -72 : 0, autoAlpha: open ? 0 : 1, duration, ease: EASE.fade }, position)
      .to(metaRight, { x: open ? 72 : 0, autoAlpha: open ? 0 : 1, duration, ease: EASE.fade }, position)
      .to(names, {
        "--name-x": open ? "64px" : "0px",
        autoAlpha: open
          ? 0
          : (index) => carouselNamePose(index - positionRef.current).visibility,
        duration,
        ease: EASE.fade,
        stagger: open ? 0.018 : { each: 0.018, from: "end" },
      }, position)
      .to(scrollbar, { x: open ? 10 : 0, autoAlpha: open ? 0 : 0.85, duration, ease: EASE.fade }, position)
      .to(otherBooks, {
        autoAlpha: open ? 0 : 1,
        duration: duration * 0.9,
        ease: EASE.fade,
        stagger: open ? 0.025 : { each: 0.025, from: "end" },
      }, position);
  };

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
    const cover = book.querySelector(".book-volume-cover");
    const titleLeaf = book.querySelector('.book-volume-leaf[data-page-kind="title"]');
    const unit = book.querySelector(".book-volume-unit");
    const pages = book.querySelector(".book-volume-pages");
    const page = book.querySelector(".book-volume-leaf.is-current, .book-volume-empty-page");
    const coverBack = book.querySelector(".book-volume-cover-back");
    const { outer, inner } = pageRadii();
    const openScale = Number.parseFloat(getComputedStyle(book).getPropertyValue("--book-open-scale")) || 1.32;
    const hasFiles = notebooks[index].files.length > 0;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const openDuration = reduceMotion ? 0 : OPEN_DURATION;
    const titleDelay = reduceMotion ? 0 : OPEN_TITLE_DELAY;
    const titleDuration = reduceMotion ? 0 : OPEN_TITLE_DURATION;
    gsap.set(book, { zIndex: 40 });
    if (hasFiles) gsap.set(titleLeaf, {
      "--leaf-angle": "0deg",
    });
    const timeline = gsap.timeline({
      onComplete: () => {
        isAnimatingRef.current = false;
        setBookAnimating(false);
      },
    });
    timeline
      .addLabel("coverTurn", 0)
      .addLabel("titleTurn", titleDelay);
    animateChrome(timeline, true, 0);
    if (hasFiles) {
      addPageTurn(timeline, titleLeaf, {
        rotationY: -180,
        duration: titleDuration,
        position: "titleTurn",
      });
    }
    timeline
      .call(() => onSelect(notebookId), [], 0.23)
      .to(cover, { "--cover-angle": "-180deg", duration: openDuration, ease: EASE.swing }, "coverTurn")
      .to(unit, { xPercent: 50, duration: openDuration * 0.88, ease: EASE.drift }, 0)
      .to(book, { "--book-scale": openScale, duration: openDuration * 0.86, ease: EASE.settle }, 0)
      .to(book, { "--book-shadow-alpha": 0, duration: openDuration * 0.62, ease: EASE.fade }, 0)
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
    pageTimelinesRef.current.forEach((timeline) => timeline.kill());
    pageTimelinesRef.current.clear();
    pageAnimatingRef.current = false;
    setPageAnimating(false);
    const cover = book.querySelector(".book-volume-cover");
    const titleLeaf = book.querySelector('.book-volume-leaf[data-page-kind="title"]');
    const unit = book.querySelector(".book-volume-unit");
    const pages = book.querySelector(".book-volume-pages");
    const page = book.querySelector(".book-volume-leaf.is-current, .book-volume-empty-page");
    const coverBack = book.querySelector(".book-volume-cover-back");
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
      .filter(({ leaf }) => leaf !== titleLeaf)
      .sort((left, right) => right.index - left.index);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const timeline = gsap.timeline({
      onComplete: () => {
        gsap.set(leaves, { "--leaf-angle": "0deg" });
        gsap.set(cover, { "--cover-angle": "0deg" });
        commitPageIndex(selectedNotebookId, 0, true);
        gsap.set([pages, page, coverBack], { clearProps: "borderRadius" });
        gsap.set(unit, { clearProps: "transform" });
        gsap.set(book, { zIndex: slot.zIndex, clearProps: "--book-shadow-alpha" });
        isAnimatingRef.current = false;
        setBookAnimating(false);
        onSelect(null);
        window.requestAnimationFrame(() => {
          if (!book.isConnected) return;
          gsap.set(leaves, { clearProps: "--leaf-angle" });
          gsap.set(cover, { clearProps: "--cover-angle" });
        });
      },
    });

    turnedLeaves.forEach(({ leaf }, order) => {
      const start = reduceMotion ? 0 : order * 0.075;
      timeline.to(leaf, {
        "--leaf-angle": "0deg",
        duration: reduceMotion ? 0 : 0.54,
        ease: "power3.inOut",
      }, start);
    });

    animateChrome(timeline, false, reduceMotion ? 0 : 0.3);
    if (titleLeaf) {
      timeline.to(titleLeaf, {
        "--leaf-angle": "0deg",
        duration: reduceMotion ? 0 : CLOSE_DURATION,
        ease: "power3.inOut",
        overwrite: "auto",
      }, 0);
    }
    timeline
      .to(cover, { "--cover-angle": "0deg", duration: reduceMotion ? 0 : CLOSE_DURATION, ease: "power3.inOut" }, 0)
      .to(unit, { xPercent: 0, duration: reduceMotion ? 0 : CLOSE_DURATION, ease: "power3.inOut" }, 0)
      .to(book, { "--book-scale": slot.scale, duration: reduceMotion ? 0 : CLOSE_DURATION, ease: "power3.inOut" }, 0)
      .to(book, { "--book-shadow-alpha": 0.28, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.72, ease: EASE.fade }, CLOSE_DURATION * 0.2)
      .to(book, { "--book-rotation": `${restingRotation}deg`, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.66, ease: "power2.inOut" }, CLOSE_DURATION * 0.34)
      .to(pages, { borderRadius: outer, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.74, ease: EASE.soft }, 0)
      .to(page, { borderRadius: inner, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.74, ease: EASE.soft }, 0)
      .to(coverBack, { borderRadius: outer, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.74, ease: EASE.soft }, 0);
  });

  useImperativeHandle(ref, () => ({ close: closeNotebook }));

  useEffect(() => {
    const dismiss = (event) => {
      if (!selectedIdRef.current || activeFileId) return;
      if (event.target.closest(".book-volume, .page-heading, [data-slot^=dialog-]")) return;
      closeNotebook();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [activeFileId, notebooks.length]);

  const changePage = contextSafe((notebookId, nextIndex) => {
    const notebook = notebooks.find((item) => item.id === notebookId);
    const currentIndex = pageIndexesRef.current[notebookId] ?? 0;
    if (!notebook || isAnimatingRef.current || nextIndex === currentIndex || nextIndex < 0 || nextIndex >= notebook.files.length) return;
    const book = bookRefs.current[notebooks.findIndex((item) => item.id === notebookId)];
    const currentPageIndex = currentIndex + 1;
    const nextPageIndex = nextIndex + 1;
    const movingIndex = nextPageIndex > currentPageIndex ? currentPageIndex : nextPageIndex;
    const leaf = book?.querySelector(`.book-volume-leaf[data-page-index="${movingIndex}"]`);
    if (!leaf) return;

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
    const targetRotation = nextPageIndex > currentPageIndex ? -180 : 0;
    const distance = Math.abs(targetRotation - currentRotation);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduceMotion ? 0 : gsap.utils.clamp(0.2, 0.6, 0.18 + (distance / 180) * 0.42);
    const timeline = gsap.timeline({
      onComplete: () => {
        if (pageTimelinesRef.current.get(leaf) !== timeline) return;
        pageTimelinesRef.current.delete(leaf);
        gsap.set(leaf, { clearProps: "--leaf-angle" });
        pageAnimatingRef.current = pageTimelinesRef.current.size > 0;
        setPageAnimating(pageAnimatingRef.current);
      },
    });
    pageTimelinesRef.current.set(leaf, timeline);
    addPageTurn(timeline, leaf, { rotationY: targetRotation, duration });
  });

  return (
    <div
      className={`book-carousel ${selectedId ? "is-open" : ""}`}
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
            isOpen={notebook.id === selectedId}
            activeFileId={activeFileId}
            pageIndex={Math.min(pageIndexes[notebook.id] ?? 0, Math.max(0, notebook.files.length - 1))}
            pageAnimating={pageAnimating && notebook.id === selectedId}
            bookAnimating={bookAnimating && notebook.id === selectedId}
            renderPages={notebook.id === selectedId || index === preparedIndex}
            onToggle={() => notebook.id === selectedId ? closeNotebook() : openNotebook(notebook.id)}
            onOpenFile={onOpenFile}
            onDeleteFile={(file) => onDeleteFile({ ...file, notebookId: notebook.id })}
            onPageChange={(nextIndex) => changePage(notebook.id, nextIndex)}
            registerBook={(element) => { bookRefs.current[index] = element; }}
            key={notebook.id}
          />
        ))}
      </div>

      <nav className="book-carousel-index" aria-label="切换备课本">
        {notebooks.map((notebook, index) => (
          <Fragment key={notebook.id}>
            <button
              className={index === activeIndex ? "is-active" : ""}
              type="button"
              aria-current={index === activeIndex ? "true" : undefined}
              aria-describedby={`book-carousel-index-description-${notebook.id}`}
              tabIndex={index === activeIndex ? 0 : -1}
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
