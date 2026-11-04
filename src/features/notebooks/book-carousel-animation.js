import gsap from "gsap";
import { carouselBookPose, carouselNamePose } from "./book-carousel-motion";

export const EASE = {
  drift: "expo.out",
  swing: "power3.inOut",
  tilt: "power2.out",
  settle: "back.out(1.35)",
  soft: "sine.inOut",
  fade: "sine.out",
  close: "power3.inOut",
};

export const OPEN_DURATION = 0.9;
export const OPEN_FIRST_PAGE_DELAY = 0.28;
const CLOSE_LEAF_DURATION = 0.4;
const CLOSE_LEAF_STAGGER = 0.05;
const CLOSE_STAGGER_LIMIT = 0.36;
const CLOSE_COVER_DURATION = 0.9;
const BASE_ROTATIONS = [-3, -2.8, 3.1, -7.5, 2, -4];

/**
 * Preserve the original staggered page rewind. The cover follows as soon as
 * the last leaf starts, rather than waiting for every leaf to land. Sharing
 * the leaf ease with a longer swing keeps the cover behind all moving pages
 * and carries the motion through their landing without a pause.
 */
export function closeBookPlan(turnedCount, reduceMotion = false) {
  const leafStarts = Array.from({ length: turnedCount }, (_, order) => (
    reduceMotion ? 0 : Math.min(order * CLOSE_LEAF_STAGGER, CLOSE_STAGGER_LIMIT)
  ));
  return {
    leafStarts,
    leafDuration: reduceMotion ? 0 : CLOSE_LEAF_DURATION,
    coverStart: leafStarts.at(-1) ?? 0,
    coverDuration: reduceMotion ? 0 : CLOSE_COVER_DURATION,
  };
}

const bookPoseWriters = new WeakMap();
const namePoseWriters = new WeakMap();
const opacityWriters = new WeakMap();
const scrollbarWriters = new WeakMap();

export const baseRotation = (index) => BASE_ROTATIONS[index % BASE_ROTATIONS.length];

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

export function readPageAngle(leaf) {
  if (!leaf) return 0;
  return Number.parseFloat(getComputedStyle(leaf).getPropertyValue("--leaf-angle")) || 0;
}

export function addPageTurn(timeline, leaf, {
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

export function applyOpenBookPose(book, root) {
  const height = root?.clientHeight ?? 0;
  const outer = height * 0.0055;
  const inner = height * 0.0045;
  const openScale = Number.parseFloat(getComputedStyle(book).getPropertyValue("--book-open-scale")) || 1;
  const pages = book.querySelector(".book-volume-pages");
  const page = book.querySelector(".book-volume-leaf.is-current");
  const coverBack = book.querySelector(".book-volume-cover-back");
  const leaves = gsap.utils.toArray(".book-volume-leaf", book);

  gsap.set(book, {
    zIndex: 40,
    "--book-scale": openScale,
    "--book-rotation": "0deg",
  });
  gsap.set(book.querySelector(".book-volume-cover"), { "--cover-angle": "-180deg" });
  gsap.set(book.querySelector(".book-volume-unit"), { "--book-spread-x": "50%" });
  // Match leaf angles to is-turned / is-current classes (CSS owns resting state).
  gsap.set(leaves, { clearProps: "--leaf-angle" });
  gsap.set(pages, { borderRadius: `0px ${outer}px ${outer}px 0px` });
  gsap.set(page, { borderRadius: `0px ${inner}px ${inner}px 0px` });
  gsap.set(coverBack, { borderRadius: `${outer}px 0px 0px ${outer}px` });
}

export function pageTurnDuration(fromAngle, toAngle, reduceMotion) {
  if (reduceMotion) return 0;
  const distance = Math.abs(toAngle - fromAngle);
  return gsap.utils.clamp(0.2, 0.6, 0.18 + (distance / 180) * 0.42);
}

export function placeCarousel({ position, bookRefs, nameRefs, metaRefs, scrollbarRef }) {
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

