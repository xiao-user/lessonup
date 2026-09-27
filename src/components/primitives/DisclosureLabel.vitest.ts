import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DisclosureLabel, DisclosureStatus } from "./DisclosureLabel.js";

describe("DisclosureLabel", () => {
  it("sizes the chevron in em and places it before the status text", () => {
    const markup = renderToStaticMarkup(React.createElement(DisclosureLabel, {
      open: true,
      onToggle() {},
      children: "正在处理 · 1 个工具调用",
    }));

    expect(markup).toContain("disclosure-label");
    expect(markup).toContain("disclosure-chevron");
    expect(markup).toContain('data-open="true"');
    expect(markup).not.toContain("width=\"12\"");
    expect(markup).not.toContain("height=\"12\"");
    expect(markup).toMatch(/disclosure-chevron[\s\S]*正在处理 · 1 个工具调用/);
  });

  it("keeps the live status on the same label geometry without a chevron", () => {
    const markup = renderToStaticMarkup(React.createElement(DisclosureStatus, null, "用时 1.2秒"));

    expect(markup).toContain("disclosure-label");
    expect(markup).toContain("用时 1.2秒");
    expect(markup).not.toContain("disclosure-chevron");
    expect(markup).not.toContain("aria-expanded");
  });
});
