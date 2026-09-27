import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ToolChips from "./ToolChips.js";

describe("ToolChips", () => {
  it("keeps the activity list open after a completed turn and hides row details until opened", () => {
    const markup = renderToStaticMarkup(React.createElement(ToolChips, {
      state: "completed",
      activities: [{ id: "read", name: "read", label: "读取教案", detail: "已读取", state: "completed" }],
    }));

    expect(markup).toContain("1 个工具调用");
    expect(markup).toContain("disclosure-label");
    expect(markup).toMatch(/disclosure-chevron[\s\S]*1 个工具调用/);
    expect(markup).toContain("读取教案");
    expect(markup).not.toContain("耗时");
    expect(markup).not.toContain("用时");
    expect(markup).not.toContain("已读取");
  });

  it("summarizes tools and turns without elapsed time", () => {
    const markup = renderToStaticMarkup(React.createElement(ToolChips, {
      state: "completed",
      activities: [
        { id: "read", name: "read", label: "读取教案", state: "completed" },
        { id: "patch", name: "patch", label: "准备修改建议", state: "completed" },
      ],
      turnCount: 2,
    }));

    expect(markup).toContain("2 个工具调用 · 2 轮");
    expect(markup).not.toContain("耗时");
    expect(markup).not.toContain("处理活动");
  });

  it("keeps the working label honest while the teacher decides", () => {
    const markup = renderToStaticMarkup(React.createElement(ToolChips, {
      state: "awaiting_approval",
      activities: [{ id: "patch", name: "propose_document_patch", label: "准备修改建议", detail: "待确认", state: "completed" }],
    }));

    expect(markup).toContain("等待确认 · 1 个工具调用");
    expect(markup).toContain("准备修改建议");
    expect(markup).not.toContain("正在处理");
    expect(markup).not.toContain("已处理");
  });

  it("renders a real tool start immediately instead of animating it in after completion", () => {
    const markup = renderToStaticMarkup(React.createElement(ToolChips, {
      state: "running",
      activities: [{ id: "read", name: "read", label: "读取教案", state: "running" }],
    }));

    expect(markup).toContain("正在处理 · 1 个工具调用");
    expect(markup).toContain("运行中");
    expect(markup).not.toContain("fade-up");
  });
});
