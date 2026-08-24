import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PromptBar from "./PromptBar.js";

function renderPromptBar(status: string) {
  return renderToStaticMarkup(React.createElement(PromptBar, {
    value: "",
    onChange: () => undefined,
    onSubmit: () => undefined,
    onStop: () => undefined,
    status,
    statusLabel: status === "streaming" ? "正在回复" : "可以提问",
  }));
}

describe("PromptBar", () => {
  it("keeps the native wide layout with the input above the controls", () => {
    const markup = renderPromptBar("ready");

    expect(markup).toContain("col-span-full col-start-1 row-start-1");
    expect(markup).toContain('aria-label="添加附件"');
    expect(markup).toContain("col-start-1 row-start-2");
    expect(markup).toContain('aria-label="发送"');
    expect(markup).toContain("col-start-4 row-start-2");
  });

  it("names every running control by its real Pi behavior", () => {
    const markup = renderPromptBar("streaming");

    expect(markup).toContain('aria-label="发送为本轮插话"');
    expect(markup).toContain("本轮插话：让 Pi 在当前 Turn 中接收这条消息");
    expect(markup).toContain('aria-label="停止生成"');
    expect(markup).toContain('aria-label="加入当前任务"');
  });
});
