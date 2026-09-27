import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ThinkingTrace from "./ThinkingTrace.js";

describe("ThinkingTrace", () => {
  it("keeps process work open under a live duration while the turn is running", () => {
    const markup = renderToStaticMarkup(React.createElement(ThinkingTrace, {
      startedAt: "2026-08-21T08:00:00.000Z",
      active: true,
    }, React.createElement("span", null, "正在思考")));

    expect(markup).toContain("用时");
    expect(markup).toContain("正在思考");
    expect(markup).not.toContain("aria-expanded");
    expect(markup).not.toContain("border-t");
  });

  it("collapses process work after the turn and keeps the duration with a chevron", () => {
    const markup = renderToStaticMarkup(React.createElement(ThinkingTrace, {
      startedAt: "2026-08-21T08:00:00.000Z",
      completedAt: "2026-08-21T08:00:08.400Z",
      active: false,
    }, React.createElement("span", null, "1 个工具调用")));

    expect(markup).toContain("用时 8.4秒");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("disclosure-label");
    expect(markup).toMatch(/disclosure-chevron[\s\S]*用时 8\.4秒/);
    expect(markup).not.toContain("1 个工具调用");
    expect(markup).not.toContain("border-t");
  });

  it("keeps duration-only chrome when tools live in the reply timeline", () => {
    const markup = renderToStaticMarkup(React.createElement(ThinkingTrace, {
      startedAt: "2026-08-21T08:00:00.000Z",
      completedAt: "2026-08-21T08:00:08.400Z",
      active: false,
    }));

    expect(markup).toContain("用时 8.4秒");
    expect(markup).not.toContain("aria-expanded");
    expect(markup).not.toContain("disclosure-chevron");
  });
});
