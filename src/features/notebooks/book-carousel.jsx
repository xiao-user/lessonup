import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

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
const CLOSE_DURATION = 1.02;
const WHEEL_SCALE = 1 / 180;
const WHEEL_SETTLE_DELAY = 140;
const OVERSCROLL_LIMIT = 0.22;
const BASE_ROTATIONS = [-3, -2.8, 3.1, -7.5, 2, -4];

const bookSlot = (offset) => {
  if (offset <= -3) return { y: -60, scale: 0.5, rotationOffset: 14, zIndex: 4 };
  if (offset === -2) return { y: -49.3, scale: 0.5, rotationOffset: 14, zIndex: 6 };
  if (offset === -1) return { y: -0.8, scale: 0.56, rotationOffset: 10, zIndex: 8 };
  if (offset === 0) return { y: 47.57, scale: 1, rotationOffset: 0, zIndex: 10 };
  if (offset === 1) return { y: 95.8, scale: 0.56, rotationOffset: 2.5, zIndex: 9 };
  if (offset === 2) return { y: 109.5, scale: 0.56, rotationOffset: 2.5, zIndex: 7 };
  if (offset === 3) return { y: 118, scale: 0.56, rotationOffset: 2.5, zIndex: 5 };
  return { y: 126, scale: 0.56, rotationOffset: 2.5, zIndex: 4 };
};

const nameSlot = (offset) => 50 + offset * 27.5;
const nameVisibility = (offset) => gsap.utils.clamp(0.08, 1, 1 - Math.abs(offset) * 0.48);

const baseRotation = (index) => BASE_ROTATIONS[index % BASE_ROTATIONS.length];
const interpolateBookSlot = (offset) => {
  const start = Math.floor(offset);
  const end = Math.ceil(offset);
  if (start === end) return bookSlot(start);
  return gsap.utils.interpolate(bookSlot(start), bookSlot(end), offset - start);
};
const interpolateNameSlot = (offset) => {
  const start = Math.floor(offset);
  const end = Math.ceil(offset);
  if (start === end) return nameSlot(start);
  return gsap.utils.interpolate(nameSlot(start), nameSlot(end), offset - start);
};

function pageLayer(index, pageIndex, fileCount) {
  return index < pageIndex ? 40 + index : 10 + fileCount - index;
}

function stagePageLayers(book, pageIndex, fileCount, movingIndexes = []) {
  const moving = new Set(Array.isArray(movingIndexes) ? movingIndexes : [movingIndexes]);
  const leaves = gsap.utils.toArray(".book-volume-leaf", book);
  leaves.forEach((leaf, index) => {
    gsap.set(leaf, { zIndex: moving.has(index) ? 80 + index : pageLayer(index, pageIndex, fileCount) });
  });
  return leaves;
}

function addPageTurn(timeline, leaf, {
  rotationY,
  duration,
  position = 0,
  ease = EASE.swing,
}) {
  if (!leaf) return timeline;
  timeline
    .to(leaf, { rotationY, duration, ease, overwrite: "auto" }, position)
    .to(leaf, { x: -3, duration: duration * 0.45, ease: "sine.out", overwrite: "auto" }, position)
    .to(leaf, { x: 0, duration: duration * 0.55, ease: "sine.in", overwrite: "auto" }, position + duration * 0.45);
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
  gsap.set(cover, { rotationY: -180 });
  if (titleLeaf && book.querySelector('.book-volume-leaf[data-page-kind="file"]')) {
    gsap.set(titleLeaf, { rotationY: -180, x: 0 });
  }
  gsap.set(unit, { xPercent: 50 });
  gsap.set(pages, { zIndex: 31 });
  stagePageLayers(book, Number(page?.dataset.pageIndex ?? 0), book.querySelectorAll(".book-volume-leaf").length);
  gsap.set(pages, { borderRadius: `0px ${outer}px ${outer}px 0px` });
  gsap.set(page, { borderRadius: `0px ${inner}px ${inner}px 0px` });
  gsap.set(coverBack, { borderRadius: `${outer}px 0px 0px ${outer}px` });
}

