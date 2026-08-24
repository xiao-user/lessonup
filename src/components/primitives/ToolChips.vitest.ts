import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ToolChips, { formatTurnDuration, turnDurationMs } from "./ToolChips.js";

describe("Beautiful UI turn timing", () => {
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

  it("does not retain a collapsed activity body after a completed turn", () => {
    const markup = renderToStaticMarkup(React.createElement(ToolChips, {
      state: "completed",
      startedAt: "2026-08-21T08:00:00.000Z",
      completedAt: "2026-08-21T08:00:02.000Z",
      activities: [{ id: "read", name: "read", label: "读取教案", detail: "已读取", state: "completed" }],
    }));

    expect(markup).toContain("耗时 2.0秒");
    expect(markup).not.toContain("已读取");
    expect(markup).not.toContain("grid-template-rows");
  });
});
