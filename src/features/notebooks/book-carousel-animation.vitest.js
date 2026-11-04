import gsap from "gsap";
import { describe, expect, it } from "vitest";

import { EASE, closeBookPlan } from "./book-carousel-animation.js";

const ease = gsap.parseEase(EASE.close);
const angleAt = (start, time, duration, delay = 0) => (
  start * (1 - ease(Math.max(0, Math.min(1, (time - delay) / duration))))
);

describe("closeBookPlan", () => {
  it("overlaps the cover with the staggered pages while keeping their angular order", () => {
    for (const count of [1, 2, 4, 8, 20, 100]) {
      const plan = closeBookPlan(count);
      let overlap = false;
      for (let frame = 1; frame <= 240; frame += 1) {
        const time = (plan.coverStart + plan.coverDuration) * frame / 240;
        const cover = angleAt(-180, time, plan.coverDuration, plan.coverStart);
        const leaves = plan.leafStarts.map(delay => angleAt(-180, time, plan.leafDuration, delay));
        if (cover > -179 && leaves.some(angle => angle > -179 && angle < -1)) overlap = true;
        expect(leaves.every(angle => angle >= cover - 1e-9)).toBe(true);
        expect(leaves.every((angle, index) => index === 0 || angle <= leaves[index - 1] + 1e-9)).toBe(true);
      }
      expect(overlap).toBe(true);
      const lastLeafLanding = plan.leafStarts.at(-1) + plan.leafDuration;
      const coverAtLanding = angleAt(-180, lastLeafLanding, plan.coverDuration, plan.coverStart);
      expect(coverAtLanding).toBeGreaterThan(-175);
      expect(coverAtLanding).toBeLessThan(-5);
    }
  });

  it("preserves separation when a partial page turn is interrupted", () => {
    const plan = closeBookPlan(4);
    for (const initialAngle of [-179, -90, -1]) {
      for (let frame = 1; frame <= 120; frame += 1) {
        const time = (plan.coverStart + plan.coverDuration) * frame / 120;
        expect(angleAt(initialAngle, time, plan.leafDuration, plan.leafStarts[0]))
          .toBeGreaterThanOrEqual(angleAt(-180, time, plan.coverDuration, plan.coverStart));
      }
    }
  });

  it("keeps the page cadence and lets total duration grow with the stack", () => {
    const few = closeBookPlan(2);
    const many = closeBookPlan(8);
    expect(few.leafStarts[1] - few.leafStarts[0]).toBeCloseTo(0.05);
    expect(many.leafDuration).toBe(0.4);
    expect(many.coverStart + many.coverDuration).toBeGreaterThan(few.coverStart + few.coverDuration);
    expect(many.coverDuration).toBe(few.coverDuration);
    expect(closeBookPlan(100).coverStart).toBeLessThan(0.4);
    expect(closeBookPlan(0).coverStart).toBe(0);
  });

  it("settles immediately with reduced motion", () => {
    for (const count of [0, 1, 8]) {
      const plan = closeBookPlan(count, true);
      expect(plan.coverStart + plan.coverDuration + plan.leafDuration).toBe(0);
      expect(plan.leafStarts.every(start => start === 0)).toBe(true);
    }
  });
});