function placeCarousel({ position, bookRefs, nameRefs }) {
  bookRefs.current.forEach((book, index) => {
    if (!book) return;
    const offset = index - position;
    const slot = interpolateBookSlot(offset);
    const restingSlot = bookSlot(Math.round(offset));
    const variables = {
      "--book-y": `${slot.y}cqh`,
      "--book-scale": slot.scale,
      "--book-rotation": `${baseRotation(index) + slot.rotationOffset}deg`,
    };
    book.dataset.slot = String(Math.round(offset));
    gsap.set(book, { zIndex: restingSlot.zIndex });
    gsap.set(book, variables);
  });

  nameRefs.current.forEach((name, index) => {
    if (!name) return;
    const offset = index - position;
    const distance = Math.abs(offset);
    const proximity = gsap.utils.clamp(0, 1, 1 - distance);
    const visibility = nameVisibility(offset);
    const variables = {
      "--name-y": `${interpolateNameSlot(offset)}cqh`,
      color: gsap.utils.interpolate("#c2c0bc", "#1b1915", proximity),
      autoAlpha: visibility,
    };
    gsap.set(name, variables);
  });
}

export const BookCarousel = forwardRef(function BookCarousel({
  notebooks,
  selectedId,
  activeFileId,
  onSelect,
  onActiveChange,
  onOpenFile,
}, ref) {
  const rootRef = useRef(null);
  const bookRefs = useRef([]);
  const nameRefs = useRef([]);
  const isAnimatingRef = useRef(false);
  const pageAnimatingRef = useRef(false);
  const pageTimelinesRef = useRef(new Map());
  const activeIndexRef = useRef(0);
  const positionRef = useRef(0);
  const positionTargetRef = useRef(0);
  const positionProxyRef = useRef({ value: 0 });
  const positionTweenRef = useRef(null);
  const positionVelocityRef = useRef(0);
  const positionTickerRef = useRef(null);
  const selectedIdRef = useRef(selectedId);
  const pageIndexesRef = useRef({});
  const wheelSettleTimerRef = useRef(null);
  const touchYRef = useRef(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pageIndexes, setPageIndexes] = useState({});
  const [pageAnimating, setPageAnimating] = useState(false);
  const [bookAnimating, setBookAnimating] = useState(false);
  const activeNotebook = notebooks[activeIndex];

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
  const clampPosition = (value) => gsap.utils.clamp(0, maxPosition(), value);
  const limitPosition = (value) => gsap.utils.clamp(-OVERSCROLL_LIMIT, maxPosition() + OVERSCROLL_LIMIT, value);

  const updateNearestIndex = (position) => {
    const nearest = clampPosition(Math.round(position));
    if (nearest !== activeIndexRef.current) {
      activeIndexRef.current = nearest;
      setActiveIndex(nearest);
    }
  };

  const commitPosition = (position, allowOverscroll = false) => {
    const resolved = allowOverscroll ? limitPosition(position) : clampPosition(position);
    positionRef.current = resolved;
    updateNearestIndex(resolved);
    placeCarousel({ position: resolved, bookRefs, nameRefs });
  };

  const stopPositionPhysics = () => {
    if (positionTickerRef.current) {
      gsap.ticker.remove(positionTickerRef.current);
      positionTickerRef.current = null;
    }
    positionVelocityRef.current = 0;
  };

  const startPositionPhysics = contextSafe(() => {
    positionTweenRef.current?.kill();
    positionTweenRef.current = null;
    if (positionTickerRef.current) return;
    const tick = () => {
      const frame = Math.min(2.5, gsap.ticker.deltaRatio(60));
      const hasRestTarget = Number.isFinite(positionTargetRef.current);
      const distance = hasRestTarget ? positionTargetRef.current - positionRef.current : 0;
      let velocity = positionVelocityRef.current;
      if (hasRestTarget) velocity += distance * 0.032 * frame;
      velocity *= Math.pow(hasRestTarget ? 0.86 : 0.9, frame);
      let next = positionRef.current + velocity * frame;
      const limited = limitPosition(next);
      if (limited !== next) {
        next = limited;
        velocity *= -0.18;
      }
      positionVelocityRef.current = velocity;
      positionProxyRef.current.value = next;
      commitPosition(next, true);
      if (hasRestTarget && Math.abs(positionTargetRef.current - next) < 0.0005 && Math.abs(velocity) < 0.0005) {
        const target = positionTargetRef.current;
        stopPositionPhysics();
        positionProxyRef.current.value = target;
        commitPosition(target, true);
      } else if (!hasRestTarget && Math.abs(velocity) < 0.0005) {
        stopPositionPhysics();
      }
    };
    positionTickerRef.current = tick;
    gsap.ticker.add(tick);
  });

  const animatePosition = contextSafe((position, {
    duration = 0.3,
    ease = "power3.out",
  } = {}) => {
    const clamped = clampPosition(position);
    positionTargetRef.current = clamped;
    stopPositionPhysics();
    positionTweenRef.current?.kill();
    if (!duration) {
      positionProxyRef.current.value = clamped;
      commitPosition(clamped);
      return;
    }
    positionTweenRef.current = gsap.to(positionProxyRef.current, {
      value: clamped,
      duration,
      ease,
      overwrite: true,
      onUpdate: () => commitPosition(positionProxyRef.current.value),
      onComplete: () => {
        positionTweenRef.current = null;
        commitPosition(clamped);
      },
    });
  });

  const releasePosition = contextSafe(() => {
    const projected = positionRef.current + positionVelocityRef.current * 10;
    positionTargetRef.current = clampPosition(Math.round(projected));
    startPositionPhysics();
  });

  const goTo = contextSafe((nextIndex) => {
    if (!notebooks.length || selectedIdRef.current || isAnimatingRef.current) return;
    const clamped = clampPosition(nextIndex);
    if (clamped === positionTargetRef.current && clamped === activeIndexRef.current) return;
    window.clearTimeout(wheelSettleTimerRef.current);
    animatePosition(clamped, { duration: 0.72, ease: "power3.inOut" });
  });

  useGSAP(() => {
    const clamped = clampPosition(positionRef.current);
    positionRef.current = clamped;
    positionTargetRef.current = clamped;
    positionProxyRef.current.value = clamped;
    updateNearestIndex(clamped);
    placeCarousel({ position: clamped, bookRefs, nameRefs });
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
      placeCarousel({ position: positionRef.current, bookRefs, nameRefs });
      return;
    }
    if (isAnimatingRef.current) return;
    const selectedIndex = notebooks.findIndex((notebook) => notebook.id === selectedId);
    if (selectedIndex < 0) return;
    activeIndexRef.current = selectedIndex;
    positionRef.current = selectedIndex;
    positionTargetRef.current = selectedIndex;
    positionProxyRef.current.value = selectedIndex;
    setActiveIndex(selectedIndex);
    const fileIndex = notebooks[selectedIndex].files.findIndex((file) => file.id === activeFileId);
    if (fileIndex >= 0) {
      commitPageIndex(selectedId, fileIndex);
    }
    gsap.set(bookRefs.current.filter(Boolean), {
      autoAlpha: (index) => index === selectedIndex ? 1 : 0,
    });
    placeCarousel({ position: selectedIndex, bookRefs, nameRefs });
    applyOpenBookPose(bookRefs.current[selectedIndex], rootRef.current);
    gsap.set(meta, { x: (index) => index === 0 ? -72 : 72, autoAlpha: 0 });
    gsap.set(names, { clearProps: "transform", "--name-x": "64px", autoAlpha: 0 });
    gsap.set(scrollbar, { x: 10, autoAlpha: 0 });
  }, { scope: rootRef, dependencies: [selectedId, activeFileId] });

  useEffect(() => {
    onActiveChange?.(activeNotebook?.id ?? null);
  }, [activeNotebook?.id, onActiveChange]);

  useEffect(() => () => {
    pageTimelinesRef.current.forEach((timeline) => timeline.kill());
    pageTimelinesRef.current.clear();
  }, []);

  useGSAP(() => {
    if (selectedIdRef.current) return;
    gsap.fromTo(".book-carousel-meta", { y: 5, autoAlpha: 0 }, {
      y: 0,
      autoAlpha: 1,
      duration: 0.32,
      ease: EASE.fade,
      stagger: 0.035,
      overwrite: "auto",
    });
  }, { scope: rootRef, dependencies: [activeIndex] });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const collection = root.closest(".notebook-collection") ?? root;

    const scheduleSettle = () => {
      window.clearTimeout(wheelSettleTimerRef.current);
      wheelSettleTimerRef.current = window.setTimeout(() => releasePosition(), WHEEL_SETTLE_DELAY);
    };
    const wheel = (event) => {
      if (selectedIdRef.current || isAnimatingRef.current || !notebooks.length) return;
      if (event.target.closest?.('[data-slot^="dialog-"]')) return;
      event.preventDefault();
      const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const controlledDelta = gsap.utils.clamp(-100, 100, rawDelta);
      positionTweenRef.current?.kill();
      positionTweenRef.current = null;
      positionTargetRef.current = null;
      const next = limitPosition(positionRef.current + controlledDelta * WHEEL_SCALE);
      positionVelocityRef.current = controlledDelta / 1200;
      positionProxyRef.current.value = next;
      commitPosition(next, true);
      startPositionPhysics();
      scheduleSettle();
    };
    const touchStart = (event) => {
      touchYRef.current = event.touches[0]?.clientY ?? null;
      window.clearTimeout(wheelSettleTimerRef.current);
    };
    const touchMove = (event) => {
      const currentY = event.touches[0]?.clientY;
      if (touchYRef.current == null || currentY == null) return;
      const delta = touchYRef.current - currentY;
      if (Math.abs(delta) < 1) return;
      event.preventDefault();
      touchYRef.current = currentY;
      const next = limitPosition(positionRef.current + delta / 180);
      positionTargetRef.current = null;
      positionProxyRef.current.value = next;
      positionVelocityRef.current = delta / 900;
      commitPosition(next, true);
    };
    const touchEnd = () => {
      touchYRef.current = null;
      releasePosition();
    };
    const keydown = (event) => {
      if (selectedIdRef.current || isAnimatingRef.current) return;
      if (["ArrowDown", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        goTo(activeIndexRef.current + 1);
      } else if (["ArrowUp", "ArrowLeft"].includes(event.key)) {
        event.preventDefault();
        goTo(activeIndexRef.current - 1);
      }
    };

    collection.addEventListener("wheel", wheel, { passive: false });
    root.addEventListener("touchstart", touchStart, { passive: true });
    root.addEventListener("touchmove", touchMove, { passive: false });
    root.addEventListener("touchend", touchEnd, { passive: true });
    window.addEventListener("keydown", keydown);
    return () => {
      collection.removeEventListener("wheel", wheel);
      root.removeEventListener("touchstart", touchStart);
      root.removeEventListener("touchmove", touchMove);
      root.removeEventListener("touchend", touchEnd);
      window.removeEventListener("keydown", keydown);
      window.clearTimeout(wheelSettleTimerRef.current);
      positionTweenRef.current?.kill();
      stopPositionPhysics();
    };
  }, [notebooks.length]);

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
          : (index) => nameVisibility(index - positionRef.current),
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

  const animateHeadingOut = (timeline, direction, position = 0) => {
    const header = rootRef.current?.closest(".notebook-collection")?.querySelector(".page-heading");
    if (!header) return;
    timeline.to(header.children, {
      y: direction * -8,
      autoAlpha: 0,
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.2,
      ease: EASE.fade,
      stagger: 0.025,
      overwrite: "auto",
    }, position);
  };

  const openNotebook = contextSafe((notebookId) => {
    const index = notebooks.findIndex((notebook) => notebook.id === notebookId);
    if (index < 0 || isAnimatingRef.current) return;
    if (index !== activeIndexRef.current) {
      goTo(index);
      return;
    }
    if (selectedIdRef.current) return;
    const book = bookRefs.current[index];
    if (!book) return;
    window.clearTimeout(wheelSettleTimerRef.current);
    stopPositionPhysics();
    positionTweenRef.current?.kill();
    animatePosition(index, { duration: 0 });
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
    const activePageIndex = hasFiles ? (pageIndexesRef.current[notebookId] ?? 0) + 1 : 0;
    gsap.set(book, { zIndex: 40 });
    gsap.set(pages, { zIndex: 20 });
    stagePageLayers(book, activePageIndex, notebooks[index].files.length + 1);
    if (hasFiles) gsap.set(titleLeaf, {
      rotationY: 0,
      x: 0,
      zIndex: 29,
      transformOrigin: "-0.5% 50%",
    });
    const timeline = gsap.timeline({
      onComplete: () => {
        isAnimatingRef.current = false;
        setBookAnimating(false);
      },
    });
    animateHeadingOut(timeline, 1, 0);
    animateChrome(timeline, true, 0);
    if (hasFiles) {
      addPageTurn(timeline, titleLeaf, {
        rotationY: -180,
        duration: OPEN_DURATION * 0.84,
        position: 0,
      });
    }
    timeline
      .call(() => onSelect(notebookId), [], 0.23)
      .to(cover, { rotationY: -180, duration: OPEN_DURATION * 0.84, ease: EASE.swing }, 0)
      .to(cover, { rotationY: -178, duration: OPEN_DURATION * 0.08, ease: "sine.out" }, OPEN_DURATION * 0.84)
      .to(cover, { rotationY: -180, duration: OPEN_DURATION * 0.08, ease: EASE.soft }, OPEN_DURATION * 0.92)
      .to(unit, { xPercent: 50, duration: OPEN_DURATION * 0.88, ease: EASE.drift }, 0)
      .to(book, { "--book-scale": openScale, duration: OPEN_DURATION * 0.86, ease: EASE.settle }, 0)
      .to(book, { "--book-shadow-alpha": 0, duration: OPEN_DURATION * 0.62, ease: EASE.fade }, 0)
      .to(book, { "--book-rotation": "0deg", duration: OPEN_DURATION * 0.82, ease: EASE.tilt }, 0)
      .fromTo(pages, { borderRadius: outer }, {
        borderRadius: `0px ${outer}px ${outer}px 0px`, duration: OPEN_DURATION * 0.78, ease: EASE.soft,
      }, 0)
      .fromTo(page, { borderRadius: inner }, {
        borderRadius: `0px ${inner}px ${inner}px 0px`, duration: OPEN_DURATION * 0.78, ease: EASE.soft,
      }, 0)
      .fromTo(coverBack, { borderRadius: outer }, {
        borderRadius: `${outer}px 0px 0px ${outer}px`, duration: OPEN_DURATION * 0.78, ease: EASE.soft,
      }, 0)
      .set(pages, { zIndex: 31 }, OPEN_DURATION * 0.42);
    if (hasFiles) timeline.set(titleLeaf, { zIndex: 40 }, OPEN_DURATION * 0.42);
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
    const slot = bookSlot(index - activeIndexRef.current);
    const restingRotation = baseRotation(index) + slot.rotationOffset;
    const { outer, inner } = pageRadii();
    const leaves = gsap.utils.toArray(".book-volume-leaf", book);
    const turnedLeaves = leaves
      .map((leaf) => ({
        leaf,
        index: Number(leaf.dataset.pageIndex),
        rotation: Number(gsap.getProperty(leaf, "rotationY")) || 0,
      }))
      .filter(({ rotation }) => rotation < -0.5)
      .filter(({ leaf }) => leaf !== titleLeaf)
      .sort((left, right) => right.index - left.index);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const timeline = gsap.timeline({
      onComplete: () => {
        stagePageLayers(book, 0, leaves.length);
        gsap.set(leaves, { rotationY: 0, x: 0 });
        commitPageIndex(selectedNotebookId, 0, true);
        gsap.set([pages, page, coverBack], { clearProps: "borderRadius" });
        gsap.set([cover, unit], { clearProps: "transform" });
        gsap.set(book, { zIndex: slot.zIndex, clearProps: "--book-shadow-alpha" });
        isAnimatingRef.current = false;
        setBookAnimating(false);
        onSelect(null);
        window.requestAnimationFrame(() => {
          if (!book.isConnected) return;
          gsap.set(leaves, { clearProps: "transform,transformOrigin" });
        });
      },
    });

    turnedLeaves.forEach(({ leaf, index: leafIndex }, order) => {
      const start = reduceMotion ? 0 : order * 0.075;
      timeline
        .set(leaf, { zIndex: 70 + leafIndex }, start)
        .to(leaf, {
          rotationY: 0,
          x: 0,
          duration: reduceMotion ? 0 : 0.54,
          ease: "power3.inOut",
        }, start);
    });

    animateHeadingOut(timeline, -1, reduceMotion ? 0 : 0.16);
    animateChrome(timeline, false, reduceMotion ? 0 : 0.3);
    if (titleLeaf) {
      gsap.set(titleLeaf, { zIndex: 40, transformOrigin: "-0.5% 50%" });
      timeline
        .to(titleLeaf, {
          rotationY: 0,
          x: 0,
          duration: reduceMotion ? 0 : CLOSE_DURATION,
          ease: "power3.inOut",
          overwrite: "auto",
        }, 0)
        .set(titleLeaf, { zIndex: 29 }, reduceMotion ? 0 : CLOSE_DURATION * 0.5);
    }
    timeline
      .to(cover, { rotationY: 0, duration: reduceMotion ? 0 : CLOSE_DURATION, ease: "power3.inOut" }, 0)
      .to(unit, { xPercent: 0, duration: reduceMotion ? 0 : CLOSE_DURATION, ease: "power3.inOut" }, 0)
      .to(book, { "--book-scale": slot.scale, duration: reduceMotion ? 0 : CLOSE_DURATION, ease: "power3.inOut" }, 0)
      .to(book, { "--book-shadow-alpha": 0.28, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.72, ease: EASE.fade }, CLOSE_DURATION * 0.2)
      .to(book, { "--book-rotation": `${restingRotation}deg`, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.66, ease: "power2.inOut" }, CLOSE_DURATION * 0.34)
      .to(pages, { borderRadius: outer, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.74, ease: EASE.soft }, 0)
      .to(page, { borderRadius: inner, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.74, ease: EASE.soft }, 0)
      .to(coverBack, { borderRadius: outer, duration: reduceMotion ? 0 : CLOSE_DURATION * 0.74, ease: EASE.soft }, 0)
      .set(pages, { zIndex: 20 }, reduceMotion ? 0 : CLOSE_DURATION * 0.5);
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

    const currentRotation = Number(gsap.getProperty(leaf, "rotationY"))
      || (movingIndex < currentIndex ? -180 : 0);
    const nextPageIndexes = { ...pageIndexesRef.current, [notebookId]: nextIndex };
    pageIndexesRef.current = nextPageIndexes;
    flushSync(() => {
      setPageAnimating(true);
      setPageIndexes(nextPageIndexes);
    });
    pageAnimatingRef.current = true;
    pageTimelinesRef.current.get(leaf)?.kill();
    const movingIndexes = [
      ...pageTimelinesRef.current.keys(),
      leaf,
    ].map((movingLeaf) => Number(movingLeaf.dataset.pageIndex));
    stagePageLayers(book, nextPageIndex, notebook.files.length + 1, movingIndexes);
    gsap.set(leaf, {
      rotationY: currentRotation,
      transformOrigin: "-0.5% 50%",
    });
    const targetRotation = nextPageIndex > currentPageIndex ? -180 : 0;
    const distance = Math.abs(targetRotation - currentRotation);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduceMotion ? 0 : gsap.utils.clamp(0.2, 0.6, 0.18 + (distance / 180) * 0.42);
    const timeline = gsap.timeline({
      onComplete: () => {
        if (pageTimelinesRef.current.get(leaf) !== timeline) return;
        pageTimelinesRef.current.delete(leaf);
        gsap.set(leaf, { zIndex: pageLayer(movingIndex, nextPageIndex, notebook.files.length + 1) });
        const stillMoving = [...pageTimelinesRef.current.keys()]
          .map((movingLeaf) => Number(movingLeaf.dataset.pageIndex));
        stagePageLayers(book, (pageIndexesRef.current[notebookId] ?? nextIndex) + 1, notebook.files.length + 1, stillMoving);
        pageAnimatingRef.current = pageTimelinesRef.current.size > 0;
        setPageAnimating(pageAnimatingRef.current);
      },
    });
    pageTimelinesRef.current.set(leaf, timeline);
    addPageTurn(timeline, leaf, { rotationY: targetRotation, duration });
  });

  return (
    <div className={`book-carousel ${selectedId ? "is-open" : ""}`} ref={rootRef}>
      <div className="book-carousel-scrollbar" aria-hidden="true" />
      {activeNotebook && <>
        <span className="book-carousel-meta book-carousel-meta-left">{activeNotebook.subject || "备课"}</span>
        <span className="book-carousel-meta book-carousel-meta-right">{activeNotebook.files.length} 份文件</span>
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
            onToggle={() => notebook.id === selectedId ? closeNotebook() : openNotebook(notebook.id)}
            onOpenFile={onOpenFile}
            onPageChange={(nextIndex) => changePage(notebook.id, nextIndex)}
            registerBook={(element) => { bookRefs.current[index] = element; }}
            key={notebook.id}
          />
        ))}
      </div>

      <nav className="book-carousel-index" aria-label="切换备课本">
        {notebooks.map((notebook, index) => (
          <button
            className={index === activeIndex ? "is-active" : ""}
            type="button"
            onClick={() => goTo(index)}
            ref={(element) => { nameRefs.current[index] = element; }}
            key={notebook.id}
          >
            {notebook.title}
          </button>
        ))}
      </nav>
    </div>
  );
});
