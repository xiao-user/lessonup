import { describe, expect, it } from "vitest";

import { formatTurnDuration, turnDurationMs } from "./turn-duration.js";

describe("turn duration", () => {
  it("keeps a completed turn duration fixed", () => {
    const startedAt = "2026-08-21T08:00:00.000Z";
    const completedAt = "2026-08-21T08:01:13.000Z";
    expect(turnDurationMs(startedAt, completedAt, Date.parse("2026-08-21T09:00:00.000Z"))).toBe(73_000);
    expect(formatTurnDuration(73_000)).toBe("1分13秒");
  });

  it("uses the current time only while a turn is running", () => {
    expect(turnDurationMs("2026-08-21T08:00:00.000Z", undefined, Date.parse("2026-08-21T08:00:02.400Z"))).toBe(2_400);
    expect(formatTurnDuration(2_400)).toBe("2.4秒");
  });
});
