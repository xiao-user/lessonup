const LINE_HEIGHT_PX = 16;
const FRAME_SECONDS = 1 / 60;
const INTEGRATION_STEP_SECONDS = 1 / 120;
const MAX_CATCH_UP_SECONDS = 0.1;

export const BOOK_CAROUSEL_MOTION = Object.freeze({
  wheelImpulsePerPixel: 0.046,
  dragPixelsPerBook: 180,
  maxVelocity: 8.5,
  freeFriction: 6.2,
  magnetStartSpeed: 1.9,
  magnetStrength: 42,
  magnetDamping: 6,
  edgeStrength: 76,
  edgeDamping: 15,
  targetStrength: 68,
  targetDamping: 14,
  overscrollLimit: 0.16,
  stopVelocity: 0.014,
  stopDistance: 0.0015,
  staleReleaseMilliseconds: 80,
});

export function clampCarouselPosition(position, maxPosition) {
  return Math.min(Math.max(position, 0), Math.max(0, maxPosition));
}

export function normalizeWheelDelta({ deltaX, deltaY, deltaMode }, pageHeight = 800) {
  const dominantDelta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  const multiplier = deltaMode === 1
    ? LINE_HEIGHT_PX
    : deltaMode === 2
      ? pageHeight
      : 1;
  return Math.min(Math.max(dominantDelta * multiplier, -120), 120);
}

export function applyCarouselEdgeResistance(position, maxPosition, limit = BOOK_CAROUSEL_MOTION.overscrollLimit) {
  const max = Math.max(0, maxPosition);
  if (position < 0) return -Math.min(limit, Math.abs(position) * 0.24);
  if (position > max) return max + Math.min(limit, (position - max) * 0.24);
  return position;
}

export function createCarouselMotion(position = 0) {
  return {
    position,
    velocity: 0,
    target: null,
    landingTarget: null,
    settled: true,
  };
}

export function addCarouselWheelImpulse(state, delta, maxPosition) {
  const max = Math.max(0, maxPosition);
  const direction = Math.sign(delta);
  const pushingPastStart = state.position <= 0 && direction < 0;
  const pushingPastEnd = state.position >= max && direction > 0;
  const edgeFactor = pushingPastStart || pushingPastEnd ? 0.28 : 1;
  return {
    position: state.position,
    velocity: Math.min(Math.max(
      state.velocity + delta * BOOK_CAROUSEL_MOTION.wheelImpulsePerPixel * edgeFactor,
      -BOOK_CAROUSEL_MOTION.maxVelocity,
    ), BOOK_CAROUSEL_MOTION.maxVelocity),
    target: null,
    landingTarget: null,
    settled: false,
  };
}

export function resolveCarouselReleaseVelocity(velocity, idleMilliseconds) {
  return idleMilliseconds > BOOK_CAROUSEL_MOTION.staleReleaseMilliseconds ? 0 : velocity;
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const ratio = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return ratio * ratio * (3 - 2 * ratio);
}

function projectedLandingTarget(position, velocity, maxPosition) {
  const projectedPosition = position + velocity / BOOK_CAROUSEL_MOTION.freeFriction;
  return clampCarouselPosition(Math.round(projectedPosition), maxPosition);
}

