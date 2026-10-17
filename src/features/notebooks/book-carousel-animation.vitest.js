import { describe, expect, it } from "vitest";

import {
  CLOSE_COVER_GAP,
  CLOSE_COVER_MIN_DURATION,
  CLOSE_DURATION,
  CLOSE_REWIND_DURATION,
  CLOSE_REWIND_START_LIMIT,
  closeDurationFor,
  closeRewindPlan,
} from "./book-carousel-animation.js";

describe("closeRewindPlan", () => {
  it("finishes every turned leaf before the cover starts", () => {
    for (const count of [1, 2, 4, 8, 20]) {
      const plan = closeRewindPlan(count);
      const lastStart = plan.starts[plan.starts.length - 1];
      expect(lastStart + CLOSE_REWIND_DURATION).toBeLessThanOrEqual(plan.coverStart);
      expect(plan.coverStart).toBeGreaterThanOrEqual(plan.rewindEnd + CLOSE_COVER_GAP - 1e-9);
    }
  });

  it("caps the stagger so large stacks do not delay the cover", () => {
    const plan = closeRewindPlan(40);
    expect(plan.starts.every((start) => start <= CLOSE_REWIND_START_LIMIT)).toBe(true);
    expect(plan.starts.at(-1)).toBe(CLOSE_REWIND_START_LIMIT);
  });

  it("keeps typical closes near the baseline duration", () => {
    expect(closeDurationFor(1)).toBeCloseTo(CLOSE_DURATION, 5);
    expect(closeDurationFor(4)).toBeCloseTo(CLOSE_DURATION, 5);
    expect(closeDurationFor(8)).toBeGreaterThan(CLOSE_DURATION);
    expect(closeDurationFor(20)).toBeLessThan(1.3);
  });

  it("reserves a visible cover swing", () => {
    for (const count of [1, 4, 20, 40]) {
      expect(closeRewindPlan(count).coverDuration).toBeGreaterThanOrEqual(CLOSE_COVER_MIN_DURATION);
    }
  });

  it("collapses to zero timing when reduced motion is requested", () => {
    expect(closeRewindPlan(8, true)).toEqual({
      starts: [],
      rewindEnd: 0,
      coverStart: 0,
      coverDuration: 0,
    });
    expect(closeRewindPlan(0)).toEqual({
      starts: [],
      rewindEnd: 0,
      coverStart: 0,
      coverDuration: CLOSE_DURATION,
    });
  });
});
