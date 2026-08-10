import { describe, expect, it } from "vitest";

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
} from "./book-carousel-motion.js";

function runUntilSettled(state, maxPosition, limit = 360) {
  const positions = [];
  let next = state;
  for (let frame = 0; frame < limit && !next.settled; frame += 1) {
    next = advanceCarouselMotion(next, 1 / 60, maxPosition);
    positions.push(next.position);
  }
  return { state: next, positions };
}

function runAtFrameRate(state, maxPosition, framesPerSecond, limitSeconds = 4) {
  let next = state;
  let elapsed = 0;
  const step = 1 / framesPerSecond;
  while (!next.settled && elapsed < limitSeconds) {
    next = advanceCarouselMotion(next, step, maxPosition);
    elapsed += step;
  }
  return { state: next, elapsed };
}

describe("book carousel motion", () => {
  it("normalizes every wheel delta mode before applying one input cap", () => {
    expect(normalizeWheelDelta({ deltaX: 0, deltaY: 80, deltaMode: 0 })).toBe(80);
    expect(normalizeWheelDelta({ deltaX: 0, deltaY: 10, deltaMode: 1 })).toBe(120);
    expect(normalizeWheelDelta({ deltaX: -2, deltaY: 1, deltaMode: 2 }, 900)).toBe(-120);
  });

  it("turns a wheel impulse into one uninterrupted coast and magnetic landing", () => {
    const initial = addCarouselWheelImpulse(createCarouselMotion(0), 120, 5);
    const result = runUntilSettled(initial, 5);

    expect(result.state).toEqual(createCarouselMotion(1));
    expect(result.positions.length).toBeLessThan(120);
    expect(result.positions[0]).toBeGreaterThan(0);
    expect(result.positions.slice(0, 35).every((position, index, positions) => (
      index === 0 || position > positions[index - 1]
    ))).toBe(true);
  });

  it("uses the same physics at an edge instead of scheduling a second correction", () => {
    const initial = addCarouselWheelImpulse(createCarouselMotion(5), 120, 5);
    const result = runUntilSettled(initial, 5);

    expect(Math.max(...result.positions)).toBeLessThanOrEqual(5 + BOOK_CAROUSEL_MOTION.overscrollLimit);
    expect(result.state).toEqual(createCarouselMotion(5));
    expect(result.positions.length).toBeLessThan(120);
  });

  it("keeps the same landing and duration across common frame rates", () => {
    const results = [30, 60, 120].map((framesPerSecond) => runAtFrameRate(
      addCarouselWheelImpulse(createCarouselMotion(0), 120, 5),
      5,
      framesPerSecond,
    ));

    expect(results.map(({ state }) => state)).toEqual([
      createCarouselMotion(1),
      createCarouselMotion(1),
      createCarouselMotion(1),
    ]);
    const elapsed = results.map((result) => result.elapsed);
    expect(Math.max(...elapsed) - Math.min(...elapsed)).toBeLessThan(0.08);
  });

  it("locks a projected landing target until a new input arrives", () => {
    const coasting = {
      ...createCarouselMotion(0.42),
      velocity: 1.2,
      settled: false,
    };
    const firstFrame = advanceCarouselMotion(coasting, 1 / 60, 5);
    const result = runUntilSettled(firstFrame, 5);

    expect(firstFrame.landingTarget).toBe(1);
    expect(result.state).toEqual(createCarouselMotion(1));
    expect(addCarouselWheelImpulse(firstFrame, -20, 5).landingTarget).toBeNull();
  });

  it("supports direct touch resistance and targeted keyboard or title navigation", () => {
    expect(clampCarouselPosition(-0.4, 4)).toBe(0);
    expect(applyCarouselEdgeResistance(-0.4, 4)).toBeCloseTo(-0.096);

    const result = runUntilSettled({
      ...createCarouselMotion(0.35),
      target: 3,
      settled: false,
    }, 5);
    expect(result.state).toEqual(createCarouselMotion(3));
    expect(resolveCarouselReleaseVelocity(2.4, 40)).toBe(2.4);
    expect(resolveCarouselReleaseVelocity(2.4, 120)).toBe(0);
  });

  it("maps books and titles continuously around the shared focus coordinate", () => {
    expect(carouselBookPose(0)).toMatchObject({ y: 47.57, scale: 1 / 1.32 });
    expect(carouselBookPose(-0.5).y).toBeLessThan(47.57);
    expect(carouselBookPose(0.5).y).toBeGreaterThan(47.57);
    expect(carouselBookPose(0.99).scale).toBeCloseTo(carouselBookPose(1.01).scale, 1);
    expect(carouselNamePose(0)).toMatchObject({ y: 47.9, proximity: 1, visibility: 1 });
  });
});