function advanceCarouselMotionStep(state, elapsedSeconds, maxPosition) {
  const max = Math.max(0, maxPosition);
  const dt = elapsedSeconds;
  let { position, velocity } = state;
  const forcedTarget = Number.isFinite(state.target)
    ? clampCarouselPosition(state.target, max)
    : null;
  let landingTarget = Number.isFinite(state.landingTarget)
    ? clampCarouselPosition(state.landingTarget, max)
    : null;
  let acceleration = 0;
  let restingTarget = forcedTarget ?? landingTarget;

  if (forcedTarget != null) {
    landingTarget = forcedTarget;
    restingTarget = forcedTarget;
    acceleration = (forcedTarget - position) * BOOK_CAROUSEL_MOTION.targetStrength
      - velocity * BOOK_CAROUSEL_MOTION.targetDamping;
  } else if (position < 0 || position > max) {
    landingTarget = position < 0 ? 0 : max;
    restingTarget = landingTarget;
    acceleration = (restingTarget - position) * BOOK_CAROUSEL_MOTION.edgeStrength
      - velocity * BOOK_CAROUSEL_MOTION.edgeDamping;
  } else {
    if (landingTarget == null && Math.abs(velocity) <= BOOK_CAROUSEL_MOTION.magnetStartSpeed) {
      landingTarget = projectedLandingTarget(position, velocity, max);
    }
    restingTarget = landingTarget;
    const magnet = smoothstep(
      BOOK_CAROUSEL_MOTION.magnetStartSpeed,
      0,
      Math.abs(velocity),
    );
    if (restingTarget != null) {
      acceleration = (restingTarget - position) * BOOK_CAROUSEL_MOTION.magnetStrength * magnet
        - velocity * BOOK_CAROUSEL_MOTION.magnetDamping * magnet;
    }
    velocity *= Math.exp(-BOOK_CAROUSEL_MOTION.freeFriction * dt);
  }

  velocity += acceleration * dt;
  position += velocity * dt;

  const lowerLimit = -BOOK_CAROUSEL_MOTION.overscrollLimit;
  const upperLimit = max + BOOK_CAROUSEL_MOTION.overscrollLimit;
  if (position < lowerLimit) {
    position = lowerLimit;
    velocity = Math.max(0, velocity * -0.18);
  } else if (position > upperLimit) {
    position = upperLimit;
    velocity = Math.min(0, velocity * -0.18);
  }

  const distance = restingTarget == null ? Number.POSITIVE_INFINITY : Math.abs(restingTarget - position);
  const settled = Math.abs(velocity) <= BOOK_CAROUSEL_MOTION.stopVelocity
    && distance <= BOOK_CAROUSEL_MOTION.stopDistance;

  if (settled) {
    return {
      position: restingTarget,
      velocity: 0,
      target: null,
      landingTarget: null,
      settled: true,
    };
  }

  return {
    position,
    velocity,
    target: forcedTarget,
    landingTarget,
    settled: false,
  };
}

export function advanceCarouselMotion(state, elapsedSeconds, maxPosition) {
  let remaining = Math.min(
    Math.max(elapsedSeconds || FRAME_SECONDS, 1 / 240),
    MAX_CATCH_UP_SECONDS,
  );
  let next = state;

  while (remaining > 0 && !next.settled) {
    const step = Math.min(remaining, INTEGRATION_STEP_SECONDS);
    next = advanceCarouselMotionStep(next, step, maxPosition);
    remaining -= step;
  }

  return next;
}

export const BOOK_OPEN_SIZE_RATIO = 1.32;

export function carouselBookPose(offset) {
  const direction = Math.sign(offset);
  const distance = Math.abs(offset);
  const travel = 48 * Math.tanh(distance * 1.35) + Math.max(0, distance - 1) * 7.5;
  const focus = Math.exp(-distance * distance * 3.25);
  // Keep resting books visually the same size as before, but open at scale 1 so
  // page/cover type stays sharp instead of being upscaled by --book-open-scale.
  const restScale = (0.56 + 0.44 * focus) / BOOK_OPEN_SIZE_RATIO;
  return {
    y: 47.57 + direction * travel,
    scale: restScale,
    rotationOffset: direction < 0
      ? 10 * (1 - focus)
      : 2.5 * (1 - focus),
    zIndex: Math.max(4, 20 - Math.round(distance * 4) + (direction > 0 ? 1 : 0)),
  };
}

export function carouselNamePose(offset) {
  const direction = Math.sign(offset);
  const distance = Math.abs(offset);
  const travel = 25 * Math.tanh(distance * 1.2) + Math.max(0, distance - 1) * 6.5;
  return {
    y: 47.9 + direction * travel,
    proximity: Math.max(0, 1 - distance),
    visibility: Math.max(0.08, 1 / (1 + distance * 1.15)),
  };
}
